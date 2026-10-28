// ssh/workspace-tools.ts — SSH 工作区的 AI 工具内核(read + bash)
//
// 为什么不能直接复用 workspace/tools 的本地内核:那两个内核的路径解析走 node:path +
// node:fs(resolveToCwd 会 expandTilde 到本机 home、pathExists 会 stat 本机磁盘),
// 把远端路径喂进去只会得到 "C:\home\user\…" 这类本机投影。本模块用同一套契约
// (名称/描述/JSON Schema/截断文案/输出形状)在远端重新实现,模型与前端渲染都无感。
//
// 能力面对齐安卓端 WorkspaceCapabilities(SSH):rootfs=false、terminal=true、
// localFiles=false、fileWriteTools=false —— 远程工作区只有 read 与 shell,没有
// write/edit/grep/find/ls;改文件由 shell 完成(heredoc / sed),与安卓端提示词里
// 那段"There are no file write or edit tools in this workspace"同一套指引。
//
// 边界纪律:授权目录就是边界。相对路径按会话 cwd 解析(与本地工具同一心智),解析结果
// 越出授权目录即 ssh.path_escape —— 不跟随符号链接(词法归一),不查远端 realpath
// (安卓端 SshWorkspaceBackend 同规则:远端是真实机器,不是沙箱,边界只在授权目录这一层)。
//
// 超时的两处夹取:runtime.clampBashTimeoutSeconds 先夹 30min(与本地同一道闸),
// 这里再夹安卓端的 SHELL_TIMEOUT_MAX_SECONDS=600(agentTimeout 的上限);未指定超时的
// 命令按 600s 走,而不是 runSshCommand 给界面用的 30s 默认值。

import type { BashOperations, BashToolInput } from "../workspace/tools/bash";
import { createBashTool } from "../workspace/tools/bash";
import { detectSupportedImageMimeType } from "../workspace/tools/mime";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "../workspace/tools/truncate";
import type { ReadToolDetails, ReadToolInput } from "../workspace/tools/read";
import type { WorkspaceToolContent, WorkspaceToolDefinition } from "../workspace/tools/types";
import { agentTimeout, runSshCommand } from "./client";
import { SHELL_TIMEOUT_MAX_MS } from "./constants";
import { SshInputError } from "./errors";
import { readRemoteBytes } from "./remote-files";
import { lexicalNormalize } from "./remote-path";
import type { SshWorkspaceTarget } from "./workspace-binding";

/** 安卓端工具层单次读上限(WorkspaceTools.MAX_READ_FILE_BYTES = 8MB)。 */
const REMOTE_MAX_READ_BYTES = 8 * 1024 * 1024;

/** 与本地 read 内核同一份 schema(workspace/tools/read.ts 的 READ_SCHEMA 逐字一致)。 */
const REMOTE_READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to read (relative or absolute)" },
    offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
    limit: { type: "number", description: "Maximum number of lines to read" },
  },
  required: ["path"],
} as const;

/**
 * 远端读入参 → {绝对路径, 相对授权目录路径}。
 * 绝对路径直接词法归一;相对路径按 cwd 拼(与本地工具"relative or absolute"的承诺一致,
 * 也允许 ~ 以外的普通名字)。`~` 明确拒绝:远端 home 我们不知道,静默改写成工作区根会让
 * 模型以为读的是 ~/.bashrc 而实际读的是别的文件——报错比猜好。
 */
function remoteReadPath(target: SshWorkspaceTarget, cwd: string, raw: string): { absolute: string; relative: string } {
  const value = String(raw ?? "").trim();
  if (!value) throw new SshInputError("Path is required", "ssh.path_missing");
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    throw new SshInputError(
      `~ is not expanded on the remote host: use an absolute path inside the authorized directory or a path relative to the workspace (${target.root})`,
      "ssh.path_invalid",
    );
  }
  const absolute = value.startsWith("/") ? lexicalNormalize(value) : lexicalNormalize(`${cwd}/${value}`);
  const root = target.root;
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new SshInputError(`Path escapes workspace root: ${raw}`, "ssh.path_escape");
  }
  const relative = absolute === root ? "" : absolute.slice(root.length + 1);
  return { absolute, relative };
}

/**
 * 远端 read 内核:一次 SFTP 读取 + 与本地内核逐字相同的截断/续读文案。
 * 体积闸门交给 readRemoteBytes(stat 后、读前判定,超限报错不返回半截——安卓端 readText
 * 的规则);本地内核那种"读完再截断、给 offset 续读"在这里仍然成立,因为 8MB 上限远大于
 * 单次返回的 50KB 窗口,续读只是重新读一遍同一个文件。
 */
