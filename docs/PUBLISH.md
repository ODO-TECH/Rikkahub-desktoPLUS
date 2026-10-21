# 把这个目录推到 GitHub

面向「手上只有这台 Windows 机器、不想碰命令行细节」的发布流程。命令都在 **Git Bash**
里执行（装 Git for Windows 后开始菜单里的 *Git Bash*，用哪个安装都一样）。

## 0. 先确认提交身份（这一步决定别人能不能从 commit 反查到你）

这个目录已经 `git init` 并做过提交，作者姓名/邮箱写在 commit 元数据里 ——
GitHub 页面上任何人点开提交都能看到。本仓库当前设的是**仓库级署名身份**
（只影响这一个仓库，不动全局 git 配置）：

```bash
cd "<这个目录的路径>"
git config user.name            # ODO-TECH
git config user.email           # 233463747+ODO-TECH@users.noreply.github.com
```

`233463747+ODO-TECH@users.noreply.github.com` 是 GitHub 为该账号分配的匿名转发邮箱：
提交会挂到 [@ODO-TECH](https://github.com/ODO-TECH) 名下并计入贡献图，真实邮箱不会出现。
数字 ID 是该账号的固定前缀，不要手改成别的数字。

**不要用真实邮箱**，一旦推上去，邮箱就永久公开（GitHub 上没有真正删干净的 history：
fork、爬虫、Google 缓存都会留下）。

## 1. 在 GitHub 建一个空仓库

New repository → 仓库名用 `Rikkahub-desktoPLUS` → **只建空仓库**：
不要勾 "Add a README"、不要选 LICENSE、不要加 `.gitignore` —— 这三个都会让首次推送
因为「远端已有提交」而失败。可见性选 Public（这就是个开源分支）。

README、关于页、侧栏与崩溃报告按钮里的链接都按 `ODO-TECH/Rikkahub-desktoPLUS` 写死了。
换仓库名就要同步改 `web-ui/app/components/settings/about.tsx`、
`web-ui/app/components/conversation-sidebar.tsx`、`web-ui/app/components/startup-gate.tsx`
与 `web-ui/src-tauri/tauri.conf.json`。Docker 镜像名保持小写 `rikkahub-desktop-plus`
（镜像名不允许大写），与仓库名无关。

### 仓库简介（About）

GitHub 仓库页右上角的 Description 建议直接填：

> RikkaHub Desktop 的社区增强分支：Windows 原生 WebView2 壳、SQLite 本地数据、stdio MCP、SSH 远程设备、Kelivo 同步与 12 项备份，并提供飞牛 OS / Docker 自托管部署。

Topics 建议：`llm` `ai-client` `desktop-app` `docker` `self-hosted` `bun` `react` `tauri`
`webview2` `mcp` `sqlite` `ssh` `nas` `fnos` `windows` `linux`。

## 2. 推上去

```bash
cd "<这个目录的路径>"
git remote add origin https://github.com/ODO-TECH/<仓库名>.git
git push -u origin main
```

如果提示要登录：Git Bash 会弹浏览器让你授权（GitHub 的 OAuth），按提示点确认即可。
用户名/仓库名如果拼错了：`git remote set-url origin https://github.com/<对的>/.git`。

## 3. 推送后立刻自查这三件事

1. **打开仓库文件树**，确认没有 `pc-data/`、`node_modules/`、`dist/`、`web-ui/build/`、
   `desktop-shell/sdk/`、`desktop-shell/dist/`。这些都是本机产物与隐私数据，
   `.gitignore` 已经拦住，肉眼再确认一次不亏。
2. **用 GitHub 的代码搜索查你自己**：在仓库页面上按 `.` 打开搜索，
   输入你的邮箱、QQ/手机号、Windows 用户名、网盘链接特征，期望结果都是 **0 命中**。
3. **看 Actions 页**：推送后 CI（typecheck + 单元测试 + 冒烟）、Docker 镜像构建会自动跑。
   Docker 工作流会把镜像发到 `ghcr.io/<你的用户名>/<仓库名>`（公开仓库不额外收费）。
   不想发镜像就在仓库 Settings → Actions 里关掉，或者删掉
   `.github/workflows/docker-publish.yml`。

## 4. 后续怎么更新

```bash
git add -A
git commit -m "说明这次改了什么"
git push
```

改之前建议先跑一遍门禁，别把红的项目推上去：

```bash
cd pc-server && bun run typecheck && bun test
```

## 5. 不要做的事

- 不要把 `pc-data/` 里的任何东西拖进仓库，也不要为了「给个示例数据」提交一个真的
  `state.json` —— 里面有 API Key、会话标题和 SSH 主机。
- 不要在仓库里放你自己机器上的截图当 README 配图，截图里常有会话标题、供应商名、
  邮箱和路径。要配图就放干净的演示图或上游的官方图。
- 不要提交安装包（`*.exe`、`*.zip`）到源码仓库：那是 100 MB+ 的二进制，会把仓库历史
  永久撑大；要发版就发到 **Releases**。
- 已经推出去的东西要「撤回」是不成立的：force push 只改 GitHub 上的显示，
  别人 fork / Actions 缓存 / 搜索引擎都还可能留着。所以第一次推送前，
  上面第 3 步的自查一定要做完。
