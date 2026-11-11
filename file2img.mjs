#!/usr/bin/env node
// file2img.mjs — 任意文件 <-> 无损 PNG 双向转换 + LSB 隐写（零依赖，仅 Node 内置模块）
// 用法:
//   node file2img.mjs encode  <in> <out.png> [--cols N] [--no-compress] [--password PW] [--part-mb N]
//   node file2img.mjs decode  <in.png...> <out> [--password PW]
//   node file2img.mjs info    <in.png>
//   node file2img.mjs embed   <carrier.png> <payload> <out.png> [--compress] [--password PW]
//   node file2img.mjs extract <in.png> <out> [--password PW]
//   node file2img.mjs restore <in.png> <outDir> [--password PW]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  MAGIC1,
  MAGIC2,
  MAGIC3,
  HEAD1,
  HEAD2,
  HEAD3,
  CHUNK_HEAD,
  F3_COMPRESSED,
  F3_ENCRYPTED,
  F3_CHUNKED,
  DEFAULT_PART_BYTES,
  crc32,
  sanitizeFilename,
  parsePngChunks,
  rawPixelsToRgb,
  buildRawScanlines,
  buildPngFromIdat,
  buildRgbLayout,
  packF2I2,
  packF2I3Part,
  inspectPayloadHeader,
  unpackRawBody,
  bytesToHex,
} from './mobile/core.mjs';

const MAGIC = Buffer.from(MAGIC1, 'ascii');
const HEAD = HEAD1;
const PBKDF2_ITERS = 100000;

/* ---------------- Node 同步加密与压缩 ---------------- */

function encryptSync(buf, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(String(password), salt, PBKDF2_ITERS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, enc, tag]);
}

function decryptSync(buf, password) {
  if (!password) throw new Error('该图片已加密，需要提供解密口令 (--password)');
  if (buf.length < 28 + 16) throw new Error('加密数据长度异常');
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(28, buf.length - 16);
  const key = crypto.pbkdf2Sync(String(password), salt, PBKDF2_ITERS, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('解密失败：口令错误或数据被篡改');
  }
}

function assembleStreamSync(partBodies, flags, password) {
  let stream = partBodies.length === 1 ? Buffer.from(partBodies[0]) : Buffer.concat(partBodies.map(b => Buffer.from(b)));
  if ((flags & F3_ENCRYPTED) !== 0) stream = decryptSync(stream, password);
  if ((flags & F3_COMPRESSED) !== 0) stream = zlib.inflateSync(stream);
  return stream;
}

/* ---------------- PNG 读写（同步） ---------------- */

function encodePng(rgb, w, h) {
  const raw = buildRawScanlines(rgb, w, h);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.from(buildPngFromIdat(w, h, idat));
}

function decodePng(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const { w, h, depth, ctype, palette, compressed } = parsePngChunks(u8);
  const raw = zlib.inflateSync(compressed);
  const { rgb } = rawPixelsToRgb(raw, w, h, depth, ctype, palette);
  const data = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength);
  return { w, h, depth, ctype, ch: 3, data, rgb: data };
}

function toRgbStream(img) {
  return Buffer.from(img.rgb || img.data);
}

/* ---------------- 载荷封装与解包（同步） ---------------- */

function pack(payload, name, opts = {}) {
  const src = Buffer.from(payload);
  const compress = !!opts.compress;
  const password = opts.password || '';
  if (!compress && !password) {
    return Buffer.from(packF2I2(src, name));
  }
  let stream = src;
  let flags = 0;
  if (compress) {
    const deflated = zlib.deflateSync(stream, { level: 9 });
    if (deflated.length < stream.length) {
      stream = deflated;
      flags |= F3_COMPRESSED;
    }
  }
  if (password) {
    stream = encryptSync(stream, password);
    flags |= F3_ENCRYPTED;
  }
  if (flags === 0) return Buffer.from(packF2I2(stream, name));
  const nameBytes = name ? Buffer.from(String(name), 'utf8') : Buffer.alloc(0);
  return Buffer.from(packF2I3Part({ flags, nameBytes, body: stream }));
}

