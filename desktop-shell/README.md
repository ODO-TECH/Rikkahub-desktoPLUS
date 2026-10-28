# desktop-shell — RikkaHub Desktop PLUS 的 Windows 原生壳（WinForms + 系统 WebView2）

English: the thin native Windows shell of RikkaHub Desktop PLUS. It hides the Bun backend, opens one
WebView2 window, and lives in the tray. It is deliberately **not** Electron: it
reuses the Edge WebView2 runtime that ships with Windows 10 1809+ / Windows 11,
so the whole shell is a ~200 KB `RikkaHub.exe` instead of a ~150 MB Chromium
bundle.

## 为什么不用 Electron / Chromium

内测这台机器上的实测结论（见 `docs/BUILD.md` 的启动耗时一节）：壳窗口 + 系统
WebView2 + 启动屏只占约 0.6–1.2 s，而自带一份 Chromium 会让安装包膨胀到 100 MB+
并带来独立的 CVE 维护面。系统 WebView2 是常青运行时（Edge 更新即随之更新），
Windows 10 1809 以上默认已安装，缺失时前端页面会提示用户按官方引导安装。

## 编译

```cmd
fetch-sdk.cmd    &REM 拉 WebView2 SDK 的 3 个引用 dll 到 sdk\lib（约 0.9 MB，不入库）
build.cmd        &REM 用系统自带的 csc.exe（.NET Framework 4.8）编出 dist\RikkaHub.exe
```

只需要：Windows 10/11（自带 .NET Framework 4.8 与 `csc.exe`）、能访问 nuget.org。
`build.cmd` 不依赖 Visual Studio、不需要 MSBuild，`Program.cs` 单文件编译，
`icon.ico` 与 `splash.html` 以 Win32 资源形式嵌进 exe。

## 便携版目录布局

`dist\RikkaHub.exe` 要和后端产物平铺在同一目录，壳会在此目录下找
`rikkahub-pc.exe` 并把数据落在 `<同目录>\pc-data\`：

```
RikkaHub_portable/
  RikkaHub.exe              <- 本目录 build.cmd 的产物
  rikkahub-pc.exe           <- pc-server `bun run compile` 的产物
  web-ui/build/client/      <- 前端静态资源
  fonts/  icons/            <- 内置字体与品牌图标
  pc-data/                  <- 运行时数据（自动生成，属于用户，切勿提交）
  Microsoft.Web.WebView2.Core.dll / .WinForms.dll / WebView2Loader.dll
```

## 行为要点

- **启动**：先在同一目录找已运行的后端（端口探活），有则直接接窗口，无则隐藏
  控制台拉起 `rikkahub-pc.exe`；期间显示 `splash.html` 启动屏。
- **关闭策略**：右上角 × 默认进托盘常驻，托盘菜单可「直接退出」（先优雅停后端）。
- **防孤儿**：后端进程挂在壳的 Job Object 上，壳被强杀时子进程一并回收。
- **重启**：前端可通过自定义协议 `rikkahub://restart` 让壳停掉后端再拉起
  （改端口等场景）；壳同时向页面注入 `window.__RIKKAHUB_SHELL__`，前端用
  `isDesktopShell()` 判断桌面形态。
- **受限沙盒自重启**：开启受限沙盒后，壳拉起的首个后端是"准备进程"——它标注目录、
  拉起低完整性后端后即退出，不输出端口标记。壳对这种"提前退出"不按故障处理，而是
  轮询同一端口最多 30 秒，探到 `/api/health` 即接上；真正的启动失败走
  `RIKKAHUB_FATAL:` 单行标记快速弹窗。低完整性后端作为孙进程仍在 Job 里，壳退出照常回收。
- **缓存**：WebView2 用户数据目录固定在 `<便携根>\webview2-data\`，磁盘配额 80 MB。

## 图标

`icon.ico` 由 `make_icon.py` 从上游 Android 仓库的 launcher 素材生成；只有上游
图标换了才需要重跑，脚本会把上游仓库常见目录名都试一遍，也可以直接传路径。

## 调试

`cdp-startup.js` 是冷启动取证脚本：用
`set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`
启动壳，再 `node cdp-startup.js <进程启动毫秒时间戳>`，会打印首屏资源与
document 耗时。测完请用应用内退出（或 `POST /api/app/shutdown`）收尾，别
`taskkill`——那会在 `pc-data/logs/` 留下未正常退出的告警与崩溃存档。
