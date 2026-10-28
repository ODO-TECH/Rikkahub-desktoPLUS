// ssh/remote-files.ts — 授权目录的 SFTP 文件面(镜像安卓端 workspace/ssh/SshWorkspaceBackend.kt)。
//
// 安卓端的文件面全走 SFTP 子系统,不用 shell 命令拼 ls/stat:路径是数据不是代码,
// 这一层因此没有命令注入面——但它同样「不是沙箱」,能读到的就是服务器上那个真实文件。
//
// 与安卓端的有意差异(其余逐条对齐,含错误文案):
// 1) 授权目录就是边界。安卓端除了工作区还有 LINUX 区(root "/")可以浏览整机,rdp 不提供:
//    每个请求必须点名一条设备里已登记的远程目录,越出该目录即 ssh.path_escape。
// 2) 不做通配转义。安卓端把每个路径过一遍 sftpQuote,是因为 JSch 的 SFTP 客户端会在
//    stat/ls 里展开 `*` 与 `?`;ssh2 按字面发路径、服务端也不展开,转义反而会叫错文件名
//    (`a*b` 变成找 `a\*b`)。要对齐的是「通配符是普通字符」这条行为,由本文件测试锁住。
// 3) 下载有上限。安卓端 exportFile 把流直接接到本地文件,字节数不设限;rdp 的下载走一次
//    HTTP 请求,超过 MAX_DOWNLOAD_BYTES 明确报错,而不是把整机大文件吸进内存。
//    报错文案因此比安卓端多带一段「(limit N)」:同一句 readRemoteBytes 服务两个上限,
//    不写清楚用户无从知道撞的是哪一个。前缀与安卓端逐字一致。
// 4) 点文件的改名。安卓端按「最后一个点」切扩展名,`.env` 冲突后变成「 (1).env」(名字带个
//    前导空格);这里把首字符是点的名字视作无扩展名,得到 `.env (1)`。本地工作区同样只改这一处。
// 5) 不提供新建空目录。安卓端的 SSH 后端没有 createDirectory,rdp 的本地面板也没有,
//    写文件与上传都会自动建父目录,授权目录本身由 ensureDir 长回来。
// 6) 多一个「预览」判定。安卓端的文件查看器只有 readText 与导出两条路,不需要区分图片/二进制;
//    rdp 的文件面板要能在同一套渲染代码里显示本地与远程文件,所以 previewRemoteFile 直接复用
//    本地面板的 WorkspaceFilePreview 形态与同一套嗅探规则(图片魔数、首 8KB 含 NUL 即二进制)。
//
// 纪律:错误文案只出现路径与 user@host:port,绝不含凭据;路径全部走 ssh/remote-path.ts 的
// 词法归一(不跟随符号链接),授权判断先于任何网络请求。

import type { SFTPWrapper } from "ssh2";
import type { SshDevice, SshRemoteDir } from "../foundation/types/settings";
import type { WorkspaceFilePreview } from "../workspace/files";
import { detectSupportedImageMimeType } from "../workspace/tools/mime";
import { findRemoteDir } from "./devices";
import {
  lstatOrNull,
  mkdirs,
  statOrNull,
  type SftpStats,
  sftpFailure,
} from "./connection";
import { SshInputError } from "./errors";
import { lexicalNormalize, resolveInsideRoot } from "./remote-path";
import { MAX_LIST_ENTRIES, MAX_READ_BYTES, MAX_WRITE_BYTES } from "./constants";
import { sshPool } from "./pool";

/**
 * 文件面板/工具共用的条目形态:字段与本地工作区的 WorkspaceFileEntry 对齐,
 * path 是「相对授权目录」的 / 分隔路径(安卓端 relativePath 的同一条规则),目录本身为空串。
 */
export interface SshFileEntry {
  path: string;
  name: string;
  type: "file" | "dir";
  /** 普通文件的字节数;目录、设备文件等按安卓端记 0。 */
  size: number;
  /** epoch 毫秒:SFTP v3 的 mtime 是无符号 32 位秒数 ×1000。 */
  modifiedAt: number;
}

/**
 * 定位授权目录:dirId 只认设备条目里的 id 或逐字登记的已填路径。
 * 没授权就先抛,连都不连——「先连上再说」正是这条边界要防的。
 */
export function authorizedRemoteDir(device: SshDevice, dirId: string): SshRemoteDir {
  const dir = findRemoteDir(device, String(dirId ?? "").trim());
  if (!dir || !dir.path) {
    throw new SshInputError(
      `Remote directory is not authorized for ${device.username}@${device.host}:${device.port}`,
      "ssh.dir_unauthorized",
    );
  }
  return dir;
}

