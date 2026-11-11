#!/usr/bin/env node
// watch.mjs — 文件 ⇄ 图片 ⇄ 剪贴板（支持合体轻量常驻收发、自动压缩、加密、5MB+ 分片）
// 用法:
//   node watch.mjs                 仅监听收件文件夹发送
//   node watch.mjs --with-recv     单进程同时监听发送 + 剪贴板接收（配合轻量 clipagent.exe，极低内存）
//   node watch.mjs --once <file>   处理单个文件（供拖放 .bat 调用）
//   环境变量: F2I_IN(默认 Desktop\f2i), F2I_OUT, F2I_RECV, F2I_PART_MB(默认4.7), F2I_MAX_MB(默认50), F2I_PART_DELAY_MS(默认2500), F2I_PASSWORD, F2I_LOG

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  encodeFilePartsSync,
  restoreImageSync,
  F3_COMPRESSED,
  F3_ENCRYPTED,
  DEFAULT_PART_BYTES,
} from '../file2img.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIP_PS = path.join(HERE, 'clip.ps1');
const CLIP_CS = path.join(HERE, 'clipagent.cs');

const IN_DIR = path.resolve(process.env.F2I_IN || path.join(os.homedir(), 'Desktop', 'f2i'));
const OUT_DIR = path.resolve(process.env.F2I_OUT || path.join(IN_DIR, '图片'));
const DEFAULT_RECV_DIR = path.resolve(process.env.F2I_RECV || path.join(IN_DIR, 'recv'));

const PART_MB = parseFloat(process.env.F2I_PART_MB || '');
const MAX_MB = parseFloat(process.env.F2I_MAX_MB || '');
const DEFAULT_PART_LIMIT = PART_MB > 0 ? Math.floor(PART_MB * 1000 * 1000) : DEFAULT_PART_BYTES;
const MAX_BYTES = MAX_MB > 0 ? Math.floor(MAX_MB * 1000 * 1000) : 50 * 1000 * 1000;
const PART_DELAY_MS = Math.max(500, parseInt(process.env.F2I_PART_DELAY_MS || '2500', 10) || 2500);
const ENV_PASSWORD = process.env.F2I_PASSWORD || '';

const SKIP = /(^~\$|\.tmp$|\.crdownload$|\.part$|^\.)/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 参数解析 ---------- */
const args = process.argv.slice(2);
let onceTarget = '';
let withRecv = false;
let cliPassword;
let cliPartBytes = 0;
let logPath = process.env.F2I_LOG ? path.resolve(process.env.F2I_LOG) : '';
let recvDir = DEFAULT_RECV_DIR;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--once' && i + 1 < args.length) onceTarget = args[++i];
  else if (args[i] === '--with-recv') withRecv = true;
  else if (args[i] === '--password' && i + 1 < args.length) cliPassword = args[++i];
  else if (args[i] === '--recv-dir' && i + 1 < args.length) recvDir = path.resolve(args[++i]);
  else if (args[i] === '--log' && i + 1 < args.length) logPath = path.resolve(args[++i]);
  else if (args[i] === '--part-mb' && i + 1 < args.length) {
    const v = parseFloat(args[++i]);
    if (v > 0) cliPartBytes = Math.floor(v * 1000 * 1000);
  }
}

