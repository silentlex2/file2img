# file2img（互传助手）

把任意文件无损编码成 PNG 图片，借道**豆包输入法超级互传**等跨设备图片剪贴板通道，实现 **PC ⇄ 手机**免线传输任意文件。

[![CI & Release](https://github.com/silentlex2/file2img/actions/workflows/ci.yml/badge.svg)](https://github.com/silentlex2/file2img/actions/workflows/ci.yml)

## 核心特性

- **零第三方运行依赖**：Node 端仅使用内置模块；浏览器端基于 Web Streams / WebCrypto + 内联 Web Worker；Android 端自研 PNG 编解码器（绕开 `BitmapFactory` 的色彩管理/Alpha 预乘篡改）。
- **全 PNG 格式兼容**：Node、浏览器、Android 三端均支持灰度 (`ctype=0/4`)、RGB (`2`)、RGBA (`6`)、**调色板索引色 (`3`，1/2/4/8 bit)** 以及 8/16 bit 位深（可抵抗部分同步通道把小图无损重编码为索引 PNG）。
- **`F2I1 / F2I2 / F2I3` 协议**：
  - **自动压缩**：默认尝试 Deflate，仅在体积更小时启用（文本/源码/JSON 压缩率极高）；
  - **大文件自动分片**：单图载荷默认上限 **`4.7 MB`**（保证不可压缩/加密图片生成的 PNG 仍 `< 5 MB`），超出自动分片，支持乱序接收合并；
  - **可选端到端加密**：支持口令派生密钥做 `AES-256-GCM` 加密（PBKDF2-HMAC-SHA256，100,000 次迭代）。
- **额外支持 LSB 隐写**：可将文件隐藏进普通载体 PNG 的像素最低有效位（`embed` / `extract`）。

---

## 传输路径一览

```text
【PC → 手机】
  本地文件 (Desktop\f2i\)
     │
     ▼ watch.mjs / 发送为图片.bat（压缩 → 可选加密 → 超4.7MB自动分片）
  PNG 图片 (Desktop\f2i\图片\*.png)
     │
     ▼ clip.ps1（写入 Bitmap + PNG流 + 本机防自收标记 F2I_LOCAL_ORIGIN）
  Windows 剪贴板 ──[豆包超级互传]──▶ 手机豆包剪贴板
                                         │
                        ┌────────────────┴────────────────┐
                        ▼（豆包保存到相册）               ▼（手动选图）
               Pictures/DoubaoIme/               mobile/index.html（网页端）
                        │                                 │
                        ▼ RelayService 监听去重           ▼ Web Worker 本地解码
               Download/互传/<文件名>              浏览器直接下载保存


【手机 → PC】
  手机文件
     │
     ├──▶ 互传助手 App（MainActivity 压缩/加密/分片 → Pictures/DoubaoIme/ → 系统剪贴板）
     └──▶ 网页端编码页（mobile/index.html 生成 PNG 保存/复制）
                                         │
                             [豆包超级互传同步]
                                         ▼
                                 Windows 剪贴板
                                         │
     ▼ cliprecv.ps1（过滤 F2I_LOCAL_ORIGIN → 优先读PNG流/兜底Bitmap）
  file2img.mjs restore-daemon（单图直解 / 分片暂存合并）
     │
     ▼
  Desktop\f2i\recv\<文件名>
```

> [!NOTE]
> **传输通道要求**：必须使用不会对 PNG 做有损转码或缩放的通道（例如豆包输入法超级互传剪贴板）。如果通道将图片转为 JPG/WebP 有损压缩，像素直编码会被破坏；可先用 `node check.mjs <回传图>` 探测通道无损性。

---

## 目录结构

- `file2img.mjs`：核心 CLI（`encode` / `decode` / `info` / `restore` / `restore-daemon` / `embed` / `extract`）
- `check.mjs`：通道无损性探测器（容器格式嗅探 + 载荷解码 + SHA-256 比对）
- `mobile/`：局域网离线编解码网页（`serve.mjs`、`index.html`、`core.mjs`、`diff.mjs`）
- `pc/`：Windows 发送端（`watch.mjs`、`发送为图片.bat`、`clip.ps1`）与剪贴板接收端（`cliprecv.ps1`）
- `android/`：Android 客户端「互传助手」（Kotlin，后台监听 `Pictures/DoubaoIme/`、自动合片、写入 `Download/互传/`、选文件发送）
- `test.mjs`：Node + Web + Kotlin 产物全端交叉验证测试

---

## 快速开始

### 1. CLI 命令行（Node.js 18+）

```bash
# 编码文件为 PNG（大于 4.7MB 自动分片，支持可选密码）
node file2img.mjs encode input.zip out.png [--password 1234] [--part-mb 4.7] [--no-compress]

# 解码单图或合并多张分片图
node file2img.mjs decode out.png restored.zip [--password 1234]
node file2img.mjs decode out.part1of2.png out.part2of2.png restored.zip

# 查看图片容量与载荷头信息
node file2img.mjs info out.png

# 隐写进普通 PNG 载体 / 提取
node file2img.mjs embed carrier.png secret.txt stego.png [--compress] [--password 1234]
node file2img.mjs extract stego.png secret_out.txt [--password 1234]
```

### 2. PC 端收发（Windows）

- **发送**：
  - 常驻监听：`node pc/watch.mjs`（默认监听 `Desktop\f2i`，丢入文件即自动编码并写入剪贴板）
  - 单次拖放：把文件直接拖到 `pc/发送为图片.bat` 上
  - 可选环境变量：`F2I_IN`、`F2I_OUT`、`F2I_PART_MB`（默认 `4.7`）、`F2I_MAX_MB`（默认 `50`）、`F2I_PART_DELAY_MS`（多分片间隔，默认 `2500`）、`F2I_PASSWORD`
- **接收**：
  ```powershell
  powershell -ExecutionPolicy Bypass -File pc/cliprecv.ps1 [-Password 1234]
  ```
  自动监听剪贴板图片（跳过本机 `clip.ps1` 发出的图），还原到 `Desktop\f2i\recv\`（也支持通过环境变量 `F2I_RECV` 或 `F2I_IN` 指定接收目录）。

### 3. 手机端接收/发送

- **方式 A：安装 Android 客户端「互传助手」**
  - 从 [GitHub Releases](https://github.com/silentlex2/file2img/releases) 下载 `互传助手.apk` 安装（或自行用 `./gradlew assembleRelease` 构建；注意默认配置沿用 debug 签名以便开发测试，公开正式分发建议替换为自己的 keystore）。
  - 打开 App 授予图片读取/通知权限（如需自动删掉豆包相册原图可点右下角「授予删图权限」）；
  - 收文件时点页面输入框唤起豆包键盘 -> 在豆包剪贴板点「保存到相册」，文件会自动解码并保存到 `Download/互传/`。
- **方式 B：免安装局域网网页端**
  ```bash
  node mobile/serve.mjs
  ```
  手机浏览器打开打印出的局域网地址即可在线编码或解码（若需把安装包一起放内网分发，将 APK 命名为 `互传助手.apk` 放在仓库根目录即可通过 `/apk` 下载）。
  > 注：局域网明文 `http://` 下浏览器安全策略会禁用 `crypto.subtle`，网页端加密/解密需在 `localhost`/HTTPS 下使用，或直接使用 PC 端 / Android App。

---

## 本地构建与测试

```bash
# 1. Android 单元测试与 APK 构建
cd android && ./gradlew test assembleDebug assembleRelease

# 2. Node + Web 核心 + Kotlin 产物交叉验证
npm test
```

## License

[MIT](LICENSE) © 2026 silentlex2