/** 授权目录 + 相对路径 → 绝对路径(越界抛 ssh.path_escape)。 */
function resolveTarget(device: SshDevice, dirId: string, relPath: string): { dir: SshRemoteDir; path: string } {
  const dir = authorizedRemoteDir(device, dirId);
  return { dir, path: resolveInsideRoot(dir.path, relPath) };
}

/** 绝对路径 → 相对授权目录的展示路径(安卓端 relativePath;根目录自身回空串)。 */
function relativeTo(root: string, path: string): string {
  if (path === root) return "";
  if (root === "/") return path.slice(1);
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.slice(1);
}

function childPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name || "/";
}

function toEntry(path: string, name: string, stats: SftpStats, isDirectory: boolean): SshFileEntry {
  return {
    path,
    name,
    type: isDirectory ? "dir" : "file",
    size: isDirectory || !stats.isFile() ? 0 : stats.size,
    modifiedAt: (stats.mtime >>> 0) * 1000,
  };
}

/** 安卓端 requireStat:不存在就是「Path does not exist」,权限问题照原样冒出去。 */
async function requireStat(sftp: SFTPWrapper, path: string, displayPath: string): Promise<SftpStats> {
  const stats = await statOrNull(sftp, path);
  if (!stats) throw new SshInputError(`Path does not exist: ${displayPath}`, "ssh.path_missing");
  return stats;
}

/** 安卓端 requireFile:必须存在且是普通文件。 */
async function requireFile(sftp: SFTPWrapper, path: string, displayPath: string): Promise<SftpStats> {
  const stats = await statOrNull(sftp, path);
  if (!stats) throw new SshInputError(`File does not exist: ${displayPath}`, "ssh.path_missing");
  if (!stats.isFile()) throw new SshInputError(`Path is not a file: ${displayPath}`, "ssh.not_a_file");
  return stats;
}

function readdir(sftp: SFTPWrapper, path: string): Promise<Array<{ filename: string; attrs: SftpStats }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, list) => {
      if (error) reject(sftpFailure(path, error));
      else resolve((list ?? []) as Array<{ filename: string; attrs: SftpStats }>);
    });
  });
}

/**
 * 列目录:先确认是目录,再逐条转换;指向目录的软链按目录展示(要多一次 stat,安卓端同款)。
 * 排序与本地面板一致——目录在前、名字区分大小写无关;条数上限 MAX_LIST_ENTRIES。
 */
export function listRemoteDir(device: SshDevice, dirId: string, relPath: string): Promise<SshFileEntry[]> {
  const { dir, path } = resolveTarget(device, dirId, relPath);
  return sshPool.use(device, async (connection) => {
    // 授权目录被误删时先让它长回来(安卓端 withSftp(FILES) 对每个文件操作都做这件事)。
    await connection.ensureDir(dir.path);
    return connection.withSftp(async (sftp) => {
      const attrs = await requireStat(sftp, path, relPath);
      if (!attrs.isDirectory()) throw new SshInputError(`Path is not a directory: ${relPath}`, "ssh.not_a_directory");
      const listed = await readdir(sftp, path);
      const entries: SshFileEntry[] = [];
      for (const item of listed) {
        // sftp-server 的回包里带 "." 与 ".."(安卓端 JSch 的 ls 也照样要滤)。ssh2 的 readdir
        // 默认 full=false,已经在客户端把它们剔掉了(node_modules/ssh2/lib/protocol/SFTP.js:937),
        // 这层滤子是防御:以后改用 readdir(handle) 或换客户端库时不会凭空多出两个上级目录。
        if (item.filename === "." || item.filename === "..") continue;
        const child = childPath(path, item.filename);
        let isDirectory = item.attrs.isDirectory();
        if (!isDirectory && item.attrs.isSymbolicLink()) {
          isDirectory = (await statOrNull(sftp, child))?.isDirectory() === true;
        }
        entries.push(toEntry(relativeTo(dir.path, child), item.filename, item.attrs, isDirectory));
      }
      // 与安卓端 compareBy{!isDirectory}.thenBy{name.lowercase()} 同序:按 UTF-16 码元比小写名,
      // 不用 localeCompare(它会把带重音、全角的中文名排到另一个位置,两端就看不出是同一套规则)。
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        const left = a.name.toLowerCase();
        const right = b.name.toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
      });
      return entries.slice(0, MAX_LIST_ENTRIES);
    });
  }, { retry: true });
}