/* ---------- 日志 ---------- */
function log(msg) {
  const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
  if (!logPath || process.stdout.isTTY) {
    console.log(line);
  }
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2 * 1024 * 1024) {
        fs.writeFileSync(logPath, '');
      }
      fs.appendFileSync(logPath, line + '\n', 'utf8');
    } catch { /* ignore */ }
  }
}

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* ---------- 轻量剪贴板助手编译与调用 ---------- */
let cachedClipExe = undefined;
function ensureClipAgent() {
  if (cachedClipExe !== undefined) return cachedClipExe;
  if (process.platform !== 'win32' || !fs.existsSync(CLIP_CS)) {
    cachedClipExe = null;
    return null;
  }
  const csc = path.join(
    process.env.windir || 'C:\\WINDOWS',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'
  );
  const binDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'f2i');
  const exe = path.join(binDir, 'clipagent.exe');
  try {
    const csMtime = fs.statSync(CLIP_CS).mtimeMs;
    const needBuild = !fs.existsSync(exe) || fs.statSync(exe).mtimeMs < csMtime;
    if (needBuild) {
      if (!fs.existsSync(csc)) {
        cachedClipExe = fs.existsSync(exe) ? exe : null;
        return cachedClipExe;
      }
      fs.mkdirSync(binDir, { recursive: true });
      execFileSync(csc, [
        '/nologo', '/optimize+', '/target:exe',
        '/out:' + exe,
        '/r:System.Windows.Forms.dll',
        '/r:System.Drawing.dll',
        CLIP_CS,
      ], { stdio: 'pipe', windowsHide: true });
    }
    cachedClipExe = exe;
  } catch {
    cachedClipExe = null;
  }
  return cachedClipExe;
}

let PS_EXE = null;
function findPS() {
  if (PS_EXE) return PS_EXE;
  for (const cand of ['pwsh', 'powershell']) {
    try {
      execFileSync(cand, ['-NoProfile', '-Command', 'exit'], { stdio: 'ignore', windowsHide: true });
      PS_EXE = cand;
      return PS_EXE;
    } catch { /* try next */ }
  }
  PS_EXE = path.join(
    process.env.SystemRoot || 'C:\\WINDOWS',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  return PS_EXE;
}

let activeClipProc = null;
const setWaiters = [];

async function sendToClipboard(pngPath) {
  // 若已常驻 clipagent --watch，直接通过管道写入剪贴板（零冷启动）
  if (activeClipProc && !activeClipProc.killed && activeClipProc.stdin.writable) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = setWaiters.indexOf(waiter);
        if (idx >= 0) setWaiters.splice(idx, 1);
        reject(new Error('clipagent timeout'));
      }, 8000);
      const waiter = { resolve, reject, timer };
      setWaiters.push(waiter);
      activeClipProc.stdin.write('SET:' + Buffer.from(pngPath, 'utf8').toString('base64') + '\n');
    }).catch(() => sendToClipboardOneShot(pngPath));
  }
  return sendToClipboardOneShot(pngPath);
}

function sendToClipboardOneShot(pngPath) {
  const exe = ensureClipAgent();
  if (exe) {
    const out = execFileSync(exe, ['--set', pngPath], { encoding: 'utf8', windowsHide: true }).trim();
    const parts = out.split(':');
    if (parts[0] === 'SETOK') return `CLIPBOARD_OK ${parts[1]} ${parts[2]}B`;
    return out;
  }
  const out = execFileSync(findPS(), [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', CLIP_PS, '-Png', pngPath,
  ], { encoding: 'utf8', windowsHide: true });
  return out.trim();
}

/* ---------- 编码发送 ---------- */
const inFlight = new Set();
const convertedSig = new Map();

