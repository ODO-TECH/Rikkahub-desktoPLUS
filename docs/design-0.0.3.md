# RikkaHub Desktop PLUS 0.0.3 设计方案

- 版本：0.0.3
- 范围：① 对话文件侧边栏（预览 / 修改）；② 外挂媒体生成（图片 / 视频，模型可调用）；③ 记忆的语义索引与召回（Embedding / Rerank）
- 上游参照：RikkaHub 移动端 3.1.0（`reference/rikkahub-android`，tag 3.1.0）
- 落地代码：`rikkahub-desktop-plus/`（Bun + React Router + WebView2 壳）

---

## 0. 结论先行

**特性 A 不需要新造布局。** rdp 已经有右侧 Workbench 面板（`WorkbenchHost` + `PANEL_RENDERERS`），也有只读的工作区文件面板。0.0.3 把它扩成「对话文件」面板：工作区树 + 会话附件 + 生成产出三个来源，加编辑、保存、冲突检测，并让普通对话也能打开。

**特性 B 不能直接「移植」移动端。** 移动端 3.1.0 的媒体生成是**纯手动入口**（ChatDrawer → `MediaCreationPage`），`ai/` 工具层里没有任何媒体生成工具。rdp 要做「对话中由模型调用」，需要新增一层桌面自己的工具（`generate_image` / `generate_video`）+ 会话级开关 + 审批 + 异步任务轮询。供应商协议、默认地址、模型清单、能力矩阵可以逐项对齐移动端，这部分是移植；工具编排是新增。

**两条链路可以共用现有基础设施：**

- 审批：`tools/approval.ts` 的 `initialApprovalState` + `tool-loop.ts` 的批前扫描，媒体工具默认 pending。
- 进度：`ToolContext.onToolPartialOutput`（聊天）/ pi `onUpdate`，现有 bash 流式输出同一条管线。
- 落盘与渲染：`filesDir` + `state.files` + `/api/files/:id/content`，消息 part 已支持 `image` / `video` / `audio`。
- 侧边栏：`WorkbenchPanel { type, title, payload }`，新增一个 renderer 即可，不需要多面板重构。

**特性 C 不是把 MCPulse-RAG 搬进来。** 参考项目是「Python + Qdrant + MCP」的知识库；rdp 的记忆已经是 SQLite 里的几十到几百条短句。正确做法是复用现有供应商凭据调 `/embeddings` 与 `/rerank`，把向量写进同一个库、在进程内做余弦检索——不引外部向量库、不做 MCP、不碰 Qdrant。同时保留现有的会话级冻结：召回只在会话首次编码时算一次，不会每轮重刷 system、打穿前缀缓存。代价是开场多一次短请求；收益是记忆多了以后不再把整包灌进提示词。

**本次交付进度**：特性 A 已完成；特性 C 只落了第一刀——**嵌入 / 重排模型可选、可检、可出站，并已能在「场景模型」里指定为全局档位**（见 C0），向量表、索引任务、召回管线、记忆设置卡片都还没开始；特性 B 仍是方案态。

---

## 1. 现状盘点（设计依据）

| 能力 | 现状 | 结论 |
| --- | --- | --- |
| 右侧面板 | `web-ui/app/components/workbench/workbench-host.tsx`，`PANEL_RENDERERS` 按 `panel.type` 派发，单面板 | 直接扩类型，不做多面板 |
| 工作区文件面板 | `workspace-files-panel.tsx`：懒加载树、单击预览、重命名/删除/定位、AGENTS.md 编辑 | 复用树与预览，补编辑器 |
| 文件 API | `GET workspaces/:id/files`、`GET files/content`、rename/delete/reveal | **缺** `PUT content`；预览 512KB 截断 |
| 边界与限额 | `assertInsideWorkspace`（realpath + 分隔符前缀）、读 512KB、写 2MB | 编辑沿用同一套边界 |
| 普通对话 | `CHAT_CONTAINER`，`conversation.workspaceId` 为空 | 附件/产出必须能脱离工作区查看 |
| 附件 URL | 消息 part 里是 `/api/files/:id/content` 或 `/api/files/path/...` | 侧边栏可反查 fileId |
| 文件内容响应 | `new Response(Bun.file(...))`，**不处理 Range** | 视频需要补 206 |
| 媒体渲染 | `message-part.tsx` 已渲染 `image` / `video` / `audio` / `document` | 产出可直接内联 |
| 现有生图 | `pc-server/media/image-gen.ts` + `/api/images/generate`，是「生图页」手动功能，不是工具 | 保留；新链路独立 |
| 设置切片 | `foundation/types/settings/*` 聚合进 `Settings`；`app-config/defaults.ts` | 新增媒体切片即可 |
| 会话持久化 | SQLite `pc_conversation`，幂等 ALTER 迁移，INSERT/UPDATE + dump 列清单 | 新增会话字段需同步 5 处 |
| 工具装配 | `tools/bound.ts#conversationFunctionTools(assistant, model)`；pi 走 `pi-engine/general-tools.ts` | 需把 conversation 传进聚合器 |
| 工具上下文 | `ToolContext` 有 `conversationId`，没有 conversation 对象 | 执行层用 `peekConversation` 读取 |
| 记忆存储 | SQLite `pc_memory` / `pc_memory_pending` / `pc_meta`，内存态整快照事务写 | 向量加同库新表，不参与整快照重写 |
| 记忆注入 | `memoriesForAssistant()` 合并全局 + 助手层，`buildMemoryPrompt()` 整包 JSON | 召回层只改「注入哪些」，不改格式 |
| 记忆块冻结 | `context-snapshots.ts` 按会话冻结，保护前缀缓存 | 召回结果同样冻结，手动刷新才重算 |
| EMBEDDING 模型 | 原为「`Model.type` 三值之一但未参与路由」；**本次已补出线路**：`/embeddings`、`/rerank` 两条真实请求 + 检测分流（`pc-server/model-providers/embeddings.ts`） | 复用供应商 / 凭据链路；重排新增 `Model.type = "RERANK"`（出安卓时剔除，见 C8） |
| 移动端媒体生成 | 独立 `mediagen` 模块；`MediaCreationService` 手动任务；**无 LLM 工具** | 协议移植，工具新增 |
| 移动端上传桶 | `uploadS3Config` 与备份 `s3Config` **分离**；S3 预签名 24h、对象保留 7 天、前缀 `rikkahub_uploads/` | 桌面新增同名字段，新增 presign |

---

# 特性 A：对话文件侧边栏

## A1. 目标与非目标

**目标**

1. 任意对话（含普通对话）都能从输入框旁打开右侧「文件」面板。
2. 面板聚合三个来源：当前工作区文件、本会话附件、本会话生成产出。
3. 文本文件可预览、可编辑、可保存；保存有冲突检测；关闭未保存标签有确认。
4. 工作区对话里，能一眼看到「这次对话 AI 改了哪些文件」，点开即看。
5. 与现有 Workbench 宽度记忆、移动端 Drawer 行为一致。

**非目标（0.0.3 不做）**

- 不新建左侧文件树（Qoder 的主侧栏形态），不替代现有左侧会话栏。
- 不做文件新建、拖拽移动、批量重命名（重命名已有右键菜单）。
- 不做多根工作区、不做跨工作区搜索。
- 不引入 Monaco / CodeMirror；0.0.3 用「高亮预览 + 纯文本编辑」。
- 不做 `fs.watch` 实时同步（v1 用事件 + 焦点刷新）。
- 不编辑非工作区文件（上传附件与生成产出只读）。

## A2. 面板结构

面板不再嵌在白色内容卡的内层，而是与一级分栏平级的独立浮卡，**镜像左侧栏**：上下留 8px 画布边距、18px 圆角、`bg-sidebar` 底色 + `--ds-elevation-100` 阴影；头部与左栏用户行左右镜像——左栏是「头像 + 标题 … 收起钮（卡内侧）」，右栏是「关闭钮（卡内侧，朝中央）… 标题 + 类型副标题 + 图标胶囊（卡外侧）」，两枚按钮距各自卡内边的距离一致（≈24px），头区同为 `p-2 pt-3`、内容行同为 `px-2.5 py-2.5`。内容区仍是白底 `surface-200`。

右栏卡贴着分栏根节点，根节点的 `overflow:hidden` 会把 `elevation-100` 向外的投影裁掉靠窗三面，只剩卡内一道几乎看不见的白高光，看起来就比左栏「平」。外投影拿不回来，用 `1px rgba(0,0,0,.06)` 实边补轮廓（1x 下与左栏 220–235 的边线同量级），elevation 的白高光留在边内侧，仍是同一张浮起的纸。

单面板，内部两个视图：文件列表 + 文件视图；窄宽度时退化为「列表 → 详情」带返回。

```
┌ ✕ ────────────────────────── 文件 ▣ ┐
│ [工作区] [附件 4] [产出 2]        ⟳  ⋯  │
├───────────────┬─────────────────────────┤
│ 筛选…          │  a.ts ×   b.md ×        │
│ ▾ 本次改动 (3) │ ┌─────────────────────┐ │
│   src/app.ts ● │ │ 预览 | 编辑 | 差异   │ │
│   AGENTS.md ●  │ │                     │ │
│ ▾ 文件树       │ │  1  import ...      │ │
│   ▾ src        │ │  2  ...             │ │
│     app.ts     │ │                     │ │
│   README.md    │ └─────────────────────┘ │
│                │  已保存 · 12.4 KB · LF  │
└───────────────┴─────────────────────────┘
```

- 顶部页签只在有工作区时显示「工作区」；普通对话只显示「附件 / 产出」。
- 「工作区」页签内先给「本次改动」分组（来自当前会话 `write` / `edit` 工具调用，倒序），再给完整文件树。
- 文件视图顶部是已打开文件页签（多文件），右侧 `⋯` 提供「在资源管理器中显示 / 用默认应用打开 / 复制路径 / 保存」。
- 面板宽度默认 36%、最小 20%、最大 60%（均为组宽百分比），拖过分隔条后记住；窄于 420px 时列表与文件视图二选一，左上角返回。
- 开合与左栏同观感：卡面在动画期间钉住宽度（展开 → 终态像素宽，收起 → 当前宽），只由面板 `overflow` 裁切，文字全程不重排（否则窄到 ~100px 时空态文案会竖排）；`flex-grow` 与分隔条宽度同起同落 200ms linear。关闭的 220ms 内保留上一次的面板内容，避免先空白再收缩。多分栏时右栏开合按各组原比例整组让位/回位，不把最后一组单独压到 `minSize`。
- 移动端沿用现有 Drawer（`h-[85vh]`），文件视图占满，底部固定「保存」按钮。

## A3. 关键交互

### A3.1 打开入口

正文顶行右端一个工作台开关（与左侧栏折叠钮同款幽灵图标）：只在面板关着时显示，点击按焦点会话/工作区打开；面板开着时开关隐藏，关闭入口在右栏卡片头部靠中央的一侧——与左栏折叠钮同为「卡内侧」幽灵钮。首页还没有会话/工作区时同样能打开，面板里给出「还没有可浏览的文件」说明与入口提示（不做禁用态，避免点了没反应）；之后进入会话，空 payload 的面板会自动跟随当前会话。窄屏不渲染并排卡片，沿用抽屉自己的关闭入口。

