// ssh/constants.ts — SSH 一层的硬数值,集中放好让测试和文档能引用同一个名字。
// 数值与安卓端 workspace/ssh/{SshConnection,SshConnectionPool,SshWorkspaceBackend}.kt 对齐,
// 除非下面「差异」注释另有说明。

/** 建立连接(TCP + 密钥交换 + 认证)的上限;安卓端 JSch session.connect(15_000)。 */
export const CONNECT_TIMEOUT_MS = 15_000;
/** 单个 channel(exec / sftp / pty)等待服务器回应的上限。 */
export const CHANNEL_TIMEOUT_MS = 15_000;
/** SSH 层 keepalive 间隔。 */
export const KEEPALIVE_INTERVAL_MS = 15_000;
/** 连续多少个 keepalive 无回应算掉线(3 × 15s ≈ 45s 判定)。 */
export const KEEPALIVE_COUNT_MAX = 3;
/** 探测远端登录 shell 的命令超时。 */
export const SHELL_DETECT_TIMEOUT_MS = 15_000;
/** PTY 类型;与安卓端一致用 256 色 xterm。 */
export const TERMINAL_TYPE = "xterm-256color";

/** 空闲多久且无进行中操作就断开连接,下次使用再重连(安卓端 5 分钟)。 */
export const IDLE_TIMEOUT_MS = 5 * 60_000;
/** 空闲扫描周期。 */
export const SWEEP_INTERVAL_MS = 30_000;

/** exec 单条输出上限:128K 字符/流(stdout 与 stderr 各自),与安卓端 WorkspaceShellRunner 一致。 */
export const MAX_OUTPUT_CHARS = 128 * 1024;
/** 一次性命令的默认与最大超时(界面侧 timeoutMs 取两者夹住)。 */
export const EXEC_TIMEOUT_DEFAULT_MS = 30_000;
export const EXEC_TIMEOUT_MAX_MS = 120_000;
/** AI 工具的 shell 超时上限(安卓端 WorkspaceTools.SHELL_TIMEOUT_MAX_SECONDS = 600)。 */
export const SHELL_TIMEOUT_MAX_MS = 600_000;

/** 读文件上限:超过直接报错,不返回半截(安卓端 maxReadBytes = 512 KiB)。 */
export const MAX_READ_BYTES = 512 * 1024;
/**
 * 界面「下载到本地/作为附件」的上限。安卓端 exportFile 是接到本地文件的流,不限大小;
 * rdp 的下载是一次 HTTP 请求,不把整机大文件吸进内存,超限明确报错(差异见 remote-files.ts)。
 */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** 写文件上限(安卓端 maxWriteBytes = 2 MiB)。 */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
/** 单次列目录返回条数上限(安卓端 maxListEntries = 500)。 */
export const MAX_LIST_ENTRIES = 500;
/** 私钥文件导入上限(安卓端 MAX_PRIVATE_KEY_BYTES = 64 KiB)。 */
export const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

/** 探测不到 bash 时的兜底 shell。 */
export const FALLBACK_SHELL = "/bin/sh";

/**
 * 终端尺寸上限(列/行)。安卓端把 UI 的字符尺寸直接发给 setPtySize,不做夹取;
 * rdp 的尺寸来自浏览器,一个错误的请求就敢报几百万列,远端要为它分配等量的行缓冲,
 * 所以这里夹一次。上限取 4096:实际终端不会超过它,超过即视为异常输入。
 */
export const MAX_COLS = 4096;
export const MAX_ROWS = 4096;
