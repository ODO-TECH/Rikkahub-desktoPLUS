// ssh/workspace-prompt.ts — 远程工作区的系统提示词(对齐安卓端 WorkspaceReminderTransformer)
//
// 这一层存在的理由:模型默认按本机 bash + apt 写命令,而远端可能是 dropbear + BusyBox ash;
// 提示词里没有 shell 与发行版,模型就会给出 `[[ ]]`、`apt install` 这类在目标机上直接报错的
// 命令。安卓端为此在每轮请求前注入一段 <workspace> 说明,这里做同一件事。
//
// 三条与安卓端一致的纪律:
// 1) shell 与发行版只在远端读一次,读到就长期沿用(RemoteEnvironmentCache:成功黏住,
//    失败只记 60s)——每轮都探测等于每轮多付两次网络往返。缓存键带连接指纹,改了密码/
//    主机等于换了台机器,自动重新探测。
// 2) shell 探测失败就不再读发行版:发行版要靠同一条连接,再试只会多等一个超时。
// 3) 远程分支不读 AGENTS.md(安卓端同款):项目上下文是本地概念,远端目录里恰好有个
//    同名文件就把它当指令,等于让服务器端任意用户写的文件接管本会话。
//
// 与安卓端的一处有意分歧:安卓端有落库的 shellStatus,没就绪就不挂载工具;rdp 没有
// 常驻连接状态,工具是否挂载只看配置(见 workspace-binding.ts),连不上时照样注入这段
// 说明——工具会自己把真实的 SSH 错误回给模型,比"提示词里说连不上、工具却静默不挂载"
// 更好排查,也让模型先告知用户而不是连试三条命令。
//
// 冻结纪律(pi-engine/resources.ts 头注):appendSystemPrompt 同会话内必须字节稳定。
// 成功结果本身稳定;失败结果里带 error.message,靠 60s 缓存 TTL 保证同一会话连续几轮
// 不会每轮换一句话术。

import type { Workspace } from "../foundation/types";
import { sshPool } from "./pool";
import { sshConnectionSignature } from "./devices";
import type { SshConnection } from "./connection";
import type { SshWorkspaceTarget } from "./workspace-binding";

/** 远端执行环境:登录 shell 路径 + 发行版名(读不到为 null,提示词省略那一行)。 */
export interface RemoteEnvironment {
  shell: string;
  distro: string | null;
}

// ── 发行版识别(安卓端 OS_RELEASE_PATHS / parseOsReleaseName 逐字对齐) ────────────

const OS_RELEASE_PATHS = ["/etc/os-release", "/usr/lib/os-release"] as const;
const MAX_OS_RELEASE_BYTES = 16 * 1024;
const MAX_DISTRO_NAME_LENGTH = 80;

/**
 * 从 os-release 内容取发行版名,优先 PRETTY_NAME,其次 NAME + VERSION_ID。
 * 内容来自远端可写文件,进系统提示前去掉控制字符并限长——不然一个 `PRETTY_NAME="a\n
 * <新的系统指令>"` 就能改写提示词的其余部分(安卓端同一道 sanitizer)。
 */
export function parseOsReleaseName(content: string): string | null {
  const values = new Map<string, string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (values.has(key)) continue;
    values.set(key, line.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
  }
  const pretty = values.get("PRETTY_NAME");
  const name = pretty && pretty.trim() ? pretty : [values.get("NAME"), values.get("VERSION_ID")].filter(Boolean).join(" ");
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_DISTRO_NAME_LENGTH);
  return cleaned || null;
}

/**
 * 读 os-release 走 exec 而不是 SFTP:授权目录是文件面的边界,而 os-release 在目录外
 * (安卓端同理——它的 readRootfsText 用的是绝对路径直通接口)。命令是常量,不含任何
 * 用户输入;`head -c` 先把上限压在远端,不把整份大文件读回来。
 */
async function readRemoteDistro(connection: SshConnection): Promise<string | null> {
  for (const path of OS_RELEASE_PATHS) {
    let outcome;
    try {
      outcome = await connection.execRaw(`head -c ${MAX_OS_RELEASE_BYTES} ${path} 2>/dev/null`);
    } catch {
      // 连接层面的失败对两个路径是同一个结论:拿不到发行版(调用方还会重试一轮)。
      return null;
    }
    if (outcome.timedOut || !outcome.stdout.trim()) continue;
    const distro = parseOsReleaseName(outcome.stdout);
    if (distro) return distro;
  }
  return null;
}

/**
 * 探测远端执行环境(在池化连接上,一次往返序列)。shell 探测失败直接抛出:
 * 发行版要靠同一条连接,再试只是多等一个超时(安卓端同一取舍)。
 */
export async function loadRemoteEnvironment(
  target: SshWorkspaceTarget,
  signal?: AbortSignal,
): Promise<RemoteEnvironment> {
  return sshPool.use(
    target.device,
    async (connection) => {
      const shell = await connection.detectShell();
      const distro = await readRemoteDistro(connection);
      return { shell, distro };
    },
    { signal },
  );
}

// ── 缓存(安卓端 RemoteEnvironmentCache 的语义:成功长期沿用,失败只记 60s) ────────

const DEFAULT_FAILURE_TTL_MS = 60_000;

