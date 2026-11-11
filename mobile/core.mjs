// core.mjs — 零依赖编解码核心（Node、浏览器、Web Worker 通用）

export const MAGIC1 = 'F2I1';
export const MAGIC2 = 'F2I2';
export const MAGIC3 = 'F2I3';
export const HEAD1 = 12;
export const HEAD2 = 14;
export const HEAD3 = 15;
export const CHUNK_HEAD = 12;

export const F3_COMPRESSED = 0x01;
export const F3_ENCRYPTED = 0x02;
export const F3_CHUNKED = 0x04;

export const DEFAULT_PART_BYTES = Math.floor(4.7 * 1000 * 1000); // 单图载荷上限 ~4.7 MB（确保 PNG < 5 MB）
const PBKDF2_ITERS = 100000;

const CRC_TBL = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

export function crc32(buf, start = 0, end = buf.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function sanitizeFilename(raw) {
  const s = String(raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  if (!s || s === '.' || s === '..') return 'decoded_' + Date.now() + '.bin';
  return s;
}

export function bytesToHex(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concatBytes(parts, total) {
  if (total === undefined) {
    total = 0;
    for (const p of parts) total += p.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* ---------------- PNG 底层解析与构建 ---------------- */

export function parsePngChunks(u8) {
  if (
    u8.length < 8 ||
    u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47 ||
    u8[4] !== 0x0d || u8[5] !== 0x0a || u8[6] !== 0x1a || u8[7] !== 0x0a
  ) {
    throw new Error('不是 PNG 文件');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 8;
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  let ihdrSeen = false;
  let iendSeen = false;
  let palette = null;
  const idat = [];
  let idatLen = 0;

  while (off + 8 <= u8.length) {
    const len = dv.getUint32(off);
    if (off + 12 + len > u8.length) throw new Error('PNG 数据块越界（文件可能被截断）');
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    if (type === 'IHDR') {
      if (len < 13) throw new Error('PNG IHDR 块损坏');
      w = dv.getUint32(off + 8);
      h = dv.getUint32(off + 12);
      depth = u8[off + 16];
      ctype = u8[off + 17];
      interlace = u8[off + 20];
      ihdrSeen = true;
    } else if (type === 'PLTE') {
      palette = u8.subarray(off + 8, off + 8 + len);
    } else if (type === 'IDAT') {
      const d = u8.subarray(off + 8, off + 8 + len);
      idat.push(d);
      idatLen += d.length;
    } else if (type === 'IEND') {
      iendSeen = true;
      break;
    }
    off += 12 + len;
  }

  if (!ihdrSeen || w <= 0 || h <= 0) throw new Error('PNG 尺寸信息缺失或异常');
  if (!iendSeen) throw new Error('PNG 文件不完整（缺少 IEND 结束块）');
  if (interlace) throw new Error('不支持隔行扫描 PNG');
  if (!idatLen) throw new Error('PNG 缺少 IDAT 图像数据');

  return { w, h, depth, ctype, interlace, palette, compressed: concatBytes(idat, idatLen) };
}

export function unfilterScanlines(raw, stride, h, bpp) {
  const expected = (stride + 1) * h;
  if (raw.length < expected) throw new Error('PNG 像素数据不完整（期望 ' + expected + ' B，实得 ' + raw.length + ' B）');
  const out = new Uint8Array(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = (y > 0 && x >= bpp) ? out[prevStart + x - bpp] : 0;
      let r;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = (v + a) & 255; break;
        case 2: r = (v + b) & 255; break;
        case 3: r = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          r = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
          break;
        }
        default: throw new Error('PNG 滤镜类型异常: ' + ft);
      }
      out[rowStart + x] = r;
    }
  }
  return out;
}

function indexAt(row, rowStart, x, depth) {
  if (depth === 8) return row[rowStart + x];
  if (depth === 4) {
    const b = row[rowStart + (x >> 1)];
    return (x & 1) === 0 ? (b >> 4) & 0x0f : b & 0x0f;
  }
  if (depth === 2) {
    const b = row[rowStart + (x >> 2)];
    return (b >> ((3 - (x & 3)) * 2)) & 0x03;
  }
  if (depth === 1) {
    const b = row[rowStart + (x >> 3)];
    return (b >> (7 - (x & 7))) & 0x01;
  }
  throw new Error('不支持的调色板位深: ' + depth);
}

export function rawPixelsToRgb(raw, w, h, depth, ctype, palette) {
  // 调色板索引色 (ctype = 3)
  if (ctype === 3) {
    if (!palette) throw new Error('调色板 PNG 缺少 PLTE 块');
    if (depth !== 1 && depth !== 2 && depth !== 4 && depth !== 8) {
      throw new Error('不支持的调色板位深: ' + depth);
    }
    const rowBytes = Math.ceil((w * depth) / 8);
    const px = unfilterScanlines(raw, rowBytes, h, 1);
    const rgb = new Uint8Array(w * h * 3);
    let o = 0;
    for (let y = 0; y < h; y++) {
      const rowStart = y * rowBytes;
      for (let x = 0; x < w; x++) {
        const idx = indexAt(px, rowStart, x, depth);
        const p = idx * 3;
        if (p + 2 < palette.length) {
          rgb[o] = palette[p];
          rgb[o + 1] = palette[p + 1];
          rgb[o + 2] = palette[p + 2];
        }
        o += 3;
      }
    }
    return { w, h, ctype, depth, rgb };
  }

  if (depth !== 8 && depth !== 16) throw new Error('只支持 8/16bit PNG（当前 ' + depth + 'bit）');
  const chMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const ch = chMap[ctype];
  if (!ch) throw new Error('不支持的 PNG 颜色类型: ' + ctype);

  const bytesPerSample = depth === 16 ? 2 : 1;
  const bpp = ch * bytesPerSample;
  const stride = w * bpp;
  const px = unfilterScanlines(raw, stride, h, bpp);

  if (depth === 8 && ch === 3) return { w, h, ctype, depth, rgb: px };

  const rgb = new Uint8Array(w * h * 3);
  let o = 0;
  if (depth === 8) {
    for (let i = 0; i < w * h; i++) {
      const s = i * ch;
      if (ch >= 3) {
        rgb[o] = px[s];
        rgb[o + 1] = px[s + 1];
        rgb[o + 2] = px[s + 2];
      } else {
        // 灰度 / 灰度+Alpha：将单通道亮度复制到 RGB 三通道
        rgb[o] = px[s];
        rgb[o + 1] = px[s];
        rgb[o + 2] = px[s];
      }
      o += 3;
    }
  } else {
    for (let i = 0; i < w * h; i++) {
      const s = i * bpp;
      if (ch >= 3) {
        rgb[o] = px[s];
        rgb[o + 1] = px[s + 2];
        rgb[o + 2] = px[s + 4];
      } else {
        rgb[o] = px[s];
        rgb[o + 1] = px[s];
        rgb[o + 2] = px[s];
      }
      o += 3;
    }
  }
  return { w, h, ctype, depth, rgb };
}

export function buildRawScanlines(rgb, w, h) {
  const stride = w * 3;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // Filter: None
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return raw;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export function buildPngFromIdat(w, h, idat) {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // 8bit
  ihdr[9] = 2; // RGB
  return concatBytes([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]);
}

export function buildRgbLayout(packed, cols = 0) {
  const npix = Math.ceil(packed.length / 3);
  const w = cols > 0 ? cols : Math.max(1, Math.ceil(Math.sqrt(npix)));
  const h = Math.max(1, Math.ceil(npix / w));
  const rgb = new Uint8Array(w * h * 3);
  rgb.set(packed, 0);
  return { w, h, rgb };
}

/* ---------------- 载荷封装与解包 (F2I1 / F2I2 / F2I3) ---------------- */

export function packF2I2(payload, name) {
  const nb = name ? new TextEncoder().encode(String(name)) : new Uint8Array(0);
  if (nb.length > 65535) throw new Error('文件名过长');
  const out = new Uint8Array(HEAD2 + nb.length + payload.length);
  const dv = new DataView(out.buffer);
  out[0] = 0x46; out[1] = 0x32; out[2] = 0x49; out[3] = 0x32; // F2I2
  dv.setUint16(4, nb.length);
  dv.setUint32(6, payload.length);
  dv.setUint32(10, crc32(payload));
  out.set(nb, HEAD2);
  out.set(payload, HEAD2 + nb.length);
  return out;
}

export function packF2I3Part({ flags, nameBytes, body, transferId, partIndex, partTotal }) {
  if (nameBytes.length > 65535) throw new Error('文件名过长');
  const chunked = (flags & F3_CHUNKED) !== 0;
  const fixedHead = HEAD3 + (chunked ? CHUNK_HEAD : 0);
  const out = new Uint8Array(fixedHead + nameBytes.length + body.length);
  const dv = new DataView(out.buffer);
  out[0] = 0x46; out[1] = 0x32; out[2] = 0x49; out[3] = 0x33; // F2I3
  out[4] = flags & 0xff;
  dv.setUint16(5, nameBytes.length);
  dv.setUint32(7, body.length);
  dv.setUint32(11, crc32(body));
  if (chunked) {
    if (!transferId || transferId.length !== 8) throw new Error('无效的 transferId');
    out.set(transferId, HEAD3);
    dv.setUint16(HEAD3 + 8, partIndex);
    dv.setUint16(HEAD3 + 10, partTotal);
  }
  out.set(nameBytes, fixedHead);
  out.set(body, fixedHead + nameBytes.length);
  return out;
}

export function inspectPayloadHeader(bytes) {
  if (bytes.length < HEAD1) throw new Error('数据长度不足，没有载荷头');
  const m4 = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (m4 === MAGIC3) {
    if (bytes.length < HEAD3) throw new Error('F2I3 头部不完整');
    const flags = bytes[4];
    const nameLen = dv.getUint16(5);
    const bodyLen = dv.getUint32(7);
    const bodyCrc = dv.getUint32(11);
    const chunked = (flags & F3_CHUNKED) !== 0;
    const fixedHead = HEAD3 + (chunked ? CHUNK_HEAD : 0);
    if (bytes.length < fixedHead) throw new Error('F2I3 分片头不完整');

    let transferIdHex = '';
    let partIndex = 0;
    let partTotal = 1;
    if (chunked) {
      transferIdHex = bytesToHex(bytes.subarray(HEAD3, HEAD3 + 8));
      partIndex = dv.getUint16(HEAD3 + 8);
      partTotal = dv.getUint16(HEAD3 + 10);
      if (partTotal < 2 || partIndex >= partTotal) throw new Error('F2I3 分片索引异常');
    }
    const nameStart = fixedHead;
    const bodyOffset = nameStart + nameLen;
    if (bodyOffset + bodyLen > bytes.length) throw new Error('长度字段越界，图片可能被裁剪或损坏');
    const name = new TextDecoder().decode(bytes.subarray(nameStart, bodyOffset));
    return {
      version: 3,
      flags,
      compressed: (flags & F3_COMPRESSED) !== 0,
      encrypted: (flags & F3_ENCRYPTED) !== 0,
      chunked,
      transferIdHex,
      partIndex,
      partTotal,
      name,
      bodyOffset,
      bodyLen,
      bodyCrc,
      totalPackedLen: bodyOffset + bodyLen,
    };
  }

  if (m4 === MAGIC2) {
    if (bytes.length < HEAD2) throw new Error('F2I2 头部不完整');
    const nameLen = dv.getUint16(4);
    const bodyLen = dv.getUint32(6);
    const bodyCrc = dv.getUint32(10);
    const bodyOffset = HEAD2 + nameLen;
    if (bodyOffset + bodyLen > bytes.length) throw new Error('长度字段越界，图片可能被裁剪或损坏');
    const name = new TextDecoder().decode(bytes.subarray(HEAD2, bodyOffset));
    return {
      version: 2,
      flags: 0,
      compressed: false,
      encrypted: false,
      chunked: false,
      transferIdHex: '',
      partIndex: 0,
      partTotal: 1,
      name,
      bodyOffset,
      bodyLen,
      bodyCrc,
      totalPackedLen: bodyOffset + bodyLen,
    };
  }

  if (m4 === MAGIC1) {
    const bodyLen = dv.getUint32(4);
    const bodyCrc = dv.getUint32(8);
    const bodyOffset = HEAD1;
    if (bodyOffset + bodyLen > bytes.length) throw new Error('长度字段越界，图片可能被裁剪或损坏');
    return {
      version: 1,
      flags: 0,
      compressed: false,
      encrypted: false,
      chunked: false,
      transferIdHex: '',
      partIndex: 0,
      partTotal: 1,
      name: '',
      bodyOffset,
      bodyLen,
      bodyCrc,
      totalPackedLen: bodyOffset + bodyLen,
    };
  }

  throw new Error('这张图里没有本工具的载荷（找不到 F2I1/F2I2/F2I3 头）');
}

export function unpackRawBody(bytes) {
  const header = inspectPayloadHeader(bytes);
  const body = bytes.subarray(header.bodyOffset, header.bodyOffset + header.bodyLen);
  const real = crc32(body);
  if (real !== header.bodyCrc) {
    throw new Error('CRC32 校验失败: 期望 ' + header.bodyCrc.toString(16) + ' 实得 ' + real.toString(16));
  }
  return { ...header, body: new Uint8Array(body) };
}

/* ---------------- Web Streams / WebCrypto 异步辅助（浏览器 & Node 通用） ---------------- */

export async function deflateBytes(u8) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([u8]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateBytes(u8) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deriveAesKey(password, salt, usage) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error('当前环境不支持 WebCrypto（HTTP 局域网网页无法加解密，请使用 PC 端或 Android 互传助手）');
  }
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

export async function encryptBytes(u8, password) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error('当前环境不支持 WebCrypto（HTTP 局域网网页无法加密，请留空口令或使用 localhost/HTTPS）');
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, 'encrypt');
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, u8));
  return concatBytes([salt, iv, cipher], 28 + cipher.length);
}

