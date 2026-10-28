// workspace/index.ts — 工作区实体管理(agent 模式地基)
// 纪律:本模块只负责工作区的 CRUD、目录生命周期与边界根解析;
// 工具执行/路径校验/审批在 tools 侧(M1-3/M1-4),不在这里。
// 存储与会话同库(rikka_hub.db,§5.2),表为 PC 自有,跨端导出永不包含(枚举纪律,§9.1)。

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { dataDir, workspacesDir } from "../foundation/paths";
import { systemDenyDirs } from "./boundary";
import type { PcWorkspaceRow, Workspace, WorkspacePermissionPreset, WorkspaceStatus, WorkspaceType } from "../foundation/types";
import { id as newId } from "../foundation/utils";
import { getConversation, getConversationsDb, persistConversation } from "../conversations";
import { resolveSshBinding, sshBindingAvailable } from "../ssh/workspace-binding";
import type { SshWorkspaceTarget } from "../ssh/workspace-binding";
import { SshInputError } from "../ssh/errors";
import { scheduleThrottledSaveState, state } from "../persistence/json-store";
import { reportError } from "../observability/app-errors";

const WORKSPACE_NAME_MAX = 80;

// ----- 表结构(幂等,懒建) -----
//
// 不在 conversations/index.ts 里建表:保持模块单向依赖(workspace→conversations),
// 会话库不感知工作区。懒建对活库损坏重建路径同样免疫——重建后的新 Database 实例
// 不在 WeakSet 里,首次访问自动补建。

const ensuredDbs = new WeakSet<Database>();

/** ssh 型绑定的两个引用列(2.x 起):老库懒迁移用 PRAGMA 探列名,不认运气。 */
const SSH_BINDING_COLUMNS = ["ssh_device_id", "ssh_dir_id"] as const;