function unpack(buf, opts = {}) {
  const info = unpackRawBody(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  if (info.chunked) {
    throw new Error('这是分片载荷 (' + (info.partIndex + 1) + '/' + info.partTotal + ')，请使用 restore 汇聚全部分片');
  }
  const payload = assembleStreamSync([info.body], info.flags, opts.password || '');
  return {
    name: info.name,
    payload,
    version: info.version,
    flags: info.flags,
    compressed: info.compressed,
    encrypted: info.encrypted,
    chunked: false,
  };
}

function encodeFilePartsSync(payload, name, opts = {}) {
  const src = Buffer.from(payload);
  const compress = opts.compress !== false;
  const password = opts.password || '';
  const maxPartBytes = opts.maxPartBytes || DEFAULT_PART_BYTES;
  const cols = opts.cols || 0;

  let stream = src;
  let flags = 0;
  if (compress) {
    const deflated = zlib.deflateSync(stream, { level: 9 });
    if (deflated.length < stream.length) {
      stream = deflated;
      flags |= F3_COMPRESSED;
    }
  }
  if (password) {
    stream = encryptSync(stream, password);
    flags |= F3_ENCRYPTED;
  }

  const nameBytes = name ? Buffer.from(String(name), 'utf8') : Buffer.alloc(0);
  if (stream.length <= maxPartBytes) {
    const packed = flags === 0
      ? Buffer.from(packF2I2(stream, name))
      : Buffer.from(packF2I3Part({ flags, nameBytes, body: stream }));
    const { w, h, rgb } = buildRgbLayout(packed, cols);
    const png = encodePng(rgb, w, h);
    return [{ png, w, h, partIndex: 0, partTotal: 1, flags, transferIdHex: '', packedSize: packed.length }];
  }

  flags |= F3_CHUNKED;
  const partTotal = Math.ceil(stream.length / maxPartBytes);
  if (partTotal > 65535) throw new Error('分片数量超过上限 (65535)');
  const transferId = crypto.randomBytes(8);
  const transferIdHex = bytesToHex(transferId);
  const parts = [];

  for (let i = 0; i < partTotal; i++) {
    const start = i * maxPartBytes;
    const end = Math.min(stream.length, start + maxPartBytes);
    const chunkBody = stream.subarray(start, end);
    const packed = Buffer.from(packF2I3Part({
      flags,
      nameBytes,
      body: chunkBody,
      transferId,
      partIndex: i,
      partTotal,
    }));
    const { w, h, rgb } = buildRgbLayout(packed, cols);
    const png = encodePng(rgb, w, h);
    parts.push({ png, w, h, partIndex: i, partTotal, flags, transferIdHex, packedSize: packed.length });
  }
  return parts;
}

/* ---------------- 文件名去重与分片清理 ---------------- */

function uniqueDestPath(outDir, filename) {
  const safe = sanitizeFilename(filename);
  let candidate = path.join(outDir, safe);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  for (let n = 1; n < 10000; n++) {
    candidate = path.join(outDir, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(outDir, `${stem}_${Date.now()}${ext}`);
}

function cleanupStaleChunks(chunkRoot) {
  if (!fs.existsSync(chunkRoot)) return;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const entry of fs.readdirSync(chunkRoot)) {
    const dir = path.join(chunkRoot, entry);
    try {
      const st = fs.statSync(dir);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }
}

function restoreImageSync(pngPath, outDir, opts = {}) {
  const img = decodePng(fs.readFileSync(pngPath));
  const info = unpackRawBody(toRgbStream(img));
  fs.mkdirSync(outDir, { recursive: true });

  if (!info.chunked) {
    const payload = assembleStreamSync([info.body], info.flags, opts.password || '');
    const dest = uniqueDestPath(outDir, info.name);
    fs.writeFileSync(dest, payload);
    return { status: 'OK', dest, size: payload.length, name: path.basename(dest), info };
  }

  // 分片暂存与汇聚
  const chunkRoot = path.join(outDir, '.f2i_chunks');
  cleanupStaleChunks(chunkRoot);
  const dir = path.join(chunkRoot, info.transferIdHex);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `part_${info.partIndex}.bin`), info.body);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    name: info.name,
    flags: info.flags,
    partTotal: info.partTotal,
  }));

  const bodies = [];
  let received = 0;
  for (let i = 0; i < info.partTotal; i++) {
    const p = path.join(dir, `part_${i}.bin`);
    if (fs.existsSync(p)) {
      received++;
      bodies.push(fs.readFileSync(p));
    }
  }

  if (received < info.partTotal) {
    return {
      status: 'PART',
      partIndex: info.partIndex,
      partTotal: info.partTotal,
      received,
      name: info.name,
      transferIdHex: info.transferIdHex,
    };
  }

  const payload = assembleStreamSync(bodies, info.flags, opts.password || '');
  const dest = uniqueDestPath(outDir, info.name);
  fs.writeFileSync(dest, payload);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    if (fs.readdirSync(chunkRoot).length === 0) fs.rmdirSync(chunkRoot);
  } catch { /* ignore */ }
  return { status: 'OK', dest, size: payload.length, name: path.basename(dest), partTotal: info.partTotal, info };
}

