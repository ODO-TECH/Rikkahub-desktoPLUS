// workspace/low-integrity.ts — Windows 低完整性进程启动(进程内 FFI,免提权)
//
// 机制(本机全链实测,见 tools/sandbox-spike/spawn-low-full.ts):复制自己的主令牌 →
// 把副本降到 Low 完整性(S-1-16-4096) → CreateProcessAsUserW 用它拉起子进程。
// 子进程继承 Low,内核 no-write-up 规则随即生效:写不了任何 Medium 及以上的对象,
// 读写标签为 Low 的目录照常——"区内读写、区外只读"由此成为内核保证。
//
// 关键事实(曾据此做过错误结论,此处留档防回退):
//   - 降自己令牌的完整性**不需要** SeRelabelPrivilege,只要求令牌句柄带
//     TOKEN_ADJUST_DEFAULT(0x80)。此前 spike 把 0x20(ADJUST_PRIVILEGES)误当 0x80 用,
//     得到 ACCESS_DENIED,一度误判为"必须 UAC 一次"。复测(relax-retest.ts)纠正。
//   - CreateProcessAsUserW 用"自复制令牌"时不需要 SeAssignPrimaryToken/SeIncreaseQuota,
//     普通 Medium 进程即可(与 Chrome 沙盒同一路线)。
//   - 目录标 Low(icacls /setintegritylevel)由属主权限即可完成,同样免提权。
//
// 纪律:本模块只做"造 Low 进程"这一件事;标目录、档位声明、探针实测分别在
// labeling.ts / sandbox.ts。FFI 调用全部收在函数内(dlopen 惰性),单测 import 零副作用。

import { dlopen } from "bun:ffi";
import { join } from "node:path";

// ---- 访问掩码/常量(不导出,防误用) ----
const TOKEN_ASSIGN_PRIMARY = 0x0001;
const TOKEN_DUPLICATE = 0x0002;
const TOKEN_QUERY = 0x0008;
const TOKEN_ADJUST_DEFAULT = 0x0080;
const SECURITY_IMPERSONATION = 2;
const TOKEN_PRIMARY = 1;
const MAXIMUM_ALLOWED = 0x02000000;
const TOKEN_INTEGRITY_LEVEL = 25;
const LOW_INTEGRITY_SID = "S-1-16-4096";
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const CREATE_NO_WINDOW = 0x08000000;
// x64:STARTUPINFOW 104 字节(cb 为首 DWORD);PROCESS_INFORMATION 24 字节。
const STARTUPINFOW_SIZE = 104;
const PROCESS_INFORMATION_SIZE = 24;

export interface LowIntegritySpawnOptions {
  /** 要拉起的可执行文件(绝对路径) */
  exe: string;
  /** 传给它的命令行参数(不含 exe 自身) */
  args: string[];
  /** 子进程工作目录 */
  cwd: string;
  /** 子进程环境(调用方用 buildLowSandboxEnvironment 造好) */
  env: Record<string, string>;
}

export interface LowIntegritySpawnResult {
  ok: boolean;
  /** 成功时的子进程 pid(用于日志,不做存活跟踪) */
  pid: number;
  /** 失败原因(英文短语,进日志) */
  error: string;
}

// ---- 纯函数部分(单测覆盖) ----

/** Windows 命令行参数引用:与 CommandLineToArgvW 解析规则互逆(CRT 算法)。
 *  含空白/引号的参数包引号,引号前反斜杠按规则翻倍——路径里有空格
 *  (如 "D:\Users Data\...")是本仓库的常态,引号错误会导致子进程参数错切。 */
export function quoteWindowsArgument(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  // 结尾的反斜杠后随闭引号,按 CRT 规则也要翻倍
  out += "\\".repeat(backslashes * 2) + '"';
  return out;
}