1. 输入框旁的「文件」按钮：目前 `workspace-files-button.tsx` 在 `CHAT_CONTAINER` 返回 `null`，改为始终显示。
2. 消息里的附件 chip / 图片 / 文档 / 视频：单击改为在侧边栏打开（`Ctrl/Cmd + 单击` 仍走浏览器新标签）。
3. 工作区工具卡：「已写入 `src/app.ts`」旁给「在侧栏打开」。
4. 快捷键 `Ctrl/Cmd + Shift + E` 开关面板（接入现有 keybindings，P1）。

### A3.2 预览

| 类型 | 行为 |
| --- | --- |
| 文本 / 代码 | shiki 只读高亮；> 2MB 或二进制 → 只读提示 + 外部打开 |
| Markdown | 渲染预览 / 源码切换（复用 `CodePreviewPanel` 的 Markdown 分支） |
| HTML / SVG / Mermaid | iframe 预览 / 源码切换（复用现有实现） |
| 图片 | `<img>`，最大 10MB（沿用预览上限） |
| 视频 / 音频 | `<video controls preload="metadata">` / `<audio controls>`；服务端补 Range |
| PDF | `<iframe src="/api/files/:id/content">`；WebView2 不支持时降级为「外部打开」 |
| 其他二进制 | 文件信息 + 定位 + 外部打开 |

### A3.3 编辑与保存

- 默认「预览」，点「编辑」进入 textarea（等宽字体 + 行号槽 + Tab 插入两空格）。
- `Ctrl/Cmd + S` 保存；工具栏也有保存按钮。**不做自动保存**（避免 AI 写入与用户编辑打架）。
- 保存成功：更新 etag、清 dirty、toast「已保存」。
- 未保存切换标签 / 关闭面板 / 切换会话：确认框「有未保存的修改」→ 保存 / 放弃 / 取消。
- 保存冲突（409）：顶部横幅「文件已被其他程序修改」，提供「重新加载（丢弃我的修改）/ 覆盖保存 / 另存为副本」。0.0.3 只做前两个。
- 编辑期间 AI 通过工具写了同一文件：SSE `tool_result` 到达时比对 etag，显示横幅「AI 刚刚修改了此文件」，不自动覆盖编辑器内容。

### A3.4 外部修改刷新

- 触发时机：面板打开、标签聚焦、窗口重新获得焦点、本会话工具结果到达（`write` / `edit` / `bash`）、手动刷新。
- 刷新只对可见标签发 `GET content?mode=edit` 取 etag；不同则提示，不静默替换。
- 0.0.4 再加 `fs.watch`（按目录懒监听 + 500ms 防抖）。

## A4. 后端设计

### A4.1 工作区文件读写 API

现有 `GET workspaces/:id/files/content?path=` 返回 `{ preview: {kind, ...} }`。扩展为：

```ts
// GET ...?path=src/app.ts&mode=edit
{
  "preview": { "kind": "text", "text": "...", "size": 12400, "truncated": false },
  "edit": {
    "editable": true,
    "etag": "sha256:9f2c…",   // 内容哈希，冲突判定用
    "eol": "lf",              // "lf" | "crlf"
    "hasBom": false,
    "limitBytes": 2097152
  }
}
```

- `mode=edit` 时文本上限放宽到 `WRITE_HARD_LIMIT_BYTES = 2MB`；超过则 `editable:false`，只返回预览截断。
- 二进制、图片、超大文件 `editable:false`。
- 现有前端忽略新增字段，向后兼容；预览默认仍按 512KB 截断。
- 顺手修一个既有隐患：`previewWorkspaceFile` 目前是「整文件读入再截断」，几十 MB 的文件会先占满内存。改为先 `stat`，超限只读前 512KB（`open` + `read` 指定长度），编辑模式最多读 2MB。大文件不再触发整读。

新增保存路由：

```ts
// PUT workspaces/:id/files/content?path=src/app.ts
// body: { content: string, baseEtag: string, eol?: "lf" | "crlf" }
// 200: { etag, size, modifiedAt }
// 409: { error: "conflict", etag, modifiedAt }
```

实现要点（`pc-server/workspace/files.ts`）：

1. `assertInsideWorkspace(join(root, rel), root)`，拒绝绝对路径、`..`、软链逃逸；保留名走 `isWindowsReservedName` 拒绝。
2. 目标必须是**已存在的普通文件**（0.0.3 不通过编辑器创建新文件）。
3. 读取原字节算 `etag = sha256(bytes).slice(0, 32)`；`baseEtag` 不一致 → 409。
4. 内容按 UTF-8 编码，超过 2MB → 413；含 `\0` → 400。
5. EOL：`eol === "crlf"` 时把 `\n` 归一成 `\r\n` 后写入；`lf` 反之。BOM 原样保留（Node UTF-8 读取会把 BOM 读成 `\uFEFF`，写回不丢）。
6. 原子写：同目录 `.rk-edit-<pid>-<rand>.tmp` → `renameSync` 覆盖；Windows 上 rename 被占用/杀软锁定时重试 3 次，仍失败则报错并清理临时文件，**不直接截断原文件**。
7. 不更新 mtime 之外的元数据，不写 `state`。

### A4.2 会话文件清单

新增 `GET conversations/:id/files`：

```ts
{
  "files": [
    {
      "fileId": 42,
      "url": "/api/files/42/content",
      "fileName": "photo.png",
      "mime": "image/png",
      "size": 182341,
      "kind": "attachment" | "output",
      "origin": "user" | "assistant" | "tool",
      "nodeId": "…",
      "messageIndex": 3,
      "createdAt": 1760000000000,
      "prompt": "…",          // output 才有
      "model": "qwen-image-3.0" // output 才有
    }
  ]
}
```

实现（新文件 `pc-server/conversations/files.ts`）：

- 取当前会话消息树（working set 命中则用内存实例，否则读库），正则抽取 `/api/files/(\d+)/content` 与 `/api/files/path/(.+)`。
- 用 `state.files` 补 `fileName` / `mime` / `size`；`path` 型条目合成虚拟 fileId（负数或 `path:` 前缀），只读。
- `kind=output`：fileId 命中 `state.generatedImages` 或 `state.generatedMedia` 的账本；否则按所属消息是否为 assistant/tool 判定。
- 去重按 fileId，保留最近一次出现位置。
- 性能：只扫描该会话，不碰全库；普通会话数十条消息，成本可忽略。

### A4.3 媒体内容路由补 Range

`pc-server/api/handlers/files.ts` 的 `files/:id/content` 与 `files/path/:path`：

- 解析 `Range: bytes=start-end`，返回 `206` + `Content-Range` + `Accept-Ranges: bytes`；
- 使用 `Bun.file(path).slice(start, end + 1)`；
- 无 Range 时保持 200 全量。
- 这是视频拖动进度条的前提；顺带服务音频。

## A5. 前端设计

### A5.1 组件拆分

```
workbench/
  workbench-host.tsx            // 注册 "conversation-files"
  conversation-files-panel.tsx  // 页签 + 列表 + 文件视图容器
  file-source-list.tsx          // 工作区树 / 改动列表 / 附件 / 产出
  file-viewer.tsx               // 预览 / 编辑 / 差异（按 mime + 扩展名）
  file-editor.tsx               // textarea + 行号 + 保存 + dirty
  file-tabs.tsx                 // 打开的文件标签
  workspace-files-panel.tsx     // 保留旧导出，内部改为薄包装（或删除并更新引用）
```

- 面板类型改为 `conversation-files`，`payload: { workspaceId?: string, open?: { fileId?: number; path?: string } }`。
- 状态只放组件内：`tab`、`openFiles[]`、`drafts: Map<path, {text, baseEtag, dirty}>`、`conflicts`。切换会话时清空；同会话关闭面板再打开可保留（组件不卸载则天然保留）。
- 用 zustand 新增 `conversation-files-store` 暴露 `openInSidebar(target)`，供消息 part、工具卡、输入框按钮调用；`conversations.tsx` 订阅后 `openPanel({ type:"conversation-files", ... })`，避免把回调层层传进消息树。
- 移动端复用同一组件；`useMediaQuery` 控制列表/详情切换与底部保存条。

### A5.2 编辑器实现

- 0.0.3：`<textarea>` + 行号（`div` 与 textarea 同步滚动）+ 等宽字体 + 当前行高亮可省。
- 预览态用 shiki 高亮（`web-ui` 已有 `shiki@3.22`）；编辑态不做实时高亮，避免大文件卡顿。
- 差异视图：把「打开时内容」作为基线，客户端用 `diff`（`pc-server` 已有 8.0.4，可加到 `web-ui` 依赖）做行级 unified diff，绿/红着色。P1。
- 保存请求串行化：同一文件同时只允许一个 in-flight PUT。

## A6. 变更清单（特性 A）

| 文件 | 变更 |
| --- | --- |
| `pc-server/workspace/files.ts` | 新增 `readWorkspaceTextForEdit`、`writeWorkspaceTextFile`（etag、EOL、原子写） |
| `pc-server/api/handlers/workspaces.ts` | `GET content` 支持 `mode=edit`；新增 `PUT content` |
| `pc-server/conversations/files.ts` | 新增会话文件清单收集 |
| `pc-server/api/handlers/conversations.ts` | 新增 `GET :id/files` |
| `pc-server/api/handlers/files.ts` | Range / 206；可选 `GET files/:id/meta` |
| `web-ui/app/components/workbench/workbench-host.tsx` | 注册 `conversation-files` |
| `web-ui/app/components/workbench/*` | 新增面板、列表、查看器、编辑器、标签 |
| `web-ui/app/stores/conversation-files-store.ts` | 新增打开目标 store |
| `web-ui/app/components/input/workspace-files-button.tsx` | 普通对话也显示 |
| `web-ui/app/routes/conversations.tsx` | 订阅 store、打开面板、移动端 Drawer |
| `web-ui/app/components/message/message-part.tsx` | 附件单击打开侧栏 |
| `web-ui/app/locales/zh-CN/common.json`、`en-US/common.json` | 新增文案 |
| `web-ui/package.json` | 可选新增 `diff` |

## A7. 验收标准（特性 A）

1. 普通对话点「文件」可打开面板，至少看到本会话附件；工作区对话默认看到工作区树与「本次改动」。
2. 打开 `src/app.ts` 显示高亮内容；进入编辑、改一行、`Ctrl+S` 后磁盘文件内容确实变化，刷新后仍在。
3. 两个标签同时编辑不同文件，互不串内容；关闭 dirty 标签弹确认。
4. 手动在外部改文件后点刷新 / 重新聚焦，出现冲突提示；选择重新加载后内容更新。
5. 会话中让 AI `write` 一个新文件，面板「本次改动」立即出现该文件；已打开的同一文件出现「已被修改」提示。
6. 上传一张图片，消息图片单击后侧栏打开预览；视频可播放、可拖动进度条。
7. 构造 `../`、盘符绝对路径、软链逃逸请求，全部 400/403，且不产生文件。
8. 3MB 文本只读并提示；CRLF 文件保存后仍为 CRLF；带 BOM 文件保存后 BOM 仍在。
9. 移动端宽度下面板以 Drawer 出现，编辑与保存可用。

---

# 特性 B：外挂媒体生成

## B1. 关键判断

移动端 3.1.0 的链路是：设置里添加媒体供应商 → 抽屉进入 `MediaCreationPage` → 填提示词/参数/素材 → `MediaCreationService` 提交任务 → 轮询 → 下载到本地 → 作为创作记录展示。**模型无法调用它**，对话里也没有「本次允许生成媒体」开关。