/* ---------------- CLI 命令实现 ---------------- */

function doEncode(inPath, outPath, opts) {
  const payload = fs.readFileSync(inPath);
  const parts = encodeFilePartsSync(payload, path.basename(inPath), opts);
  console.log('[encode] ' + inPath + '  (' + payload.length + ' B)');
  if (parts.length === 1) {
    const p = parts[0];
    fs.writeFileSync(outPath, p.png);
    console.log('[encode] -> ' + outPath + '  ' + p.w + 'x' + p.h + '  PNG ' + p.png.length + ' B' +
      (p.flags & F3_COMPRESSED ? '  [已压缩]' : '') +
      (p.flags & F3_ENCRYPTED ? '  [已加密]' : ''));
    return { w: p.w, h: p.h, size: p.png.length, parts: [outPath] };
  }
  const ext = path.extname(outPath) || '.png';
  const stem = outPath.slice(0, outPath.length - (path.extname(outPath).length));
  const outFiles = [];
  for (const p of parts) {
    const fp = `${stem}.part${p.partIndex + 1}of${p.partTotal}${ext}`;
    fs.writeFileSync(fp, p.png);
    outFiles.push(fp);
    console.log(`[encode] [${p.partIndex + 1}/${p.partTotal}] -> ${fp}  ${p.w}x${p.h}  PNG ${p.png.length} B`);
  }
  return { parts: outFiles };
}

function doDecode(inPaths, outPath, opts) {
  if (inPaths.length === 1) {
    const img = decodePng(fs.readFileSync(inPaths[0]));
    const res = unpack(toRgbStream(img), opts);
    fs.writeFileSync(outPath, res.payload);
    console.log('[decode] ' + inPaths[0] + '  ' + img.w + 'x' + img.h + '  ctype=' + img.ctype);
    console.log('[decode] 原名: ' + (res.name || '(无)') + '  版本: F2I' + res.version);
    console.log('[decode] -> ' + outPath + '  ' + res.payload.length + ' B  CRC32 OK');
    return res.payload.length;
  }

  // 多分片文件一次性解码汇聚
  const byIndex = new Map();
  let flags = null;
  let total = 0;
  let transferId = '';
  let name = '';
  for (const p of inPaths) {
    const img = decodePng(fs.readFileSync(p));
    const info = unpackRawBody(toRgbStream(img));
    if (!info.chunked) throw new Error(p + ' 不是分片载荷');
    if (flags === null) {
      flags = info.flags;
      total = info.partTotal;
      transferId = info.transferIdHex;
      name = info.name;
    } else if (info.transferIdHex !== transferId) {
      throw new Error(p + ' 不属于同一批次分片 (' + info.transferIdHex + ' != ' + transferId + ')');
    }
    byIndex.set(info.partIndex, info.body);
  }
  if (byIndex.size !== total) {
    throw new Error(`分片不完整: 需要 ${total} 个，实得 ${byIndex.size} 个`);
  }
  const bodies = [];
  for (let i = 0; i < total; i++) bodies.push(byIndex.get(i));
  const payload = assembleStreamSync(bodies, flags, opts.password || '');
  fs.writeFileSync(outPath, payload);
  console.log(`[decode] 合并 ${total} 个分片 (${name || '(无)'}) -> ${outPath}  ${payload.length} B  OK`);
  return payload.length;
}

function doRestore(pngPath, outDir, opts) {
  const res = restoreImageSync(pngPath, outDir, opts);
  if (res.status === 'PART') {
    process.stdout.write(
      `PART:${res.received}/${res.partTotal}:${Buffer.from(res.name || '', 'utf8').toString('base64')}\n`
    );
    return null;
  }
  // 纯 ASCII 输出，避免任何控制台编码问题
  process.stdout.write('OK:' + Buffer.from(res.dest, 'utf8').toString('base64') + '\n');
  return res.dest;
}

