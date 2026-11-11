#!/usr/bin/env node
// check.mjs — 通道无损性判定器
// 用法: node check.mjs <回传文件或目录> [--password PW]
// 自动识别格式 -> 直接调用 file2img 核心解 F2I1/F2I2/F2I3 载荷 -> 与原始 probe 比对 -> 给出通道结论

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodePng, toRgbStream, unpack, inspectPayloadHeader } from './file2img.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sniff(file) {
  const b = fs.readFileSync(file);
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return { fmt: 'PNG', buf: b };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { fmt: 'JPEG', buf: b };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { fmt: 'WEBP', buf: b };
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return { fmt: 'HEIC/MP4', buf: b };
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { fmt: 'BMP', buf: b };
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'GIF8') return { fmt: 'GIF', buf: b };
  return { fmt: 'UNKNOWN', buf: b };
}

// 已知原始载荷（按内嵌标识匹配，在当前目录 / 图片所在目录 / 脚本根目录查找）
function findOriginal(payload, imgFile) {
  const head = payload.subarray(0, 64).toString('utf8');
  const m = head.match(/^PROBE\|[^|]*\|([A-Za-z0-9_]+)\|/);
  if (!m) return null;
  const fname = 'probe_' + m[1] + '.bin';
  for (const dir of [process.cwd(), path.dirname(path.resolve(imgFile)), HERE]) {
    const p = path.join(dir, fname);
    if (fs.existsSync(p)) return { name: fname, buf: fs.readFileSync(p) };
  }
  return null;
}

function inspect(file, opts) {
  const { fmt, buf } = sniff(file);
  const size = buf.length;
  const out = { file: path.basename(file), fmt, size };
  console.log('─'.repeat(64));
  console.log('文件     : ' + out.file);
  console.log('格式     : ' + fmt + (
    fmt === 'PNG' ? '  ✅ 无损容器' :
    fmt === 'JPEG' ? '  ❌ 有损容器，通道已转码' :
    fmt === 'WEBP' ? '  ⚠️  WebP（可能是有损）' :
    fmt === 'HEIC/MP4' ? '  ❌ 已被转成 HEIC/视频' : ''
  ));
  console.log('大小     : ' + size + ' B' + (size > 0 ? ' (' + (size / 1024).toFixed(1) + ' KB)' : ''));

  if (fmt !== 'PNG') {
    console.log('结论     : 通道把图转成了 ' + fmt + '，像素直编码已毁。');
    out.verdict = 'LOSSY_CONTAINER';
    return out;
  }

  try {
    const img = decodePng(buf);
    const rgb = toRgbStream(img);
    const hdr = inspectPayloadHeader(rgb);
    console.log('像素     : ' + img.w + 'x' + img.h + '  ctype=' + img.ctype + '  depth=' + img.depth + '  格式=F2I' + hdr.version);

    const res = unpack(rgb, opts);
    const payload = res.payload;
    console.log('解码     : 成功，载荷 ' + payload.length + ' B' + (res.name ? '  原名 ' + res.name : ''));

    const orig = findOriginal(payload, file);
    if (orig) {
      const a = sha256(orig.buf), b = sha256(payload);
      const match = a === b;
      console.log('比对     : ' + orig.name + '  ' + (match ? '✅ 完全一致' : '❌ 不一致'));
      if (!match) {
        console.log('  src ' + a);
        console.log('  dst ' + b);
        let diff = -1;
        const n = Math.min(orig.buf.length, payload.length);
        for (let i = 0; i < n; i++) if (orig.buf[i] !== payload[i]) { diff = i; break; }
        console.log('  首个差异字节偏移: ' + (diff >= 0 ? diff : '(长度不同)'));
      }
      out.verdict = match ? 'LOSSLESS' : 'CORRUPTED';
    } else {
      console.log('比对     : 找不到对应原始 probe_*.bin，仅确认可解码');
      out.verdict = 'DECODED_NO_REF';
    }
  } catch (e) {
    console.log('解码     : 失败  ' + (e.message || String(e)));
    out.verdict = 'DECODE_FAILED';
  }
  return out;
}

const args = process.argv.slice(2);
let password = '';
let target = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--password' && i + 1 < args.length) password = args[++i];
  else if (!target) target = args[i];
}

if (!target) {
  console.log('用法: node check.mjs <文件或目录> [--password PW]');
  process.exit(1);
}

const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter(f => /\.(png|jpe?g|webp|heic|bmp|gif)$/i.test(f)).map(f => path.join(target, f))
  : [target];

if (!files.length) { console.log('目录里没有图片文件'); process.exit(1); }

const results = files.map(f => inspect(f, { password }));

console.log('─'.repeat(64));
console.log('汇总');
const ok = results.filter(r => r.verdict === 'LOSSLESS' || r.verdict === 'DECODED_NO_REF');
const bad = results.filter(r => ['LOSSY_CONTAINER', 'CORRUPTED', 'DECODE_FAILED'].includes(r.verdict));
for (const r of results) console.log('  ' + r.file.padEnd(28) + r.fmt.padEnd(10) + String(r.size).padEnd(10) + ' B   ' + r.verdict);

console.log('');
if (ok.length && !bad.length) {
  console.log('▶ 判定: 通道无损。像素直编码方案可行。');
} else if (bad.length) {
  console.log('▶ 判定: 通道已破坏数据（或部分文件解码失败）。');
  const hasContainer = bad.some(r => r.verdict === 'LOSSY_CONTAINER');
  if (hasContainer) console.log('  原因: 图片被转成有损格式 -> 需改走高冗余编码。');
  else console.log('  原因: 容器仍是 PNG 但像素被改或头损坏 -> 可用 mobile/diff.mjs 对比字节差异。');
}