rdp 要做的是「模型在对话中调用」。因此：

- 供应商适配层：**移植**（5 家、默认地址、模型默认值、能力矩阵、异步任务协议）。
- 任务与存储：**重写为 Bun/TS**（移动端是前台 Service + Room；桌面是单进程异步任务）。
- 工具层、会话开关、审批、消息渲染：**新增**，移动端没有对应物。

## B2. 目标与非目标

**目标**

1. 设置中可添加 5 类媒体供应商，字段与移动端一致；模型可编辑，默认值可一键恢复。
2. 会话级开关：开启后为本次会话选择图片模型 / 视频模型；只有开启才向模型暴露媒体工具。
3. 模型可调用 `generate_image` / `generate_video`；每次调用都经过审批卡（显示供应商、模型、类型、数量/时长、参考素材数）。
4. 图片同步返回并内联；视频异步任务，工具卡实时显示阶段与耗时，可停止。
5. 产出落到 `filesDir` + `state.files`，在消息内渲染，并出现在文件侧边栏「产出」。
6. 视频参考素材需要公网地址时，用独立的 `uploadS3Config` 上传并预签名；未配置时给出可操作错误。
7. 失败、取消、重启都有确定状态，不产生半截文件或幽灵任务。

**非目标**

- 不做移动端那套完整创作工作台（草稿、会话、版本、素材库）——0.0.3 只做对话内生成与最小产出列表。
- 不做文生视频的「首尾帧 + 参考视频」全参数 UI；工具参数先覆盖常用子集，能力矩阵保留完整定义供后续扩展。
- 不做自动重试风暴；4xx 不重试。
- 不做多用户/多租户密钥管理；密钥仍存本机 `state.json`，与现有供应商一致。
- 不替换现有 `/images` 生图页与 `imageGenerationModelId`。

## B3. 供应商矩阵（与移动端 3.1.0 对齐）

| 类型 | 默认 baseUrl | 支持类型 | 默认模型 | 备注 |
| --- | --- | --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | 图片 | `gpt-image-2.5-sunburst`、`gpt-image-2.5-flare` | 无参考图走 `/images/generations`，有参考图走 multipart `/images/edits` |
| `aliyun` | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1` | 图片 + 视频 | `qwen-image-3.0`、`wan3.0-video` | `{WorkspaceId}` 占位符替换；不含占位符的旧地址原样使用 |
| `volcengine` | `https://ark.cn-beijing.volces.com/api/v3` | 图片 + 视频 | `doubao-seedream-5-0-pro-260628`、`doubao-seedance-2-5-260628` | |
| `minimax` | `https://api.minimaxi.com/v2` | 视频 | `MiniMax-H3` | 结果 URL 同源时带 Bearer 下载 |
| `openrouter` | `https://openrouter.ai/api/v1` | 图片 + 视频 | `openai/gpt-image-2.5-sunburst`、`openai/gpt-image-2.5-flare`、`google/veo-3.1` | 请求带 `HTTP-Referer: https://rikka-ai.com`；结果同源带 Bearer |

### B3.1 端点

| 能力 | 方法 / 路径 |
| --- | --- |
| OpenAI 图片 | `POST /images/generations`；`POST /images/edits`（multipart，字段 `image` 或 `image[]`） |
| 阿里云图片 | `POST /services/aigc/multimodal-generation/generation`（同步） |
| 阿里云视频 | `POST /services/aigc/video-generation/video-synthesis`（`X-DashScope-Async: enable`）→ `GET /tasks/{id}` |
| 火山图片 | `POST /images/generations` |
| 火山视频 | `POST /contents/generations/tasks` → `GET /contents/generations/tasks/{id}` |
| MiniMax 视频 | `POST /video_generation` → `GET /query/video_generation/{id}` |
| OpenRouter 图片 | `POST /images` |
| OpenRouter 视频 | `POST /videos` → `GET /videos/{id}` |

### B3.2 能力矩阵（TS 侧镜像）

> 这是「适配器能接受什么」的描述，不是「某个模型一定支持」。UI 只展示矩阵内参数；提交前按矩阵裁剪，必填缺失直接报错。

| 能力 | 参数 | 必填 | 图片角色 | 视频输入 | 帧与参考互斥 | 提示词必填 | 需公网素材 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OPENAI_IMAGE | COUNT, RESOLUTION | — | 参考图 | 否 | 否 | 是 | 否 |
| ALIYUN_IMAGE | COUNT, RESOLUTION, WATERMARK, SEED, PROMPT_ENHANCEMENT | — | 参考图 | 否 | 否 | 是 | 否 |
| ALIYUN_VIDEO | RESOLUTION, ASPECT_RATIO, DURATION, GENERATE_AUDIO, WATERMARK, SEED, PROMPT_ENHANCEMENT | — | 首帧/尾帧/参考图 | 是 | 是 | 否 | 是 |
| VOLCENGINE_IMAGE | RESOLUTION, WATERMARK | — | 参考图 | 否 | 否 | 是 | 否 |
| VOLCENGINE_VIDEO | RESOLUTION, ASPECT_RATIO, DURATION, GENERATE_AUDIO, WATERMARK, SEED | — | 首帧/尾帧/参考图 | 是 | 是 | 否 | 是 |
| MINIMAX_VIDEO | RESOLUTION, ASPECT_RATIO, DURATION, WATERMARK | RESOLUTION, ASPECT_RATIO, DURATION | 首帧/尾帧/参考图 | 是 | 是 | 是 | 是 |
| OPENROUTER_IMAGE | COUNT, RESOLUTION, ASPECT_RATIO, SEED | — | 参考图 | 否 | 否 | 是 | 否 |
| OPENROUTER_VIDEO | RESOLUTION, ASPECT_RATIO, DURATION, GENERATE_AUDIO, SEED | — | 首帧/尾帧/参考图 | 是 | 是 | 否 | 是 |

## B4. 数据模型

### B4.1 设置切片

新增 `pc-server/foundation/types/settings/media-generation-config.ts`，字段名与移动端保持一致，便于整包互通：

```ts
export type MediaGenerationProviderType =
  | "openai" | "aliyun" | "volcengine" | "minimax" | "openrouter";

export type MediaKind = "image" | "video";

export interface MediaGenerationModel {
  modelId: string;
  kind: MediaKind;
}

export interface MediaGenerationProviderConfig {
  id: string;
  type: MediaGenerationProviderType;
  name: string;
  apiKey: string;
  baseUrl: string;
  /** 仅 aliyun：替换 baseUrl 里的 {WorkspaceId} */
  workspaceId?: string;
  models: MediaGenerationModel[];
}

export interface MediaModelRef {
  providerId: string;
  modelId: string;
}

export interface MediaGenerationConfig {
  mediaGenerationProviders: MediaGenerationProviderConfig[];
  /** 媒体参考素材上传桶，与备份 s3Config 分离（对齐移动端） */
  uploadS3Config: S3Config | null;
  /** 新会话默认选择；桌面独有，移动端会忽略未知字段 */
  defaultMediaImageModel?: MediaModelRef | null;
  defaultMediaVideoModel?: MediaModelRef | null;
}
```

- `Settings` 聚合加入 `MediaGenerationConfig`。
- `defaultSettings()` 默认：空供应商数组、`uploadS3Config: null`、默认模型 null。
- 密钥随 `state.json` 明文保存，与 `settings.providers[].apiKey` 同策略；不新增密钥库。
- 备份：`backup/export.ts` 导出整个 `settings`，新字段自动带出；`backup/import.ts` 按字段名合并。移动端 Json 配置 `ignoreUnknownKeys = true`（已核对），桌面独有的默认模型字段不会让它崩。
- **不把** `mediaGenerationProviders` 放进 `backupScope.models` 之外的新开关：0.0.3 跟随「模型」开关一起导出。

### B4.2 会话级开关

`Conversation` 新增：

```ts
mediaGeneration?: {
  enabled: boolean;
  image?: MediaModelRef | null;
  video?: MediaModelRef | null;
} | null;
```

SQLite 同步 5 处：

1. `ensureConversationTables` 的 `CREATE TABLE` 加 `media_generation TEXT`；
2. 新增幂等迁移 `ensureConversationMediaGenerationColumn`（`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`）；
3. `INSERT ... ON CONFLICT` 的列与占位符 + `conv.mediaGeneration` 绑定；
4. dump（`pcdump.pc_conversation`）的建表与 `INSERT ... SELECT` 列清单；
5. 行 → `Conversation` 映射（`read-queries.ts` / `conversations/index.ts` 的 `workspaceId` 同位置）与 DTO。

只存 PC 自有库；跨端导出白名单不含此列（对齐 `workspace_id`）。移动端没有会话级开关，会话同步到移动端时忽略即可。

### B4.3 产出账本

`State` 新增：

```ts
generatedMedia: GeneratedMediaRecord[]; // 上限 300，按 createdAt 倒序
```

```ts
export interface GeneratedMediaRecord {
  id: string;
  kind: "image" | "video";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  providerId: string;
  providerType: MediaGenerationProviderType;
  modelId: string;
  prompt: string;
  params: Record<string, JsonValue>;
  fileId: number | null;
  url: string | null;
  providerTaskId: string | null;
  conversationId: string | null;
  nodeId: string | null;
  toolCallId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
```

- 与 `generatedImages` 并存：老生图页继续用旧账本；媒体链路用新账本。
- `normalizeState` 缺省 `[]`。
- 备份：加入 `backup/export.ts` 的 `state` 段；字节仍走 `state.files` + `attachments` 范围。
- 为什么不用 SQLite 表：0.0.3 的任务量级是「每会话个位数」，账本 + `state.files` 足够；且与现有 `generatedImages` 一致。若后续要跨会话媒体库 / 多端并发，再迁 `pc_media_task` 表（见 §F 待定）。

## B5. 后端结构

```
pc-server/media-generation/
  types.ts            // 请求 / 任务 / 输出 / 错误 / 状态
  capabilities.ts     // B3.2 矩阵，唯一事实源
  registry.ts         // type + kind -> adapter / capabilities
  service.ts          // 选型、素材准备、提交、轮询、下载、落盘
  storage.ts          // saveGeneratedMedia / 下载 / 文件登记
  s3-upload.ts        // 参考素材上传 + 预签名（复用 backup/storage.ts 的 SigV4）
  resume.ts           // 启动时恢复未完成任务
  providers/
    http.ts           // fetch + 超时 + 错误映射
    openai.ts
    aliyun.ts
    volcengine.ts
    minimax.ts
    openrouter.ts
```

### B5.1 请求 / 任务类型

```ts
export interface MediaGenerationRequest {
  prompt?: string;
  inputs: MediaInput[];       // {type:"image", role:"reference"|"first_frame"|"last_frame", url}
  count?: number;
  resolution?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  generateAudio?: boolean;
  watermark?: boolean;
  seed?: number;
  promptEnhancement?: boolean;
}

export interface MediaGenerationTask {
  id: string;                 // 本地任务 id
  providerTaskId?: string;    // 异步接口返回
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  outputs: { url?: string; data?: Buffer; mime: string; duration?: number }[];
  error?: { code?: string; message: string };
}
```

### B5.2 轮询与取消

对齐移动端 `MediaCreationService`：