interface CacheEntry {
  signature: string;
  /** null = 这次取失败了(原因在 error)。 */
  environment: RemoteEnvironment | null;
  error: string | null;
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** 指纹变了(改密码/换主机密钥/删了重加)就当没缓存;单测与设置页改动后亦可显式清空。 */
export function clearRemoteEnvironmentCache(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/**
 * 取远端执行环境:命中可用缓存则不碰网络。可用 = 成功结果(无限期)或 TTL 内的失败结果。
 * 失败也算"取到了":它决定提示词走 unreachable 分支,而不是每轮都重新等一次超时。
 */
export async function cachedRemoteEnvironment(
  workspaceId: string,
  target: SshWorkspaceTarget,
  signal?: AbortSignal,
): Promise<{ environment: RemoteEnvironment | null; error: string | null }> {
  const signature = sshConnectionSignature(target.device);
  const now = Date.now();
  const hit = cache.get(workspaceId);
  if (hit && hit.signature === signature) {
    if (hit.environment) return { environment: hit.environment, error: null };
    if (now - hit.loadedAt < DEFAULT_FAILURE_TTL_MS) return { environment: null, error: hit.error };
  }
  try {
    const environment = await loadRemoteEnvironment(target, signal);
    cache.set(workspaceId, { signature, environment, error: null, loadedAt: now });
    return { environment, error: null };
  } catch (err) {
    // 取消不是"连不上":原样抛出,让调用方按停止处理,不把 aborted 当成网络故障缓存 60s。
    if (signal?.aborted) throw err;
    const error = err instanceof Error ? err.message : String(err);
    cache.set(workspaceId, { signature, environment: null, error, loadedAt: now });
    return { environment: null, error };
  }
}

// ── 提示词文本 ────────────────────────────────────────────────────────────────

/** bash 之外的 shell 要明说"别用 bash 语法"(安卓端 appendShellLine 同一判据)。 */
function shellLine(shell: string): string {
  const name = shell.split("/").pop() ?? shell;
  if (name === "bash") return "- `bash` runs commands with " + quote(shell) + ".";
  return (
    "- `bash` runs commands with " + quote(shell) +
    ", a POSIX shell. Bash is not installed, so avoid bash-only syntax such as arrays, here-strings (<<<) and brace expansion."
  );
}

function quote(value: string): string {
  return "`" + value + "`";
}

/** 远程工作区说明(安卓端 buildSshWorkspacePrompt 的 rdp 版):工具名换成本工程的
 *  read / bash,并把"只有 read 受授权目录约束、shell 不受"这条差异说清——远端是真实
 *  机器,边界只存在于文件面,不说不等于不存在。 */
export function buildSshWorkspacePrompt(
  workspace: Pick<Workspace, "name">,
  target: SshWorkspaceTarget,
  environment: RemoteEnvironment,
  cwd: string | null,
): string {
  const lines = [
    "<workspace>",
    "You have access to a persistent remote workspace named " + quote(workspace.name) +
      " on a real machine, reached over SSH as " + quote(target.label) + ".",
    "- The workspace directory is " + quote(target.root) +
      ". Use it as your working directory; files written there persist across turns of this conversation.",
    "- Paths passed to the read tool must live inside that directory: use absolute paths on the remote machine (for example " +
      quote(`${target.root}/notes.md`) + ") or paths relative to it. `~` is not expanded.",
    "- Only the read tool is confined to that directory. Shell commands run with the SSH user's real permissions and can reach anywhere on the machine, so keep them inside the workspace directory unless the user asks otherwise.",
    "- This is not a sandbox: a command can affect other data and services on this machine. Avoid destructive or system-wide changes unless the user asks for them.",
  ];
  if (environment.distro) lines.push("- The remote operating system is " + environment.distro + ".");
  lines.push(
    shellLine(environment.shell),
    "- Available tools:",
    "  - `read`: read file contents (text or images) inside the workspace directory.",
    "  - `bash`: run shell commands on the remote machine (defaults to the workspace directory).",
    "- There are no file write or edit tools in this workspace. Create and modify files with `bash`, for example a quoted heredoc (`cat > file <<'EOF'`) for new content, or `sed`, `patch` or a short script for targeted edits. Prefer targeted edits over rewriting whole files.",
  );
  const dir = String(cwd ?? "").trim();
  if (dir && dir !== target.root) {
    lines.push("- Current working directory: " + quote(dir) + ". Use this as the default context for file operations and shell commands.");
  }
  lines.push("</workspace>");
  return lines.join("\n");
}

/** 连不上时的说明(安卓端 buildUnreachablePrompt):工具仍然挂着,所以要把"会失败"说在前面。 */
export function buildUnreachablePrompt(
  workspace: Pick<Workspace, "name">,
  target: SshWorkspaceTarget,
  error: string | null,
): string {
  return [
    "<workspace>",
    "You are bound to a workspace named " + quote(workspace.name) + " on " + quote(target.label) +
      " with directory " + quote(target.root) + ", but it is currently unreachable" +
      (error ? ": " + error : "") + ".",
    "- Workspace tools will fail until the connection is restored. If the user asks you to work in the workspace, tell them it is unreachable instead of retrying commands.",
    "</workspace>",
  ].join("\n");
}

/**
 * 远程工作区提示词的单一入口(编排器在装配系统注入时 await 它)。
 * 永不抛出:探测失败只是换成 unreachable 文案,对话照常进行——与安卓端"连不上不阻塞对话"
 * 同一取舍,而工具真实可用性由执行时的 SSH 错误自己说话。
 */
export async function sshWorkspacePrompt(input: {
  workspace: Pick<Workspace, "id" | "name">;
  target: SshWorkspaceTarget;
  cwd: string | null;
  signal?: AbortSignal;
}): Promise<string> {
  const { environment, error } = await cachedRemoteEnvironment(input.workspace.id, input.target, input.signal);
  if (!environment) return buildUnreachablePrompt(input.workspace, input.target, error);
  return buildSshWorkspacePrompt(input.workspace, input.target, environment, input.cwd);
}
