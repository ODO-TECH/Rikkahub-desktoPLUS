// test-utils/fake-sftp-fs.ts — 假 SSH 服务器的内存远端文件系统(SFTP 服务端实现)。
//
// 为什么自己实现而不是拿本机目录当远端:测试要断言的是「rdp 的 SFTP 层在真实服务器上会看到什么」
// ——目录项里有没有 "." 与 ".."、stat 的 mode 位、ENOENT 的错误文案、写满后的截断、符号链接的
// lstat 与 read 差异。用真实磁盘会把平台差异(win32 权限/换行)混进断言,还会污染工作区。
//
// 行为对齐的是 OpenSSH sftp-server:REALPATH 回绝对路径、READDIR 含 "." 与 ".."、
// 目录 mode 带 S_IFDIR、找不到回 NO_SUCH_FILE("No such file")、权限不足回 PERMISSION_DENIED。
// 纪律:只在内存里,不落盘;路径与内容全是测试常量。

import { constants } from "node:fs";
import type { Session } from "ssh2";

// @types/ssh2 里的 sftp 命名空间在模块块内,不作为可导入成员(运行时确实挂在导出上)。
// 与其写 `as any` 绕类型,不如按 SFTPv3 的 wire 常量写死——这些值二十年没变过。
const OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020,
} as const;

const STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

export type FakeFsNode =
  | { kind: "dir"; mtime: number; mode: number }
  | { kind: "file"; content: Buffer; mtime: number; mode: number }
  | { kind: "link"; target: string; mtime: number; mode: number };

/** 种子:`{ "/srv/app": {dir:true} }`、`{ "/srv/app/a.txt": "内容" }`、`{ "/l": {link:"/srv"} }`。 */
export type FakeFsSeed = Record<string, true | string | { link: string }>;

const DIR_MODE = constants.S_IFDIR | 0o755;
const FILE_MODE = constants.S_IFREG | 0o644;
const LINK_MODE = constants.S_IFLNK | 0o777;

/** 词法规范化:绝对路径、去掉 . 与 ..、去掉多余斜杠与结尾斜杠。 */
export function canonical(path: string, base = "/"): string {
  const absolute = path.startsWith("/") ? path : `${base}/${path}`;
  const out: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** 父目录路径("/a" → "/", "/a/b" → "/a")。 */
function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * 内存远端文件系统。默认只有根目录与 homeDir(测试常按 homeDir 断言 realpath 的结果)。
 */
export class FakeRemoteFs {
  readonly nodes = new Map<string, FakeFsNode>();
  /** 记本次会话被请求过的操作,断言「客户端到底发了什么」用。 */
  readonly ops: string[] = [];

  constructor(
    readonly homeDir = "/home/tester",
    seed: FakeFsSeed = {},
  ) {
    this.nodes.set("/", { kind: "dir", mtime: Date.now(), mode: DIR_MODE });
    this.mkdirs(homeDir);
    for (const [raw, value] of Object.entries(seed)) {
      const path = canonical(raw);
      if (value === true) this.mkdirOne(path);
      else if (typeof value === "string") this.write(path, value);
      else this.nodes.set(path, { kind: "link", target: value.link, mtime: Date.now(), mode: LINK_MODE });
    }
  }

  exists(path: string): boolean {
    return this.nodes.has(canonical(path, this.homeDir));
  }

  /** 测试侧断言用:读文件内容(不存在回 null)。 */
  read(path: string): string | null {
    const node = this.nodes.get(canonical(path, this.homeDir));
    return node?.kind === "file" ? node.content.toString("utf8") : null;
  }

  /** 测试侧断言用:列目录(不含 "." 与 "..",方便逐条比对)。 */
  list(dir: string): string[] {
    const path = canonical(dir, this.homeDir);
    return [...this.nodes.keys()].filter((item) => parentOf(item) === path && item !== path).sort();
  }

  mkdirs(path: string): void {
    const absolute = canonical(path, this.homeDir);
    const parts = absolute.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      if (!this.nodes.has(current)) this.mkdirOne(current);
    }
  }

  write(path: string, content: string | Buffer): void {
    const absolute = canonical(path, this.homeDir);
    this.mkdirs(parentOf(absolute));
    this.nodes.set(absolute, {
      kind: "file",
      content: Buffer.from(content),
      mtime: Date.now(),
      mode: FILE_MODE,
    });
  }

  private mkdirOne(path: string): void {
    this.nodes.set(path, { kind: "dir", mtime: Date.now(), mode: DIR_MODE });
  }
}