- 首次间隔 5s，之后 ×2，封顶 60s；
- 连续失败 20 次判失败；
- 总时限 24h；
- 每次轮询前检查 `AbortSignal`；用户停止 → 状态 `cancelled`，保留 `providerTaskId` 供后续查询；
- 提交成功后**立即**把 `providerTaskId` 写进账本，防止进程中断后找不到任务；
- 下载：带适配器的 `downloadHeaders(url)`（MiniMax / OpenRouter 同源 Bearer），30s 超时，先写临时文件再 rename；
- 产出 MIME 由 `Content-Type` + 扩展名推断，默认 `image/png` / `video/mp4`。

### B5.3 素材准备

| 场景 | 处理 |
| --- | --- |
| 图片输入 + OpenAI | 本地文件走 multipart `/images/edits`，不要求公网 |
| 图片输入 + 其他图片接口 | 本地文件转 data URI 或 base64（按适配器），不要求公网 |
| 视频输入 / 视频参考图（`requiresRemoteInputs`） | 必须有 `uploadS3Config`：上传到 `rikkahub_uploads/<sha256>.<ext>`，预签名 24h，提交时用 URL |
| 同时有首尾帧和参考图（`framesExcludeReferences`） | 提交前直接拒绝，工具返回可读错误，让模型改用其中一种 |

- 预签名：在 `backup/storage.ts` 抽出可复用的 `s3PutObject` / 新增 `s3PresignUrl(config, key, expiresSeconds)`（SigV4 query 签名，`X-Amz-Expires`，`UNSIGNED-PAYLOAD` 或空 payload hash）。
- 对象清理：0.0.3 不主动清理；文档提示桶生命周期规则。P1 加「7 天后清扫」。
- 未配置 S3 时，错误文案必须可操作：`视频参考素材需要公网地址：请先在 设置 → 媒体 → 上传与存储 配置 S3。`

### B5.4 落盘

- 图片/视频字节写入 `filesDir`，`id = state.nextFileId++`，push `state.files`；
- 生成 `url = /api/files/:id/content`；
- 账本 `generatedMedia` 记录 fileId/url/状态；
- 若会话绑定工作区，**不自动**写进工作区；消息菜单提供「保存到工作区」（P1），走现有 `write` 边界与审批语义。

## B6. 工具层

### B6.1 声明

`pc-server/tools/definitions.ts` 新增：

```ts
openAiMediaTools(conversation, assistant): ToolDefinition[]
```

仅在以下条件同时满足时返回工具：

- `conversation.mediaGeneration?.enabled === true`；
- 对应类型有可用模型（`image` / `video` 各自的 ref 能在 `mediaGenerationProviders` 里解析到）；
- 供应商配置存在（`apiKey` 非空）。

工具 schema：

```jsonc
// generate_image
{
  "prompt": "string, 必填",
  "count": "integer 1-4, 可选",
  "resolution": "string, 可选（如 2K / 1024x1024）",
  "aspect_ratio": "string, 可选（如 16:9）",
  "reference_file_ids": "number[], 可选（本会话附件 id）",
  "reference_paths": "string[], 可选（工作区相对路径）"
}

// generate_video
{
  "prompt": "string, 必填（MINIMAX 之外可为空，但建议总是给）",
  "duration_seconds": "integer, 可选（-1 = 模型决定）",
  "resolution": "string, 可选",
  "aspect_ratio": "string, 可选",
  "generate_audio": "boolean, 可选",
  "reference_file_ids": "number[], 可选",
  "reference_paths": "string[], 可选",
  "first_frame_file_id": "number, 可选",
  "last_frame_file_id": "number, 可选"
}
```

**模型不选供应商、不选模型。** 供应商与模型由会话设置决定，避免模型擅自切到更贵的档位。工具描述里明确写「使用用户为此会话配置的图片/视频模型」。

### B6.2 装配

- `conversationFunctionTools(assistant, model?, conversation?)` 增加第三参，内部追加 `...openAiMediaTools(conversation, assistant)`。
- 更新 6 个调用点：`conversations/orchestrator.ts:194/223/267/293/345`、`inference-engine/conversation-encoding.ts:39`。
- pi：`pi-engine/general-tools.ts` 的 `PiGeneralToolsContext` 已有 `conversation`，在 `customTools` 里追加上面的媒体工具；过滤逻辑与聊天引擎同一份 `openAiMediaTools`，避免两套 schema。

### B6.3 执行

`tools/execution.ts` 增加分发：

```ts
if (name === "generate_image") return runGenerateImageTool(args, context);
if (name === "generate_video") return runGenerateVideoTool(args, context);
```

`runGenerateImageTool` / `runGenerateVideoTool`：

1. `context.conversationId` → `peekConversation` 取会话；不存在或 `mediaGeneration.enabled !== true` → 返回错误「媒体生成未在此会话启用」。
2. 解析 `MediaModelRef` → 供应商配置 + 模型；不存在 → 明确错误（附当前可用模型列表，方便模型纠正）。
3. 解析参考素材：fileId → `state.files`；path → 工作区边界内；角色按能力矩阵裁剪；首尾帧与参考图互斥检查。
4. 调用 `service.generate`，期间用 `context.onToolPartialOutput` 推送进度：`{ type:"text", text:"正在提交…" }` → `"生成中 12s"` → `"下载中"`。
5. 成功返回 `ToolOutputEntry[]`：`[ {type:"text", text:"已生成 1 张图片（qwen-image-3.0，fileId=42）"}, {type:"image", url:"/api/files/42/content"} ]`；视频同理返回 `video` part。
6. 失败返回 `{ error: "…" }`，错误里带 provider code / status，提示「不要原样重试 4xx」。
7. 每个会话一把任务锁（`Map<conversationId, Promise>`），串行化媒体调用，防止模型一轮并发提交多个付费任务。

### B6.4 审批

`tools/approval.ts`：

- `ConversationWorkspacePick` 扩展 `mediaGeneration` 字段；
- 新增 `mediaApprovalDecision(toolName, conversation, args)`：
  - 未启用 → 不需要审批（执行层仍会拒绝）；
  - 启用 → 一律 `{ pending: true, reason }`；
  - reason 示例：`调用 阿里云 / wan3.0-video 生成 1 段 5s 视频（含 1 张参考图）。可能产生供应商费用。`
- `initialApprovalState` 在 workspace 判定之后、MCP 之前接媒体判定。
- 审批卡沿用现有 `ToolApprovalState.pending.reason`；`tool-loop.ts` 的批前扫描天然覆盖，无需改循环。
- pi 路径经 `gateToolApproval` + 同一 `initialApprovalState`，自动一致。

**默认每次审批。** 0.0.3 不做「本会话自动批准」；如果后续要加，放在 `conversation.mediaGeneration.autoApprove`，并在审批卡提供勾选。

### B6.5 停止与恢复

- 用户点停止：`abortGeneration` → `signal.aborted` → 轮询退出 → 账本 `cancelled`；已下载一半的临时文件删除。
- 进程退出：启动时 `resume.ts` 扫描账本 `running/queued` 且有 `providerTaskId` 的记录，恢复轮询（最多到创建后 24h）。完成后落盘、更新账本、广播一个轻量通知；若 `conversationId/nodeId/toolCallId` 仍在且工具卡存在，**可选**回填工具卡（P1），0.0.3 先只进「产出」列表。
- 无 `providerTaskId` 的 running 记录 → 标 `failed`，原因「应用在提交完成前退出」。

## B7. 前端设计

### B7.1 设置页

在 `settings-nav.ts` 新增一级「媒体」（图标 `ImagePlus` 或 `Clapperboard`），两个二级：

1. `media/providers` — 生成服务
   - 卡片列表：名称、类型、模型数、启用状态、编辑/删除。
   - 「添加服务」抽屉：5 个类型单选；表单字段 `name`、`apiKey`、`baseUrl`、`workspaceId`（仅阿里云）、模型列表（`modelId` + `kind` 下拉）。
   - 保存前校验：baseUrl 可解析、至少一个模型、模型 id 非空；阿里云 baseUrl 含 `{WorkspaceId}` 时 `workspaceId` 必填。
   - 「恢复默认地址与模型」按钮，按 B3 表回填。
   - 不做在线「测试连接」：没有免费且通用的探测端点，避免误花额度；连通性由首次真实生成暴露。若要做，只能做「不产生生成任务」的鉴权探测，P1 再评估。
2. `media/storage` — 上传与存储
   - `uploadS3Config`：endpoint、bucket、region、accessKeyId、secretAccessKey、pathStyle；「测试连接」调用现有 `s3TestConnection`（只 list，不产生生成费用）。
   - 说明文案：仅视频参考素材 / 需要公网地址的接口使用；与备份 S3 分开。
   - 默认图片/视频模型（可选）：从已配置模型里选，写入 `defaultMediaImageModel` / `defaultMediaVideoModel`。

新增文件：`web-ui/app/components/settings/media/providers.tsx`、`storage.tsx`、`provider-sheet.tsx`；`settings-registry.tsx` 挂载；`settings-search-index.ts` 加索引项；两套 locale 文案。

### B7.2 会话开关

输入框工具栏新增「媒体」按钮（`Sparkles` / `ImagePlus`），状态：

- 关闭：灰色；点击弹 popover「为本会话启用媒体生成」+ 去设置链接（无供应商时）。
- 开启：高亮；popover 内两个下拉：
  - 图片模型（所有 `kind=image` 的已配置模型，显示 `供应商名 / 模型 id`）；
  - 视频模型（同上，`kind=video`）；
  - 若视频需要 S3 而 `uploadS3Config` 为空，显示黄色提示「视频参考素材需要配置上传存储」。
- 变更调用 `POST conversations/:id/media-generation`，会话对象更新并广播；输入框立即反映。
- 会话标题栏或消息区顶部不加常驻横幅，避免噪音；按钮本身显示小圆点表示已开启。

### B7.3 审批卡与工具卡

- 审批卡：标题「生成图片 / 生成视频」，正文展示 reason；按钮「允许 / 拒绝」；视频额外提示「可能需要数分钟，可随时停止」。
- 生成中工具卡：阶段文案 + 已用时 + 「停止」；`onToolPartialOutput` 每次替换 output，渲染成一行状态，不刷屏。
- 完成：工具卡折叠为一行「已生成 1 张图片 · qwen-image-3.0」，下面直接渲染图片；视频渲染 `<video controls>`。
- 失败：显示 provider 错误摘要 + 「重试」按钮（重试会重新走审批）。

### B7.4 消息渲染与侧边栏

- 图片：沿用 `ImagePart`，点击放大；菜单「下载 / 在侧栏打开 / 用作参考图」。
- 视频：`<video controls preload="metadata">`，无 ffmpeg 不做封面图；首帧由浏览器渲染。
- 产出进入特性 A 的「产出」页签：按 `createdAt` 倒序，显示缩略图/视频图标、prompt 摘要、模型、状态。
- 0.0.3 不新建 `/media` 页面；现有 `/images` 只服务旧生图链路。若要统一媒体库，放 0.0.4。

## B8. 与现有生图的关系

| | 旧生图（`/images`） | 新媒体链路 |
| --- | --- | --- |
| 入口 | 侧栏/页面手动 | 对话内模型调用 |
| 模型来源 | `settings.imageGenerationModelId` + 供应商模型列表 | `mediaGenerationProviders` |
| 协议 | OpenAI images / Gemini / OpenRouter 参考图 | 5 家媒体适配器（含异步视频） |
| 账本 | `state.generatedImages` | `state.generatedMedia` |
| 审批 | 无 | 每次 pending |

