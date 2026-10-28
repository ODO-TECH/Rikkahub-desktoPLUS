# Windows 沙盒与权限管理 —— 方案（2026-10-26；2026-10-27 全量实施）

> 结论先行：**策略只声明一次、实测只做一次，两种操作系统各用各的机制兑现。**
> 2026-10-26 落地"声明 + 探针 + 权限层联动 + 界面显示"这一层（跨平台共用）；
> 2026-10-27 把 Windows 那一步也按下去了——设置开关 → 启动编排（标注目录 + 低完整性
> 自重启）→ 探针实测通过，**全程免提权**（此前"必须一次 UAC"的结论是常量写错造成的
> 误判，见 §2.1 更正）。

## 0. 档位语义（三个档，跨平台一致）

| 档位 | 应用层含义 | 操作系统层含义 |
| --- | --- | --- |
| 受限 `restricted` | 工作区内读写免审；区外写入要审批；危险命令要审批 | 区外写入由操作系统直接拒绝（Windows 低完整性内核 / 容器只读挂载） |
| 完全访问 `full_access` | 全部免审 | 不设边界 |
| 不设边界 `off` | 只做危险命令清单 | 不设边界 |

应用层的档位（`confirm_each` / `balanced` / `full_access`）与操作系统的边界是**两件事**：
档位决定"要不要弹卡"，系统边界决定"弹了卡也拦不拦得住"。混为一谈就会出现
"用户点了允许，写入还是失败"的错位体验。

## 1. 已落地：一份声明、一套判定、两种机制

新增 `pc-server/workspace/sandbox.ts`：

- **声明**：环境变量 `RIKKAHUB_SANDBOX=restricted|full|off`（容器 compose 默认 `restricted`）。
- **Windows 判定**：往 `%LOCALAPPDATA%\Temp`（Medium 标签，低完整性进程写不进去）写临时文件。
  - 写成功 ⇒ 没有边界（`measured=not_enforced`），日志与 `/api/app/sandbox` 显式点名；
  - 写被拒 ⇒ 边界在起作用（`measured=enforced`）；
  - 探针位置不存在 ⇒ `unknown`（不能新建，也不能当成边界生效）。
- **容器判定**：读 `/proc/self/mounts` 的根 fs 挂载标志——`ro` ⇒ `enforced`；`rw` ⇒ `not_enforced`；
  读不到或无法解析 ⇒ `unknown`。普通目录权限不足（例如 `/` 的 EACCES）不再当成边界：
  Linux 非容器部署没有这类系统级机制，结论是 `not_enforced`，不会误报“受限中”。
  可选的 `RIKKAHUB_SANDBOX_PROBE_PATH` 会对指定“区外代表点”再做一次写探针；
  写得进去说明存在 rw 例外挂载，不能宣称全局边界。
- **不能用 `os.tmpdir()` 当探针**：启动时 TEMP/TMP 已改道到 `dataDir/tmp`（那正是区内可写处），
  用它探针会永远得出假阴性。这条对 Windows 探针尤其关键。
- **汇报**：`GET /api/app/sandbox` 返回档位、实测结论、机制、`rwMounts`（标为 rw 的挂载点，
  不代表当前 uid 一定有写权限）、差异说明；启动日志打一行 `[sandbox] ...`。

权限层联动（`workspace/approval.ts` + `tools/approval.ts` + `workspace/runtime.ts`）：

- 边界生效时，区外写入的审批卡文案改成"操作系统会拒绝"，不再承诺"允许一次就能写"；
- 边界生效时，`runtime.ts` 一律走严界路径，不再因为"用户批准过"而放行宽界写入；
- 区外写入被边界挡下时，错误信息追加一句"换写法没用，改在区内写"（模型少一轮无效重试）。

界面：工作区权限下拉里新增一行"系统边界：已生效 / 未启用 / 声明受限但实测未生效"，
把"审批卡 ≠ 真隔离"这件事摆在明面上。

> 声明不等于生效。所以别只信 `RIKKAHUB_SANDBOX` 这个变量：启动日志的 `[sandbox]` 行与
> `/api/app/sandbox` 才是实情。

