// ssh/remote-path.ts — 远端路径的词法处理(纯字符串,不碰 ssh2)。
//
// 单独成模块的理由:state 加载与设备归一也要用这套规则,不该为此把 ssh2 拉进启动路径
// (冷启动预算是逐毫秒算过的)。连接层的 re-export 见 ssh/connection.ts 末尾。
//
// 语义与安卓端 SshWorkspaceBackend 的路径处理一致:只做词法归一、不跟随符号链接、
// 出了授权根就拒绝——远端是个真实机器,不是沙箱。

import { SshInputError } from "./errors";

/**
 * 远端路径归一:反斜杠→正斜杠、去重复斜杠与尾斜杠、空串当根。
 * 相对路径与含 NUL 的路径直接拒(安卓端 "Path must be absolute" 的同一条规则)。
 */
export function normalizeRemotePath(raw: string): string {
  const value = String(raw ?? "").trim().replace(/\\/g, "/");
  if (value.includes("\0")) throw new SshInputError("Path contains invalid character", "ssh.path_invalid");
  if (!value.startsWith("/")) throw new SshInputError(`Path must be absolute: ${raw}`, "ssh.path_relative");
  const collapsed = `/${value.split("/").filter((part) => part !== "" && part !== ".").join("/")}`;
  return collapsed === "//" ? "/" : collapsed.replace(/\/+$/, "") || "/";
}

/** 去掉 `.` 与 `..` 的词法归一(不查远端、不跟符号链接;安卓端 normalizeAbsolute 的同款)。 */
export function lexicalNormalize(path: string): string {
  const parts: string[] = [];
  for (const part of normalizeRemotePath(path).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}` || "/";
}

/** 绝对路径是否落在授权根内(含根自身)。root="/" 是所有绝对路径的共同根,
 *  必须单独处理——直接拼 `${root}/` 会得到 "//",把 /tmp 等合法路径判成越界。 */
export function isRemotePathWithinRoot(root: string, absolutePath: string): boolean {
  const rootNormalized = lexicalNormalize(root);
  const pathNormalized = lexicalNormalize(absolutePath);
  if (rootNormalized === "/") return true;
  return pathNormalized === rootNormalized || pathNormalized.startsWith(`${rootNormalized}/`);
}

/** 授权根内绝对路径 → 相对根路径(root 自身返回空串)。调用方应先做边界检查。 */
export function relativeToRemoteRoot(root: string, absolutePath: string): string {
  const rootNormalized = lexicalNormalize(root);
  const pathNormalized = lexicalNormalize(absolutePath);
  if (rootNormalized === "/") return pathNormalized === "/" ? "" : pathNormalized.slice(1);
  if (pathNormalized === rootNormalized) return "";
  return pathNormalized.startsWith(`${rootNormalized}/`) ? pathNormalized.slice(rootNormalized.length + 1) : "";
}

/** Windows 绝对形态(盘符 X:\ 或 UNC \\server\share)。会话原先绑本地工作区、后来换到远程
 *  工作区时,库里残留的本机 cwd 就是这个样子——它在 POSIX 侧不是路径,只是会被拼成
 *  "/srv/app/C:\Users\me" 这种永远 cd 不到的目录,让每条命令都失败。自愈回边界根。 */
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]|^\\\\/;

/** 远程会话 cwd:纯词法(远端目录存在与否不在热路径上问服务器,由工具自己报错)。
 *  越界与本地同语义——自愈回边界根,而不是让每条命令都撞在 escape 报错上。 */
export function resolveRemoteWorkspaceCwd(root: string, workspaceCwd: string | null | undefined): string {
  const rootNormalized = lexicalNormalize(root);
  const raw = String(workspaceCwd ?? "").trim();
  if (!raw || WINDOWS_ABSOLUTE.test(raw)) return rootNormalized;
  const absolute = lexicalNormalize(raw.startsWith("/") ? raw : `${rootNormalized}/${raw}`);
  return isRemotePathWithinRoot(rootNormalized, absolute) ? absolute : rootNormalized;
}

/**
 * 拼子路径并夹在根内;越界抛错(安卓端 Path escapes workspace root)。
 *
 * 这里是边界执行点而不是拼接执行命令的地方:返回值只是「绝对路径字符串」,它进入 shell 的唯一
 * 通道是 ssh/command-wrap.ts 的 buildExecCommand——cwd 与命令都经 shellQuote 逐字引用后作为
 * 位置参数传给 `cd -- "$1"`,不存在把路径裸插进命令串的写法。
 * SFTP 侧同理:ssh2 按字面发送路径、服务端不展开 `*`/`?`,所以这里不需要(也不能)做
 * 安卓端那套 sftpQuote 反斜杠转义——转义了反而会叫错真实存在的文件名。
 */
export function resolveInsideRoot(root: string, path: string): string {
  const joined = lexicalNormalize(`${normalizeRemotePath(root)}/${String(path ?? "").replace(/^\/+/, "")}`);
  if (!isRemotePathWithinRoot(root, joined)) {
    throw new SshInputError(`Path escapes workspace root: ${path}`, "ssh.path_escape");
  }
  return joined;
}
