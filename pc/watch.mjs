#!/usr/bin/env node
// watch.mjs — 文件 → 图片 → 剪贴板（配合豆包输入法超级互传）
// 特性：自动压缩（变小才启用）、支持 5MB+ 大文件自动分片、可选加密、防止重复触发
// 用法:
//   node watch.mjs                           常驻监听收件文件夹
//   node watch.mjs --once <file>             处理单个文件（供拖放 .bat 调用）
//   可用环境变量: F2I_IN(默认 Desktop\f2i), F2I_OUT, F2I_PART_MB(默认4.7), F2I_MAX_MB(默认50), F2I_PART_DELAY_MS(默认2500), F2I_PASSWORD

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeFilePartsSync, F3_COMPRESSED, F3_ENCRYPTED, DEFAULT_PART_BYTES } from '../file2img.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIP_PS = path.join(HERE, 'clip.ps1');

const IN_DIR = path.resolve(process.env.F2I_IN || path.join(os.homedir(), 'Desktop', 'f2i'));
const OUT_DIR = path.resolve(process.env.F2I_OUT || path.join(IN_DIR, '图片'));
const PART_MB = parseFloat(process.env.F2I_PART_MB || '');
const MAX_MB = parseFloat(process.env.F2I_MAX_MB || '');
const DEFAULT_PART_LIMIT = PART_MB > 0 ? Math.floor(PART_MB * 1000 * 1000) : DEFAULT_PART_BYTES;
const MAX_BYTES = MAX_MB > 0 ? Math.floor(MAX_MB * 1000 * 1000) : 50 * 1000 * 1000;
const PART_DELAY_MS = Math.max(500, parseInt(process.env.F2I_PART_DELAY_MS || '2500', 10) || 2500);
const ENV_PASSWORD = process.env.F2I_PASSWORD || '';

const SKIP = /(^~\$|\.tmp$|\.crdownload$|\.part$|^\.)/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] ' + msg);
}

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
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

function sendToClipboard(pngPath) {
  const out = execFileSync(findPS(), [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', CLIP_PS, '-Png', pngPath,
  ], { encoding: 'utf8', windowsHide: true });
  return out.trim();
}

const inFlight = new Set();
const convertedSig = new Map();

async function convert(file, opts = {}) {
  const abs = path.resolve(file);
  const name = path.basename(abs);
  if (SKIP.test(name)) return null;
  if (abs.startsWith(OUT_DIR + path.sep)) return null;

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

      const clipMsg = sendToClipboard(outPath);
      const tags = [];
      if (p.flags & F3_COMPRESSED) tags.push('压缩');
      if (p.flags & F3_ENCRYPTED) tags.push('加密');
      const tagStr = tags.length ? ` [${tags.join('+')}]` : '';
      const partLabel = parts.length > 1 ? ` [${i + 1}/${parts.length}]` : '';

      log(
        `✅ ${name}${partLabel}  ${payload.length} B → ${p.w}x${p.h}  PNG ${(p.png.length / 1024).toFixed(1)} KB${tagStr}`
      );
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

/* ---------- 参数解析 ---------- */
const args = process.argv.slice(2);
let onceTarget = '';
let cliPassword;
let cliPartBytes = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--once' && i + 1 < args.length) onceTarget = args[++i];
  else if (args[i] === '--password' && i + 1 < args.length) cliPassword = args[++i];
  else if (args[i] === '--part-mb' && i + 1 < args.length) {
    const v = parseFloat(args[++i]);
    if (v > 0) cliPartBytes = Math.floor(v * 1000 * 1000);
  }
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
  if (abs.startsWith(OUT_DIR + path.sep)) return;
  if (SKIP.test(path.basename(abs))) return;
  try { if (!fs.statSync(abs).isFile()) return; } catch { return; }

  clearTimeout(pending.get(abs));
  pending.set(abs, setTimeout(() => {
    pending.delete(abs);
    try {
      if (!fs.existsSync(abs)) return;
      const s1 = fs.statSync(abs);
      if (!s1.isFile()) return;
      // 间隔确认文件大小、修改时间和可读性均稳定，避免读到复制一半的文件
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

process.on('SIGINT', () => { log('已退出'); process.exit(0); });