export function createRemoteReadTool(
  target: SshWorkspaceTarget,
  cwd: string,
): WorkspaceToolDefinition<ReadToolInput, ReadToolDetails | undefined> {
  return {
    name: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: REMOTE_READ_SCHEMA as unknown as Record<string, unknown>,
    async execute({ path, offset, limit }, signal?) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const { relative } = remoteReadPath(target, cwd, path);
      const buffer = await readRemoteBytes(target.device, target.dir.id, relative, REMOTE_MAX_READ_BYTES);
      if (signal?.aborted) throw new Error("Operation aborted");

      const mimeType = detectSupportedImageMimeType(buffer);
      if (mimeType) {
        const imageContent: WorkspaceToolContent[] = [
          { type: "text", text: `Read image file [${mimeType}]` },
          { type: "image", data: buffer.toString("base64"), mimeType },
        ];
        return { content: imageContent };
      }

      const textContent = buffer.toString("utf-8");
      const allLines = textContent.split("\n");
      const totalFileLines = allLines.length;
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }
      let selectedContent: string;
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }
      const truncation = truncateHead(selectedContent);
      let outputText: string;
      let details: ReadToolDetails | undefined;
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        outputText +=
          truncation.truncatedBy === "lines"
            ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
            : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        details = { truncation };
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }
      return { content: [{ type: "text", text: outputText }], details };
    },
  };
}

/**
 * 远端 shell 的 BashOperations(pi 内核留的注入点,注释里就写着 "for example SSH")。
 * 命令文本与 cwd 一律经 ssh/command-wrap.ts 的 shellQuote 作位置参数进
 * `cd -- "$1" && eval "$2"`,外层只解析一次——本层不拼任何命令串。
 */
export function createRemoteBashOperations(target: SshWorkspaceTarget): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const seconds = Number.isFinite(timeout) && (timeout ?? 0) > 0 ? (timeout as number) : undefined;
      // 给了超时 → agentTimeout 夹到安卓端 600s 上限;没给 → 直接按上限跑
      // (本地内核是"不给超时",界面侧的 30s 默认值不适合长任务——这里取交集:不设限,
      // 由 SHELL_TIMEOUT_MAX_MS 兜住,与安卓端 SHELL_TIMEOUT_MAX_SECONDS 同一数值)。
      const timeoutMs = seconds !== undefined ? agentTimeout(seconds * 1000) : SHELL_TIMEOUT_MAX_MS;
      const outcome = await runSshCommand(target.device, command, {
        cwd,
        timeoutMs,
        signal,
        // 命令不可重复:连接断了宁可失败,不把同一条命令在远端再跑一遍。
        retry: false,
        // stdout/stderr 混进同一条流(与本地内核一致,pi 的 OutputAccumulator 不分流)。
        onData: (chunk) => onData(Buffer.from(chunk, "utf8")),
      });
      if (signal?.aborted) throw new Error("aborted");
      if (outcome.timedOut) {
        // pi 内核按 "timeout:<秒>" 组装 "Command timed out after N seconds" 文案。
        throw new Error(`timeout:${seconds ?? timeoutMs / 1000}`);
      }
      return { exitCode: outcome.code };
    },
  };
}

/** 远程工作区的 bash 工具:pi 内核原样(描述/节流/截断落盘/退出码报错),换掉执行手。 */
export function createRemoteBashTool(
  target: SshWorkspaceTarget,
  cwd: string,
  options: { tempFileDir?: string } = {},
): WorkspaceToolDefinition<BashToolInput, unknown> {
  return createBashTool(cwd, {
    operations: createRemoteBashOperations(target),
    tempFileDir: options.tempFileDir,
  }) as WorkspaceToolDefinition<BashToolInput, unknown>;
}

/** 远程工作区可用的工具名(安卓端 fileWriteTools=false:没有 write/edit)。 */
export const REMOTE_WORKSPACE_TOOL_NAMES = ["read", "bash"] as const;

/** 分发入口:runtime.buildWorkspaceTool 的远程分支。name 由挂载矩阵给出,其余一律拒。 */
export function buildRemoteWorkspaceTool(
  name: string,
  target: SshWorkspaceTarget,
  cwd: string,
  options: { tempFileDir?: string } = {},
): WorkspaceToolDefinition<unknown, unknown> {
  switch (name) {
    case "read":
      return createRemoteReadTool(target, cwd) as WorkspaceToolDefinition<unknown, unknown>;
    case "bash":
      return createRemoteBashTool(target, cwd, options) as WorkspaceToolDefinition<unknown, unknown>;
    default:
      // 能力面兜底:挂载矩阵不给远程工作区发别的名字(历史残留调用会走到这里)。
      throw new Error(
        `Tool '${name}' is not available in an SSH workspace — remote workspaces only provide read and bash (edit files with the shell).`,
      );
  }
}