/** Low 后端的环境:继承启动方的环境 + 四组重定向。
 *  TEMP/TMP 已由 server.ts 改道到 dataDir/tmp(这里再钉一次,防"直接启动 exe"路径漏改);
 *  HOME/USERPROFILE 指到 dataDir/home——Low 进程写不了真实的用户家目录(Medium),
 *  bash 的 ~/、PowerShell 的 $env:USERPROFILE、各类工具缓存必须落在区内,
 *  与容器部署的 HOME=/app/pc-data/home 约定一致。
 *  npm/uv/pip 的缓存**不**跟随 HOME(Windows 下各自默认 %LOCALAPPDATA%),必须显式改道:
 *  受限后端里的本地 MCP(npx -y xxx / uvx xxx)一启动就往 Medium 缓存目录写,_cacache
 *  写入被内核拒绝,npm 直接 EPERM 退出("本地 MCP 进程已退出(code 1)">
 *  "EPERM ... npm-cache\_cacache\tmp")。同理 uv 报 "Failed to initialize cache"。
 *  LAUNCHED 标记最后强制写入且不可被 base 里的同名值覆盖——它是防自重启循环的硬不变量。
 *  Windows 环境变量不区分大小写:base 里可能同时存在 Path/PATH,按大写键去重、后者胜。 */
export function buildLowSandboxEnvironment(
  dataDir: string,
  base: Record<string, string | undefined>,
): Record<string, string> {
  const merged = new Map<string, { key: string; value: string }>();
  const put = (key: string, value: string) => merged.set(key.toUpperCase(), { key, value });
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") put(key, value);
  }
  const home = join(dataDir, "home");
  const cacheHome = join(home, ".cache");
  put("TEMP", join(dataDir, "tmp"));
  put("TMP", join(dataDir, "tmp"));
  put("HOME", home);
  put("USERPROFILE", home);
  put("npm_config_cache", join(home, ".npm"));
  put("UV_CACHE_DIR", join(cacheHome, "uv"));
  put("UV_TOOL_DIR", join(home, ".local", "uv-tools"));
  put("PIP_CACHE_DIR", join(cacheHome, "pip"));
  put("XDG_CACHE_HOME", cacheHome);
  put("RIKKAHUB_PC_DATA_DIR", dataDir);
  put("RIKKAHUB_SANDBOX", "restricted");
  put("RIKKAHUB_SANDBOX_LAUNCHED", "1");
  const env: Record<string, string> = {};
  for (const { key, value } of merged.values()) env[key] = value;
  return env;
}