async function convert(file, opts = {}) {
  const abs = path.resolve(file);
  const name = path.basename(abs);
  if (SKIP.test(name)) return null;
  if (abs.startsWith(OUT_DIR + path.sep) || abs.startsWith(recvDir + path.sep)) return null;

  const st = fs.statSync(abs);
  if (!st.isFile()) return null;
  if (st.size === 0) { log('跳过空文件 ' + name); return null; }
  if (st.size > MAX_BYTES) {
    log('跳过 ' + name + '：' + (st.size / 1000000).toFixed(2) + ' MB 超过总上限 ' + (MAX_BYTES / 1000000).toFixed(1) + ' MB');
    return null;
  }

  const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
  if (!opts.force && convertedSig.get(abs) === sig) return null;
  if (inFlight.has(abs)) return null;
  inFlight.add(abs);

  try {
    const t0 = Date.now();
    const payload = fs.readFileSync(abs);
    const maxPartBytes = opts.maxPartBytes || DEFAULT_PART_LIMIT;
    const password = opts.password !== undefined ? opts.password : ENV_PASSWORD;
    const parts = encodeFilePartsSync(payload, name, { compress: true, password, maxPartBytes });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const base = name.replace(/\.[^.]+$/, '') || name;
    const ts = stamp();
    const outPaths = [];

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const suffix = parts.length > 1 ? `.part${i + 1}of${parts.length}` : '';
      const outPath = path.join(OUT_DIR, `${ts}_${base}${suffix}.png`);
      fs.writeFileSync(outPath, p.png);
      outPaths.push(outPath);

      const clipMsg = await sendToClipboard(outPath);
      const tags = [];
      if (p.flags & F3_COMPRESSED) tags.push('压缩');
      if (p.flags & F3_ENCRYPTED) tags.push('加密');
      const tagStr = tags.length ? ` [${tags.join('+')}]` : '';
      const partLabel = parts.length > 1 ? ` [${i + 1}/${parts.length}]` : '';

      log(`✅ ${name}${partLabel}  ${payload.length} B → ${p.w}x${p.h}  PNG ${(p.png.length / 1024).toFixed(1)} KB${tagStr}`);
      log(`   已入剪贴板 · ${clipMsg}`);
      log(`   输出 ${outPath}`);

      if (i + 1 < parts.length) {
        log(`   等待 ${(PART_DELAY_MS / 1000).toFixed(1)}s 让剪贴板同步下一分片…`);
        await sleep(PART_DELAY_MS);
      }
    }

    const ms = Date.now() - t0;
    log(`   完成 (${parts.length} 张, ${ms} ms)`);
    convertedSig.set(abs, sig);
    return outPaths;
  } finally {
    inFlight.delete(abs);
  }
}

/* ---------- 轻量剪贴板接收（与发送共进程） ---------- */
let shuttingDown = false;

function handleClipImage(source, imgPath, isTemp) {
  const password = cliPassword !== undefined ? cliPassword : ENV_PASSWORD;
  log('剪贴板捕获: ' + source);
  try {
    const res = restoreImageSync(imgPath, recvDir, { password });
    if (res.status === 'PART') {
      log(`   收到分片 ${res.received}/${res.partTotal} · ${res.name}`);
    } else {
      log(`   还原 -> ${res.dest}  (${res.size} B)`);
    }
  } catch (e) {
    const msg = e.message || String(e);
    if (/解密|口令/.test(msg)) log('   解码失败: ' + msg);
    else log('   不是载荷图（普通图片，忽略）');
  } finally {
    if (isTemp) {
      try { fs.unlinkSync(imgPath); } catch { /* ignore */ }
    }
  }
}