function doRestoreDaemon(outDir, opts) {
  fs.mkdirSync(outDir, { recursive: true });
  process.stdout.write('READY\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    const raw = line.trim();
    if (!raw) return;
    if (raw === 'QUIT') { rl.close(); return; }
    const pngPath = raw.startsWith('B64:')
      ? Buffer.from(raw.slice(4), 'base64').toString('utf8')
      : raw;
    try {
      const res = restoreImageSync(pngPath, outDir, opts);
      if (res.status === 'PART') {
        process.stdout.write(
          `PART:${res.received}/${res.partTotal}:${Buffer.from(res.name || '', 'utf8').toString('base64')}\n`
        );
      } else {
        process.stdout.write('OK:' + Buffer.from(res.dest, 'utf8').toString('base64') + '\n');
      }
    } catch (e) {
      const msg = e.message || String(e);
      const tag = /解密|口令/.test(msg) ? 'ERR' : 'SKIP';
      process.stdout.write(tag + ':' + Buffer.from(msg, 'utf8').toString('base64') + '\n');
    }
  });
}

function doInfo(inPath) {
  const img = decodePng(fs.readFileSync(inPath));
  const bytes = toRgbStream(img);
  console.log('尺寸: ' + img.w + 'x' + img.h + '  颜色类型: ' + img.ctype + '  位深: ' + img.depth);
  console.log('裸容量(RGB): ' + bytes.length + ' B = ' + (bytes.length / 1048576).toFixed(2) + ' MB');
  console.log('可用载荷(F2I2): ' + Math.max(0, bytes.length - HEAD2) + ' B');
  let has = false;
  try {
    const info = inspectPayloadHeader(bytes);
    const body = bytes.subarray(info.bodyOffset, info.bodyOffset + info.bodyLen);
    const real = crc32(body);
    if (real !== info.bodyCrc) throw new Error('CRC32 校验失败');
    has = true;
    const tags = [];
    if (info.compressed) tags.push('压缩');
    if (info.encrypted) tags.push('加密');
    if (info.chunked) tags.push(`分片 ${info.partIndex + 1}/${info.partTotal} (batch=${info.transferIdHex})`);
    console.log(
      `内含载荷: 是 (F2I${info.version})，载荷体 ${info.bodyLen} B，原名 ${info.name || '(无)'}` +
      (tags.length ? '  [' + tags.join(', ') + ']' : '')
    );
  } catch (e) {
    console.log('内含载荷: 否 (' + e.message + ')');
  }
  return has;
}

function doEmbed(carrierPath, payloadPath, outPath, opts = {}) {
  const img = decodePng(fs.readFileSync(carrierPath));
  const bytes = toRgbStream(img);
  const packed = pack(fs.readFileSync(payloadPath), path.basename(payloadPath), opts);
  const cap = Math.floor(bytes.length / 8);
  if (packed.length > cap) throw new Error('载体容量不足: 需要 ' + packed.length + ' B，最多 ' + cap + ' B');
  for (let i = 0; i < packed.length; i++) {
    const b = packed[i];
    for (let k = 0; k < 8; k++) {
      const idx = i * 8 + k;
      bytes[idx] = (bytes[idx] & 0xfe) | ((b >> (7 - k)) & 1);
    }
  }
  const png = encodePng(bytes, img.w, img.h);
  fs.writeFileSync(outPath, png);
  console.log('[embed] 载体 ' + img.w + 'x' + img.h + ' 容量 ' + cap + ' B，嵌入 ' + packed.length + ' B');
  console.log('[embed] -> ' + outPath + '  ' + png.length + ' B');
  return { cap, used: packed.length };
}

function readLsbBytes(rgbBytes, count, byteOffset = 0) {
  const out = Buffer.alloc(count);
  for (let i = 0; i < count; i++) {
    let v = 0;
    const base = (byteOffset + i) * 8;
    for (let k = 0; k < 8; k++) v = (v << 1) | (rgbBytes[base + k] & 1);
    out[i] = v;
  }
  return out;
}

