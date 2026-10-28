// ssh/command-wrap.ts — 远端命令的拼装与引号处理。
//
// 为什么不把命令原样丢给 sshd:
// 1) sshd 用「登录用户的 shell -c <命令>」执行,rc 文件里 echo 的东西会混进 stdout;
// 2) 不固定 shell,同一份工作区里 bash/zsh 语法差异会让模型写的命令随机失败;
// 3) 颜色转义会把界面上的纯文本输出区搞成一堆乱码——安卓端因此统一注入 NO_COLOR=1、
//    PAGER=cat、CI=true(工具不再等交互确认)。这里逐条对齐安卓端 WorkspaceShellRunner 与
//    SshWorkspaceBackend 的拼装结果,保证两端给服务器的字节一致。
//
// 命令文本一律作为 `eval "$2"` 的参数、以位置参数传过去,只在外层被解析一次;路径同理,
// 避免「用户目录里有空格」或「命令里有 $」时被远端 shell 二次展开。

/**
 * POSIX 单引号转义:整体包 '…',内部的 ' 换成 '"'"'(关引号→双引号里的 '→开引号)。
 * 一律加引号,不做「安全字符省略」的优化——和安卓端逐字节一致比省几个字符重要。
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

/** 一次 exec 的固定外壳:env 三件套 + 探测到的 shell 以登录 shell 跑 cd && eval。 */
const EXEC_WRAPPER = 'cd -- "$1" && eval "$2"';
/** argv0 占位:让位置参数从 $1 开始,和安卓端保持同一个字面量。 */
const ARGV0 = "rikkahub";

/**
 * 组装在远端执行的命令。
 * @param shell 探测到的远端 shell 绝对路径(bash 或 /bin/sh)
 * @param cwd 远端工作目录(绝对路径)
 * @param command 用户/AI 给的命令原文
 */
export function buildExecCommand(shell: string, cwd: string, command: string): string {
  return [
    "env",
    "CI=true",
    "NO_COLOR=1",
    "PAGER=cat",
    shell,
    "-l",
    "-c",
    EXEC_WRAPPER,
    ARGV0,
    cwd,
    command,
  ]
    .map(shellQuote)
    .join(" ");
}

/**
 * 组装交互式终端的命令(在带 PTY 的 exec channel 里跑)。
 * cd 失败也继续(`;`),然后 exec 用户自己的登录 shell;$SHELL 未设置时退回探测到的 shell。
 * 与安卓端 SshWorkspaceBackend.openShell 的字符串一致。
 */
export function buildShellCommand(shell: string, cwd: string): string {
  const inner = 'cd -- "$1"; exec "${SHELL:-$0}" -l';
  return [shell, "-c", inner, shell, cwd].map(shellQuote).join(" ");
}

/** 探测远端有没有 bash:`command -v bash` 的 stdout 最后一行绝对路径才是真答案(rc 噪音在前)。 */
export const SHELL_PROBE_COMMAND = "command -v bash";

/** 从 `command -v bash` 的输出里取 shell 路径;没有绝对路径行则返回兜底。 */
export function pickShellPath(stdout: string, exitCode: number | null, fallback: string): string {
  if (exitCode !== 0) return fallback;
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"));
  const last = lines[lines.length - 1];
  return last && last.includes(" ") === false ? last : fallback;
}
