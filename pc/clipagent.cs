using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace F2IClip {
    // 仅在真正需要读写位图/PNG流时才由 JIT 加载 WinForms 与 System.Drawing
    static class LazyClipboard {
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static void SetClipboardImage(string pngPath, Action<string> emit) {
            if (!File.Exists(pngPath)) throw new FileNotFoundException("file not found", pngPath);
            byte[] bytes = File.ReadAllBytes(pngPath);
            using (var imgStream = new MemoryStream(bytes))
            using (var pngStream = new MemoryStream(bytes))
            using (var img = Image.FromStream(imgStream)) {
                var dobj = new DataObject();
                dobj.SetData(DataFormats.Bitmap, img);
                dobj.SetData("PNG", false, pngStream);
                dobj.SetData("F2I_LOCAL_ORIGIN", "1");
                Clipboard.SetDataObject(dobj, true);
                if (emit != null) emit("SETOK:" + img.Width + "x" + img.Height + ":" + bytes.Length);
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        public static bool TryExtractClipboardPng(out byte[] pngBytes, out string source) {
            pngBytes = null;
            source = null;

            if (Clipboard.ContainsData("PNG")) {
                object raw = Clipboard.GetData("PNG");
                var st = raw as Stream;
                if (st != null) {
                    using (st)
                    using (var ms = new MemoryStream()) {
                        st.CopyTo(ms);
                        pngBytes = ms.ToArray();
                        source = "PNG流";
                        return pngBytes.Length > 0;
                    }
                } else if (raw is byte[]) {
                    pngBytes = (byte[])raw;
                    source = "PNG流";
                    return pngBytes.Length > 0;
                }
            }

            if (Clipboard.ContainsImage()) {
                using (var img = Clipboard.GetImage()) {
                    if (img != null) {
                        using (var ms = new MemoryStream()) {
                            img.Save(ms, ImageFormat.Png);
                            pngBytes = ms.ToArray();
                            source = "Bitmap " + img.Width + "x" + img.Height;
                            return pngBytes.Length > 0;
                        }
                    }
                }
            }
            return false;
        }
    }

    static class Program {
        const int WM_DESTROY = 0x0002;
        const int WM_TIMER = 0x0113;
        const int WM_CLIPBOARDUPDATE = 0x031D;
        const int WM_APP = 0x8000;
        const int WM_APP_EXEC = WM_APP + 1;
        const int WM_APP_QUIT = WM_APP + 2;

        const uint CF_BITMAP = 2;
        const uint CF_DIB = 8;
        const uint CF_HDROP = 15;
        static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);
        static readonly IntPtr TIMER_CLIP = new IntPtr(1);

        delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WNDCLASSEX {
            public uint cbSize;
            public uint style;
            public WndProcDelegate lpfnWndProc;
            public int cbClsExtra;
            public int cbWndExtra;
            public IntPtr hInstance;
            public IntPtr hIcon;
            public IntPtr hCursor;
            public IntPtr hbrBackground;
            public string lpszMenuName;
            public string lpszClassName;
            public IntPtr hIconSm;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        struct MSG {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
        }

        [DllImport("ole32.dll")]
        static extern int OleInitialize(IntPtr pvReserved);

        [DllImport("ole32.dll")]
        static extern void OleUninitialize();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateWindowEx(
            uint dwExStyle, string lpClassName, string lpWindowName, uint dwStyle,
            int x, int y, int nWidth, int nHeight,
            IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

        [DllImport("user32.dll")]
        static extern bool DestroyWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        static extern bool TranslateMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        static extern IntPtr DispatchMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern void PostQuitMessage(int nExitCode);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool AddClipboardFormatListener(IntPtr hwnd);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

        [DllImport("user32.dll")]
        static extern IntPtr SetTimer(IntPtr hWnd, IntPtr nIDEvent, uint uElapse, IntPtr lpTimerFunc);

        [DllImport("user32.dll")]
        static extern bool KillTimer(IntPtr hWnd, IntPtr uIDEvent);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern uint RegisterClipboardFormat(string lpszFormat);

        [DllImport("user32.dll")]
        static extern bool IsClipboardFormatAvailable(uint format);

        [DllImport("user32.dll")]
        static extern bool OpenClipboard(IntPtr hWndNewOwner);

        [DllImport("user32.dll")]
        static extern bool CloseClipboard();

        [DllImport("user32.dll")]
        static extern IntPtr GetClipboardData(uint uFormat);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern uint DragQueryFileW(IntPtr hDrop, uint iFile, StringBuilder lpszFile, int cch);

        static WndProcDelegate _wndProcKeepAlive;
        static IntPtr _hwnd;
        static uint _cfPng;
        static uint _cfLocalOrigin;
        static string _lastHash = "";

        static readonly object _logLock = new object();
        static readonly Queue<Action> _staQueue = new Queue<Action>();
        static string _logFile = "";
        static bool _relayMode = false;
        static string _repoRoot = "";
        static string _inDir = "";
        static string _outDir = "";
        static string _recvDir = "";
        static string _nodeExe = "node.exe";

        static void Log(string msg) {
            string line = "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg;
            lock (_logLock) {
                if (string.IsNullOrEmpty(_logFile)) {
                    Console.WriteLine(line);
                    Console.Out.Flush();
                    return;
                }
                try {
                    string dir = Path.GetDirectoryName(_logFile);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    if (File.Exists(_logFile) && new FileInfo(_logFile).Length > 2 * 1024 * 1024) {
                        File.WriteAllText(_logFile, "");
                    }
                    File.AppendAllText(_logFile, line + "\n", new UTF8Encoding(false));
                } catch { }
            }
        }

        static void Emit(string line) {
            lock (_logLock) {
                Console.WriteLine(line);
                Console.Out.Flush();
            }
        }

        static string B64(string s) {
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(s));
        }

        static string FromB64(string b64) {
            return Encoding.UTF8.GetString(Convert.FromBase64String(b64));
        }

        static string Sha256Hex(byte[] data) {
            using (var sha = SHA256.Create()) {
                byte[] h = sha.ComputeHash(data);
                var sb = new StringBuilder(h.Length * 2);
                for (int i = 0; i < h.Length; i++) sb.Append(h[i].ToString("x2"));
                return sb.ToString();
            }
        }

        static void EnqueueSta(Action act) {
            lock (_staQueue) { _staQueue.Enqueue(act); }
            if (_hwnd != IntPtr.Zero) PostMessage(_hwnd, WM_APP_EXEC, IntPtr.Zero, IntPtr.Zero);
        }

        // 纯 Win32 预检 HDROP 中的 .png，避免复制普通文件时加载 WinForms
        static List<string> PeekDropPngs() {
            var list = new List<string>();
            if (!OpenClipboard(IntPtr.Zero)) return list;
            try {
                IntPtr hDrop = GetClipboardData(CF_HDROP);
                if (hDrop == IntPtr.Zero) return list;
                uint count = DragQueryFileW(hDrop, 0xFFFFFFFF, null, 0);
                var sb = new StringBuilder(520);
                for (uint i = 0; i < count; i++) {
                    sb.Length = 0;
                    uint len = DragQueryFileW(hDrop, i, sb, sb.Capacity);
                    if (len > 0) {
                        string fp = sb.ToString();
                        if (string.Equals(Path.GetExtension(fp), ".png", StringComparison.OrdinalIgnoreCase) && File.Exists(fp)) {
                            list.Add(fp);
                        }
                    }
                }
            } finally {
                CloseClipboard();
            }
            return list;
        }

        static void RunNodeRestore(string source, string pngPath, bool isTemp) {
            ThreadPool.QueueUserWorkItem(_ => {
                try {
                    Log("剪贴板捕获: " + source);
                    var psi = new ProcessStartInfo(_nodeExe, "\"" + Path.Combine(_repoRoot, "file2img.mjs") + "\" restore \"" + pngPath + "\" \"" + _recvDir + "\"");
                    psi.UseShellExecute = false;
                    psi.RedirectStandardOutput = true;
                    psi.RedirectStandardError = true;
                    psi.StandardOutputEncoding = Encoding.UTF8;
                    psi.StandardErrorEncoding = Encoding.UTF8;
                    psi.CreateNoWindow = true;
                    psi.WorkingDirectory = _repoRoot;

                    using (var p = Process.Start(psi)) {
                        string stdout = p.StandardOutput.ReadToEnd().Trim();
                        string stderr = p.StandardError.ReadToEnd().Trim();
                        p.WaitForExit();
                        if (p.ExitCode == 0 && stdout.StartsWith("OK:")) {
                            string dest = FromB64(stdout.Substring(3));
                            long sz = File.Exists(dest) ? new FileInfo(dest).Length : 0;
                            Log("   还原 -> " + dest + "  (" + sz + " B)");
                        } else if (p.ExitCode == 0 && stdout.StartsWith("PART:")) {
                            var segs = stdout.Split(new[] { ':' }, 3);
                            string prog = segs.Length > 1 ? segs[1] : "";
                            string nm = segs.Length > 2 ? FromB64(segs[2]) : "";
                            Log("   收到分片 " + prog + " · " + nm);
                        } else if (stderr.Contains("解密") || stderr.Contains("口令")) {
                            Log("   解码失败: " + stderr.Replace("[error] ", ""));
                        } else {
                            Log("   不是载荷图（普通图片，忽略）");
                        }
                    }
                } catch (Exception ex) {
                    Log("   解码异常: " + ex.Message);
                } finally {
                    if (isTemp) {
                        try { File.Delete(pngPath); } catch { }
                    }
                }
            });
        }

        static void HandleClipboardUpdate(int attempt = 0) {
            try {
                // 纯 Win32 预检：复制文本/非图片文件时直接返回，不加载 WinForms/Drawing/Node
                if (_cfLocalOrigin != 0 && IsClipboardFormatAvailable(_cfLocalOrigin)) {
                    if (_relayMode) Log("跳过本机发出的载荷图");
                    else Emit("SKIP_LOCAL");
                    return;
                }

                bool hasPngOrImg = (_cfPng != 0 && IsClipboardFormatAvailable(_cfPng))
                    || IsClipboardFormatAvailable(CF_DIB)
                    || IsClipboardFormatAvailable(CF_BITMAP);
                bool hasDrop = IsClipboardFormatAvailable(CF_HDROP);

                if (!hasPngOrImg && !hasDrop) return;

                if (hasPngOrImg) {
                    byte[] pngBytes;
                    string source;
                    if (LazyClipboard.TryExtractClipboardPng(out pngBytes, out source)) {
                        string hash = Sha256Hex(pngBytes);
                        if (hash == _lastHash) return;
                        _lastHash = hash;
                        string tmp = Path.Combine(Path.GetTempPath(), "f2icb_" + Guid.NewGuid().ToString("N") + ".png");
                        File.WriteAllBytes(tmp, pngBytes);
                        if (_relayMode) RunNodeRestore(source, tmp, true);
                        else Emit("TMP:" + B64(source) + ":" + B64(tmp));
                        return;
                    }
                }

                if (hasDrop) {
                    var pngs = PeekDropPngs();
                    foreach (string fp in pngs) {
                        byte[] fb = File.ReadAllBytes(fp);
                        string hash = Sha256Hex(fb);
                        if (hash == _lastHash) continue;
                        _lastHash = hash;
                        string src = "FileDrop " + Path.GetFileName(fp);
                        if (_relayMode) RunNodeRestore(src, fp, false);
                        else Emit("FILE:" + B64(src) + ":" + B64(fp));
                    }
                }
            } catch (ExternalException) {
                if (attempt < 2) {
                    Thread.Sleep(150);
                    HandleClipboardUpdate(attempt + 1);
                }
            } catch (Exception ex) {
                if (_relayMode) Log("剪贴板读取异常: " + ex.Message);
                else Emit("CLIPERR:" + B64(ex.Message));
            }
        }

        /* ---------- Relay 模式下的轻量文件监听（按需调用 node watch.mjs --once） ---------- */
        static readonly Regex _skipRx = new Regex(@"(^~\$|\.tmp$|\.crdownload$|\.part$|^\.)", RegexOptions.IgnoreCase);
        static readonly object _fileLock = new object();
        static readonly Dictionary<string, System.Threading.Timer> _pendingTimers = new Dictionary<string, System.Threading.Timer>(StringComparer.OrdinalIgnoreCase);
        static readonly Dictionary<string, string> _convertedSig = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        static readonly HashSet<string> _inFlight = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        static bool IsReadable(string path) {
            try {
                using (File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read)) return true;
            } catch {
                return false;
            }
        }

        static void ScheduleFile(string fullPath, int attempts) {
            string abs;
            try { abs = Path.GetFullPath(fullPath); } catch { return; }
            string name = Path.GetFileName(abs);
            if (_skipRx.IsMatch(name)) return;
            if (abs.StartsWith(_outDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return;
            if (abs.StartsWith(_recvDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return;
            if (!File.Exists(abs)) return;

            lock (_fileLock) {
                System.Threading.Timer old;
                if (_pendingTimers.TryGetValue(abs, out old)) {
                    old.Dispose();
                    _pendingTimers.Remove(abs);
                }
                System.Threading.Timer self = null;
                self = new System.Threading.Timer(_ => {
                    lock (_fileLock) {
                        System.Threading.Timer t;
                        if (_pendingTimers.TryGetValue(abs, out t) && ReferenceEquals(t, self)) {
                            t.Dispose();
                            _pendingTimers.Remove(abs);
                        }
                    }
                    try {
                        if (!File.Exists(abs)) return;
                        var fi1 = new FileInfo(abs);
                        Thread.Sleep(400);
                        if (!File.Exists(abs)) return;
                        var fi2 = new FileInfo(abs);
                        if (fi2.Length != fi1.Length || fi2.LastWriteTimeUtc != fi1.LastWriteTimeUtc || !IsReadable(abs)) {
                            if (attempts < 20) ScheduleFile(abs, attempts + 1);
                            else Log("放弃（文件一直被占用）: " + name);
                            return;
                        }
                        if (fi2.Length == 0) { Log("跳过空文件 " + name); return; }
                        string sig = fi2.Length + ":" + fi2.LastWriteTimeUtc.Ticks;
                        lock (_fileLock) {
                            string prev;
                            if (_convertedSig.TryGetValue(abs, out prev) && prev == sig) return;
                            if (_inFlight.Contains(abs)) return;
                            _inFlight.Add(abs);
                        }
                        try {
                            var psi = new ProcessStartInfo(_nodeExe, "\"" + Path.Combine(_repoRoot, "pc", "watch.mjs") + "\" --once \"" + abs + "\"");
                            psi.UseShellExecute = false;
                            psi.RedirectStandardOutput = true;
                            psi.RedirectStandardError = true;
                            psi.StandardOutputEncoding = Encoding.UTF8;
                            psi.StandardErrorEncoding = Encoding.UTF8;
                            psi.CreateNoWindow = true;
                            psi.WorkingDirectory = _repoRoot;
                            using (var p = Process.Start(psi)) {
                                string stdout = p.StandardOutput.ReadToEnd();
                                string stderr = p.StandardError.ReadToEnd();
                                p.WaitForExit();
                                foreach (string ln in (stdout + "\n" + stderr).Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)) {
                                    // 去掉 watch.mjs 自带的时间戳避免双时间戳
                                    string clean = Regex.Replace(ln, @"^\[\d{2}:\d{2}:\d{2}\]\s*", "");
                                    Log(clean);
                                }
                                if (p.ExitCode == 0) {
                                    lock (_fileLock) { _convertedSig[abs] = sig; }
                                }
                            }
                        } finally {
                            lock (_fileLock) { _inFlight.Remove(abs); }
                        }
                    } catch (Exception ex) {
                        Log("处理失败 " + name + ": " + ex.Message);
                    }
                }, null, 300, Timeout.Infinite);
                _pendingTimers[abs] = self;
            }
        }

        static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam) {
            if (msg == WM_CLIPBOARDUPDATE) {
                KillTimer(hWnd, TIMER_CLIP);
                SetTimer(hWnd, TIMER_CLIP, 140, IntPtr.Zero);
                return IntPtr.Zero;
            }
            if (msg == WM_TIMER && wParam == TIMER_CLIP) {
                KillTimer(hWnd, TIMER_CLIP);
                HandleClipboardUpdate(0);
                return IntPtr.Zero;
            }
            if (msg == WM_APP_EXEC) {
                for (;;) {
                    Action act = null;
                    lock (_staQueue) {
                        if (_staQueue.Count > 0) act = _staQueue.Dequeue();
                    }
                    if (act == null) break;
                    try { act(); } catch { }
                }
                return IntPtr.Zero;
            }
            if (msg == WM_APP_QUIT) {
                DestroyWindow(hWnd);
                return IntPtr.Zero;
            }
            if (msg == WM_DESTROY) {
                PostQuitMessage(0);
                return IntPtr.Zero;
            }
            return DefWindowProc(hWnd, msg, wParam, lParam);
        }

        static void InitMessageWindow() {
            _cfPng = RegisterClipboardFormat("PNG");
            _cfLocalOrigin = RegisterClipboardFormat("F2I_LOCAL_ORIGIN");
            _wndProcKeepAlive = WndProc;

            string cls = "F2IClipHost_" + Process.GetCurrentProcess().Id;
            var wc = new WNDCLASSEX {
                cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX)),
                lpfnWndProc = _wndProcKeepAlive,
                hInstance = GetModuleHandle(null),
                lpszClassName = cls
            };
            RegisterClassEx(ref wc);
            _hwnd = CreateWindowEx(0, cls, "", 0, 0, 0, 0, 0, HWND_MESSAGE, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
            AddClipboardFormatListener(_hwnd);
        }

        static void PumpMessages() {
            MSG m;
            while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
                TranslateMessage(ref m);
                DispatchMessage(ref m);
            }
            RemoveClipboardFormatListener(_hwnd);
            if (_hwnd != IntPtr.Zero) DestroyWindow(_hwnd);
        }

        [STAThread]
        static int Main(string[] args) {
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;
            OleInitialize(IntPtr.Zero);
            try {
                if (args.Length >= 2 && args[0] == "--set") {
                    try {
                        LazyClipboard.SetClipboardImage(args[1], Emit);
                        return 0;
                    } catch (Exception ex) {
                        Console.Error.WriteLine(ex.Message);
                        return 1;
                    }
                }

                if (args.Length >= 1 && args[0] == "--relay") {
                    _relayMode = true;
                    _repoRoot = args.Length >= 2 ? Path.GetFullPath(args[1]) : AppDomain.CurrentDomain.BaseDirectory;
                    for (int i = 2; i < args.Length; i++) {
                        if (args[i] == "--log" && i + 1 < args.Length) _logFile = Path.GetFullPath(args[++i]);
                    }
                    if (string.IsNullOrEmpty(_logFile)) {
                        string envLog = Environment.GetEnvironmentVariable("F2I_LOG");
                        if (!string.IsNullOrEmpty(envLog)) _logFile = Path.GetFullPath(envLog);
                    }
                    string envIn = Environment.GetEnvironmentVariable("F2I_IN");
                    _inDir = Path.GetFullPath(!string.IsNullOrEmpty(envIn) ? envIn : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "f2i"));
                    string envOut = Environment.GetEnvironmentVariable("F2I_OUT");
                    _outDir = Path.GetFullPath(!string.IsNullOrEmpty(envOut) ? envOut : Path.Combine(_inDir, "图片"));
                    string envRecv = Environment.GetEnvironmentVariable("F2I_RECV");
                    _recvDir = Path.GetFullPath(!string.IsNullOrEmpty(envRecv) ? envRecv : Path.Combine(_inDir, "recv"));

                    Directory.CreateDirectory(_inDir);
                    Directory.CreateDirectory(_outDir);
                    Directory.CreateDirectory(_recvDir);

                    var fsw = new FileSystemWatcher(_inDir);
                    fsw.IncludeSubdirectories = false;
                    fsw.NotifyFilter = NotifyFilters.FileName | NotifyFilters.Size | NotifyFilters.LastWrite;
                    FileSystemEventHandler onFs = (s, e) => ScheduleFile(e.FullPath, 0);
                    RenamedEventHandler onRen = (s, e) => ScheduleFile(e.FullPath, 0);
                    fsw.Created += onFs;
                    fsw.Changed += onFs;
                    fsw.Renamed += onRen;
                    fsw.EnableRaisingEvents = true;

                    Log("极简监听已启动（待机零 Node · 事件驱动）");
                    Log("发送目录: " + _inDir + " -> " + _outDir);
                    Log("接收目录: " + _recvDir);

                    InitMessageWindow();
                    PumpMessages();
                    fsw.Dispose();
                    return 0;
                }

                if (args.Length >= 1 && args[0] == "--watch") {
                    // 先创建消息窗口再启动 stdin 读取线程，避免立即收到 QUIT 时 _hwnd 尚未就绪
                    InitMessageWindow();
                    var stdinThread = new Thread(() => {
                        try {
                            string line;
                            while ((line = Console.ReadLine()) != null) {
                                line = line.Trim();
                                if (line.Length == 0) continue;
                                if (line == "QUIT") {
                                    PostMessage(_hwnd, WM_APP_QUIT, IntPtr.Zero, IntPtr.Zero);
                                    return;
                                }
                                if (line.StartsWith("SET:")) {
                                    string path = FromB64(line.Substring(4));
                                    EnqueueSta(() => {
                                        try { LazyClipboard.SetClipboardImage(path, Emit); }
                                        catch (Exception ex) { Emit("SETERR:" + B64(ex.Message)); }
                                    });
                                }
                            }
                            PostMessage(_hwnd, WM_APP_QUIT, IntPtr.Zero, IntPtr.Zero);
                        } catch { }
                    });
                    stdinThread.IsBackground = true;
                    stdinThread.Start();

                    Emit("READY");
                    PumpMessages();
                    return 0;
                }

                Console.Error.WriteLine("Usage: clipagent.exe --relay <repoRoot> [--log file] | --watch | --set <png>");
                return 2;
            } finally {
                OleUninitialize();
            }
        }
    }
}