两者**不合并**。旧链路的 `callImageGeneration` 可以复用部分下载/落盘工具函数，但不要把它改成媒体工具，避免影响现有生图页。

## B9. 变更清单（特性 B）

| 文件 | 变更 |
| --- | --- |
| `pc-server/foundation/types/settings/media-generation-config.ts` | 新增切片类型 |
| `pc-server/foundation/types/settings/index.ts` | `Settings` 聚合 + 导出 |
| `pc-server/app-config/defaults.ts` | 默认值 |
| `pc-server/foundation/types/index.ts` | `Conversation.mediaGeneration`、`GeneratedMediaRecord`、`State.generatedMedia` |
| `pc-server/conversations/index.ts` | 建表列、迁移、INSERT/UPDATE、dump、映射 |
| `pc-server/conversations/read-queries.ts` | 行 → 会话的媒体字段映射 |
| `pc-server/api/handlers/conversations.ts` | `POST :id/media-generation` |
| `pc-server/api/handlers/media.ts`（或新 `media-generation.ts`） | 供应商 CRUD、模型校验、上传存储测试 |
| `pc-server/api/router.ts` | 注册新 handler（若独立） |
| `pc-server/media-generation/*` | 新增适配器、能力矩阵、服务、存储、恢复 |
| `pc-server/backup/storage.ts` | 抽出/新增 `s3PutObject`、`s3PresignUrl` |
| `pc-server/backup/export.ts` / `import.ts` | 导出 `generatedMedia`；确认新设置字段合并 |
| `pc-server/persistence/state-load.ts` | `generatedMedia` 缺省 |
| `pc-server/tools/definitions.ts` | `openAiMediaTools` |
| `pc-server/tools/bound.ts` | 聚合器加 conversation 参数 |
| `pc-server/tools/execution.ts` | 媒体工具分发与守卫 |
| `pc-server/tools/approval.ts` | 媒体审批判定 |
| `pc-server/pi-engine/general-tools.ts` | pi 工具列表追加媒体工具 |
| `pc-server/conversations/orchestrator.ts` | 5 处聚合调用传 conversation |
| `pc-server/inference-engine/conversation-encoding.ts` | 同上 |
| `web-ui/app/components/settings/settings-nav.ts` | 新增「媒体」 |
| `web-ui/app/components/settings/settings-registry.tsx` | 挂载两页 |
| `web-ui/app/components/settings/media/*` | 新页面 |
| `web-ui/app/components/input/*` | 媒体开关 popover |
| `web-ui/app/components/message/*` | 视频/审批/工具卡展示 |
| `web-ui/app/components/workbench/*` | 产出页签 |
| `web-ui/app/types` | 设置与 DTO 类型 |
| `web-ui/app/locales/*` | 文案 |

## B10. 失败与成本策略

| 场景 | 行为 |
| --- | --- |
| 供应商 401/403 | 不重试；提示检查 API Key；工具返回明确错误 |
| 429 / 5xx | 异步任务轮询按退避重试；同步图片最多重试 1 次（仅网络错误） |
| 任务失败 / 过期 | 账本 `failed/expired` + provider 原始 message；不自动重提 |
| 用户停止 | 停轮询、删临时文件、账本 `cancelled`；已提交的上游任务不保证取消 |
| 应用退出 | 有 taskId 的恢复；无 taskId 的标失败 |
| 模型重复调用 | 会话级任务锁；审批卡每次出现；工具描述要求「一次请求只生成用户要求的内容」 |
| 参考素材过大 | 图片单张 ≤ 10MB（与预览上限一致）；超出直接报错 |
| S3 未配置 | 仅影响需要公网素材的请求；图片常见路径不受影响 |

---

# 特性 C：记忆的语义索引与召回（Embedding / Rerank）

## C0. 已交付：嵌入 / 重排「可选、可检、可出站」

本次只做到「模型层能用」为止：模型可选、可检、可出站，并能在「设置 › 模型 › 场景模型」里被点名为全局档位。向量表 / 索引 / 召回 / 记忆板块的向量卡片全部未开始（`enabled` 默认关，记忆注入行为与改动前逐字节一致）。

| 面 | 落地 |
| --- | --- |
| 类型 | `Model.type` 扩为 `CHAT \| IMAGE \| EMBEDDING \| RERANK`（`pc-server/foundation/types/index.ts` 单源；web-ui 只重导出） |
| 出线路 | 新文件 `pc-server/model-providers/embeddings.ts`：`{model, input}` / `{model, query, documents, top_n}` 两种请求体、响应形态族解析、60s 超时、`provider:embeddings` / `provider:rerank` 请求日志；凭据仍走 `resolveProviderAuthForProvider` 单一出口（含模型级 `providerOverwrite.baseUrl` 与 customHeaders/customBodies） |
| 端点 | `${baseUrl}/embeddings`、`${baseUrl}/rerank`（剥尾斜杠后拼固定尾缀）；Cohere 需 `…/v2`、SiliconFlow / Jina / Voyage 需 `…/v1`，非标准路径由模型级覆盖 baseUrl 承载 |
| 检测 | `settings/provider/test`（含 SSE）按所选模型类型分流：嵌入只打 `/embeddings`、重排只打 `/rerank`，聊天仍三档；结果行是「嵌入可用：维度 1024…」「重排可用：对 2 条文档打分…」；工具型供应商没有 chat 线路也能盖 `testPassed` |
| 添加 | 模型编辑对话框类型选择器四档；手输 modelId 时类型自动跟随（`bge-m3`→嵌入、`ReaderLM-v2` / `bge-reranker-v2-m3`→重排；用户手动点过一次类型即永久尊重，编辑已有模型不重判）；勾选供应商模型时同样按 id 判类型（重排规则先于嵌入，避免 `bge-reranker-v2-m3` 被误判成嵌入） |
| 实机演示 | 新脚本 `pc-server/scripts/mock-nonchat-provider.ts`：本机假供应商，实现 `/v1/models`、`/v1/embeddings`、`/v1/rerank` 并打印每条入站请求；`--alt` 换成非标准响应形态（`embeddings[][]` / `scores[]`）验证解析族的另一分支；`--seed <baseUrl>` 往一次性档案注入两个演示供应商（含一个 google 型，专门演示「未发出任何 /embeddings 请求」的拒绝路径）并当场各跑一次检测。配 `RIKKAHUB_PC_DATA_DIR=demo-profiles/nonchat`（已 gitignore）起独立实例，真实点击链路 + 零配额，不碰 `pc-data/` |
| 跨端 | 导出到安卓的 `settings.json` 剔除 RERANK 模型行；PC→PC 备份与 Kelivo 往返保留（详见 C8） |
| 全局场景档 | 「设置 › 模型 › 场景模型」新增两行：**嵌入模型** / **重排模型**（`settings.embeddingModelId` / `rerankModelId`，PC 独有字符串键）。下拉只列该类型且供应商已启用的模型，与聊天场景的候选集互为补集；三档「未设置」语义照 OCR/生图口径（报错档：触发器留白、列表首项写「未设置」）；一个候选都没有时行内提示「去供应商页把类型标为嵌入/重排」；沿用本页防抖自动保存。设置搜索可命中（关键词「嵌入,向量,embeddings」「重排,召回排序,rerank」） |
| 测试 | `pc-server/model-providers/embeddings.test.ts`（25）、`pc-server/api/settings-provider-test.test.ts`（5，含聊天三档回归）、`pc-server/backup/android-contract.test.ts` 增 4 条剥除锁 + 2 条场景档跨端锁、`pc-server/api/default-models-toggles.test.ts` 增 5 条场景档持久化锁（落库 / 缺省键保持 / 空串清空 / 不校验存在性）、`web-ui/app/tests/model-type-inference.test.ts`（4）；全部打桩 fetch，零真实额度消耗 |


## C1. 目标与非目标

**目标**

1. 设置里能指定一个 **embedding 模型**（复用现有 `Model.type = "EMBEDDING"` 的模型行，供应商拿现有 API Key / Base URL），开启后把已有记忆和新写入的记忆嵌入成向量。**✅ 模型选择这一半已交付**：全局「嵌入模型」场景档（见 C0 末），向量功能直接读它。
2. 可选指定一个 **rerank 服务**：召回候选先做本地混合打分，再交给 rerank 重排。**✅ 同上**：全局「重排模型」场景档已交付，M6 只需读键。
3. 会话开场按「直接联想（关键词命中）+ 语义联想（向量余弦）+ 关联扩展（记忆互近邻）」召回相关记忆注入 system，替代现在「不管多少条都整包灌进去」。
4. 记忆与向量**全部由 SQL 管理**：新增表落在 `rikka_hub.db`，不引 Qdrant、不写独立索引文件、不加 Python 侧车。
5. 全链路可降级：没配模型、网络失败、维度不符、rerank 报错，都退回现有全量注入，不阻塞对话。
6. 参考 `ODO-TECH/MCPulse-RAG` 的**协议与批处理思路**（`/embeddings` 批 64；`/rerank` 的 `{model, query, documents, top_n}` 契约），不搬它的运行时。

**非目标（0.0.3 不做）**

- **不做 MCP**：不新增 MCP server、不注册 MCP 工具、不引外部向量库（用户明确要求）。
- 不索引对话历史——历史检索已有 FTS5（`conversations/fts.ts`）；本特性只索引记忆。
- 不做多套向量并存（同一时刻一套；换模型即重建）。
- ~~不把 rerank 塞进 `Model.type`~~ → **本次已塞**（`RERANK` 档位），跨端风险改由「导出到安卓时剔除该模型行」兜住，理由与边界见 C8。
- 不做记忆自动摘要 / 自动去重。
- 不在对话中途按每轮重算召回（会打穿前缀缓存，见 C5.1）。

## C2. 现状与关键判断

| 事实 | 依据 | 对设计的影响 |
| --- | --- | --- |
| 记忆本体已在 SQL | `pc_memory` / `pc_memory_pending` / `pc_meta`；`writeMemorySql` 单事务整快照重写 | 向量加**同库新表**；不参与整快照 DELETE+INSERT |
| 注入是整包 | `memoriesForAssistant()`（全局 + 助手叠加）→ `buildMemoryPrompt()` 输出 `[{id,content}]` JSON | 只在 `buildMemoryPrompt` 前插召回层，模型侧无感、格式不变 |
| 注入按会话冻结 | `context-snapshots.ts` 冻结记忆 / 最近会话块，保护前缀缓存 | 召回在会话**首次编码**时算一次并冻结；显式刷新才重算 |
| 双引擎共用 | 聊天 `conversation-encoding.ts` 与 pi `resources.ts` 都调 `frozenContextBlocks` | 召回预计算要在两条链路各挂一次 |
| EMBEDDING 类型已有但未路由 → **已路由** | 改动前 `Model.type` 三值、`model-edit-dialog.tsx` 注明「EMBEDDING 未参与路由分发」；现两档（EMBEDDING/RERANK）各有真实出线与检测档 | 索引层直接调 `callEmbeddings` / `callRerank`，不必再造客户端 |
| 凭据单一入口 | `resolveProviderAuthForProvider` + `applyRequestHeaders` | embedding / rerank 走同一出口，含 OAuth 供应商 |
| 备份只带记忆文本 | `memoryStore.exportFlat()`；`exportPcConversationsDump` 是显式表清单 | 向量天然不进备份，恢复后标 stale 重建 |
| 记忆量级小 | 单条是短句，常见几十到几百条 | 向量存 BLOB、进程内暴力余弦足够；不需要 ANN 索引 |