/** ssh2 服务端 SFTP 流:类型只覆盖了客户端方法,服务端回包 API 在这里补齐。 */
interface SftpNameItem {
  filename: string;
  longname: string;
  attrs: Record<string, number>;
}

interface ServerSftpStream {
  on(event: "OPEN", l: (reqid: number, path: string, flags: number, attrs: Record<string, unknown>) => void): void;
  on(event: "READ", l: (reqid: number, handle: Buffer, offset: number, length: number) => void): void;
  on(event: "WRITE", l: (reqid: number, handle: Buffer, offset: number, data: Buffer) => void): void;
  on(event: "CLOSE", l: (reqid: number, handle: Buffer) => void): void;
  on(event: "FSTAT", l: (reqid: number, handle: Buffer) => void): void;
  on(event: "FSETSTAT", l: (reqid: number, handle: Buffer, attrs: Record<string, unknown>) => void): void;
  on(event: "LSTAT", l: (reqid: number, path: string) => void): void;
  on(event: "STAT", l: (reqid: number, path: string) => void): void;
  on(event: "SETSTAT", l: (reqid: number, path: string, attrs: Record<string, unknown>) => void): void;
  on(event: "OPENDIR", l: (reqid: number, path: string) => void): void;
  on(event: "READDIR", l: (reqid: number, handle: Buffer) => void): void;
  on(event: "REMOVE", l: (reqid: number, path: string) => void): void;
  on(event: "MKDIR", l: (reqid: number, path: string, attrs: Record<string, unknown>) => void): void;
  on(event: "RMDIR", l: (reqid: number, path: string) => void): void;
  on(event: "REALPATH", l: (reqid: number, path: string) => void): void;
  on(event: "RENAME", l: (reqid: number, oldPath: string, newPath: string) => void): void;
  on(event: "READLINK", l: (reqid: number, path: string) => void): void;
  on(event: "SYMLINK", l: (reqid: number, linkPath: string, targetPath: string) => void): void;
  status(reqid: number, code: number, message?: string): void;
  handle(reqid: number, handle: Buffer): void;
  data(reqid: number, data: Buffer): void;
  name(reqid: number, items: SftpNameItem[]): void;
  attrs(reqid: number, attrs: Record<string, number>): void;
}

type OpenedHandle =
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string; sent: boolean };

