#!/usr/bin/env node
// test.mjs — 全端编解码与交叉验证测试套件（Node + core.mjs + HTML 同步 + Android 产物交叉解码）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  encodePng,
  decodePng,
  pack,
  unpack,
  toRgbStream,
  encodeFilePartsSync,
  restoreImageSync,
  sanitizeFilename,
  F3_COMPRESSED,
  F3_ENCRYPTED,
  F3_CHUNKED,
} from './file2img.mjs';
import {
  decodeFileBytes,
  encodeFileToPartsAsync,
  assembleChunksAsync,
  buildPngFromIdat,
  buildRawScanlines,
} from './mobile/core.mjs';
import { renderHtml } from './mobile/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2i_test_'));

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeCustomPng({ w, h, colorType, bitDepth, rawScanlines, palette = null }) {
  const crcTbl = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  const crc = b => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = crcTbl[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (palette) parts.push(chunk('PLTE', palette));
  parts.push(chunk('IDAT', zlib.deflateSync(rawScanlines, { level: 9 })));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

try {
  // 1. 验证 mobile/index.html 与 mobile/core.mjs 内联代码同步
  const diskHtml = fs.readFileSync(path.join(HERE, 'mobile/index.html'), 'utf8');
  assert.equal(diskHtml, renderHtml(), 'mobile/index.html 内联 core.mjs 未同步');
  console.log('PASS  1. index.html <-> core.mjs 内联同步一致');

  // 2. F2I1 旧格式 & 调色板 PNG 解码 (probe_small.png / palette.png)
  const probeBuf = fs.readFileSync(path.join(HERE, 'android/app/src/test/resources/probe_small.png'));
  const probeNode = unpack(toRgbStream(decodePng(probeBuf)));
  const probeWeb = await decodeFileBytes(new Uint8Array(probeBuf));
  assert.equal(probeNode.version, 1);
  assert.equal(sha256(probeNode.payload), sha256(probeWeb.payload));

  const palBuf = fs.readFileSync(path.join(HERE, 'android/app/src/test/resources/palette.png'));
  const palNode = unpack(toRgbStream(decodePng(palBuf)));
  const palWeb = await decodeFileBytes(new Uint8Array(palBuf));
  assert.equal(palNode.name, '测试文件.txt');
  assert.equal(palWeb.name, '测试文件.txt');
  assert.equal(sha256(palNode.payload), sha256(palWeb.payload));
  console.log('PASS  2. F2I1 & 调色板 PNG (ctype=3) Node/Web 双端解码一致');

  // 3. 灰度 PNG (ctype=0) & 灰度+Alpha PNG (ctype=4) 像素映射修复验证
  const grayScan = Buffer.from([0, 10, 20, 0, 30, 40]); // 2x2 灰度
  const grayPng = makeCustomPng({ w: 2, h: 2, colorType: 0, bitDepth: 8, rawScanlines: grayScan });
  const grayNode = decodePng(grayPng);
  const grayWeb = await decodeFileBytes(new Uint8Array(grayPng)).catch(() => null);
  assert.deepEqual([...grayNode.rgb], [10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40]);
  assert.equal(grayWeb, null); // 非 F2I 载荷应拒收

  const gaScan = Buffer.from([0, 77, 255, 88, 128]); // 2x1 灰度+Alpha
  const gaPng = makeCustomPng({ w: 2, h: 1, colorType: 4, bitDepth: 8, rawScanlines: gaScan });
  assert.deepEqual([...decodePng(gaPng).rgb], [77, 77, 77, 88, 88, 88]);
  console.log('PASS  3. 灰度 (ctype=0/4) PNG RGB 复制修复验证通过');

  // 4. F2I2 + F2I3 (压缩 + AES-256-GCM 加密) Node <-> Web 双向互通
  const sampleText = Buffer.from('跨端测试数据 F2I3 AES-GCM + Deflate! '.repeat(250), 'utf8');
  const pw = 'pass-口令-999';
  const nodeParts = encodeFilePartsSync(sampleText, '测试文档.md', { compress: true, password: pw });
  assert.equal(nodeParts.length, 1);
  assert.ok((nodeParts[0].flags & F3_COMPRESSED) && (nodeParts[0].flags & F3_ENCRYPTED));

  // Node -> Web 解码（正确与错误口令）
  await assert.rejects(() => decodeFileBytes(nodeParts[0].png, 'wrong-pw'));
  const webDec = await decodeFileBytes(nodeParts[0].png, pw);
  assert.equal(webDec.name, '测试文档.md');
  assert.equal(sha256(webDec.payload), sha256(sampleText));

  // Web -> Node 解码
  const webParts = await encodeFileToPartsAsync(new Uint8Array(sampleText), '网页编码.txt', { compress: true, password: pw });
  const nodeDec = unpack(toRgbStream(decodePng(webParts[0].png)), { password: pw });
  assert.equal(nodeDec.name, '网页编码.txt');
  assert.equal(sha256(nodeDec.payload), sha256(sampleText));
  console.log('PASS  4. F2I3 压缩+加密 Node <-> Web 双向互通');

  // 5. 大文件分片 & 乱序还原 & 同名去重 & 文件名清洗
  const bigBin = crypto.randomBytes(12000);
  const splitParts = encodeFilePartsSync(bigBin, '../../evil:name?.bin', {
    compress: true,
    password: pw,
    maxPartBytes: 3500,
  });
  assert.ok(splitParts.length >= 4 && (splitParts[0].flags & F3_CHUNKED));

  const outDir = path.join(tmpDir, 'restore_out');
  const partFiles = splitParts.map((p, idx) => {
    const fp = path.join(tmpDir, `p_${idx}.png`);
    fs.writeFileSync(fp, p.png);
    return fp;
  }).reverse(); // 倒序投入

  for (let i = 0; i < partFiles.length - 1; i++) {
    const r = restoreImageSync(partFiles[i], outDir, { password: pw });
    assert.equal(r.status, 'PART');
  }
  const finalR = restoreImageSync(partFiles[partFiles.length - 1], outDir, { password: pw });
  assert.equal(finalR.status, 'OK');
  assert.equal(path.basename(finalR.dest), 'evil_name_.bin');
  assert.equal(sha256(fs.readFileSync(finalR.dest)), sha256(bigBin));

  // 同名再次还原不应覆盖，应生成 "evil_name_ (1).bin"
  const singlePng = encodeFilePartsSync(Buffer.from('second'), 'evil_name_.bin', { compress: false })[0].png;
  const singlePath = path.join(tmpDir, 'dup.png');
  fs.writeFileSync(singlePath, singlePng);
  const dupR = restoreImageSync(singlePath, outDir);
  assert.equal(path.basename(dupR.dest), 'evil_name_ (1).bin');
  assert.equal(sanitizeFilename('..\\a/b<c>.txt'), 'b_c_.txt');

  // Web 端分片合并测试
  const decodedWebChunks = [];
  for (const pf of partFiles) {
    const info = await decodeFileBytes(new Uint8Array(fs.readFileSync(pf)), pw);
    decodedWebChunks[info.partIndex] = info.body;
  }
  const assembledWeb = await assembleChunksAsync(decodedWebChunks, splitParts[0].flags, pw);
  assert.equal(sha256(assembledWeb), sha256(bigBin));
  console.log('PASS  5. 多分片乱序还原、同名防覆盖、文件名清洗验证通过');

  // 6. LSB 隐写 F2I2 & F2I3 (压缩+加密) embed / extract 往返
  const carrierPath = path.join(HERE, 'android/app/src/test/resources/carrier.png');
  const secretSrc = path.join(tmpDir, 'secret.txt');
  const stegoF2I2 = path.join(tmpDir, 'stego2.png');
  const stegoF2I3 = path.join(tmpDir, 'stego3.png');
  const extOut2 = path.join(tmpDir, 'ext2.txt');
  const extOut3 = path.join(tmpDir, 'ext3.txt');
  fs.writeFileSync(secretSrc, 'LSB stego payload check 2026! '.repeat(20), 'utf8');

  execFileSync(process.execPath, [path.join(HERE, 'file2img.mjs'), 'embed', carrierPath, secretSrc, stegoF2I2], { stdio: 'pipe' });
  execFileSync(process.execPath, [path.join(HERE, 'file2img.mjs'), 'extract', stegoF2I2, extOut2], { stdio: 'pipe' });
  assert.equal(sha256(fs.readFileSync(extOut2)), sha256(fs.readFileSync(secretSrc)));

  execFileSync(process.execPath, [path.join(HERE, 'file2img.mjs'), 'embed', carrierPath, secretSrc, stegoF2I3, '--compress', '--password', 'stego-pw'], { stdio: 'pipe' });
  execFileSync(process.execPath, [path.join(HERE, 'file2img.mjs'), 'extract', stegoF2I3, extOut3, '--password', 'stego-pw'], { stdio: 'pipe' });
  assert.equal(sha256(fs.readFileSync(extOut3)), sha256(fs.readFileSync(secretSrc)));
  console.log('PASS  6. LSB 隐写 embed/extract (F2I2 & F2I3) 往返验证通过');

  // 7. Kotlin 单元测试产物交叉验证
  const ktF2 = path.join(HERE, 'android/app/build/roundtrip.kt.png');
  const ktF3 = path.join(HERE, 'android/app/build/roundtrip_f2i3.kt.png');
  if (fs.existsSync(ktF2)) {
    const r2 = unpack(toRgbStream(decodePng(fs.readFileSync(ktF2))));
    assert.equal(r2.name, '测试.txt');
    assert.equal(r2.payload.length, 5000);
    console.log('PASS  7a. Kotlin -> Node/Web F2I2 交叉验证通过');
  }
  if (fs.existsSync(ktF3)) {
    const r3 = unpack(toRgbStream(decodePng(fs.readFileSync(ktF3))), { password: 'pw-口令-2026' });
    const r3w = await decodeFileBytes(new Uint8Array(fs.readFileSync(ktF3)), 'pw-口令-2026');
    assert.equal(r3.name, '密文.txt');
    assert.equal(sha256(r3.payload), sha256(r3w.payload));
    assert.ok(r3.payload.toString('utf8').includes('F2I3 跨端压缩加密验证内容！'));
    console.log('PASS  7b. Kotlin -> Node/Web F2I3 (压缩+AES-GCM) 交叉验证通过');
  }

  // 8. restore-daemon 模式测试
  const daemonOut = path.join(tmpDir, 'daemon_out');
  const dPng = path.join(tmpDir, 'daemon_in.png');
  fs.writeFileSync(dPng, encodeFilePartsSync(Buffer.from('daemon-ok'), '守护测试.txt')[0].png);
  const b64In = 'B64:' + Buffer.from(dPng, 'utf8').toString('base64') + '\nQUIT\n';
  const daemonStdout = execFileSync(process.execPath, [path.join(HERE, 'file2img.mjs'), 'restore-daemon', daemonOut], {
    input: b64In,
    encoding: 'utf8',
  });
  const lines = daemonStdout.trim().split(/\r?\n/);
  assert.equal(lines[0], 'READY');
  assert.ok(lines[1].startsWith('OK:'));
  const restoredPath = Buffer.from(lines[1].slice(3), 'base64').toString('utf8');
  assert.equal(fs.readFileSync(restoredPath, 'utf8'), 'daemon-ok');
  console.log('PASS  8. restore-daemon 常驻解码管道验证通过');

  // 9. check.mjs CLI 验证（在其他工作目录下运行也应正常工作）
  const checkOut = execFileSync(process.execPath, [path.join(HERE, 'check.mjs'), palBuf ? path.join(HERE, 'android/app/src/test/resources/palette.png') : ''], {
    cwd: tmpDir,
    encoding: 'utf8',
  });
  assert.ok(checkOut.includes('DECODED_NO_REF'));
  console.log('PASS  9. check.mjs 跨目录直接执行验证通过');

  // 10. 大于 5 MB 文件自动分片并确保单张 PNG < 5 MB
  const big55 = crypto.randomBytes(5_500_000);
  const bigParts = encodeFilePartsSync(big55, 'over5mb.bin', { compress: true });
  assert.ok(bigParts.length >= 2, '5.5MB 不可压缩文件应拆分成多片');
  for (const p of bigParts) {
    assert.ok(p.png.length < 5_000_000, `单张 PNG (${p.png.length} B) 应小于 5 MB`);
  }
  const bigOutDir = path.join(tmpDir, 'big55_out');
  let bigRestored = null;
  for (let i = 0; i < bigParts.length; i++) {
    const fp = path.join(tmpDir, `big_${i}.png`);
    fs.writeFileSync(fp, bigParts[i].png);
    bigRestored = restoreImageSync(fp, bigOutDir);
  }
  assert.equal(bigRestored.status, 'OK');
  assert.equal(sha256(fs.readFileSync(bigRestored.dest)), sha256(big55));
  console.log(`PASS 10. 5.5MB 大文件自动分片 (${bigParts.length} 张, 每张 < 5MB) 还原校验通过`);

  console.log('\nALL TESTS PASSED');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