/** 读文本:超过 MAX_READ_BYTES 直接报错,不返回半截(安卓端 readText 的规则)。 */
export function readRemoteText(device: SshDevice, dirId: string, relPath: string): Promise<string> {
  return readRemoteBytes(device, dirId, relPath, MAX_READ_BYTES).then((buffer) => buffer.toString("utf8"));
}

/**
 * 读字节:preview 用 MAX_READ_BYTES,下载用 MAX_DOWNLOAD_BYTES。
 * 上限在 stat 之后、读之前判定,与安卓端一致(所以是「尽力而为」的护栏:极窄的
 * stat→read 竞态里大文件仍可能被吸进来,这跟移动端同一个窗口)。
 */
export function readRemoteBytes(
  device: SshDevice,
  dirId: string,
  relPath: string,
  maxBytes: number,
): Promise<Buffer> {
  const { dir, path } = resolveTarget(device, dirId, relPath);
  return sshPool.use(device, async (connection) => {
    await connection.ensureDir(dir.path);
    return connection.withSftp(async (sftp) => {
      const stats = await requireFile(sftp, path, relPath);
      if (stats.size > maxBytes) {
        throw new SshInputError(
          `File is too large to read: ${stats.size} bytes (limit ${maxBytes})`,
          "ssh.file_too_large",
        );
      }
      return readWholeFile(sftp, path);
    });
  }, { retry: true });
}

function readWholeFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // ssh2 的 readFile 自己做「按 size 分块读到 EOF」,不返回会二次卡住的流句柄
    // (安卓端绕开 get() 的同一个理由:读取被打断后不能再挂在那里)。
    sftp.readFile(path, { flag: "r" }, (error, data) => {
      if (error) reject(sftpFailure(path, error));
      else resolve(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));
    });
  });
}

/** 图片魔数嗅探窗口与本地面板同源(workspace/tools/mime.ts:4100 字节)。 */
const IMAGE_SNIFF_BYTES = 4100;
/** 图片预览的字节上限:与本地面板 IMAGE_PREVIEW_LIMIT_BYTES 同值,超了就只报「二进制文件」。 */
const IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;
/** 首 8KB 含 NUL 即按二进制处理(与本地面板 looksBinary、git 的同一条启发一致)。 */
const BINARY_SNIFF_BYTES = 8192;
/** 单次 SFTP READ 的请求量:服务端会自己截短返回,循环补读直到够数或 EOF。 */
const READ_CHUNK_BYTES = 32 * 1024;

/**
 * 面板预览:形态与判定规则都复用本地工作区那套(text / image / binary + size),
 * 远程与本地因此是同一个渲染组件。读取按前缀截断——预览一个 200MB 的日志不该把整机吸进内存。
 *
 * 与 readRemoteText 的分工:那条是安卓端 readText(AI 工具与编辑器用,超过 MAX_READ_BYTES 直接报错);
 * 这条是面板用,超长不报错,回 truncated 让界面标出「只看了前半截」。
 */