function startClipListener() {
  const exe = ensureClipAgent();
  if (!exe) {
    log('⚠️ 未找到 csc.exe，无法启用轻量内置接收器，请单独运行 pc/cliprecv.ps1');
    return;
  }
  fs.mkdirSync(recvDir, { recursive: true });
  const proc = spawn(exe, ['--watch'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeClipProc = proc;

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', raw => {
    const line = raw.trim();
    if (!line) return;
    if (line === 'READY') {
      log('接收监听就绪（WM_CLIPBOARDUPDATE 事件驱动）-> ' + recvDir);
      return;
    }
    if (line === 'SKIP_LOCAL') {
      log('跳过本机发出的载荷图');
      return;
    }
    if (line.startsWith('SETOK:') || line.startsWith('SETERR:')) {
      const w = setWaiters.shift();
      if (w) {
        clearTimeout(w.timer);
        if (line.startsWith('SETOK:')) {
          const p = line.split(':');
          w.resolve(`CLIPBOARD_OK ${p[1]} ${p[2]}B`);
        } else {
          w.reject(new Error(Buffer.from(line.slice(7), 'base64').toString('utf8')));
        }
      }
      return;
    }
    if (line.startsWith('TMP:') || line.startsWith('FILE:')) {
      const idx1 = line.indexOf(':');
      const idx2 = line.indexOf(':', idx1 + 1);
      if (idx2 > idx1) {
        const src = Buffer.from(line.slice(idx1 + 1, idx2), 'base64').toString('utf8');
        const fp = Buffer.from(line.slice(idx2 + 1), 'base64').toString('utf8');
        handleClipImage(src, fp, line.startsWith('TMP:'));
      }
      return;
    }
    if (line.startsWith('CLIPERR:')) {
      log('剪贴板读取异常: ' + Buffer.from(line.slice(8), 'base64').toString('utf8'));
    }
  });

  proc.on('exit', code => {
    if (activeClipProc === proc) activeClipProc = null;
    while (setWaiters.length) {
      const w = setWaiters.shift();
      clearTimeout(w.timer);
      w.reject(new Error('clipagent exited'));
    }
    if (!shuttingDown) {
      log(`clipagent 退出 (${code})，2 秒后重启…`);
      setTimeout(startClipListener, 2000);
    }
  });
}

/* ---------- 单文件模式 ---------- */
if (onceTarget) {
  const abs = path.resolve(onceTarget);
  if (!fs.existsSync(abs)) { console.error('找不到: ' + abs); process.exit(1); }
  try {
    await convert(abs, { force: true, password: cliPassword, maxPartBytes: cliPartBytes });
  } catch (e) {
    console.error('[error] ' + e.message);
    process.exit(2);
  }
  process.exit(0);
}

/* ---------- 常驻监听 ---------- */
fs.mkdirSync(IN_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

log('监听: ' + IN_DIR);
log('输出: ' + OUT_DIR);
log(`分片阈值: ${(DEFAULT_PART_LIMIT / 1000000).toFixed(1)} MB   总上限: ${(MAX_BYTES / 1000000).toFixed(0)} MB   等待文件…`);

if (withRecv) startClipListener();

const pending = new Map();

function isFileReadable(file) {
  try {
    const fd = fs.openSync(file, 'r');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function schedule(file, attempts = 0) {
  const abs = path.resolve(file);
  if (abs.startsWith(OUT_DIR + path.sep) || abs.startsWith(recvDir + path.sep)) return;
  if (SKIP.test(path.basename(abs))) return;
  try { if (!fs.statSync(abs).isFile()) return; } catch { return; }

  clearTimeout(pending.get(abs));
  pending.set(abs, setTimeout(() => {
    pending.delete(abs);
    try {
      if (!fs.existsSync(abs)) return;
      const s1 = fs.statSync(abs);
      if (!s1.isFile()) return;
      setTimeout(async () => {
        try {
          if (!fs.existsSync(abs)) return;
          const s2 = fs.statSync(abs);
          if (s2.size !== s1.size || s2.mtimeMs !== s1.mtimeMs || !isFileReadable(abs)) {
            if (attempts < 20) schedule(abs, attempts + 1);
            else log('放弃（文件一直被占用）: ' + path.basename(abs));
            return;
          }
          await convert(abs, { password: cliPassword, maxPartBytes: cliPartBytes });
        } catch (e) {
          log('处理失败 ' + path.basename(abs) + ': ' + e.message);
        }
      }, 400);
    } catch (e) {
      log('处理失败: ' + e.message);
    }
  }, 300));
}

fs.watch(IN_DIR, (ev, fname) => {
  if (!fname) return;
  schedule(path.join(IN_DIR, fname));
});

function shutdown() {
  shuttingDown = true;
  if (activeClipProc && activeClipProc.stdin.writable) {
    try { activeClipProc.stdin.write('QUIT\n'); } catch { /* ignore */ }
  }
  log('已退出');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