**关键判断**：MCPulse-RAG 是「Python + Qdrant + MCP」的知识库，rdp 是「Bun + SQLite + 进程内检索」的个人记忆。能复用的是**接口契约与索引纪律**（批量、哈希增量、维度校验、失败不重试 401），不能复用它的存储与运行形态。

## C3. 数据模型（SQL）

### C3.1 新表

```sql
-- 一条记忆一行向量。主键用 memory_id：同一时刻只保留当前模型的一套向量。
CREATE TABLE IF NOT EXISTS pc_memory_vector (
  memory_id    INTEGER PRIMARY KEY NOT NULL,  -- 对应 pc_memory.id（刻意不加外键：
                                              -- 记忆整快照重写会先 DELETE 再 INSERT）
  model_key    TEXT NOT NULL,                 -- `${providerId}::${modelId}`，换模型即失效
  content_hash TEXT NOT NULL,                 -- sha256(content) 前 32 hex，判定是否需重嵌
  dim          INTEGER NOT NULL,
  vector       BLOB NOT NULL,                 -- Float32Array 小端序列化
  embedded_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_memory_vector_model ON pc_memory_vector(model_key);
```

索引元信息复用已存在的 `pc_meta`（不建新表）：`memory_vector_model_key`、`memory_vector_dim`、`memory_vector_indexed_at`、`memory_vector_last_error`。

建表入口：`ensureMemoryVectorTables(db)`，与 `ensureMemoryTables` 同样 `CREATE TABLE IF NOT EXISTS` 幂等；在 `readMemorySql` 与向量模块首次取库时调用。**不做版本号迁移**——纯加表，老库零风险。

不引 `sqlite-vec` 扩展：几百条向量的暴力余弦是微秒级，扩展带来的动态库打包 / 跨平台加载成本远大于收益；量级真的上万再评估。

### C3.2 设置切片（PC 独有）

**2026-10-22 收敛**：模型选择不再放进向量切片，改用「设置 › 模型 › 场景模型」里的两档全局场景（与主模型 / 翻译 / OCR 同族、同页、同自动保存）：

```ts
// foundation/types/settings/model-config.ts（PC-only 字符串键）
embeddingModelId: string;   // Model.id，必须是 EMBEDDING 类型；空串 = 未配置
rerankModelId: string;      // Model.id，必须是 RERANK 类型；空串 = 未配置
```

向量切片只留「怎么用」，不留「用哪个模型」：

```ts
export interface MemoryVectorSettings {
  enabled: boolean;              // 总开关，默认 false（关闭时行为与今天逐字节一致）
  autoIndex: boolean;            // 新写入/编辑记忆自动嵌入，默认 true（开启时已提示成本）
  topK: number;                  // 最终注入条数，默认 20，夹在 5–50
  minMemories: number;           // 候选 ≤ 此值直接全量注入，默认 24，夹在 0–200
  expandNeighbors: boolean;      // 记忆互近邻扩展，默认 true（纯本地计算，零额外请求）
  rerankTopN: number;            // 送重排的候选数，默认 40，夹在 10–100
}
```

- 两档全局场景已落地：默认空串（`app-config/defaults.ts`）、`settings/default-models` 按字段合并（缺省键不动现值、显式空串清空）、`backup/import.ts` 从安卓备份回导时显式保住 PC 值、导出侧不进 `uuidFields`（否则「未设置」会被改写成随机 UUID）。下拉只列对应类型且供应商已启用的模型，一个都没有时行内提示「去供应商页把类型标为嵌入 / 重排」。
- 原方案的 `rerank: { providerId, model, path }` 自由文本块**删除**：重排模型已经进类型系统（见 C8），供应商与 baseUrl 由那一行模型自带，路径不标准走「高级 › 供应商覆盖」改 baseUrl，不需要在记忆页再填一遍。
- 新增 `foundation/types/settings/memory-vector-config.ts` + 聚合进 `Settings`；默认值进 `app-config/defaults.ts`；`state-load.ts` 做字段级规范化（非法值回落默认，不整块丢弃）。
- 不复用 `MemorySettings`：那三个字段是与移动端对齐的语义（全局层 / 写入策略），向量设置是桌面独有能力，分片更干净。
- **不新增 apiKey 字段**：嵌入与重排都复用所选模型所在供应商的凭据，密文只有一个出口，OAuth 供应商也不用特殊处理。

### C3.3 与 JSON 快照、整快照写的关系

- `writeMemorySql` 仍然整表重写 `pc_memory`；`pc_memory_vector` **不参与**，因此向量不会因批量编辑 / 导入被误删。
- 需要一致性的三个地方：
  1. 记忆删除 → 删对应向量行（`deleteMemory` / `deleteMemoriesByAssistant`）。
  2. 批量替换 / 备份导入 → 按现存 id 做一次 prune，其余靠 `content_hash` 判定 stale。
  3. 换 embedding 模型 → 旧 `model_key` 的向量在召回时**忽略**（不删除，等用户确认重建再覆盖），状态卡提示「模型已变更，需重建」。
- JSON 三件套（`memory/*.json`）继续只作灾备，不写向量；用户说「记忆用 SQL 管」——本特性把向量也放 SQL，但**不回退现有 JSON 快照**（那是迁移期的灾备，动它属于另一个话题）。

## C4. 索引管线

### C4.1 模型与端点

| 项 | 规则 |
| --- | --- |
| embedding | 模型取全局场景档 `settings.embeddingModelId`（`type === "EMBEDDING"`）；仅 `provider.type === "openai"`（其余类型直接给可读报错，见 `model-providers/embeddings.ts`）；`POST ${baseUrl}/embeddings`，body `{ model, input: string[] }`，取 `data[].embedding`（MCPulse-RAG 同款） |
| 批次 | 64 条/批（对齐参考项目；OpenAI 上限更高，但小批失败面小、进度细） |
| 鉴权 | `resolveProviderAuthForProvider` → `applyRequestHeaders`，与聊天请求同一出口 |
| 超时 | 单批 20s（`fetchWithTimeout`）；整体任务可取消 |
| 重试 | 429 / 5xx / 网络错误每批最多 2 次退避（1s、4s）；401/403 立即停并报可读错误 |
| 维度 | 写入前校验同一批维度一致；与 `pc_meta.memory_vector_dim` 不一致视为换模型，要求重建 |
| rerank | 模型取全局场景档 `settings.rerankModelId`（`type === "RERANK"`）；仅 `openai` 型供应商；`POST ${baseUrl}/rerank`（路径不标准就去「高级 › 供应商覆盖」改 baseUrl，不再有自由文本 path），body `{ model, query, documents, top_n }`；解析 `results[].index` + `relevance_score`（兼容 `score`），与参考项目一致 |

### C4.2 任务与增量

- 任务入口只有两个：设置页「重建全部 / 补齐缺失」，以及 `autoIndex` 触发的单条嵌入。
- 单飞队列（并发 1），`vectorQueue` 与 `memoryStore.writeQueue` 分开：向量失败不拖慢记忆落盘。
- 单个记忆的判定：`content_hash(content)` 与 `model_key` 都匹配才跳过；否则重嵌。
- 批量重建按批事务写：`INSERT ... ON CONFLICT(memory_id) DO UPDATE`，每批提交一次；中途取消保留已完成部分，下次「补齐」续跑。
- `autoIndex`：`addMemory` / `updateMemory` / `resolvePending(Batch)` / `replaceGlobalMemories` / `replaceAssistantGroups` / `copyAssistantMemories` / `importFlatMemories` 之后，防抖 500ms 合并成一次嵌入调用（连续写多条只发一批）；替换类操作先 prune 再补嵌。
- 删除：`deleteMemory` 同步删向量行（单条 SQL，不等队列）。
- 进度走 SSE（见 C6），状态由 SQL 现算，不缓存计数。

### C4.3 失败与成本

| 场景 | 行为 |
| --- | --- |
| 未启用 / 未配模型 | 零网络请求，注入行为与今天完全一致 |
| 供应商 401/403 | 停止任务，状态卡显示端点 + 原始 message；召回退回全量 |
| 429 / 5xx | 按批退避重试 2 次；仍失败则本批跳过并记 `last_error`，不中断整任务 |
| 维度不一致 / 换模型 | 召回忽略旧向量，状态提示「需重建」 |
| 记忆少于 `minMemories` | 根本不嵌入查询，也不召回——直接全量（省钱、省延迟） |
| 重建成本 | 开启开关与点「重建」前弹确认，展示条数与**粗略 token 估算**（按字符数 / 2），并说明「每新增一条记忆会自动调用一次」 |
| autoIndex 成本顾虑 | 用户可关；关闭后新记忆标记未索引，召回时按「最近未索引兜底」注入 |

## C5. 召回管线

### C5.1 触发时机与冻结

- 只在**会话首次编码**前算一次：`orchestrator.callProvider()` 里 `await prepareMemoryRecall(conversation, assistant)`；pi 链路在 `createPiSessionResources()` 里同样调用。
- 查询文本 = 会话里第一条非空 user 文本（`textFromParts`，截 2000 字）。会话首次编码时它一定已存在。
- 结果写入 `recallCache`（`conversationId → { selectedIds, queryHash, modelKey, builtAt }`，LRU 200，与 `context-snapshots` 同量级）。
- `buildMemoryPrompt(assistant, conversationId)` 同步读缓存：命中 → 只注入选中条目；未命中 → 退回全量。**签名加一个可选 conversationId，不改变现有调用方语义**。
- `invalidateContextSnapshots()` 同时清 `recallCache`（设置页改记忆、开关变化、手动刷新都走这里）。
- 会话中途话题切换不重算：这是对前缀缓存的主动让路。会话页记忆徽章提供「重新匹配记忆」动作，点了才清该会话快照。

### C5.2 混合打分（直接 + 语义）

对每一条可见记忆（`memoriesForAssistant()` 的结果，已按开关过滤）计算：

- **词法分**（直接联想）：查询与记忆都转小写；按空白/标点切词，中文额外生成 2-gram；`lex = 0.5 × 命中 token 占比 + 0.5 × 查询整体子串命中(0/1)`。
- **向量分**（语义联想）：查询向量与记忆向量余弦，截到 `[0,1]`；无向量或 `content_hash` 不匹配 → 记 0。
- **混合**：`score = 0.45 × lex + 0.55 × cos`（常量写在代码里，不做用户可调——可调只会让效果无法复现）。
- 兜底并入：最近更新的 3 条记忆 + 最多 3 条「从未索引」的近期记忆，无论分数都注入，避免漏掉刚写的重要事实。

### C5.3 关联扩展与 rerank

1. 取混合分前 `topN`（默认 40）作为候选。
2. **关联扩展**（`expandNeighbors`）：对前 5 个种子，各找余弦 ≥ 0.78 且未入选的近邻最多 2 条，总扩展上限 10 条。纯本地向量计算，零额外请求——这就是「记忆之间的关联联想」。
3. **rerank**（可选）：把候选内容按当前顺序发给 rerank 服务，`top_n = topK`；返回按 `relevance_score` 重排。失败/畸形响应 → 保持本地顺序并记一次 warning，不重试整轮。
4. 截到 `topK`，顺序即注入顺序。模型看到的仍然是 `[{id, content}]`，只是从「全部」变成「相关的这些」，并多一行 `Ordered by relevance to the current conversation.`。