export async function previewRemoteFile(
  device: SshDevice,
  dirId: string,
  relPath: string,
): Promise<WorkspaceFilePreview> {
  const { dir, path } = resolveTarget(device, dirId, relPath);
  return sshPool.use(device, async (connection) => {
    await connection.ensureDir(dir.path);
    return connection.withSftp(async (sftp) => {
      const stats = await requireFile(sftp, path, relPath);
      const size = stats.size;
      // 一个文件只开一次句柄:嗅探与预览都从同一个 handle 上按偏移续读。
      return withRemoteFile(sftp, path, async (read) => {
        const head = await read(0, Math.min(size, IMAGE_SNIFF_BYTES));
        const imageMime = detectSupportedImageMimeType(head);
        if (imageMime) {
          if (size > IMAGE_PREVIEW_BYTES) return { kind: "binary", size };
          const bytes = size <= head.byteLength ? head : await read(0, size);
          return { kind: "image", dataUrl: `data:${imageMime};base64,${bytes.toString("base64")}`, size };
        }
        const wanted = Math.min(size, MAX_READ_BYTES);
        const prefix = wanted <= head.byteLength
          ? head
          : Buffer.concat([head, await read(head.byteLength, wanted - head.byteLength)]);
        if (prefix.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary", size };
        const truncated = size > MAX_READ_BYTES;
        const text = prefix.toString("utf-8");
        // 截断边界可能把多字节 UTF-8 字符切成两半:去掉尾部的 U+FFFD 替换字符,而不是显示乱码残片(本地面板同处理)。
        return { kind: "text", text: truncated ? text.replace(/\uFFFD+$/, "") : text, truncated, size };
      });
    });
  }, { retry: true });
}

/** 按偏移续读的函数:previewRemoteFile 在同一次打开里先嗅探、再决定读多少。 */
type RangeReader = (offset: number, length: number) => Promise<Buffer>;

/**
 * 打开一次、按偏移续读、无论成功失败都 close(远端 sshd 的句柄不是无限的)。
 * 分成两次 open 会多一整轮往返,文件面板每次浏览目录都这么浪费一遍。
 */
async function withRemoteFile<T>(sftp: SFTPWrapper, path: string, fn: (read: RangeReader) => Promise<T>): Promise<T> {
  const handle = await new Promise<Buffer>((resolve, reject) => {
    sftp.open(path, "r", (error, opened) => {
      if (error || !opened) reject(sftpFailure(path, error ?? new Error("SFTP open returned no handle")));
      else resolve(opened);
    });
  });
  try {
    return await fn((offset, length) => readRange(sftp, handle, path, offset, length));
  } finally {
    // close 的失败不改变已经读到的内容:读成功比一句关闭报错更值钱,句柄照样交回去了。
    await new Promise<void>((resolve) => sftp.close(handle, () => resolve()));
  }
}

/**
 * 读 [offset, offset+length)。单次 READ 会被服务端截短(OpenSSH 每次只回 32KB 量级),
 * 所以要循环补读;EOF 在 ssh2 里是「回 0 字节」而不是错误(SFTP.js:2148 只有回调带
 * _wantEOFError 标记时才把 EOF 交给调用方),因此按「读到 0 就收」终止,不必嗅错误码。
 */
function readRange(sftp: SFTPWrapper, handle: Buffer, path: string, offset: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = (): void => resolve(Buffer.concat(chunks, total));
    const step = (at: number): void => {
      if (total >= length) {
        finish();
        return;
      }
      const want = Math.min(READ_CHUNK_BYTES, length - total);
      const buffer = Buffer.alloc(want);
      sftp.read(handle, buffer, 0, want, at, (error, bytesRead) => {
        if (error) {
          reject(sftpFailure(path, error));
          return;
        }
        const got = Math.max(0, Math.min(bytesRead ?? 0, want));
        if (got === 0) {
          finish();
          return;
        }
        chunks.push(buffer.subarray(0, got));
        total += got;
        step(at + got);
      });
    };
    step(offset);
  });
}

/**
 * 写文本:超过 MAX_WRITE_BYTES 先拒;overwrite=false 且目标已存在时报「File already exists」;
 * 父目录自动创建;写完回读一次 stat 组装条目(安卓端 writeBytes + requireStat)。
 */
export function writeRemoteText(
  device: SshDevice,
  dirId: string,
  relPath: string,
  text: string,
  overwrite: boolean,
): Promise<SshFileEntry> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_WRITE_BYTES) {
    return Promise.reject(new SshInputError(
      `Content is too large to write: ${bytes.byteLength} bytes`,
      "ssh.content_too_large",
    ));
  }
  const { dir, path } = resolveTarget(device, dirId, relPath);
  return sshPool.use(device, async (connection) => {
    await connection.ensureDir(dir.path);
    return connection.withSftp(async (sftp) => {
      const existing = await statOrNull(sftp, path);
      if (existing && !overwrite) {
        throw new SshInputError(`File already exists: ${relPath}`, "ssh.already_exists");
      }
      if (existing?.isDirectory()) {
        throw new SshInputError(`Path is not a file: ${relPath}`, "ssh.not_a_file");
      }
      await mkdirs(sftp, parentPath(path));
      await writeFileBytes(sftp, path, bytes);
      const stats = await requireStat(sftp, path, relPath);
      return toEntry(relativeTo(dir.path, path), baseName(path), stats, stats.isDirectory());
    });
  }, { retry: false });
}

function writeFileBytes(sftp: SFTPWrapper, path: string, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    // flag "w" = 建文件 + 截断,等价安卓端 put(..., OVERWRITE)。
    sftp.writeFile(path, bytes, { flag: "w", mode: 0o644 }, (error) => {
      if (error) reject(sftpFailure(path, error));
      else resolve();
    });
  });
}

/**
 * 上传:目标已存在就不覆盖,而是改名 `名字 (1).扩展名`(安卓端 resolveConflict),
 * 与本地工作区的导入行为一致——导入永远不该静默吃掉远端同名文件。
 * 分块大小只影响 SFTP 请求条数,不改变结果。
 */