export async function decryptBytes(u8, password) {
  if (!password) throw new Error('该图片已加密，需要提供解密口令');
  if (u8.length < 28 + 16) throw new Error('加密数据长度异常');
  const salt = u8.subarray(0, 16);
  const iv = u8.subarray(16, 28);
  const cipher = u8.subarray(28);
  const key = await deriveAesKey(password, salt, 'decrypt');
  try {
    const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new Uint8Array(plain);
  } catch {
    throw new Error('解密失败：口令错误或数据被篡改');
  }
}

export async function decodePngBytes(u8) {
  const { w, h, depth, ctype, palette, compressed } = parsePngChunks(u8);
  const raw = await inflateBytes(compressed);
  return rawPixelsToRgb(raw, w, h, depth, ctype, palette);
}

export async function encodePngBytes(rgb, w, h) {
  const raw = buildRawScanlines(rgb, w, h);
  const idat = await deflateBytes(raw);
  return buildPngFromIdat(w, h, idat);
}

export async function encodeFileToPartsAsync(dataU8, name, opts = {}) {
  const compress = opts.compress !== false;
  const password = opts.password || '';
  const maxPartBytes = opts.maxPartBytes || DEFAULT_PART_BYTES;
  const cols = opts.cols || 0;

  let stream = dataU8;
  let flags = 0;

  if (compress) {
    const deflated = await deflateBytes(stream);
    if (deflated.length < stream.length) {
      stream = deflated;
      flags |= F3_COMPRESSED;
    }
  }

  if (password) {
    stream = await encryptBytes(stream, password);
    flags |= F3_ENCRYPTED;
  }

  const nameBytes = name ? new TextEncoder().encode(String(name)) : new Uint8Array(0);
  if (stream.length <= maxPartBytes) {
    const packed = flags === 0
      ? packF2I2(stream, name)
      : packF2I3Part({ flags, nameBytes, body: stream });
    const { w, h, rgb } = buildRgbLayout(packed, cols);
    const png = await encodePngBytes(rgb, w, h);
    return [{ png, w, h, partIndex: 0, partTotal: 1, flags, transferIdHex: '', packedSize: packed.length }];
  }

  flags |= F3_CHUNKED;
  const partTotal = Math.ceil(stream.length / maxPartBytes);
  if (partTotal > 65535) throw new Error('分片数量超过上限 (65535)');
  const transferId = globalThis.crypto.getRandomValues(new Uint8Array(8));
  const transferIdHex = bytesToHex(transferId);
  const parts = [];

  for (let i = 0; i < partTotal; i++) {
    const start = i * maxPartBytes;
    const end = Math.min(stream.length, start + maxPartBytes);
    const chunkBody = stream.subarray(start, end);
    const packed = packF2I3Part({
      flags,
      nameBytes,
      body: chunkBody,
      transferId,
      partIndex: i,
      partTotal,
    });
    const { w, h, rgb } = buildRgbLayout(packed, cols);
    const png = await encodePngBytes(rgb, w, h);
    parts.push({ png, w, h, partIndex: i, partTotal, flags, transferIdHex, packedSize: packed.length });
  }
  return parts;
}

export async function assembleChunksAsync(partBodies, flags, password = '') {
  let stream = partBodies.length === 1 ? partBodies[0] : concatBytes(partBodies);
  if ((flags & F3_ENCRYPTED) !== 0) stream = await decryptBytes(stream, password);
  if ((flags & F3_COMPRESSED) !== 0) stream = await inflateBytes(stream);
  return stream;
}

export async function decodeFileBytes(u8, password = '') {
  const { w, h, ctype, depth, rgb } = await decodePngBytes(u8);
  const info = unpackRawBody(rgb);
  if (info.chunked) {
    return { w, h, ctype, depth, ...info, payload: null };
  }
  const payload = await assembleChunksAsync([info.body], info.flags, password);
  return { w, h, ctype, depth, ...info, payload };
}