## 2. Windows 的机制选择

### 2.1 低完整性（Mandatory Integrity Control）—— 目标方案

内核的 no-write-up 规则：进程完整性级别低于对象完整性级别 ⇒ 写入被拒，读取照旧。
把 agent 进程降到 Low、把它要写的工作区标成 Low，"区内可写、区外只读"就是内核保证的，
不是应用层自觉。

**本机实测到的四件事**（`tools/sandbox-spike/`）：

| 事实 | 怎么验的 | 结论 |
| --- | --- | --- |
| 目录可以无提权降到 Low | `icacls <dir> /setintegritylevel "(OI)(CI)L"`（属主权限即可） | 成功，出现 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` |
| 降级会传播到既有子文件 | 降级前建的 `existing.txt` 降级后带上了 Low 标签 | 工作区已有文件不会"留在 Medium 上写不进去" |
| Medium 进程仍能写 Low 目录 | 降级后普通进程写入成功 | **用户自己的编辑器/资源管理器不受影响**（Low 只挡 Low 以下） |
| ~~降自己的令牌到 Low 需要管理员授权~~ **降级免提权** | 最初 spike 得到 ACCESS_DENIED、误判为需要 UAC；复测（`relax-retest.ts`）发现是 `OpenProcessToken` 掩码写错——把 `TOKEN_ADJUST_PRIVILEGES`(0x20) 当成了 `TOKEN_ADJUST_DEFAULT`(0x80)。换对掩码后 `SetTokenInformation(TokenIntegrityLevel=Low)` 在普通 Medium 令牌上直接成功 | **不需要 SeRelabelPrivilege、不需要 UAC**，整套机制普通权限即可 |

补充（更正）：`SetTokenInformation` 的 `TokenIntegrityLevel`(=25) 修改**不需要**
`SeRelabelPrivilege`——把完整性降下来（no-write-up 只会让自己更受限）不视为提权操作，
令牌句柄带 `TOKEN_ADJUST_DEFAULT` 即可；需要的只有 `OpenProcessToken` 的掩码里含
`TOKEN_DUPLICATE`（后续 `DuplicateTokenEx` 复制主令牌）与 `TOKEN_ADJUST_DEFAULT`。
原文"卡点在特权"不成立。

### 2.2 受限令牌（Restricted Token + restricting SID）—— 为什么不用作主方案

不需要提权，但语义是"双向收紧"：访问要同时通过普通 DACL 检查与 restricting SID 检查，
于是**区外读也会被拒**（除非给 restricting SID 到处开读权限，那等于给整盘改 ACL，
且继承传播在百万文件目录上会跑到天亮）。它换来的是"区内读写 + 区外全看不见"，
比用户要的"区外只读"更严，会让 agent 读不到该读的资料。作为主方案不合适。

### 2.3 Docker Desktop on Windows —— 零新增代码的等价路径

复用已经加固好的 `docker-compose.yml`：`:rw` 只给工作区、其余 `:ro`、只读根 fs、非 root、
`cap_drop: ALL`、`no-new-privileges`。语义与低完整性完全一致，且**不需要任何提权**。
代价是整个后端跑在容器里（桌面壳要改成连容器后端），与"便携版 + WebView2 轻壳"的形态不合。
适合 NAS 场景，不适合桌面日常驱动。

## 3. 低完整性路线的实现（已实施，2026-10-27）

入口是设置里的一个开关（`settings.sandboxRestricted`，PC-only、导出安卓备份时剥离），
后端启动时按触发矩阵决定走哪条路（`pc-server/workspace/restricted-launch.ts`）：

| 条件 | 动作 |
| --- | --- |
| 非首次 Medium 启动（`RIKKAHUB_SANDBOX_LAUNCHED=1`，子进程标记） | 跳过——防自重启循环的硬不变量 |
| 开关开或部署声明 `restricted`（Windows） | 标注目录 → 低完整性自重启 → 准备进程干净退出 |
| 开关关且有标注记录残留 | 按记录把目录还原回 Medium |
| 其余（常态） | 零开销直过 |

流程细节：

1. **编排位置**：`server.ts` 在 dataDir 单实例锁**之前**调用——准备进程不抢锁，Low 子进程
   拿锁无竞态；准备进程退出前调 `bootCleanExit()`，不留下"假崩溃"黑匣子。
2. **标注**（`workspace/labeling.ts`，icacls 参数数组形态）：把 `pc-data` 与所有 folder 型
   工作区根 `icacls /setintegritylevel "(OI)(CI)L"`；成功者记入 `pc-data/sandbox-labels.json`，
   下次启动记录里已有的目录跳过重放（大目录的标签传播可达秒级）。dataDir 标注后还要
   实测确认真是 Low——低完整性进程写不了自己的库，标不上就不降级。
3. **造低完整性进程**（`workspace/low-integrity.ts`，进程内 bun:ffi，免提权）：
   `OpenProcessToken(含 TOKEN_ADJUST_DEFAULT)` → `DuplicateTokenEx(TokenPrimary)` →
   `SetTokenInformation(TokenIntegrityLevel=Low)` → `CreateProcessAsUserW` 拉起自己
   （同一条命令行，`bInheritHandles=false`）。自复制令牌不需要 `SeAssignPrimaryToken`
   （Chrome 沙盒同款路线）。
4. **环境重定向**：`TEMP/TMP` → `dataDir/tmp`、`HOME/USERPROFILE` → `dataDir/home`（Low
   进程写不了真实用户家目录，bash 的 `~` 必须落在区内，与容器 `HOME=/app/pc-data/home`
   同一约定）；`RIKKAHUB_SANDBOX=restricted`；`RIKKAHUB_SANDBOX_LAUNCHED=1`（最后强制
   写入、不可被继承环境覆盖）。
5. **还原**：用户关掉开关后，**下一次 Medium 启动**按记录还原标签（Low 进程自己改不了
   标签）；全部还原干净即删除记录文件。部分失败的目录留在记录里下次重试。
6. **失败降级**：标注不成功或拉起失败 ⇒ 还原已做的标注、以不受限模式继续、日志如实点名
   ——绝不"降级失败还自称受限"。
7. **实测兜底**：`/api/app/sandbox` 的探针（§1）不受任何声明影响；界面（设置 › 网络 ›
   Web 服务）同时显示"开关（待重启）"与"实测（已生效/未生效）"两件事。
8. **桌面壳**（`desktop-shell/Program.cs`）：壳拉起的首个后端就是准备进程，它自重启后
   即退出、不输出端口标记。壳的 `Exited` 处理对"提前退出"不按故障报，改为轮询同一端口
   （`/api/health`）最多 30 秒，探到即接上；真正的启动失败走 `RIKKAHUB_FATAL:` 单行
   标记快速弹窗。低完整性后端作为孙进程仍在壳的 Job Object 里，壳退出照常回收。

### 验收结果（demo 17455，2026-10-27 实测）

- 开 → 重启：`icacls` 显示 `Mandatory Label\Low Mandatory Level`（dataDir + folder 工作区）；
  `/api/app/sandbox` 返回 `tier=restricted, measured=enforced`，探针写 `%LOCALAPPDATA%\Temp`
  被内核拒绝（EPERM）；后端在 Low 下 SQLite 读写、改设置全部正常。
- 关 → 重启：2 个目录标签还原回 Medium，`sandbox-labels.json` 删除；探针恢复可写
  （`measured=not_enforced`），界面不再显示残留。

## 4. 明确不做的事

- **不做"两套实现"**：策略声明一份、判定口径一份；Windows 用写探针、容器用挂载表，只换机制，不换承诺。
- **不承诺做不到的事**：边界没生效时，应用层不弹"允许一次写区外"（反正会被系统打回）；
  边界生效时，审批卡直接说明"操作系统会拒绝"。
- **不静默降级**：声明 `restricted` 但实测 `not_enforced` 时，启动日志与 `/api/app/sandbox`
  都会点名，绝不把"没边界"说成"受限中"。