function columnNames(handle: Database, table: string): string[] {
  return (handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
}

function db(): Database {
  const handle = getConversationsDb();
  if (!handle) throw new Error("conversations db not open");
  if (!ensuredDbs.has(handle)) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS pc_workspace (
        id                TEXT PRIMARY KEY NOT NULL,
        name              TEXT NOT NULL,
        type              TEXT NOT NULL,
        root              TEXT NOT NULL DEFAULT '',
        permission_preset TEXT NOT NULL,
        trusted_at        INTEGER,
        ssh_device_id     TEXT,
        ssh_dir_id        TEXT,
        create_at         INTEGER NOT NULL,
        update_at         INTEGER NOT NULL,
        last_access_at    INTEGER NOT NULL
      );
    `);
    // 懒迁移:建 ssh 工作区之前建的库没有这两列。ADD COLUMN 只改元数据、不动行,
    // 与"老库里全是 managed/folder 行"互不干扰(缺省 NULL,由 rowToWorkspace 收敛)。
    const existing = new Set(columnNames(handle, "pc_workspace"));
    for (const column of SSH_BINDING_COLUMNS) {
      if (!existing.has(column)) handle.exec(`ALTER TABLE pc_workspace ADD COLUMN ${column} TEXT`);
    }
    ensuredDbs.add(handle);
  }
  return handle;
}

/** 工作区宿主目录(= tmp/ 的父目录)。远程工作区用它当引擎的本地 cwd:pi 的会话 cwd
 *  必须是一个真实的本机目录(它要在那儿做 fs 行走与保留名清扫),而工作区的边界根在远端,
 *  两者不是同一个东西——runtime.ts 里 engineCwd 与 root/cwd 分列就是这个分歧的形状。 */
export function workspaceHostDir(workspaceId: string): string {
  return hostDir(workspaceId);
}

// ----- 目录布局 -----
//
// 每个工作区(不分类型)在 workspacesDir/<id>/ 下有宿主目录:tmp/ 放超长 shell 输出
// 落盘等 PC 侧杂物(folder 型也在这里,不污染用户目录)。managed 型额外有 files/
// 作为模型可见的边界根。

function hostDir(workspaceId: string): string {
  return join(workspacesDir, workspaceId);
}

export function workspaceTmpDir(workspaceId: string): string {
  return join(hostDir(workspaceId), "tmp");
}

function managedRoot(workspaceId: string): string {
  return join(hostDir(workspaceId), "files");
}

// ----- 行映射 -----
//
// managed 型 root 落库为空串、载入时由当前 dataDir 计算——数据目录整体搬迁
// (RIKKAHUB_PC_DATA_DIR / 便携安装挪盘)后边界根自愈,不留死绝对路径。

function normalizeType(raw: string): WorkspaceType {
  if (raw === "folder") return "folder";
  if (raw === "ssh") return "ssh";
  return "managed";
}

function normalizePreset(raw: string): WorkspacePermissionPreset {
  if (raw === "confirm_each" || raw === "full_access") return raw;
  return "balanced";
}

function rowToWorkspace(row: PcWorkspaceRow): Workspace {
  const type = normalizeType(row.type);
  const sshDeviceId = row.ssh_device_id ?? null;
  const sshDirId = row.ssh_dir_id ?? null;
  // ssh 型的边界根不属于自己的表:每次由「拓展 › SSH」的授权目录派生(见 ssh/workspace-binding.ts)。
  // 派生不出来(设备删了/目录撤了)时退回落库的那份路径快照——它不再参与任何边界判定
  // (绑定断了工作区就不可用),只是让界面还能显示"这个工作区本来指向哪里"。
  const binding = type === "ssh" ? resolveSshBinding(sshDeviceId, sshDirId) : null;
  const root = type === "managed"
    ? managedRoot(row.id)
    : binding?.target ? binding.target.root : row.root;
  return {
    id: row.id,
    name: row.name,
    type,
    root,
    permissionPreset: normalizePreset(row.permission_preset),
    trustedAt: row.trusted_at ?? null,
    sshDeviceId: type === "ssh" ? sshDeviceId : null,
    sshDirId: type === "ssh" ? sshDirId : null,
    createAt: row.create_at,
    updateAt: row.update_at,
    lastAccessAt: row.last_access_at,
  };
}

/** 远程绑定的不可用原因(仅 ssh 型;其余型返回 null)。工具挂载与引擎选路读它,界面用它解释
 *  "看起来正常却一个工具都没有"的工作区。文案是英文——同一份字符串会进模型错误文案(runtime.ts)。 */
export function workspaceUnavailableReasonOf(workspace: Workspace | null): string | null {
  if (!workspace) return null;
  if (workspace.type !== "ssh") return null;
  return resolveSshBinding(workspace.sshDeviceId, workspace.sshDirId).reason;
}

/** 运行时健康状态(计算,不落库):根目录丢失 = missing(对齐安卓 BROKEN,不静默删记录)。
 *  ssh 型的"丢失"只看配置层绑定(设备/授权目录/主机密钥),不探网络——列表页与每轮挂载判定
 *  都在这条路径上,探测留给「测试连接」与工具执行自己报错。远端临时不可达不是 missing。 */
export function workspaceStatus(workspace: Workspace): WorkspaceStatus {
  if (workspace.type === "ssh") {
    return resolveSshBinding(workspace.sshDeviceId, workspace.sshDirId).reason ? "missing" : "ready";
  }
  try {
    return statSync(workspace.root).isDirectory() ? "ready" : "missing";
  } catch {
    return "missing";
  }
}

// ----- CRUD -----

export function listWorkspaces(): Workspace[] {
  const rows = db().prepare(
    "SELECT * FROM pc_workspace ORDER BY last_access_at DESC, create_at DESC, id DESC",
  ).all() as PcWorkspaceRow[];
  return rows.map(rowToWorkspace);
}

export function getWorkspace(workspaceId: string): Workspace | null {
  const row = db().prepare("SELECT * FROM pc_workspace WHERE id = ?").get(workspaceId) as PcWorkspaceRow | null;
  return row ? rowToWorkspace(row) : null;
}

function sanitizeName(raw: unknown, fallback: string): string {
  const name = String(raw ?? "").trim().slice(0, WORKSPACE_NAME_MAX);
  return name || fallback;
}

/** 路径身份比较键:Windows 文件系统大小写不敏感,统一小写参与比较;resolve() 已归一
 *  分隔符与尾部斜杠。不追 symlink/junction 别名——目录别名的越权问题归边界层
 *  (boundary.ts)管,这里只负责"同一路径写法"的身份判定,过度解析反而引入网络盘/
 *  subst 的兼容坑。 */
function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** 工作区 ↔ 文件夹 1:1 不变式的查询半边:该目录当前绑定的 folder 型工作区(无则 null)。
 *  会话/信任/权限/宿主目录全挂在工作区实体上,允许同目录重复绑定会造成"平行工作区、
 *  历史互不可见"的割裂(2.0.0 内测反馈)。managed 型 root 由 id 派生且必在 dataDir 内、
 *  与 folder 型准入互斥(validateFolderRoot 拒绝 dataDir 重叠),天然不参与查重。 */
export function findWorkspaceByRoot(root: string): Workspace | null {
  const target = comparablePath(root);
  for (const workspace of listWorkspaces()) {
    if (workspace.type === "folder" && comparablePath(workspace.root) === target) return workspace;
  }
  return null;
}

/** ssh 型的 1:1 不变式半边(与 folder 型同一条理由:会话/权限/宿主目录挂在工作区实体上,
 *  同一远程目录开出两个平行工作区会把历史切成两半)。比较的是两个引用 id 而不是路径——
 *  改了授权目录的路径写法就等于换了一个绑定,这由设置层负责解释,这里不做跨语义归一。 */
export function findWorkspaceBySshBinding(deviceId: string, dirId: string): Workspace | null {
  for (const workspace of listWorkspaces()) {
    if (workspace.type === "ssh" && workspace.sshDeviceId === deviceId && workspace.sshDirId === dirId) return workspace;
  }
  return null;
}

/**
 * ssh 型绑定准入:入参只有两个引用 id(凭据与远程路径都活在「拓展 › SSH」,工作区一行都不存)。
 * 判据全交给 ssh/workspace-binding.ts;错误带 errorCode 进 `errors.ssh.*` 的 i18n 通道
 * (message 是英文兜底——与 ssh/errors.ts 头注那条分工一致)。
 */
function requireSshTarget(deviceId: unknown, dirId: unknown): SshWorkspaceTarget {
  const wantedDevice = String(deviceId ?? "").trim();
  const wantedDir = String(dirId ?? "").trim();
  if (!wantedDevice || !wantedDir) {
    throw new SshInputError("Select an SSH device and one of its authorized remote directories", "ssh.binding_dir_unauthorized");
  }
  const binding = resolveSshBinding(wantedDevice, wantedDir);
  if (!sshBindingAvailable(binding)) {
    throw new SshInputError(binding.reason ?? "SSH binding is not usable", binding.errorCode ?? "ssh.binding_dir_unauthorized");
  }
  return binding.target;
}

/** folder 型根目录准入校验。返回规范化绝对路径,不合法抛错(错误文案直达 UI)。 */
export function validateFolderRoot(rawRoot: unknown): string {
  const raw = String(rawRoot ?? "").trim();
  if (!raw || !isAbsolute(raw)) throw new Error("必须提供绝对路径");
  const root = resolve(raw);
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new Error("目录不存在或不可访问");
  }
  if (!stat.isDirectory()) throw new Error("路径不是目录");
  // 文件系统根(C:\ / /)作为边界等于没有边界
  if (root === resolve(root, "..")) throw new Error("不能以磁盘根目录作为工作区");
  // 与应用数据目录互斥:工作区含 dataDir 或位于 dataDir 内,模型可改写应用自身状态
  const rootPrefixed = root + sep;
  const dataPrefixed = resolve(dataDir) + sep;
  if (rootPrefixed.startsWith(dataPrefixed) || dataPrefixed.startsWith(rootPrefixed)) {
    throw new Error("工作区不能与应用数据目录重叠");
  }
  // 操作系统系统目录拒绝(M1 冒烟发现的缺口):这类目录做工作区无正当场景,
  // 写坏即系统级灾难。只拦"等于或位于系统目录内",不拦包含关系(C:\ 已被盘根规则拦)。
  // Windows 路径大小写不敏感,比较前统一小写。
  for (const sysDir of systemDenyDirs()) {
    if (comparablePath(root) === comparablePath(sysDir) || comparablePath(rootPrefixed).startsWith(comparablePath(sysDir + sep))) {
      throw new Error("不能以操作系统目录作为工作区");
    }
  }
  return root;
}

/** 新建 managed 工作区的默认名:首个用"默认工作区",此后取最小空号"工作区 N"——
    避免多个互不相同的工作区顶着同一个名字让人误以为是同一个(G6)。 */
function nextManagedWorkspaceName(): string {
  const names = new Set(
    (db().prepare("SELECT name FROM pc_workspace").all() as { name: string }[]).map((row) => row.name),
  );
  if (!names.has("默认工作区")) return "默认工作区";
  for (let n = 2; ; n += 1) {
    const candidate = `工作区 ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

export function createWorkspace(input: {
  type: WorkspaceType;
  name?: unknown;
  root?: unknown;
  sshDeviceId?: unknown;
  sshDirId?: unknown;
}): Workspace {
  const now = Date.now();
  const workspaceId = newId();
  let root = "";
  let sshDeviceId: string | null = null;
  let sshDirId: string | null = null;
  let trustedAt: number | null = now; // managed 型创建即信任(§3.3)
  let fallbackName = nextManagedWorkspaceName();
  if (input.type === "folder") {
    root = validateFolderRoot(input.root);
    // 工作区 ↔ 文件夹 1:1 不变式(2.0.0 内测反馈):同一目录重复"创建"= 打开既有
    // 工作区(open-or-create),不再造平行工作区把历史会话藏起来。folder 型创建
    // 对话框本就不收名字,无"改名"歧义;返回形状与新建一致,前端 onCreated 自然选中。
    const bound = findWorkspaceByRoot(root);
    if (bound) {
      touchWorkspaceAccess(bound.id);
      return getWorkspace(bound.id) ?? bound;
    }
    trustedAt = null; // folder 型必须显式过信任门
    fallbackName = root.split(sep).filter(Boolean).pop() ?? "工作区";
  }
  if (input.type === "ssh") {
    const target = requireSshTarget(input.sshDeviceId, input.sshDirId);
    root = target.root;
    sshDeviceId = target.device.id;
    // 落库存解析后的规范 id(不是界面传来的原值):findRemoteDir 也认旧式"路径当 id",
    // 归一之后 1:1 查重的比较才有唯一口径。
    sshDirId = target.dir.id;
    // 与 folder 型同一条 open-or-create 不变式:同一设备的同一授权目录只开一个工作区。
    const bound = findWorkspaceBySshBinding(sshDeviceId, sshDirId);
    if (bound) {
      touchWorkspaceAccess(bound.id);
      return getWorkspace(bound.id) ?? bound;
    }
    // 信任门:ssh 型创建即信任——"允许 AI 碰这台机器"已经由「登记授权目录」+「确认主机
    // 密钥」两个显式动作表达过,工作区绑定不该再弹第三次(详见 ssh/workspace-binding.ts 头注)。
    fallbackName = root.split("/").filter(Boolean).pop() || target.label;
  }
  // 默认档位(权限档位改版):一律"默认权限"(balanced);但记住用户上一次的显式选择——
  // 上次切到"完全访问"的用户,新建工作区也从"完全访问"起步。folder 型的风险由信任门把守。
  // state 在启动装载前为 undefined(单测常见),此时按无记忆处理(normalizePreset 回退 balanced)。
  const preset: WorkspacePermissionPreset = normalizePreset(String(state?.settings?.workspaceLastPermissionPreset ?? ""));
  const name = sanitizeName(input.name, fallbackName);

  mkdirSync(workspaceTmpDir(workspaceId), { recursive: true });
  if (input.type === "managed") mkdirSync(managedRoot(workspaceId), { recursive: true });

  db().prepare(
    "INSERT INTO pc_workspace (id, name, type, root, permission_preset, trusted_at, ssh_device_id, ssh_dir_id, create_at, update_at, last_access_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(workspaceId, name, input.type, input.type === "managed" ? "" : root, preset, trustedAt, sshDeviceId, sshDirId, now, now, now);
  const created = getWorkspace(workspaceId);
  if (!created) throw new Error("workspace insert failed");
  return created;
}

/** B6-①b:重绑支持。patch.root 仅对 folder 型生效(工作区与项目文件夹解耦:实体保留,
 * 指向的目录可换)。managed 型 root 由 dataDir 派生、不落库,不可改绑。
 * folder 型重绑新目录后重置信任门(trusted_at 置空,待用户重确认)——新目录是新边界,
 * 沿用旧信任等于让模型静默获得一片未授权目录的读写权。
 *
 * ssh 型的改绑走 patch.sshDeviceId / patch.sshDirId,且**不**重置信任门:换上去的目标必须
 * 是「拓展 › SSH」里另一个已授权、已确认主机密钥的目录,同意在设置层已经给过;folder 型
 * 那道门拦的是用户手输的任意本机路径,两者的风险来源不同(见 ssh/workspace-binding.ts 头注)。 */
export function updateWorkspace(
  workspaceId: string,
  patch: { name?: unknown; permissionPreset?: unknown; root?: unknown; sshDeviceId?: unknown; sshDirId?: unknown },
): Workspace | null {
  const existing = getWorkspace(workspaceId);
  if (!existing) return null;
  const name = patch.name !== undefined ? sanitizeName(patch.name, existing.name) : existing.name;
  let preset = existing.permissionPreset;
  if (patch.permissionPreset !== undefined) {
    const raw = String(patch.permissionPreset);
    if (raw !== "confirm_each" && raw !== "balanced" && raw !== "full_access") {
      throw new Error("无效的权限档位");
    }
    preset = raw;
    if (preset !== existing.permissionPreset && state?.settings) {
      // 记录"用户上一次的选择"作为后续新建工作区的默认档位(PC-only 设置,节流落盘)。
      state.settings.workspaceLastPermissionPreset = preset;
      scheduleThrottledSaveState();
    }
  }
  let root = existing.type === "folder" ? existing.root : "";
  let trustedAt = existing.trustedAt;
  let sshDeviceId = existing.type === "ssh" ? existing.sshDeviceId : null;
  let sshDirId = existing.type === "ssh" ? existing.sshDirId : null;
  if (patch.root !== undefined) {
    if (existing.type !== "folder") throw new Error("仅 folder 型工作区可重新绑定目录");
    const newRoot = validateFolderRoot(patch.root);
    // 大小写变体视为同目录(comparablePath):不算换绑,信任不重置。
    if (comparablePath(newRoot) !== comparablePath(existing.root)) {
      // 1:1 不变式的另一半:重绑目标已被其他工作区绑定 → 拒绝(错误文案直达 UI)。
      const bound = findWorkspaceByRoot(newRoot);
      if (bound && bound.id !== workspaceId) throw new Error(`该文件夹已绑定工作区「${bound.name}」`);
      root = newRoot;
      trustedAt = null; // 重绑新目录 → 信任门重置,待用户重确认
    }
  }
  if (patch.sshDeviceId !== undefined || patch.sshDirId !== undefined) {
    if (existing.type !== "ssh") throw new Error("仅 SSH 工作区可更换绑定的设备与远程目录");
    const target = requireSshTarget(patch.sshDeviceId ?? existing.sshDeviceId, patch.sshDirId ?? existing.sshDirId);
    if (target.device.id !== existing.sshDeviceId || target.dir.id !== existing.sshDirId) {
      const bound = findWorkspaceBySshBinding(target.device.id, target.dir.id);
      if (bound && bound.id !== workspaceId) throw new Error(`该远程目录已绑定工作区「${bound.name}」`);
    }
    sshDeviceId = target.device.id;
    sshDirId = target.dir.id;
    // root 列是那份"本来指向哪里"的显示快照,换绑必须同步——否则绑定失效态会指着旧路径。
    root = target.root;
  }
  db().prepare("UPDATE pc_workspace SET name = ?, permission_preset = ?, root = ?, trusted_at = ?, ssh_device_id = ?, ssh_dir_id = ?, update_at = ? WHERE id = ?")
    .run(name, preset, root, trustedAt, sshDeviceId, sshDirId, Date.now(), workspaceId);
  return getWorkspace(workspaceId);
}

/** 信任门确认(§3.3,folder 型)。managed 型创建即信任,重复调用幂等。 */
export function trustWorkspace(workspaceId: string): Workspace | null {
  const existing = getWorkspace(workspaceId);
  if (!existing) return null;
  if (existing.trustedAt === null) {
    const now = Date.now();
    db().prepare("UPDATE pc_workspace SET trusted_at = ?, update_at = ? WHERE id = ?").run(now, now, workspaceId);
  }
  return getWorkspace(workspaceId);
}

export function touchWorkspaceAccess(workspaceId: string): void {
  db().prepare("UPDATE pc_workspace SET last_access_at = ? WHERE id = ?").run(Date.now(), workspaceId);
}

/**
 * 删除工作区:managed 删托管宿主目录(含 files/),folder 只删 tmp 宿主目录、用户
 * 真实目录一个字节不动(§5.2);ssh 型同样只删本地 tmp 宿主目录——远端那台机器上的
 * 任何文件都不因"删除工作区"而改变(授权还留在 拓展 › SSH,由那里单独撤销)。
 * 归属会话解绑为对话模式(workspaceId 置空,无数据
 * 丢失;是否连会话一起删由 M2 的 UI 决策,后端保守)。
 *
 * 解绑必须走 working set 权威实例(getConversation→改字段→persistConversation),
 * 不能只 UPDATE 库行——活跃实例内存里还留着旧 workspaceId,后续任何 flush 会把
 * 库行覆盖回去(安卓 moveConversationToFolder 同款教训)。
 *
 * B5-① 原子性:无法包成一个 DB 事务(persistConversation 自带事务,SQLite 不支持
 * 嵌套;且必须走内存实例)。改为"逐个解绑 + 任一失败即时中止"——某个会话解绑失败
 * 立即停手、如实上报已解绑计数、不删工作区记录。残留绑定幂等,用户重试即可续解,
 * 优于"工作区已删但部分会话仍绑着已删 id"的孤儿态。
 */
export function deleteWorkspace(workspaceId: string): boolean {
  const existing = getWorkspace(workspaceId);
  if (!existing) return false;

  const boundIds = (db().prepare("SELECT id FROM pc_conversation WHERE workspace_id = ?").all(workspaceId) as { id: string }[])
    .map((row) => row.id);
  let unbound = 0;
  for (const convId of boundIds) {
    const conversation = getConversation(convId);
    if (!conversation) {
      // 会话行在 SELECT 与解绑之间被并发删除:无需解绑,跳过计入已处理。
      unbound += 1;
      continue;
    }
    conversation.workspaceId = null;
    conversation.workspaceCwd = null;
    conversation.updateAt = Date.now();
    try {
      persistConversation(conversation);
    } catch (err) {
      reportError(
        "workspace",
        "warn",
        `删除工作区失败:解绑会话 ${convId} 时出错(已解绑 ${unbound}/${boundIds.length} 个,工作区未删除,可重试)`,
        err,
        "workspace_delete_unbind_failed",
        { workspaceId, failedConversationId: convId, unbound, total: boundIds.length },
      );
      return false;
    }
    unbound += 1;
  }

  db().prepare("DELETE FROM pc_workspace WHERE id = ?").run(workspaceId);

  // 目录清理尽力而为:失败(文件占用/权限)只上报不回滚——记录已删,残留目录无引用,
  // 下次同 id 不会再出现(id 是 UUID)
  const dir = hostDir(workspaceId);
  // 防御性断言:被删目录必须在托管宿主目录之下,绝不触碰 folder 型的用户真实目录
  if (resolve(dir).startsWith(resolve(workspacesDir) + sep) && existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      reportError("workspace", "warn", `工作区目录清理失败(记录已删除,残留目录可手动清理):${dir}`, err, "workspace_dir_cleanup_failed");
    }
  }
  return true;
}
