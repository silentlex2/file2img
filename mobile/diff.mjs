import fs from 'node:fs';
import { decodePngBytes } from './core.mjs';

const [a, b] = process.argv.slice(2);
const A = await decodePngBytes(new Uint8Array(fs.readFileSync(a)));
const B = await decodePngBytes(new Uint8Array(fs.readFileSync(b)));

console.log('A: ' + a + '  ' + A.w + 'x' + A.h);
console.log('B: ' + b + '  ' + B.w + 'x' + B.h);
if (A.w !== B.w || A.h !== B.h) { console.log('尺寸不同，直接结束'); process.exit(0); }

const n = Math.min(A.rgb.length, B.rgb.length);
let diff = 0, maxd = 0;
for (let i = 0; i < n; i++) {
  const d = Math.abs(A.rgb[i] - B.rgb[i]);
  if (d) { diff++; if (d > maxd) maxd = d; }
}
console.log('字节总数: ' + n);
console.log('不同字节: ' + diff + '  (' + (diff / n * 100).toFixed(3) + '%)');
console.log('最大偏差: ' + maxd);

console.log('\n前 24 字节 (A 原始 / B 剪贴板):');
for (let i = 0; i < 24; i++) {
  const x = A.rgb[i], y = B.rgb[i];
  const ch = ['R','G','B'][i % 3];
  const px = Math.floor(i / 3);
  console.log('  px' + String(px).padStart(2) + ch + '  ' + String(x).padStart(3) + ' -> ' + String(y).padStart(3) + (x === y ? '' : '   <<< 变了'));
}
console.log('\nA 前16字节 ASCII: ' + JSON.stringify(Buffer.from(A.rgb.subarray(0, 16)).toString('latin1')));
console.log('B 前16字节 ASCII: ' + JSON.stringify(Buffer.from(B.rgb.subarray(0, 16)).toString('latin1')));