/** UTF-16 编码单串(带 NUL 终止)。FFI 侧需要真正的 UTF-16 缓冲,cstring 只给 UTF-8。 */
function utf16z(text: string): Uint16Array {
  const src = Buffer.from(text + "\0", "utf16le");
  const out = new Uint16Array(src.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = src.readUInt16LE(i * 2);
  return out;
}

/** CreateProcess 的 UTF-16 环境块:每项 "NAME=value\0",末尾再补一个 \0 终止整块。
 *  键排序保证输出确定(单测可断言),CreateProcess 不要求排序。 */
export function encodeUtf16EnvironmentBlock(env: Record<string, string>): Uint16Array {
  const keys = Object.keys(env).filter((key) => key.length > 0).sort();
  const parts = keys.map((key) => utf16z(`${key}=${env[key] ?? ""}`));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const block = new Uint16Array(total + 1);
  let offset = 0;
  for (const part of parts) {
    block.set(part, offset);
    offset += part.length;
  }
  return block;
}

// ---- FFI 部分(仅 Windows;行为由验收测试覆盖,单测不触达) ----

/** 用 Low 完整性令牌拉起子进程。仅 win32 可用(非 win32 直接失败,不抛异常)。
 *  失败仅返回原因:调用方(S2b 编排)决定是回退 Medium 继续跑,而不是把启动炸掉。 */
export function spawnProcessAtLowIntegrity(options: LowIntegritySpawnOptions): LowIntegritySpawnResult {
  if (process.platform !== "win32") {
    return { ok: false, pid: 0, error: "low-integrity spawn is Windows-only" };
  }
  let ffi: ReturnType<typeof loadLowIntegrityFfi>;
  try {
    ffi = loadLowIntegrityFfi();
  } catch (err) {
    return { ok: false, pid: 0, error: `ffi load failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 1) 开自己令牌(掩码含 TOKEN_ADJUST_DEFAULT——0x20/0x80 混用是曾踩过的坑,见文件头)
  const tokenOut = new BigUint64Array(1);
  if (!ffi.advapi32.symbols.OpenProcessToken(ffi.kernel32.symbols.GetCurrentProcess(), TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, tokenOut)) {
    return { ok: false, pid: 0, error: "OpenProcessToken failed" };
  }
  const token = Number(tokenOut[0]);
  try {
    // 2) 复制为主令牌:CreateProcessAsUserW 要求 TokenPrimary;自复制令牌免 SeAssignPrimaryToken
    const dupOut = new BigUint64Array(1);
    if (!ffi.advapi32.symbols.DuplicateTokenEx(token, MAXIMUM_ALLOWED, null, SECURITY_IMPERSONATION, TOKEN_PRIMARY, dupOut)) {
      return { ok: false, pid: 0, error: "DuplicateTokenEx failed" };
    }
    const lowToken = Number(dupOut[0]);
    try {
      // 3) 降到 Low:免提权,只要求句牌带 TOKEN_ADJUST_DEFAULT
      const sidOut = new BigUint64Array(1);
      if (!ffi.advapi32.symbols.ConvertStringSidToSidA(LOW_INTEGRITY_SID, sidOut)) {
        return { ok: false, pid: 0, error: "ConvertStringSidToSid failed" };
      }
      const label = new Uint8Array(16);
      new DataView(label.buffer).setBigUint64(0, sidOut[0], true);
      new DataView(label.buffer).setUint32(8, 0, true);
      if (!ffi.advapi32.symbols.SetTokenInformation(lowToken, TOKEN_INTEGRITY_LEVEL, label, 16)) {
        return { ok: false, pid: 0, error: "SetTokenInformation(integrity=Low) failed" };
      }
      // 4) 拉起子进程:bInheritHandles 必须 false(跨完整性级别继承句柄无意义且危险)
      const appName = utf16z(options.exe);
      const cmdLine = utf16z([quoteWindowsArgument(options.exe), ...options.args.map(quoteWindowsArgument)].join(" "));
      const startup = new Uint8Array(STARTUPINFOW_SIZE);
      new DataView(startup.buffer).setUint32(0, STARTUPINFOW_SIZE, true);
      const procInfo = new Uint8Array(PROCESS_INFORMATION_SIZE);
      const spawned = ffi.kernel32.symbols.CreateProcessAsUserW(
        lowToken,
        appName,
        cmdLine,
        null,
        null,
        false,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        encodeUtf16EnvironmentBlock(options.env),
        utf16z(options.cwd),
        startup,
        procInfo,
      );
      if (!spawned) {
        return { ok: false, pid: 0, error: "CreateProcessAsUserW failed" };
      }
      const pid = new DataView(procInfo.buffer).getUint32(16, true);
      const hProcess = new DataView(procInfo.buffer).getBigUint64(0, true);
      const hThread = new DataView(procInfo.buffer).getBigUint64(8, true);
      ffi.kernel32.symbols.CloseHandle(hProcess);
      ffi.kernel32.symbols.CloseHandle(hThread);
      return { ok: true, pid, error: "" };
    } finally {
      ffi.kernel32.symbols.CloseHandle(BigInt(lowToken));
    }
  } finally {
    ffi.kernel32.symbols.CloseHandle(BigInt(token));
  }
}

/** dlopen 惰性加载:模块 import 零副作用(单测可安全 import 纯函数段)。
 *  token API 在 advapi32(kernel32 里没有),SID 转换器是 ANSI 版 ConvertStringSidToSidA。 */
function loadLowIntegrityFfi() {
  const kernel32 = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "bool" },
    CreateProcessAsUserW: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr", "bool", "u32", "ptr", "ptr", "ptr", "ptr"],
      returns: "bool",
    },
  });
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: ["ptr", "u32", "ptr"], returns: "bool" },
    DuplicateTokenEx: { args: ["ptr", "u32", "ptr", "i32", "i32", "ptr"], returns: "bool" },
    SetTokenInformation: { args: ["ptr", "i32", "ptr", "i32"], returns: "bool" },
    ConvertStringSidToSidA: { args: ["cstring", "ptr"], returns: "bool" },
  });
  return { kernel32, advapi32 };
}