export function uploadRemoteFile(
  device: SshDevice,
  dirId: string,
  destinationRelPath: string,
  fileName: string,
  data: Uint8Array,
): Promise<SshFileEntry> {
  const name = String(fileName ?? "").trim().replace(/[\\/]/g, "/").split("/").pop() ?? "";
  if (!name) return Promise.reject(new SshInputError("File name is required", "ssh.name_required"));
  if (data.byteLength > MAX_WRITE_BYTES) {
    return Promise.reject(new SshInputError(
      `Content is too large to write: ${data.byteLength} bytes`,
      "ssh.content_too_large",
    ));
  }
  const joined = String(destinationRelPath ?? "").trim() ? `${destinationRelPath}/${name}` : name;
  const { dir, path } = resolveTarget(device, dirId, joined);
  return sshPool.use(device, async (connection) => {
    await connection.ensureDir(dir.path);
    return connection.withSftp(async (sftp) => {
      await mkdirs(sftp, parentPath(path));
      const target = (await statOrNull(sftp, path)) ? await resolveConflict(sftp, path) : path;
      await writeFileBytes(sftp, target, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      const stats = await requireStat(sftp, target, joined);
      return toEntry(relativeTo(dir.path, target), baseName(target), stats, stats.isDirectory());
    });
  }, { retry: false });
}

/**
 * `<stem> (n)<ext>`,n 从 1 递增到第一个不存在的名字(安卓端 resolveConflict 的格式)。
 * 点开头的名字整段当名字(差异第 4 条):安卓端会切出空词干,得到「 (1).env」这种带前导空格的文件名。
 */
async function resolveConflict(sftp: SFTPWrapper, path: string): Promise<string> {
  const parent = parentPath(path);
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n += 1) {
    const candidate = childPath(parent, `${stem} (${n})${extension}`);
    if (!(await statOrNull(sftp, candidate))) return candidate;
  }
}

/** 文件字节数(面板与工具用它做「太大就别读」的判断);非普通文件按安卓端报错。 */
export function remoteFileSize(device: SshDevice, dirId: string, relPath: string): Promise<number> {
  const { dir, path } = resolveTarget(device, dirId, relPath);
  return sshPool.use(device, async (connection) => {
    await connection.ensureDir(dir.path);
    return connection.withSftp(async (sftp) => {
      const stats = await requireFile(sftp, path, relPath);
      return stats.size;
    });
  }, { retry: true });
}

/**
 * 删除:先 lstat——删指向目录的软链时只删链接本身,不跟着进目标目录(安卓端 deleteFile)。
 * 目录必须 recursive=true,授权目录本身永远拒绝;不存在时回 false(不报错,界面按「已删除」处理)。
 */
export function deleteRemoteEntry(
  device: SshDevice,
  dirId: string,
  relPath: string,
  recursive: boolean,
): Promise<boolean> {
  const raw = String(relPath ?? "").trim();
  if (!raw || raw === ".") {
    return Promise.reject(new SshInputError("Refusing to delete workspace root", "ssh.root_delete"));
  }
  const { dir, path } = resolveTarget(device, dirId, raw);
  if (path === lexicalNormalize(dir.path)) {
    return Promise.reject(new SshInputError("Refusing to delete workspace root", "ssh.root_delete"));
  }
  return sshPool.use(device, async (connection) => {
    await connection.ensureDir(dir.path);
    return connection.withSftp(async (sftp) => {
      const attrs = await lstatOrNull(sftp, path);
      if (!attrs) return false;
      if (attrs.isDirectory() && !attrs.isSymbolicLink()) {
        if (!recursive) {
          throw new SshInputError("Directory delete requires recursive = true", "ssh.recursive_required");
        }
        await deleteRecursively(sftp, path);
        return true;
      }
      await remove(sftp, path);
      return true;
    });
  }, { retry: false });
}

async function deleteRecursively(sftp: SFTPWrapper, dir: string): Promise<void> {
  for (const item of await readdir(sftp, dir)) {
    // 滤子与 listRemoteDir 同一理由:ssh2 已经剔过,这里不依赖它。
    if (item.filename === "." || item.filename === "..") continue;
    const child = childPath(dir, item.filename);
    // 链接指向目录也只删链接:递归进目标是安卓端明确禁止的行为。
    if (item.attrs.isDirectory() && !item.attrs.isSymbolicLink()) await deleteRecursively(sftp, child);
    else await remove(sftp, child);
  }
  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(dir, (error) => {
      if (error) reject(sftpFailure(dir, error));
      else resolve();
    });
  });
}

function remove(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (error) => {
      if (error) reject(sftpFailure(path, error));
      else resolve();
    });
  });
}