### C5.4 降级矩阵

| 条件 | 结果 |
| --- | --- |
| 功能关闭 / 无 embedding 模型 | 全量注入（今天的行为） |
| 可见记忆 ≤ `minMemories` | 全量注入，不发任何请求 |
| 查询向量失败 / 超时 | 词法分排序（仍比全量好），本会话冻结该结果 |
| 向量缺失（stale） | 该条按词法参与；未索引兜底条数补上 |
| rerank 失败 | 本地混合分顺序 |
| 一切正常 | 混合分 + 关联扩展 + rerank |

## C6. API 与 SSE

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `memory/vector/status` | GET | `{ enabled, modelKey, dim, total, indexed, stale, running, progress, lastError, rerank }` |
| `memory/vector/index` | POST | body `{ mode: "rebuild" \| "missing" }`；启动任务，立即返回 `{ started: true }`；已运行返回 409 |
| `memory/vector/cancel` | POST | 取消当前任务，已完成批次保留 |
| `memory/vector/clear` | POST | 清空向量表 + meta（不动记忆），需确认对话框 |
| `memory/vector/search` | POST | body `{ query, limit? }`；只读预览，返回 `[{ id, content, lex, cos, score, reranked }]` |
| `settings/memory-vector` | POST | 局部更新切片；服务端校验：数值夹取、布尔归一。模型不在这里选（走 `settings/default-models` 的全局嵌入 / 重排档），但开启总开关前要校验 `embeddingModelId` 指向的模型存在且为 EMBEDDING，否则返回可读错误 |

- 新增 SSE 事件 `memory-index`：`{ phase: "running" \| "done" \| "error" \| "idle", done, total, message? }`，经 `/api/events` 单通道广播（与 `memory` 事件并列）。前端 `AppEventMap` 与 worker 转发清单同步加名字。
- 路由注册在 `api/router.ts` + `api/handlers/memory.ts`，不新建 handler 文件。

## C7. 前端设计

### C7.1 设置页（记忆板块）

新增 `web-ui/app/components/memory/memory-vector-card.tsx`，挂在 `memory-section.tsx` 的写入策略之后：

- **总开关** + 一句说明：「开启后记忆会被嵌入模型索引，会话开场只注入相关记忆」。
- **模型不在本页选**：嵌入与重排都是全局场景档，已上线在「设置 › 模型 › 场景模型」（见 C0 末）。本页只显示当前用的是哪一个，未配置时给一行提示 + 「去场景模型」按钮（跳 `?section=models&sub=scenes`，不自动改设置）。这样向量、以后的知识库、任何用语义检索的功能共用同一份选择，用户不必在每个功能卡里重挑一遍模型。
- **Rerank**（折叠为「高级」）：只有开关 + 候选数（`rerankTopN`）；模型同样取全局重排档，未配置时开关置灰并说明去哪儿配。
- **索引状态行**：`已索引 128 / 132 · 模型 bge-m3 · 维度 1024 · 上次 10-22 14:30`；stale 时高亮「需重建」；运行中显示进度条 + 取消。
- **动作**：重建全部 / 补齐缺失 / 清空索引 / 召回预览。
- **召回预览**：输入一句查询 → 列表显示前 10 条（内容截断 + 词法/余弦/总分小条）；有 rerank 时标注「已重排」。这只是按钮触发的显式请求，不做自动测试。
- **成本确认**：首次开启与每次「重建全部」弹确认（条数 + token 粗估 + 「之后新记忆会自动嵌入」）。

### C7.2 会话侧

- 记忆徽章 tooltip 增加一行：`本次召回 18 / 132`（未启用或全量时显示 `全部注入`）。
- 徽章菜单加「重新匹配记忆」：清该会话的召回缓存与冻结快照，下一轮重建（仅在启用时出现）。

### C7.3 模型选择器的前提

本次已经改了模型编辑对话框与供应商页：类型选择器加到四档（聊天 / 图像生成 / 嵌入 / 重排），勾选供应商模型时按 id 自动判型，非聊天档位在对话框里显示它所走的端点与「路径不标准就去高级 › 供应商覆盖改 baseUrl」的提示。剩下的仍只是「在设置页选一个已存在的模型」——记忆的向量功能不自己造模型、不写供应商。

## C8. 跨端与备份边界

- **`Model.type` 新增 `"RERANK"`（推翻原 C8 决定）**：移动端 `ModelType` 是 `kotlinx.serialization` 严格枚举（`reference/rikkahub-android/ai/.../Model.kt:25`，只有 CHAT/IMAGE/EMBEDDING），写入未知值不是「忽略一个键」而是整份 settings 反序列化失败。原方案因此把 rerank 放在 PC 独有设置键里；实际做「模型检测要支持重排」时，把重排模型藏在设置文本框里既测不了也管不了，故改为进类型系统 + 在出口处剥：
  - 导出给移动端的 `settings.json`（`pc-server/backup/export.ts` 的 `to-android` 清洗）整条剔除 `type === "RERANK"` 的模型行，供应商行与其余模型保留——`chatModelId` 等引用仍可解析。锁在 `backup/android-contract.test.ts`。
  - `pc-backup.json`（PC→PC）与 `state.json` 不剥，跨机恢复原样保留重排模型。
  - Kelivo 往返安全：Dart 侧 `_parseType` 对未知字符串退回 null（不当错误处理），且 PC→Kelivo 导入按 modelId 保留 PC 既有模型行，所以 `rerank` 能在 PC 侧留住；`map-to-pc.ts` 显式认 `rerank`，避免往返把它洗成聊天模型。
  - 记忆向量功能因此不需要独立的 rerank 配置键：已收敛为「全局重排场景档」（`settings.rerankModelId`，见 C0 末与 C3.2），不再有 `rerank.providerId/model/path` 自由文本块。
- **新设置键 `embeddingModelId` / `rerankModelId`（全局场景档，PC 独有）**：与 `promptOptimizeModelId` 同族——移动端 `Settings` 无对应字段，靠 `ignoreUnknownKeys` 无视，所以导出侧**原样透传**且**不得进 `export.ts` 的 `uuidFields`**（那里会把空串「未设置」改写成随机 UUID）；`backup/import.ts` 从安卓备份回导时显式保住 PC 值，否则 `normalizeState` 会把用户选好的模型重置掉。两条锁都在 `backup/android-contract.test.ts` + `api/default-models-toggles.test.ts`。
- 新设置键 `memoryVectorSettings`：移动端 `ignoreUnknownKeys` 已验证（特性 B 同一依据），导入桌面备份会安全忽略；导出一份不含该键的旧备份也能正常回填默认。
- 向量不进备份（`exportFlat` 只带文本；`pc_conversations.db` dump 是显式表清单）。恢复/导入后：清空向量、状态标 stale、由用户点「补齐」——不自动花钱。
- Kelivo 导入导出不受影响：只读写记忆文本。

## C9. 变更清单（特性 C）

> 下表是**剩余**（M6–M8）的变更清单。已交付的「模型可选 / 可检 / 可出站」一刀见 C0，不与本表重复。

| 文件 | 变更 |
| --- | --- |
| `pc-server/memory/sqlite.ts` | 向量表建表函数（幂等） |
| `pc-server/memory/vector-store.ts` | 新：向量读写、hash、prune、meta |
| `pc-server/memory/embedding-client.ts` | 新：`/embeddings` 批 64、重试、超时 |
| `pc-server/memory/rerank-client.ts` | 新：`/rerank` 契约、结果映射、失败保序 |
| `pc-server/memory/vector-index.ts` | 新：单飞任务、进度、取消、autoIndex 防抖 |
| `pc-server/memory/recall.ts` | 新：词法/余弦混合、关联扩展、LRU 缓存 |
| `pc-server/memory/index.ts` | 写入钩子、删除清向量、导入后 prune + stale |
| `pc-server/inference-engine/context-snapshots.ts` | `buildMemoryPrompt(assistant, conversationId)` 读召回缓存；失效时清缓存 |
| `pc-server/conversations/orchestrator.ts` | 首次编码前 `await prepareMemoryRecall` |
| `pc-server/pi-engine/resources.ts` | 同上（pi 链路） |
| `pc-server/api/handlers/memory.ts` | 5 条向量路由 + 设置校验 |
| `pc-server/api/sse.ts` | `memory-index` 事件 |
| `pc-server/foundation/types/settings/*`、`types/index.ts` | 新切片 + 类型 |
| `pc-server/app-config/defaults.ts`、`persistence/state-load.ts` | 默认值与规范化 |
| `web-ui/app/components/memory/memory-vector-card.tsx` | 新卡片 |
| `web-ui/app/components/memory/memory-section.tsx` | 挂载 |
| `web-ui/app/stores/memory-vector-store.ts` | 新：状态 + SSE 进度 |
| `web-ui/app/services/app-events.ts`、`workers/app-events-worker.ts` | 新事件名 |
| `web-ui/app/components/memory/memory-badge.tsx` | 召回计数 + 重新匹配 |
| `web-ui/app/types`、`locales/zh-CN`、`locales/en-US` | 类型与文案 |

## C10. 验收标准（特性 C）

1. 功能关闭时：不发任何请求，system 里的记忆块与改动前**逐字节一致**（快照单测）。
2. 供应商页添加一个 embedding 模型 → 设置页出现在下拉里；开启后「重建全部」能把 N/N 标记为已索引；重启后状态仍在。
3. 可见记忆 ≤ `minMemories`：即使开启也全量注入、零请求。
4. 记忆超过阈值：注入条数 ≤ `topK + 关联扩展 + 兜底`，同会话连续两轮 system 字节一致（冻结生效）。
5. 只配 embedding：召回按混合分；配了 rerank：请求体符合 `{model, query, documents, top_n}`，失败回退本地序且对话正常。
6. 新增 / 编辑 / 删除记忆后：索引增量更新；被删记忆不再出现在召回或预览里。
7. 换 embedding 模型：旧向量被忽略、状态提示重建；重建后恢复召回。
8. 401 / 超时 / 维度不符：对话照常发出，状态卡给可读错误，不出现空白或卡死。
9. 备份导出不含向量；恢复后状态为 stale，点「补齐」可恢复。
10. 全程没有 MCP server、外部向量库、新进程；库文件仍是 `rikka_hub.db`，增量约为 `维度 × 4B × 记忆条数`（1024 维约 4KB/条）。

---

## 里程碑（全版本）

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| M1 | 特性 A 后端：`PUT content`（etag/EOL/原子写）、会话文件清单、Range；前端面板骨架 + 附件/产出只读 | 4–5 人日 |
| M2 | 特性 A 编辑：编辑器、保存、冲突、dirty 守卫、改动列表、AI 写入刷新、移动端适配 | 4–5 人日 |
| M3 | 特性 B 基座：设置切片 + 两页设置 UI + 供应商 CRUD + 能力矩阵 + 5 家图片适配器 + `generate_image` + 会话开关 + 审批 + 渲染 | 6–8 人日 |
| M4 | 特性 B 视频：异步任务/轮询/取消/恢复 + S3 上传与预签名 + 4 家视频适配器 + `generate_video` + 进度 | 6–8 人日 |
| M5 | 收口：i18n、错误文案、备份回归、移动端导入导出验证、测试补全、发布文档 | 3–4 人日 |
| M6 | 特性 C 索引基座：向量表 + 设置切片 + embedding/rerank 客户端 + 全量/增量索引 + 状态与 SSE + 设置页卡片 | 4–5 人日 |
| M7 | 特性 C 召回：混合打分 + 关联扩展 + rerank + 冻结快照接入（聊天 / pi 双引擎）+ 召回预览 + 降级 | 3–4 人日 |
| M8 | 特性 C 收口：i18n、备份恢复 stale 处理、成本提示、测试补全 | 2–3 人日 |

