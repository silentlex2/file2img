#!/usr/bin/env node
// serve.mjs — 在局域网提供手机端编解码页（动态注入最新 core.mjs）
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(HERE, 'index.html');
const CORE_PATH = path.join(HERE, 'core.mjs');
const PORT = Number(process.env.PORT || 8123);

export function renderHtml() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const core = fs.readFileSync(CORE_PATH, 'utf8').replace(/^export\s+/gm, '');
  return html.replace(
    /\/\/ __CORE_MJS_START__[\s\S]*?\/\/ __CORE_MJS_END__/,
    () => `// __CORE_MJS_START__\n${core.trimEnd()}\n// __CORE_MJS_END__`
  );
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderHtml());
  } else if (pathname === '/core.mjs') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(CORE_PATH));
  } else if (pathname === '/apk' || pathname === '/f2i.apk') {
    const apk = path.join(HERE, '..', '互传助手.apk');
    if (!fs.existsSync(apk)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('apk not built');
      return;
    }
    const st = fs.statSync(apk);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename="f2i-relay.apk"',
    });
    const stream = fs.createReadStream(apk);
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    stream.pipe(res);
  } else if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '0.0.0.0', () => {
    const ips = lanIPs();
    console.log('');
    console.log('  手机端编解码页已启动');
    console.log('  ─────────────────────────────────────');
    if (!ips.length) {
      console.log('  没找到局域网地址，检查是否连了 WiFi');
    }
    for (const { name, ip } of ips) {
      console.log('  http://' + ip + ':' + PORT + '     [' + name + ']');
    }
    console.log('  ─────────────────────────────────────');
    console.log('  手机连同一个 WiFi，浏览器打开上面的地址');
    console.log('  然后「添加到主屏幕」，就能当 App 用');
    console.log('');
    console.log('  首次运行 Windows 会弹防火墙提示，允许「专用网络」');
    console.log('  停止：Ctrl + C');
    console.log('');
  });
}