/** 挂一个 SFTP 服务端到 session 上;回环假服务器用。 */
export function attachFakeSftp(session: Session, fs: FakeRemoteFs): void {
  session.on("sftp", (accept) => {
    const stream = accept() as unknown as ServerSftpStream;
    const handles = new Map<number, OpenedHandle>();
    let handleCount = 0;

    const allocHandle = (entry: OpenedHandle): Buffer => {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(handleCount, 0);
      handles.set(handleCount, entry);
      handleCount += 1;
      return buf;
    };
    const handleOf = (buf: Buffer): { id: number; entry: OpenedHandle } | null => {
      if (buf.length !== 4) return null;
      const id = buf.readUInt32BE(0);
      const entry = handles.get(id);
      return entry ? { id, entry } : null;
    };
    const fail = (reqid: number, message: string) => {
      stream.status(reqid, STATUS_CODE.FAILURE, message);
    };
    const missing = (reqid: number, path: string) => {
      // 真实 sshd 的文案就是 "No such file";rdp 层按它判 ENOENT,别写成别的。
      stream.status(reqid, STATUS_CODE.NO_SUCH_FILE, `No such file: ${path}`);
    };

    const attrsOf = (node: FakeFsNode): Record<string, number> => ({
      mode: node.mode,
      uid: 1000,
      gid: 1000,
      size: node.kind === "file" ? node.content.length : 0,
      atime: Math.floor(node.mtime / 1000),
      mtime: Math.floor(node.mtime / 1000),
    });
    const longnameOf = (name: string, node: FakeFsNode): string => {
      const head = node.kind === "dir" ? "d" : node.kind === "link" ? "l" : "-";
      return `${head}rwxr-xr-x 1 tester tester ${attrsOf(node).size} Jan  1 00:00 ${name}`;
    };

    stream.on("REALPATH", (reqid, path) => {
      fs.ops.push(`realpath:${path}`);
      // "." 和相对路径都要能解析(homeDir 就靠 realpath(".") 拿)。
      const node = lookup(path);
      if (!node) return missing(reqid, path);
      const resolved = canonical(path, fs.homeDir);
      stream.name(reqid, [{ filename: resolved, longname: longnameOf(baseName(resolved), node), attrs: attrsOf(node) }]);
    });

    stream.on("STAT", (reqid, path) => {
      fs.ops.push(`stat:${path}`);
      const node = lookup(path);
      if (!node) return missing(reqid, path);
      stream.attrs(reqid, attrsOf(node));
    });
    stream.on("LSTAT", (reqid, path) => {
      fs.ops.push(`lstat:${path}`);
      const node = lstat(path);
      if (!node) return missing(reqid, path);
      stream.attrs(reqid, attrsOf(node));
    });
    stream.on("SETSTAT", (reqid, path, attrs) => {
      fs.ops.push(`setstat:${path}`);
      const node = lstat(path);
      if (!node) return missing(reqid, path);
      const mode = Number(attrs.mode);
      if (Number.isFinite(mode)) node.mode = mode | (node.kind === "dir" ? constants.S_IFDIR : node.kind === "link" ? constants.S_IFLNK : constants.S_IFREG);
      if (Number.isFinite(Number(attrs.mtime))) node.mtime = Number(attrs.mtime) * 1000;
      stream.status(reqid, STATUS_CODE.OK);
    });

    stream.on("OPEN", (reqid, rawPath, flags) => {
      const path = canonical(rawPath, fs.homeDir);
      fs.ops.push(`open:${path}`);
      const existing = fs.nodes.get(path);
      if (existing?.kind === "dir") return fail(reqid, "Is a directory");
      if (flags & OPEN_MODE.EXCL) return fail(reqid, `File exists: ${rawPath}`);
      if (flags & OPEN_MODE.READ) {
        if (!existing) return missing(reqid, rawPath);
        return stream.handle(reqid, allocHandle({ kind: "file", path }));
      }
      if (!existing) {
        if (!(flags & OPEN_MODE.CREAT)) return missing(reqid, rawPath);
        if (!fs.nodes.has(parentOf(path))) return missing(reqid, parentOf(path));
        fs.nodes.set(path, { kind: "file", content: Buffer.alloc(0), mtime: Date.now(), mode: FILE_MODE });
      } else if (existing.kind === "file") {
        if (flags & OPEN_MODE.TRUNC) existing.content = Buffer.alloc(0);
        // APPEND 不需要特判:客户端写入时给的就是末尾 offset,这里按 offset 落。
      } else {
        // 写穿过符号链接在真实 sshd 上是「写目标」;本桩只关心写入结果,直接把链换成文件。
        fs.nodes.set(path, { kind: "file", content: Buffer.alloc(0), mtime: Date.now(), mode: FILE_MODE });
      }
      stream.handle(reqid, allocHandle({ kind: "file", path }));
    });

    stream.on("READ", (reqid, handleBuf, offset, length) => {
      const opened = handleOf(handleBuf);
      if (!opened || opened.entry.kind !== "file") return stream.status(reqid, STATUS_CODE.FAILURE, "Invalid handle");
      const node = fs.nodes.get(opened.entry.path);
      if (!node || node.kind !== "file") return missing(reqid, opened.entry.path);
      if (offset >= node.content.length) return stream.status(reqid, STATUS_CODE.EOF, "End of file");
      stream.data(reqid, node.content.subarray(offset, Math.min(offset + length, node.content.length)));
    });

    stream.on("WRITE", (reqid, handleBuf, offset, data) => {
      const opened = handleOf(handleBuf);
      if (!opened || opened.entry.kind !== "file") return stream.status(reqid, STATUS_CODE.FAILURE, "Bad handle");
      const node = fs.nodes.get(opened.entry.path);
      if (!node || node.kind !== "file") return missing(reqid, opened.entry.path);
      const end = offset + data.length;
      if (end > node.content.length) node.content = Buffer.concat([node.content, Buffer.alloc(end - node.content.length)]);
      data.copy(node.content, offset);
      node.mtime = Date.now();
      stream.status(reqid, STATUS_CODE.OK);
    });

    stream.on("FSTAT", (reqid, handleBuf) => {
      const opened = handleOf(handleBuf);
      if (!opened || opened.entry.kind !== "file") return stream.status(reqid, STATUS_CODE.FAILURE, "Bad handle");
      const node = fs.nodes.get(opened.entry.path);
      if (!node) return missing(reqid, opened.entry.path);
      stream.attrs(reqid, attrsOf(node));
    });

    stream.on("FSETSTAT", (reqid, handleBuf, attrs) => {
      const opened = handleOf(handleBuf);
      if (!opened || opened.entry.kind !== "file") return stream.status(reqid, STATUS_CODE.FAILURE, "Bad handle");
      const node = fs.nodes.get(opened.entry.path);
      if (!node) return missing(reqid, opened.entry.path);
      if (Number.isFinite(Number(attrs.mtime))) node.mtime = Number(attrs.mtime) * 1000;
      stream.status(reqid, STATUS_CODE.OK);
    });

    stream.on("CLOSE", (reqid, handleBuf) => {
      const opened = handleOf(handleBuf);
      if (opened) handles.delete(opened.id);
      stream.status(reqid, STATUS_CODE.OK);
    });

    stream.on("OPENDIR", (reqid, rawPath) => {
      const path = canonical(rawPath, fs.homeDir);
      fs.ops.push(`opendir:${path}`);
      const node = lookup(rawPath);
      if (!node) return missing(reqid, rawPath);
      if (node.kind !== "dir") return fail(reqid, `Not a directory: ${rawPath}`);
      stream.handle(reqid, allocHandle({ kind: "dir", path, sent: false }));
    });

    stream.on("READDIR", (reqid, handleBuf) => {
      const opened = handleOf(handleBuf);
      if (!opened || opened.entry.kind !== "dir") return stream.status(reqid, STATUS_CODE.FAILURE, "Bad handle");
      if (opened.entry.sent) return stream.status(reqid, STATUS_CODE.EOF, "End of file");
      opened.entry.sent = true;
      const dir = opened.entry.path;
      // 真实 sftp-server 会把 "." 与 ".." 一起回:rdp 的列目录必须自己过滤,这里如实还原。
      const items: SftpNameItem[] = [
        { filename: ".", longname: ".", attrs: attrsOf(fs.nodes.get(dir) ?? { kind: "dir", mtime: Date.now(), mode: DIR_MODE }) },
        {
          filename: "..",
          longname: "..",
          attrs: attrsOf(fs.nodes.get(parentOf(dir)) ?? { kind: "dir", mtime: Date.now(), mode: DIR_MODE }),
        },
      ];
      for (const [path, node] of fs.nodes) {
        if (parentOf(path) !== dir || path === dir) continue;
        items.push({ filename: baseName(path), longname: longnameOf(baseName(path), node), attrs: attrsOf(node) });
      }
      stream.name(reqid, items);
    });

    stream.on("MKDIR", (reqid, rawPath, attrs) => {
      const path = canonical(rawPath, fs.homeDir);
      fs.ops.push(`mkdir:${path}`);
      if (fs.nodes.has(path)) return stream.status(reqid, STATUS_CODE.FAILURE, `Directory already exists: ${rawPath}`);
      if (!fs.nodes.has(parentOf(path))) return missing(reqid, parentOf(path));
      const mode = Number.isFinite(Number(attrs.mode)) ? Number(attrs.mode) | constants.S_IFDIR : DIR_MODE;
      fs.nodes.set(path, { kind: "dir", mtime: Date.now(), mode });
      stream.status(reqid, STATUS_CODE.OK);
    });

    stream.on("RMDIR", (reqid, rawPath) => {
      const path = canonical(rawPath, fs.homeDir);
      fs.ops.push(`rmdir:${path}`);
      const node = fs.nodes.get(path);
      if (!node) return missing(reqid, rawPath);
      if (node.kind !== "dir") return fail(reqid, `Not a directory: ${rawPath}`);
      if (fs.list(path).length > 0) return fail(reqid, `Directory not empty: ${rawPath}`);
      fs.nodes.delete(path);
      stream.status(reqid, STATUS_CODE.OK);
    });

    stream.on("REMOVE", (reqid, rawPath) => {
      const path = canonical(rawPath, fs.homeDir);
      fs.ops.push(`remove:${path}`);
      const node = fs.nodes.get(path);
      if (!node) return missing(reqid, rawPath);
      if (node.kind === "dir") return fail(reqid, `Is a directory: ${rawPath}`);
      fs.nodes.delete(path);
      stream.status(reqid, STATUS_CODE.OK);
    });

    stream.on("RENAME", (reqid, oldRaw, newRaw) => {
      const from = canonical(oldRaw, fs.homeDir);
      const to = canonical(newRaw, fs.homeDir);
      fs.ops.push(`rename:${from}->${to}`);
      const node = fs.nodes.get(from);
      if (!node) return missing(reqid, oldRaw);
      if (fs.nodes.has(to)) return fail(reqid, `File exists: ${newRaw}`);
      if (!fs.nodes.has(parentOf(to))) return missing(reqid, parentOf(to));
      // 目录改名要连子树一起搬,否则 realpath 之后目录是空的。
      const moved = [...fs.nodes.keys()].filter((item) => item === from || item.startsWith(`${from}/`));
      for (const path of moved) {
        const child = fs.nodes.get(path)!;
        fs.nodes.delete(path);
        fs.nodes.set(to + path.slice(from.length), child);
      }
      stream.status(reqid, STATUS_CODE.OK);
    });

    stream.on("SYMLINK", (reqid, linkRaw, targetRaw) => {
      const linkPath = canonical(linkRaw, fs.homeDir);
      fs.ops.push(`symlink:${linkPath}->${targetRaw}`);
      if (fs.nodes.has(linkPath)) return fail(reqid, `File exists: ${linkRaw}`);
      fs.nodes.set(linkPath, { kind: "link", target: targetRaw, mtime: Date.now(), mode: LINK_MODE });
      stream.status(reqid, STATUS_CODE.OK);
    });

    stream.on("READLINK", (reqid, rawPath) => {
      const path = canonical(rawPath, fs.homeDir);
      fs.ops.push(`readlink:${path}`);
      const node = fs.nodes.get(path);
      if (!node) return missing(reqid, rawPath);
      if (node.kind !== "link") return fail(reqid, `Not a symbolic link: ${rawPath}`);
      stream.name(reqid, [{ filename: node.target, longname: node.target, attrs: attrsOf(node) }]);
    });

    function lookup(path: string): FakeFsNode | null {
      let current = canonical(path, fs.homeDir);
      for (let hop = 0; hop < 8; hop += 1) {
        const node = fs.nodes.get(current);
        if (!node) return null;
        if (node.kind !== "link") return node;
        current = canonical(node.target, parentOf(current));
      }
      return null;
    }

    function lstat(path: string): FakeFsNode | null {
      return fs.nodes.get(canonical(path, fs.homeDir)) ?? null;
    }
  });
}
