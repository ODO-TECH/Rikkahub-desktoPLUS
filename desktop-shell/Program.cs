using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace RikkaHubShell
{
    internal static class Paths
    {
        public static readonly string BaseDir = AppDomain.CurrentDomain.BaseDirectory;
        public static readonly string ConfigPath = Path.Combine(BaseDir, "shell.ini");
        public static readonly string LogPath = Path.Combine(BaseDir, "shell.log");
        public static readonly string WebViewDataDir = Path.Combine(BaseDir, "webview2-data");
    }

    internal static class Log
    {
        private static readonly object Gate = new object();
        private static bool rotated;

        public static void Write(string message)
        {
            lock (Gate)
            {
                try
                {
                    if (!rotated)
                    {
                        rotated = true;
                        try
                        {
                            FileInfo info = new FileInfo(Paths.LogPath);
                            if (info.Exists && info.Length > 4 * 1024 * 1024)
                            {
                                string old = Paths.LogPath + ".1";
                                if (File.Exists(old)) File.Delete(old);
                                File.Move(Paths.LogPath, old);
                            }
                        }
                        catch { }
                    }
                    File.AppendAllText(
                        Paths.LogPath,
                        "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "] " + message + Environment.NewLine,
                        new UTF8Encoding(false));
                }
                catch { }
            }
        }
    }

    internal sealed class AppConfig
    {
        public int Port = 17455;
        public bool MinimizeToTray = true;
        public bool LowVramMode;
        public bool TrayHintShown;
        public string ServerPath = "";
        public string DataDir = "";
        public string Bounds = "";

        private static bool ParseBool(string value, bool fallback)
        {
            if (string.IsNullOrEmpty(value)) return fallback;
            string v = value.Trim().ToLowerInvariant();
            if (v == "1" || v == "true" || v == "yes" || v == "on") return true;
            if (v == "0" || v == "false" || v == "no" || v == "off") return false;
            return fallback;
        }

        public static AppConfig Load(string path)
        {
            AppConfig config = new AppConfig();
            try
            {
                foreach (string raw in File.ReadAllLines(path))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#") || line.StartsWith(";")) continue;
                    int separator = line.IndexOf('=');
                    if (separator <= 0) continue;
                    string key = line.Substring(0, separator).Trim().ToLowerInvariant();
                    string value = line.Substring(separator + 1).Trim();
                    switch (key)
                    {
                        case "port":
                            int port;
                            if (int.TryParse(value, out port) && port > 0 && port < 65536) config.Port = port;
                            break;
                        case "minimizetotray":
                            config.MinimizeToTray = ParseBool(value, config.MinimizeToTray);
                            break;
                        case "lowvrammode":
                            config.LowVramMode = ParseBool(value, config.LowVramMode);
                            break;
                        case "trayhintshown":
                            config.TrayHintShown = ParseBool(value, config.TrayHintShown);
                            break;
                        case "serverpath":
                            config.ServerPath = value;
                            break;
                        case "datadir":
                            config.DataDir = value;
                            break;
                        case "bounds":
                            config.Bounds = value;
                            break;
                    }
                }
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
            catch (Exception ex)
            {
                Log.Write("read config failed: " + ex.Message);
            }
            return config;
        }

        public void Save(string path)
        {
            try
            {
                StringBuilder builder = new StringBuilder();
                builder.AppendLine("# RikkaHub Desktop PLUS desktop shell settings");
                builder.AppendLine("port=" + Port);
                builder.AppendLine("minimizeToTray=" + (MinimizeToTray ? "1" : "0"));
                builder.AppendLine("lowVramMode=" + (LowVramMode ? "1" : "0"));
                builder.AppendLine("trayHintShown=" + (TrayHintShown ? "1" : "0"));
                builder.AppendLine("serverPath=" + ServerPath);
                builder.AppendLine("dataDir=" + DataDir);
                builder.AppendLine("bounds=" + Bounds);
                string tmp = path + ".tmp";
                File.WriteAllText(tmp, builder.ToString(), new UTF8Encoding(false));
                if (File.Exists(path)) File.Delete(path);
                File.Move(tmp, path);
            }
            catch (Exception ex)
            {
                Log.Write("write config failed: " + ex.Message);
            }
        }
    }

    internal sealed class UiStrings
    {
        private readonly Dictionary<string, string> values;

        public UiStrings()
        {
            bool zh = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.Equals("zh", StringComparison.OrdinalIgnoreCase);
            values = new Dictionary<string, string>();
            if (zh)
            {
                values["open"] = "打开 RikkaHub Desktop PLUS";
                values["closeBehavior"] = "关闭按钮行为";
                values["toTray"] = "最小化到托盘";
                values["quitDirect"] = "直接退出程序";
                values["lowVram"] = "低显存模式（软件渲染，下次启动生效）";
                values["openDataDir"] = "打开数据目录";
                values["quit"] = "退出 RikkaHub Desktop PLUS";
                values["trayTitle"] = "RikkaHub Desktop PLUS 仍在后台运行";
                values["trayBody"] = "点击托盘图标重新打开，右键托盘菜单可退出。";
                values["lowVramTitle"] = "低显存模式已更新";
                values["lowVramBody"] = "下次启动 RikkaHub Desktop PLUS 时生效。";
                values["startupFailed"] = "RikkaHub Desktop PLUS 启动失败";
                values["startupFailedBody"] = "无法启动 RikkaHub Desktop PLUS 后端服务。";
                values["logLabel"] = "日志";
                values["runtimeTitle"] = "需要 Microsoft Edge WebView2";
                values["runtimeBody"] = "RikkaHub Desktop PLUS 使用系统自带的 Edge WebView2 渲染界面，本机尚未安装。\n\n是否现在打开微软官方下载页面？安装完成后重新打开 RikkaHub Desktop PLUS 即可。";
                values["componentTitle"] = "WebView2 组件缺失";
                values["componentBody"] = "RikkaHub Desktop PLUS 目录里缺少 WebView2 组件文件，请重新解压完整的桌面壳压缩包。\n\n缺少文件：";
                values["serverMissingDetail"] = "未找到 rikkahub-pc.exe。请把桌面壳放在便携版目录内，或在 shell.ini 里配置 serverPath。";
                values["serverTimeout"] = "后端启动超时（90 秒）。";
                values["crashTitle"] = "RikkaHub Desktop PLUS 界面进程异常";
                values["crashBody"] = "界面渲染进程已异常退出，请关闭后重新打开。";
            }
            else
            {
                values["open"] = "Open RikkaHub Desktop PLUS";
                values["closeBehavior"] = "When closing the window";
                values["toTray"] = "Minimize to tray";
                values["quitDirect"] = "Quit the app";
                values["lowVram"] = "Low VRAM mode (software rendering, next launch)";
                values["openDataDir"] = "Open data folder";
                values["quit"] = "Quit RikkaHub Desktop PLUS";
                values["trayTitle"] = "RikkaHub Desktop PLUS is still running";
                values["trayBody"] = "Click the tray icon to reopen. Right-click it to quit.";
                values["lowVramTitle"] = "Low VRAM mode updated";
                values["lowVramBody"] = "Takes effect the next time RikkaHub Desktop PLUS starts.";
                values["startupFailed"] = "RikkaHub Desktop PLUS failed to start";
                values["startupFailedBody"] = "The RikkaHub Desktop PLUS backend did not start.";
                values["logLabel"] = "Log";
                values["runtimeTitle"] = "Microsoft Edge WebView2 is required";
                values["runtimeBody"] = "RikkaHub Desktop PLUS uses the system Edge WebView2 runtime, which is not installed.\n\nOpen the official Microsoft download page now? Reopen RikkaHub Desktop PLUS after installing.";
                values["componentTitle"] = "WebView2 components are missing";
                values["componentBody"] = "The WebView2 files are missing from the RikkaHub Desktop PLUS folder. Please extract the complete desktop shell package.\n\nMissing: ";
                values["serverMissingDetail"] = "rikkahub-pc.exe was not found. Put the desktop shell inside the portable folder, or set serverPath in shell.ini.";
                values["serverTimeout"] = "The backend did not start within 90 seconds.";
                values["crashTitle"] = "RikkaHub Desktop PLUS renderer failed";
                values["crashBody"] = "The UI renderer exited unexpectedly. Please close and reopen the app.";
            }
        }

        public string this[string key]
        {
            get
            {
                string value;
                return values.TryGetValue(key, out value) ? value : key;
            }
        }
    }

    internal sealed class ServerInfo
    {
        public string Origin;
        public string Entry;
        public int Port;
    }

    internal static class ServerLocator
    {
        public static string FindServerExe(AppConfig config)
        {
            List<string> candidates = new List<string>();
            string fromEnv = Environment.GetEnvironmentVariable("RIKKAHUB_SERVER_EXE");
            if (!string.IsNullOrEmpty(fromEnv)) candidates.Add(fromEnv);
            if (!string.IsNullOrEmpty(config.ServerPath))
            {
                candidates.Add(Path.IsPathRooted(config.ServerPath)
                    ? config.ServerPath
                    : Path.Combine(Paths.BaseDir, config.ServerPath));
            }
            candidates.Add(Path.Combine(Paths.BaseDir, "rikkahub-pc.exe"));
            candidates.Add(Path.Combine(Paths.BaseDir, "..", "rikkahub-pc.exe"));

            foreach (string candidate in candidates)
            {
                try
                {
                    if (File.Exists(candidate)) return Path.GetFullPath(candidate);
                }
                catch { }
            }
            return null;
        }

        public static string DataDirFor(string serverExe, AppConfig config)
        {
            if (!string.IsNullOrEmpty(config.DataDir))
            {
                return Path.IsPathRooted(config.DataDir)
                    ? config.DataDir
                    : Path.Combine(Paths.BaseDir, config.DataDir);
            }
            return Path.Combine(Path.GetDirectoryName(serverExe), "pc-data");
        }

        public static string ReadOriginRecord(string dataDir)
        {
            try
            {
                string text = File.ReadAllText(Path.Combine(dataDir, "ui-origin.json"));
                Match match = Regex.Match(text, "\"origin\"\\s*:\\s*\"(http[^\"]+)\"");
                if (match.Success) return match.Groups[1].Value;
            }
            catch { }
            return null;
        }

        /// <summary>
        /// 端口上是否真有东西在听。本机(防火墙丢弃而非拒绝)对死端口的裸 connect 要 2s 才失败、
        /// 走 HttpWebRequest 要撞满 600ms 超时才报错,而候选端口有 21 个 —— 壳"找后端"那 1.9 秒
        /// 全是这笔钱。回环上开着的端口约 1ms 就 accept,所以用带预算的异步 connect 先过一遍,
        /// 只有过了的端口才值得进 HTTP 栈。
        /// </summary>
        private static bool IsPortOpen(int port, int budgetMs)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect("127.0.0.1", port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(budgetMs)) return false;
                    if (!client.Connected) return false;
                    client.EndConnect(ar);
                    return true;
                }
            }
            catch { return false; }
        }

        private static ServerInfo Probe(int port)
        {
            if (!IsPortOpen(port, 150)) return null;
            string origin = "http://localhost:" + port;
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(origin + "/api/health");
                request.Proxy = null;
                request.Timeout = 600;
                request.ReadWriteTimeout = 600;
                request.AllowAutoRedirect = false;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                {
                    string body = reader.ReadToEnd();
                    if (response.StatusCode == HttpStatusCode.OK && body.Contains("\"ok\":true"))
                    {
                        return new ServerInfo { Origin = origin, Entry = origin + "/", Port = port };
                    }
                }
            }
            catch { }
            return null;
        }

        public static ServerInfo FindRunning(AppConfig config, string serverExe)
        {
            List<int> ports = new List<int>();
            HashSet<int> seen = new HashSet<int>();
            Action<int> addPort = delegate(int port)
            {
                if (port > 0 && port < 65536 && seen.Add(port)) ports.Add(port);
            };

            addPort(config.Port);
            if (serverExe != null)
            {
                string recorded = ReadOriginRecord(DataDirFor(serverExe, config));
                if (!string.IsNullOrEmpty(recorded))
                {
                    try
                    {
                        Uri uri = new Uri(recorded);
                        if (uri.Scheme == "http" || uri.Scheme == "https") addPort(uri.Port);
                    }
                    catch { }
                }
            }
            for (int i = 1; i < 20; i++) addPort(config.Port + i);

            // 先并发 connect 筛掉没人听的端口(整批最多 150ms),再按优先级对幸存者做 HTTP 确认。
            // 顺序不能反:/api/health 才是"这就是 RikkaHub 后端"的凭据,但死端口的超时代价太高,
            // 不该让 HTTP 栈去撞 21 次。筛漏了(400ms 内没跑完)也照样 HTTP 探,宁可慢不可漏。
            List<Task<bool>> scans = new List<Task<bool>>();
            foreach (int port in ports)
            {
                int captured = port;
                scans.Add(Task.Factory.StartNew(() => IsPortOpen(captured, 150)));
            }
            try { Task.WaitAll(scans.ToArray(), 400); } catch { }

            for (int i = 0; i < ports.Count; i++)
            {
                if (i < scans.Count && scans[i].Status == TaskStatus.RanToCompletion && !scans[i].Result) continue;
                ServerInfo hit = Probe(ports[i]);
                if (hit != null) return hit;
            }
            return null;
        }
    }

    internal static class Native
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string className, string windowName);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

        private static readonly IntPtr PerMonitorV2 = new IntPtr(-4);

        public static void EnablePerMonitorDpi()
        {
            try { SetProcessDpiAwarenessContext(PerMonitorV2); } catch { }
        }

        public static void ActivateExistingWindow(string title)
        {
            IntPtr window = FindWindow(null, title);
            if (window == IntPtr.Zero) return;
            ShowWindow(window, IsIconic(window) ? 9 : 5);
            SetForegroundWindow(window);
        }
    }

    // 宿主异常退出时 Job 句柄随之关闭，Windows 会一并结束后端进程，避免隐藏控制台的孤儿进程。
    internal static class ServerJob
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimit
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimit
        {
            public BasicLimit BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll")]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length);

        [DllImport("kernel32.dll")]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        private const int ExtendedLimitInformation = 9;
        private const uint KillOnJobClose = 0x2000;
        private static IntPtr job = IntPtr.Zero;

        public static void Attach(Process process)
        {
            try
            {
                if (job == IntPtr.Zero)
                {
                    job = CreateJobObject(IntPtr.Zero, null);
                    if (job == IntPtr.Zero) return;
                    ExtendedLimit limit = new ExtendedLimit();
                    limit.BasicLimitInformation.LimitFlags = KillOnJobClose;
                    int size = Marshal.SizeOf(typeof(ExtendedLimit));
                    IntPtr buffer = Marshal.AllocHGlobal(size);
                    try
                    {
                        Marshal.StructureToPtr(limit, buffer, false);
                        if (!SetInformationJobObject(job, ExtendedLimitInformation, buffer, size))
                        {
                            Log.Write("job limit setup failed: " + Marshal.GetLastWin32Error());
                        }
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buffer);
                    }
                }
                if (!AssignProcessToJobObject(job, process.Handle))
                {
                    Log.Write("job assign failed: " + Marshal.GetLastWin32Error());
                }
            }
            catch (Exception ex)
            {
                Log.Write("job attach failed: " + ex.Message);
            }
        }
    }

    internal static class Program
    {
        private static Mutex instanceMutex;

        [STAThread]
        private static void Main()
        {
            bool created;
            instanceMutex = new Mutex(true, @"Local\RikkaHub.Desktop.Shell", out created);
            if (!created)
            {
                Native.ActivateExistingWindow("RikkaHub Desktop PLUS");
                return;
            }

            Native.EnablePerMonitorDpi();
            // .NET 线程池按需注入(达到 minThreads 后约每 500ms 才补一条线程),而端口扇出探测一次
            // 就要 20 路并发 —— 不抬下限的话大部分探测在排队等线程,找后端凭空多花一秒。
            int minWorker, minIo;
            ThreadPool.GetMinThreads(out minWorker, out minIo);
            if (minWorker < 32) ThreadPool.SetMinThreads(32, minIo);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                Log.Write("unhandled UI exception: " + e.Exception);
                MessageBox.Show(e.Exception.Message, "RikkaHub Desktop PLUS", MessageBoxButtons.OK, MessageBoxIcon.Error);
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                Log.Write("unhandled exception: " + e.ExceptionObject);
            };

            string runtimeVersion = DetectRuntime();
            if (runtimeVersion == null)
            {
                PromptRuntimeInstall();
                return;
            }
            Log.Write("WebView2 runtime " + runtimeVersion);

            AppConfig config = AppConfig.Load(Paths.ConfigPath);
            Application.Run(new MainForm(config));
            GC.KeepAlive(instanceMutex);
        }

        private static string DetectRuntime()
        {
            try
            {
                return CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (Exception ex)
            {
                Log.Write("WebView2 runtime detection failed: " + ex.Message);
                return null;
            }
        }

        private static void PromptRuntimeInstall()
        {
            if (!File.Exists(Path.Combine(Paths.BaseDir, "WebView2Loader.dll")))
            {
                MessageBox.Show(
                    UiStringsForStartup()["componentBody"] + "WebView2Loader.dll",
                    UiStringsForStartup()["componentTitle"],
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            DialogResult answer = MessageBox.Show(
                UiStringsForStartup()["runtimeBody"],
                UiStringsForStartup()["runtimeTitle"],
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (answer != DialogResult.Yes) return;
            try
            {
                Process.Start(new ProcessStartInfo("https://go.microsoft.com/fwlink/p/?LinkId=2124703")
                {
                    UseShellExecute = true,
                });
            }
            catch (Exception ex)
            {
                Log.Write("open WebView2 download failed: " + ex.Message);
            }
        }

        private static UiStrings UiStringsForStartup()
        {
            return new UiStrings();
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly AppConfig config;
        private readonly UiStrings text;
        private readonly WebView2 webView;
        private readonly NotifyIcon tray;
        private readonly Icon appIcon;
        private readonly string splashHtml;

        private ContextMenuStrip trayMenu;
        private CoreWebView2 core;
        private readonly HashSet<string> allowedOrigins = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private Process serverProcess;
        private bool serverOwned;
        private int serverPort;
        private bool quitting;
        private bool shutdownStarted;
        private bool restartingBackend;
        private bool memoryLevelWarned;

        public MainForm(AppConfig config)
        {
            this.config = config;
            text = new UiStrings();
            appIcon = LoadAppIcon();
            splashHtml = LoadTextResource("RikkaHubSplash");

            Text = "RikkaHub Desktop PLUS";
            Icon = appIcon;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(1280, 840);
            MinimumSize = new Size(880, 560);
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Color.FromArgb(247, 247, 248);
            ApplySavedBounds();

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.FromArgb(247, 247, 248);
            Controls.Add(webView);

            tray = new NotifyIcon();
            tray.Icon = appIcon != null ? appIcon : SystemIcons.Application;
            tray.Text = "RikkaHub Desktop PLUS";
            tray.Visible = true;
            tray.MouseClick += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) ShowMain();
            };
            RebuildTrayMenu();

            Shown += OnShown;
            FormClosing += OnFormClosing;
            Resize += delegate
            {
                if (WindowState == FormWindowState.Minimized) ApplyMemoryLevel(true);
                else if (Visible) ApplyMemoryLevel(false);
            };
            VisibleChanged += delegate
            {
                ApplyMemoryLevel(!Visible);
            };
        }

        private static Icon LoadAppIcon()
        {
            try
            {
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("RikkaHubIcon"))
                {
                    return stream == null ? null : new Icon(stream);
                }
            }
            catch (Exception ex)
            {
                Log.Write("load icon failed: " + ex.Message);
                return null;
            }
        }

        private static string LoadTextResource(string name)
        {
            try
            {
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                {
                    if (stream == null) return "";
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        return reader.ReadToEnd();
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Write("load resource failed: " + ex.Message);
                return "";
            }
        }

        private void ApplySavedBounds()
        {
            try
            {
                if (string.IsNullOrEmpty(config.Bounds)) return;
                string[] parts = config.Bounds.Split(',');
                if (parts.Length != 4) return;
                int x, y, width, height;
                if (!int.TryParse(parts[0], out x) || !int.TryParse(parts[1], out y)
                    || !int.TryParse(parts[2], out width) || !int.TryParse(parts[3], out height)) return;
                if (width < 400 || height < 300) return;
                Rectangle saved = new Rectangle(x, y, width, height);
                foreach (Screen screen in Screen.AllScreens)
                {
                    Rectangle work = screen.WorkingArea;
                    Rectangle visible = Rectangle.Intersect(work, saved);
                    if (visible.Width >= 160 && visible.Height >= 120)
                    {
                        int fittedWidth = Math.Min(saved.Width, work.Width);
                        int fittedHeight = Math.Min(saved.Height, work.Height);
                        int fittedX = Math.Max(work.Left, Math.Min(saved.X, work.Right - fittedWidth));
                        int fittedY = Math.Max(work.Top, Math.Min(saved.Y, work.Bottom - fittedHeight));
                        StartPosition = FormStartPosition.Manual;
                        Bounds = new Rectangle(fittedX, fittedY, fittedWidth, fittedHeight);
                        return;
                    }
                }
            }
            catch { }
        }

        private void SaveBounds()
        {
            try
            {
                Rectangle bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                if (bounds.Width < 400 || bounds.Height < 300) return;
                config.Bounds = bounds.X + "," + bounds.Y + "," + bounds.Width + "," + bounds.Height;
                config.Save(Paths.ConfigPath);
            }
            catch { }
        }

        private async void OnShown(object sender, EventArgs e)
        {
            Shown -= OnShown;
            try
            {
                Directory.CreateDirectory(Paths.WebViewDataDir);
                CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions();
                List<string> arguments = new List<string>();
                arguments.Add("--disk-cache-size=83886080");
                arguments.Add("--media-cache-size=20971520");
                if (config.LowVramMode) arguments.Add("--disable-gpu");
                string extraArguments = Environment.GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
                if (!string.IsNullOrEmpty(extraArguments)) arguments.Add(extraArguments);
                options.AdditionalBrowserArguments = string.Join(" ", arguments.ToArray());

                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewDataDir, options);
                await webView.EnsureCoreWebView2Async(environment);
                if (IsDisposed) return;
                core = webView.CoreWebView2;
                await ConfigureWebViewAsync();
                if (!string.IsNullOrEmpty(splashHtml)) core.NavigateToString(splashHtml);

                Log.Write("locating backend");
                ServerInfo server = await EnsureServerAsync();
                if (IsDisposed || quitting) return;
                AllowOrigin(server.Origin);
                // 端口与上次不同时,后端把 Entry 留在旧 origin 的 relay 页上(先迁 localStorage
                // 再跳新端口)。这个 origin 也必须放行,否则会被当成外链交给系统浏览器。
                AllowOrigin(server.Entry);
                Log.Write("navigate " + server.Entry);
                core.Navigate(server.Entry);
            }
            catch (Exception ex)
            {
                Log.Write("initialize failed: " + ex);
                if (quitting) return;
                MessageBox.Show(
                    this,
                    ex.Message + "\n\n" + text["logLabel"] + ": " + Paths.LogPath,
                    text["startupFailed"],
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                QuitApp();
            }
        }

        private async Task ConfigureWebViewAsync()
        {
            CoreWebView2Settings settings = core.Settings;
            settings.AreDevToolsEnabled = false;
            settings.AreDefaultContextMenusEnabled = true;
            settings.IsStatusBarEnabled = false;
            settings.IsSwipeNavigationEnabled = false;
            settings.IsZoomControlEnabled = true;
            settings.AreBrowserAcceleratorKeysEnabled = true;
            settings.AreHostObjectsAllowed = false;
            settings.IsWebMessageEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;

            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += OnNewWindowRequested;
            core.PermissionRequested += OnPermissionRequested;
            core.ProcessFailed += OnProcessFailed;

            // 页面据此知道自己在桌面壳里(Tauri 走 __TAURI_INTERNALS__,这里不是 Tauri)。
            // 端口页的「保存并重启应用」按钮和 rikkahub://restart 都依赖这个标记。
            try
            {
                await core.AddScriptToExecuteOnDocumentCreatedAsync(
                    "window.__RIKKAHUB_SHELL__ = 'webview2';");
            }
            catch (Exception ex)
            {
                Log.Write("inject shell marker failed: " + ex.Message);
            }
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            string uri = e.Uri ?? "";
            if (uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)
                || uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
                || uri.StartsWith("file:", StringComparison.OrdinalIgnoreCase)
                || uri.StartsWith("blob:", StringComparison.OrdinalIgnoreCase)) return;
            if (IsShellCommand(uri)) { e.Cancel = true; return; }
            if (IsAppUri(uri)) return;
            e.Cancel = true;
            OpenExternal(uri);
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            if (IsShellCommand(e.Uri)) return;
            if (IsAppUri(e.Uri)) core.Navigate(e.Uri);
            else OpenExternal(e.Uri);
        }

        /// <summary>
        /// 页面 → 壳的最小控制通道:自定义协议导航,不开放 HostObject/WebMessage。
        /// 目前只认 rikkahub://restart(端口保存后重启后端并重新导航)。
        /// </summary>
        private bool IsShellCommand(string uri)
        {
            if (uri == null) return false;
            if (!uri.StartsWith("rikkahub://restart", StringComparison.OrdinalIgnoreCase)) return false;
            Log.Write("restart requested by page");
            BeginBackendRestart();
            return true;
        }

        private async void BeginBackendRestart()
        {
            if (restartingBackend) return;
            restartingBackend = true;
            try
            {
                if (!string.IsNullOrEmpty(splashHtml)) core.NavigateToString(splashHtml);
                allowedOrigins.Clear();
                await ShutdownServerAsync();
                // 等旧后端彻底松口:FindRunning 只要探到端口就 attach,太早会连回正在退出的实例。
                await Task.Delay(600);
                if (IsDisposed || quitting) return;
                Log.Write("restarting backend");
                ServerInfo server = await EnsureServerAsync();
                if (IsDisposed || quitting) return;
                AllowOrigin(server.Origin);
                AllowOrigin(server.Entry);
                Log.Write("restart navigate " + server.Entry);
                core.Navigate(server.Entry);
            }
            catch (Exception ex)
            {
                Log.Write("restart failed: " + ex);
                if (!IsDisposed && !quitting)
                {
                    MessageBox.Show(
                        this,
                        ex.Message + "\n\n" + text["logLabel"] + ": " + Paths.LogPath,
                        text["startupFailed"],
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
            }
            finally
            {
                restartingBackend = false;
            }
        }

        private void OnPermissionRequested(object sender, CoreWebView2PermissionRequestedEventArgs e)
        {
            if (e.PermissionKind == CoreWebView2PermissionKind.Notifications && IsAppUri(e.Uri))
            {
                e.State = CoreWebView2PermissionState.Allow;
            }
            else
            {
                e.State = CoreWebView2PermissionState.Default;
            }
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            Log.Write("webview process failed: " + e.ProcessFailedKind);
            if (!quitting)
            {
                ShowBalloon(text["crashTitle"], text["crashBody"]);
            }
        }

        /// <summary>放行一个 origin(及其 loopback 双生);参数可以是完整 URL 或 origin。</summary>
        private void AllowOrigin(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return;
            try
            {
                string origin = new Uri(uri).GetLeftPart(UriPartial.Authority);
                if (string.IsNullOrEmpty(origin)) return;
                allowedOrigins.Add(origin);
                string twin = SwapLoopback(origin);
                if (twin != null) allowedOrigins.Add(twin);
            }
            catch { }
        }

        private bool IsAppUri(string uri)
        {
            try
            {
                string origin = new Uri(uri).GetLeftPart(UriPartial.Authority);
                return allowedOrigins.Contains(origin);
            }
            catch
            {
                return false;
            }
        }

        private static string SwapLoopback(string origin)
        {
            if (origin.IndexOf("://localhost", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return origin.Replace("://localhost", "://127.0.0.1");
            }
            if (origin.IndexOf("://127.0.0.1", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return origin.Replace("://127.0.0.1", "://localhost");
            }
            return null;
        }

        private static void OpenExternal(string uri)
        {
            try
            {
                Uri parsed = new Uri(uri);
                if (parsed.Scheme == "http" || parsed.Scheme == "https" || parsed.Scheme == "mailto")
                {
                    Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
                }
            }
            catch (Exception ex)
            {
                Log.Write("open external failed: " + ex.Message);
            }
        }

        private async Task<ServerInfo> EnsureServerAsync()
        {
            string serverExe = ServerLocator.FindServerExe(config);
            ServerInfo running = await Task.Factory.StartNew(() => ServerLocator.FindRunning(config, serverExe));
            if (running != null)
            {
                serverOwned = false;
                serverPort = running.Port;
                Log.Write("attach to " + running.Origin);
                return running;
            }
            if (serverExe == null) throw new Exception(text["serverMissingDetail"]);

            string dataDir = ServerLocator.DataDirFor(serverExe, config);
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = serverExe;
            startInfo.Arguments = "--no-open --ui-shell";
            startInfo.WorkingDirectory = Path.GetDirectoryName(serverExe);
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.StandardOutputEncoding = Encoding.UTF8;
            startInfo.StandardErrorEncoding = Encoding.UTF8;
            startInfo.EnvironmentVariables["RIKKAHUB_SHELL"] = "webview2";
            // 后端进程树(PowerShell 打包/解包、stdio MCP)和 Bun 单文件 exe 启动期的原生
            // 模块解包都往 TEMP 里写。重定向到数据目录,便携版才真正"数据不出目录"——
            // JS 侧还会再设一次(覆盖直接启动 exe 的场景),这里是唯一能覆盖解包阶段的点。
            string stagingTempDir = Path.Combine(dataDir, "tmp");
            try { Directory.CreateDirectory(stagingTempDir); } catch { }
            startInfo.EnvironmentVariables["TEMP"] = stagingTempDir;
            startInfo.EnvironmentVariables["TMP"] = stagingTempDir;
            if (!string.IsNullOrEmpty(config.DataDir))
            {
                startInfo.EnvironmentVariables["RIKKAHUB_PC_DATA_DIR"] = dataDir;
            }

            Log.Write("spawn " + serverExe + " (data " + dataDir + ")");
            TaskCompletionSource<ServerInfo> ready = new TaskCompletionSource<ServerInfo>();
            object gate = new object();
            string origin = null;
            string entry = null;
            int port = 0;
            bool fallbackStarted = false;

            Action complete = delegate
            {
                lock (gate)
                {
                    if (string.IsNullOrEmpty(origin)) return;
                    if (port <= 0)
                    {
                        try { port = new Uri(origin).Port; } catch { return; }
                    }
                    if (!ready.Task.IsCompleted)
                    {
                        string finalEntry = string.IsNullOrEmpty(entry) ? origin + "/" : entry;
                        ready.TrySetResult(new ServerInfo { Origin = origin, Entry = finalEntry, Port = port });
                    }
                }
            };

            Action<string> handleLine = delegate(string line)
            {
                if (line == null) return;
                Log.Write("[server] " + line);
                if (line.StartsWith("RIKKAHUB_UI_ORIGIN:", StringComparison.Ordinal))
                {
                    origin = line.Substring("RIKKAHUB_UI_ORIGIN:".Length).Trim().TrimEnd('/');
                    lock (gate)
                    {
                        if (!fallbackStarted)
                        {
                            fallbackStarted = true;
                            Task.Delay(2000).ContinueWith(delegate { complete(); });
                        }
                    }
                }
                else if (line.StartsWith("RIKKAHUB_UI_ENTRY:", StringComparison.Ordinal))
                {
                    entry = line.Substring("RIKKAHUB_UI_ENTRY:".Length).Trim();
                }
                else if (line.StartsWith("RIKKAHUB_PORT:", StringComparison.Ordinal))
                {
                    int parsed;
                    if (int.TryParse(line.Substring("RIKKAHUB_PORT:".Length).Trim(), out parsed)) port = parsed;
                    complete();
                }
            };

            Process process = new Process();
            process.StartInfo = startInfo;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { handleLine(e.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { handleLine(e.Data); };
            process.Exited += delegate
            {
                if (!ready.Task.IsCompleted)
                {
                    ready.TrySetException(new Exception("后端进程提前退出。"));
                }
                else if (!quitting && !restartingBackend)
                {
                    Log.Write("server exited unexpectedly");
                    ShowBalloon("RikkaHub Desktop PLUS", "RikkaHub Desktop PLUS 后端服务已退出，请从托盘退出后重新打开。");
                }
            };

            try
            {
                process.Start();
            }
            catch (Exception ex)
            {
                throw new Exception("无法启动后端进程：" + ex.Message, ex);
            }
            serverProcess = process;
            serverOwned = true;
            ServerJob.Attach(process);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            Task completed = await Task.WhenAny(ready.Task, Task.Delay(90000));
            if (completed != ready.Task)
            {
                try { if (!process.HasExited) process.Kill(); } catch { }
                throw new TimeoutException(text["serverTimeout"]);
            }
            ServerInfo info = await ready.Task;
            serverPort = info.Port;
            return info;
        }

        private async Task ShutdownServerAsync()
        {
            Process process = serverProcess;
            serverProcess = null;
            bool owned = serverOwned;
            serverOwned = false;
            Log.Write("shutdown start owned=" + owned + " port=" + serverPort);
            if (!owned || process == null) return;

            if (serverPort > 0)
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                        "http://127.0.0.1:" + serverPort + "/api/app/shutdown");
                    request.Method = "POST";
                    request.ContentLength = 0;
                    request.Proxy = null;
                    request.Timeout = 4000;
                    request.ReadWriteTimeout = 4000;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        Log.Write("shutdown endpoint " + (int)response.StatusCode);
                    }
                }
                catch (Exception ex)
                {
                    Log.Write("graceful shutdown failed: " + ex.Message);
                }
                await Task.Delay(350);
            }
            try
            {
                if (!process.HasExited)
                {
                    Log.Write("kill backend pid " + process.Id);
                    process.Kill();
                }
            }
            catch (Exception ex)
            {
                Log.Write("kill backend failed: " + ex.Message);
            }
            try { process.Dispose(); } catch { }
            Log.Write("shutdown done");
        }

        private void ApplyMemoryLevel(bool low)
        {
            try
            {
                if (core == null) return;
                core.MemoryUsageTargetLevel = low
                    ? CoreWebView2MemoryUsageTargetLevel.Low
                    : CoreWebView2MemoryUsageTargetLevel.Normal;
            }
            catch (Exception ex)
            {
                if (!memoryLevelWarned)
                {
                    memoryLevelWarned = true;
                    Log.Write("memory target level failed: " + ex.Message);
                }
            }
        }

        private void ShowMain()
        {
            if (quitting) return;
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
            ApplyMemoryLevel(false);
        }

        private void HideToTray()
        {
            Hide();
            ApplyMemoryLevel(true);
            if (!config.TrayHintShown)
            {
                config.TrayHintShown = true;
                config.Save(Paths.ConfigPath);
                ShowBalloon(text["trayTitle"], text["trayBody"]);
            }
        }

        private void ShowBalloon(string title, string body)
        {
            try
            {
                tray.ShowBalloonTip(3000, title, body, ToolTipIcon.Info);
            }
            catch { }
        }

        private void QuitApp()
        {
            if (quitting) return;
            quitting = true;
            Hide();
            StartShutdown();
        }

        private async void StartShutdown()
        {
            if (shutdownStarted) return;
            shutdownStarted = true;
            Log.Write("start shutdown");
            try
            {
                Task shutdown = ShutdownServerAsync();
                await Task.WhenAny(shutdown, Task.Delay(7000));
            }
            catch (Exception ex)
            {
                Log.Write("shutdown failed: " + ex);
            }
            try
            {
                if (!IsDisposed) Close();
                Application.Exit();
            }
            catch { }
            Log.Write("start shutdown finished");
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            Log.Write("form closing reason=" + e.CloseReason + " tray=" + config.MinimizeToTray + " quitting=" + quitting);
            SaveBounds();
            if (quitting) return;
            if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing)
            {
                Log.Write("system closing, best-effort flush");
                FlushServerBeforeSystemExit();
                return;
            }
            if (config.MinimizeToTray)
            {
                e.Cancel = true;
                HideToTray();
                return;
            }
            e.Cancel = true;
            quitting = true;
            Hide();
            StartShutdown();
        }

        private void FlushServerBeforeSystemExit()
        {
            if (!serverOwned || serverPort <= 0) return;
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + serverPort + "/api/app/shutdown");
                request.Method = "POST";
                request.ContentLength = 0;
                request.Proxy = null;
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    Log.Write("system close flush " + (int)response.StatusCode);
                }
            }
            catch (Exception ex)
            {
                Log.Write("system close flush failed: " + ex.Message);
            }
        }

        private void RebuildTrayMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add(Item(text["open"], delegate { ShowMain(); }));
            menu.Items.Add(new ToolStripSeparator());
            ToolStripMenuItem header = new ToolStripMenuItem(text["closeBehavior"]);
            header.Enabled = false;
            menu.Items.Add(header);

            ToolStripMenuItem toTray = new ToolStripMenuItem(text["toTray"]);
            toTray.Checked = config.MinimizeToTray;
            toTray.Click += delegate
            {
                config.MinimizeToTray = true;
                config.Save(Paths.ConfigPath);
                RebuildTrayMenu();
            };
            menu.Items.Add(toTray);

            ToolStripMenuItem direct = new ToolStripMenuItem(text["quitDirect"]);
            direct.Checked = !config.MinimizeToTray;
            direct.Click += delegate
            {
                config.MinimizeToTray = false;
                config.Save(Paths.ConfigPath);
                RebuildTrayMenu();
            };
            menu.Items.Add(direct);

            menu.Items.Add(new ToolStripSeparator());
            ToolStripMenuItem lowVram = new ToolStripMenuItem(text["lowVram"]);
            lowVram.Checked = config.LowVramMode;
            lowVram.Click += delegate
            {
                config.LowVramMode = !config.LowVramMode;
                config.Save(Paths.ConfigPath);
                RebuildTrayMenu();
                ShowBalloon(text["lowVramTitle"], text["lowVramBody"]);
            };
            menu.Items.Add(lowVram);
            menu.Items.Add(Item(text["openDataDir"], delegate { OpenDataDir(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(Item(text["quit"], delegate { QuitApp(); }));

            tray.ContextMenuStrip = menu;
            ContextMenuStrip previous = trayMenu;
            trayMenu = menu;
            if (previous != null) previous.Dispose();
        }

        private static ToolStripMenuItem Item(string label, EventHandler handler)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(label);
            item.Click += handler;
            return item;
        }

        private void OpenDataDir()
        {
            try
            {
                string serverExe = ServerLocator.FindServerExe(config);
                string dir = serverExe != null ? ServerLocator.DataDirFor(serverExe, config) : Paths.BaseDir;
                if (!Directory.Exists(dir)) dir = Paths.BaseDir;
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dir + "\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Log.Write("open data dir failed: " + ex.Message);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (tray != null)
                {
                    tray.Visible = false;
                    tray.Dispose();
                }
                if (trayMenu != null) trayMenu.Dispose();
                if (appIcon != null) appIcon.Dispose();
                if (webView != null) webView.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