建议发布切片：

- `0.0.3-alpha.1` = M1 + M2（文件侧边栏）
- `0.0.3-alpha.2` = M3（图片生成可用）
- `0.0.3-alpha.3` = M6（记忆索引可用，设置页能看到 N/M）
- `0.0.3-beta.1` = M4（视频可用）
- `0.0.3-beta.2` = M7（记忆召回生效）
- `0.0.3` = M5 + M8

## 风险与对策（全版本）

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 移动端模型 ID / 端点会变 | 默认配置失效 | 模型与 baseUrl 全可编辑；「恢复默认」集中在一处；文档标注对齐版本 3.1.0 |
| 视频接口要求公网素材，多数用户没有 S3 | 视频功能不可用 | 设置页明确说明；错误文案直达配置；图片链路不依赖 S3；后续可评估临时图床 |
| WebView2 视频编码 / Range | 视频不能播放或不能拖动 | 补 206；MP4/H.264 作为默认；失败时提供「外部打开」 |
| 2MB 编辑上限 | 大文件不能改 | 只读 + 外部打开；后续可做分段编辑（不建议） |
| CRLF / BOM 往返 | 保存后整文件 diff 爆炸 | 服务端检测并回写 EOL/BOM；测试覆盖 |
| 无 `fs.watch` | 外部修改不同步 | 焦点/事件刷新 + 冲突提示；0.0.4 再加 watch |
| 媒体任务写 `state.json` | 状态文件变大 / 写频繁 | 账本上限 300；只在状态变更时 `saveState`；量大再迁 SQLite |
| 模型滥用付费接口 | 费用失控 | 会话开关 + 每次审批 + 会话级串行 + 4 张/时长上限 |
| 设置跨端 | 移动端读到未知字段 | 字段名与移动端一致；桌面独有字段可选；已验证移动端 `ignoreUnknownKeys` |
| pi 与聊天引擎双份工具 | 行为漂移 | 声明只写 `openAiMediaTools` 一份，两边共用；执行同走 `executeToolCall` |
| 供应商适配差异（图片输入形态） | 某家参考图失败 | 能力矩阵 + 每家单测用 mock；错误带 provider code |
| 换 embedding 模型 / 维度变化 | 旧向量不可用 | 以 `model_key + dim` 校验；召回自动忽略不匹配向量；状态卡提示重建 |
| 召回多一次开场请求 | 首字延迟增加 | 只在新会话首次编码时付一次；6–10s 超时；失败当轮回退词法/全量 |
| 记忆量大后 BLOB 膨胀 | 库文件变大 | 1024 维 × 4B ≈ 4KB/条；1000 条约 4MB，可接受；不做向量压缩 |
| 供应商不支持 `/embeddings` | 配置后必失败 | 仅支持 OpenAI 兼容厂商；设置页写明；错误带端点与原始 message |
| 备份恢复后向量与记忆错位 | 注入错误内容 | 向量不进备份；导入后清空并标 stale，用户点「补齐」才重建 |
| 召回漏掉关键记忆 | 回答质量下降 | 小记忆量仍全量（≤ `minMemories`）+ 最近 3 条兜底 + 召回预览可验证 |
| 每条新记忆自动调付费接口 | 费用不可控 | 默认关闭；开启/重建前弹成本确认；`autoIndex` 可关 |

## 测试计划（全版本）

**单元 / 集成（不花真实额度）**

1. `workspace/files-edit.test.ts`：etag 冲突、CRLF/BOM、2MB 上限、`..`/绝对路径/软链逃逸、原子写失败不破坏原文件。
2. `conversations/files.test.ts`：附件/产出分类、去重、路径型附件。
3. `conversations/media-column.test.ts`：新库建列、老库 ALTER、INSERT/UPDATE、dump 列数。
4. `media-generation/capabilities.test.ts`：矩阵与移动端逐项一致（参数、必填、角色、remote）。
5. `media-generation/providers/*.test.ts`：用 `fetch` mock 校验请求体、端点、鉴权头、错误映射；OpenAI multipart、阿里云异步、火山任务、MiniMax 下载头、OpenRouter referer。
6. `media-generation/service.test.ts`：轮询退避、20 次失败、24h、取消、恢复。
7. `tools/approval-media.test.ts`：未启用不审批、启用必审批、reason 含模型名。
8. `backup/roundtrip.test.ts`：新设置字段 + `generatedMedia` 导出/恢复。
9. `web-ui`：EOL/etag 辅助函数、diff 行数、dirty 守卫（若已有测试框架）。
10. `memory/vector-store.test.ts`：建表幂等、Float32 BLOB 往返、upsert、按 id 删除、prune、hash 变更覆盖。
11. `memory/vector-score.test.ts`：余弦、中文 2-gram 词法、混合权重、无向量降级、关联扩展阈值。
12. `memory/embedding-client.test.ts`：请求体 `{model,input}`、批 64、返回顺序、429 重试、401 不重试、超时。
13. `memory/rerank-client.test.ts`：请求体 `{model,query,documents,top_n}`、`results` 映射、畸形响应保序。
14. `memory/recall.test.ts`：≤ `minMemories` 全量、会话冻结一次、失效重建、模型不匹配忽略向量、rerank 失败回退。
15. `api/memory-vector.test.ts`：status / index / cancel / clear / search 契约；设置校验（模型类型、topK 夹取、path）。
16. `context-snapshots.test.ts` 扩充：关闭特性时记忆块与改动前逐字节一致。

**手工验收（需要用户自己的密钥，先征得同意）**

- 每家至少 1 次图片生成；视频至少 1 家（建议阿里云或火山）；记录实际耗时与错误。
- 移动端导入桌面备份、桌面导入移动端备份各一次，确认设置不崩。
- WebView2 内视频播放、拖动、全屏。
- 用户自备一个 embedding 模型与（可选）rerank 服务：跑一次「重建全部」，看进度与耗时；再跑一次召回预览，确认结果合理。

> 注意：真实生成 / 嵌入 / 重排都会产生供应商费用。开发期全部用 mock；手工验收由用户提供密钥并明确同意后再执行，不做「自动连通性测试」消耗额度。

## 待定问题与建议（全版本）

| # | 问题 | 建议 |
| --- | --- | --- |
| 1 | 是否把媒体供应商字段做成与移动端完全同构，支持整包互通？ | **是**。字段名、类型值、模型结构照 B3/B4.1；桌面独有字段保持可选 |
| 2 | 会话级「自动批准」要不要在 0.0.3 上？ | **不上**。先保证每次可见；0.0.4 再给 `autoApprove` |
| 3 | S3 用公共读还是预签名？ | **预签名**（24h，对齐移动端）；桶保持私有 |
| 4 | 视频生成是阻塞工具调用还是后台任务？ | **0.0.3 阻塞 + 可停止**；后台任务与消息回填放 0.0.4 |
| 5 | 是否新建 `/media` 媒体库页？ | **0.0.3 只做侧栏「产出」**；全量库随 0.0.4 |
| 6 | 生成产出是否自动写进工作区？ | **不自动**；提供「保存到工作区」动作 |
| 7 | 媒体账本放 `state.json` 还是 SQLite？ | **0.0.3 放 state 账本**；超过 300 条或需要跨端查询时迁 `pc_media_task` |
| 8 | 编辑上限 2MB 是否够？ | 够用于代码/配置；大文件只读并外部打开 |
| 9 | 是否引入 CodeMirror？ | **不引入**。0.0.3 用 textarea；若编辑体验成为瓶颈再评估（包体 + WebView2 性能） |
| 10 | 旧生图页是否合并？ | **不合并**。两条链路并存，避免回归 |
| 11 | 召回要不要在会话中途每轮重算？ | **不重算**。冻结到会话首次编码，手动「重新匹配记忆」才刷新——中途重算会打穿前缀缓存 |
| 12 | rerank 要不要单独存 apiKey？ | **不新增**。复用已有 openai 型供应商凭据，密文只有一个出口 |
| 13 | 是否加 `Model.type = "RERANK"`？ | **加了**（本次推翻原决定）：检测要能按类型分流，藏在设置文本框里的重排服务测不了。跨端风险由「导安卓时剔除该行」兜住，锁在 `android-contract.test.ts`（见 C8） |
| 14 | 是否要永远注入「最近 N 条记忆」？ | **要**。最近 3 条 + 最多 3 条未索引兜底，防漏召回 |
| 15 | 向量要不要进备份？ | **不进**。可重建、会随模型失效；恢复后标 stale 由用户补齐 |
| 16 | 默认开启吗？ | **不**。默认关闭；首次开启弹成本确认，关闭时行为与今天逐字节一致 |
| 17 | 记忆很少时也走向量召回吗？ | **不**。≤ `minMemories`（默认 24）直接全量——零请求、零延迟，效果与今天相同 |

## G. 验收标准（特性 B）

1. 设置 → 媒体 → 生成服务：能添加 5 类供应商中的任意一类，保存后重启仍在；模型可增删改；「恢复默认」回填正确。
2. 会话未开启媒体：请求体里没有 `generate_image` / `generate_video`；开启后出现，关闭后消失。
3. 选择图片模型后对模型说「画一只橘猫」：出现审批卡（含供应商/模型/张数）；拒绝则不产生任何上游请求；允许后生成图片并内联显示，侧栏「产出」出现该图。
4. 视频：选择视频模型并给参考图；未配置 S3 时返回明确错误；配置后提交成功，工具卡显示阶段与耗时，停止后状态为已取消，完成后视频可播放。
5. 每次媒体调用都必须审批；模型无法通过参数绕过供应商/模型选择。
6. 供应商返回 401 / 任务失败时，工具返回可读错误，消息不显示空白图片，账本状态正确。
7. 应用在视频生成中退出，重启后任务恢复或明确标记失败，不出现永久「生成中」。
8. 5 家适配器的请求端点、默认地址、模型默认值与移动端 3.1.0 逐项一致（单测断言）。
9. 设置与 `generatedMedia` 经备份导出/恢复后不丢；导入移动端备份不崩。

---

## 附：实施顺序建议

1. 先做 A 的后端保存 API 与测试（独立、可先合入）。
2. 再做 A 的面板重构（只读三来源）——此时 UI 已有价值，风险低。
3. 加 A 的编辑与冲突处理。
4. 做 B 的设置切片 + 能力矩阵 + 一家图片适配器（建议 OpenAI 或火山，协议最直），打通「开关 → 工具 → 审批 → 图片」最小闭环。
5. 补其余图片适配器；再做视频异步与 S3。
6. C 先做「向量表 + 索引 + 状态」（可独立验收：设置页看到 N/M，不接召回也能用），再接召回。
7. 召回先只在聊天引擎生效，验收通过后再挂 pi 引擎——两条链路的冻结语义必须一致。
8. 最后补恢复、i18n、备份与发布文档。

这样每个阶段都能独立验收，不会出现「两边都做一半、都不能用」的状态。