function doExtract(inPath, outPath, opts = {}) {
  const img = decodePng(fs.readFileSync(inPath));
  const bytes = toRgbStream(img);
  const cap = Math.floor(bytes.length / 8);
  if (cap < HEAD1) throw new Error('图片容量过小，没有隐写载荷');

  // 先提取固定头部最大长度（27 字节可覆盖 F2I1/F2I2/F2I3 含分片头）
  const probeLen = Math.min(cap, HEAD3 + CHUNK_HEAD);
  const head = readLsbBytes(bytes, probeLen);
  const magic = head.subarray(0, 4).toString('ascii');

  let total;
  if (magic === MAGIC1) {
    total = HEAD1 + head.readUInt32BE(4);
  } else if (magic === MAGIC2) {
    if (probeLen < HEAD2) throw new Error('隐写头不完整');
    total = HEAD2 + head.readUInt16BE(4) + head.readUInt32BE(6);
  } else if (magic === MAGIC3) {
    if (probeLen < HEAD3) throw new Error('隐写头不完整');
    const flags = head[4];
    const fixedHead = HEAD3 + ((flags & F3_CHUNKED) ? CHUNK_HEAD : 0);
    if (probeLen < fixedHead) throw new Error('F2I3 分片头不完整');
    total = fixedHead + head.readUInt16BE(5) + head.readUInt32BE(7);
  } else {
    throw new Error('没有 F2I1/F2I2/F2I3 隐写载荷');
  }

  if (total > cap) throw new Error('隐写载荷长度越界: 需要 ' + total + ' B，容量 ' + cap + ' B');
  const packed = readLsbBytes(bytes, total);
  const { name, payload } = unpack(packed, opts);
  fs.writeFileSync(outPath, payload);
  console.log('[extract] 原名: ' + (name || '(无)') + ' -> ' + outPath + '  ' + payload.length + ' B  CRC32 OK');
  return payload.length;
}

/* ---------------- 库导出 ---------------- */
export {
  encodePng,
  decodePng,
  pack,
  unpack,
  toRgbStream,
  crc32,
  sanitizeFilename,
  inspectPayloadHeader,
  encodeFilePartsSync,
  restoreImageSync,
  HEAD,
  HEAD1,
  HEAD2,
  HEAD3,
  MAGIC,
  MAGIC1,
  MAGIC2,
  MAGIC3,
  F3_COMPRESSED,
  F3_ENCRYPTED,
  F3_CHUNKED,
  DEFAULT_PART_BYTES,
};

/* ---------------- CLI 参数解析 ---------------- */

function parseCli(argv) {
  const pos = [];
  const opts = { compress: true, password: '', cols: 0, maxPartBytes: DEFAULT_PART_BYTES };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-compress') opts.compress = false;
    else if (arg === '--compress') opts.compress = true;
    else if (arg === '--cols' && i + 1 < argv.length) opts.cols = parseInt(argv[++i], 10) || 0;
    else if (arg === '--password' && i + 1 < argv.length) opts.password = argv[++i];
    else if (arg === '--part-mb' && i + 1 < argv.length) {
      const mb = parseFloat(argv[++i]);
      if (mb > 0) opts.maxPartBytes = Math.floor(mb * 1000 * 1000);
    } else pos.push(arg);
  }
  return { pos, opts };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { pos, opts } = parseCli(process.argv.slice(2));
  const [cmd, a, b, c] = pos;
  try {
    if (cmd === 'encode' && a && b) doEncode(a, b, opts);
    else if (cmd === 'decode' && pos.length >= 3) doDecode(pos.slice(1, -1), pos[pos.length - 1], opts);
    else if (cmd === 'info' && a) doInfo(a);
    else if (cmd === 'restore' && a && b) doRestore(a, b, opts);
    else if (cmd === 'restore-daemon' && a) doRestoreDaemon(a, opts);
    else if (cmd === 'embed' && a && b && c) doEmbed(a, b, c, { ...opts, compress: process.argv.includes('--compress') });
    else if (cmd === 'extract' && a && b) doExtract(a, b, opts);
    else {
      console.log('用法:');
      console.log('  node file2img.mjs encode  <in> <out.png> [--cols N] [--no-compress] [--password PW] [--part-mb N]');
      console.log('  node file2img.mjs decode  <in.png...> <out> [--password PW]');
      console.log('  node file2img.mjs info    <in.png>');
      console.log('  node file2img.mjs embed   <carrier.png> <payload> <out.png> [--compress] [--password PW]');
      console.log('  node file2img.mjs extract <in.png> <out> [--password PW]');
      console.log('  node file2img.mjs restore <in.png> <outDir> [--password PW]');
      process.exit(1);
    }
  } catch (e) {
    console.error('[error] ' + e.message);
    process.exit(2);
  }
}
