using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace F2IClip {
    class HostControl : Control {
        private const int WM_CLIPBOARDUPDATE = 0x031D;
        public event Action ClipboardChanged;

        protected override CreateParams CreateParams {
            get {
                var cp = base.CreateParams;
                cp.Style = 0;
                cp.ExStyle = 0;
                cp.Parent = new IntPtr(-3); // HWND_MESSAGE
                return cp;
            }
        }

        public HostControl() {
            this.CreateHandle();
        }

        protected override void WndProc(ref Message m) {
            if (m.Msg == WM_CLIPBOARDUPDATE) {
                var h = ClipboardChanged;
                if (h != null) h();
            }
            base.WndProc(ref m);
        }
    }

    static class Program {
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool AddClipboardFormatListener(IntPtr hwnd);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

        static string _lastHash = "";
        static readonly object _outLock = new object();

        static void Emit(string line) {
            lock (_outLock) {
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

        static void SetClipboardImage(string pngPath) {
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
                Emit("SETOK:" + img.Width + "x" + img.Height + ":" + bytes.Length);
            }
        }

        static void ProcessClipboard(int attempt = 0) {
            try {
                if (Clipboard.ContainsData("F2I_LOCAL_ORIGIN")) {
                    Emit("SKIP_LOCAL");
                    return;
                }

                byte[] pngBytes = null;
                string source = null;

                // 1. 优先读原生 PNG 流（无损且免 GDI+ 重编码）
                if (Clipboard.ContainsData("PNG")) {
                    object raw = Clipboard.GetData("PNG");
                    var st = raw as Stream;
                    if (st != null) {
                        using (st)
                        using (var ms = new MemoryStream()) {
                            st.CopyTo(ms);
                            pngBytes = ms.ToArray();
                            source = "PNG流";
                        }
                    } else if (raw is byte[]) {
                        pngBytes = (byte[])raw;
                        source = "PNG流";
                    }
                }

                // 2. 兜底 Bitmap 位图
                if (pngBytes == null || pngBytes.Length == 0) {
                    if (Clipboard.ContainsImage()) {
                        using (var img = Clipboard.GetImage()) {
                            if (img != null) {
                                using (var ms = new MemoryStream()) {
                                    img.Save(ms, ImageFormat.Png);
                                    pngBytes = ms.ToArray();
                                    source = "Bitmap " + img.Width + "x" + img.Height;
                                }
                            }
                        }
                    }
                }

                if (pngBytes != null && pngBytes.Length > 0) {
                    string hash = Sha256Hex(pngBytes);
                    if (hash == _lastHash) return;
                    _lastHash = hash;
                    string tmp = Path.Combine(Path.GetTempPath(), "f2icb_" + Guid.NewGuid().ToString("N") + ".png");
                    File.WriteAllBytes(tmp, pngBytes);
                    Emit("TMP:" + B64(source) + ":" + B64(tmp));
                    return;
                }

                // 3. 兜底 FileDrop (.png)
                if (Clipboard.ContainsFileDropList()) {
                    foreach (string fp in Clipboard.GetFileDropList()) {
                        if (!File.Exists(fp)) continue;
                        if (!string.Equals(Path.GetExtension(fp), ".png", StringComparison.OrdinalIgnoreCase)) continue;
                        byte[] fbytes = File.ReadAllBytes(fp);
                        string hash = Sha256Hex(fbytes);
                        if (hash == _lastHash) continue;
                        _lastHash = hash;
                        Emit("FILE:" + B64("FileDrop " + Path.GetFileName(fp)) + ":" + B64(fp));
                    }
                }
            } catch (ExternalException) {
                if (attempt < 2) {
                    Thread.Sleep(150);
                    ProcessClipboard(attempt + 1);
                }
            } catch (Exception ex) {
                Emit("CLIPERR:" + B64(ex.Message));
            }
        }

        [STAThread]
        static int Main(string[] args) {
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;

            if (args.Length >= 2 && args[0] == "--set") {
                try {
                    SetClipboardImage(args[1]);
                    return 0;
                } catch (Exception ex) {
                    Console.Error.WriteLine(ex.Message);
                    return 1;
                }
            }

            if (args.Length >= 1 && args[0] == "--watch") {
                var host = new HostControl();
                var settle = new System.Windows.Forms.Timer();
                settle.Interval = 140;
                settle.Tick += (s, e) => {
                    settle.Stop();
                    ProcessClipboard();
                };
                host.ClipboardChanged += () => {
                    settle.Stop();
                    settle.Start();
                };

                AddClipboardFormatListener(host.Handle);

                var stdinThread = new Thread(() => {
                    try {
                        string line;
                        while ((line = Console.ReadLine()) != null) {
                            line = line.Trim();
                            if (line.Length == 0) continue;
                            if (line == "QUIT") {
                                host.BeginInvoke(new Action(() => Application.ExitThread()));
                                return;
                            }
                            if (line.StartsWith("SET:")) {
                                string path = FromB64(line.Substring(4));
                                host.BeginInvoke(new Action(() => {
                                    try {
                                        SetClipboardImage(path);
                                    } catch (Exception ex) {
                                        Emit("SETERR:" + B64(ex.Message));
                                    }
                                }));
                            }
                        }
                        // stdin closed -> parent exited
                        host.BeginInvoke(new Action(() => Application.ExitThread()));
                    } catch { }
                });
                stdinThread.IsBackground = true;
                stdinThread.Start();

                Emit("READY");
                Application.Run();
                RemoveClipboardFormatListener(host.Handle);
                settle.Dispose();
                host.Dispose();
                return 0;
            }

            Console.Error.WriteLine("Usage: clipagent.exe --watch | --set <png>");
            return 2;
        }
    }
}
