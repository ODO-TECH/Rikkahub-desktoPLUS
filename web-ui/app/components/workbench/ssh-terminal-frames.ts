import { ApiError } from "~/services/api";
import { extractErrorMessage } from "~/lib/error";

// 终端 WebSocket 帧的前端解读(与 pc-server/ssh/terminal-session.ts 的发帧侧一一对应)。
//
// 单独成模块是为了能被 bun test 直接跑到:这一层的字段名读错,代价是终端里那句错误说明
// 变成空字符串或通用兜底——服务端辛苦分层的 errorCode 与远端原文全丢,而界面看上去「只是连不上」。
// 曾经真的把 error 写成 message,所以把映射固定在这里并上测试。
//
// 纪律同服务端:帧里的错误文本可以安全显示(载荷只允许 user@host:port、路径与指纹,不含凭据),
// 但键盘输入与远端回显不落日志、不进 store、不进 URL。

/** 服务端帧的原始形状:靠 type 分支,其余字段按需读,未知字段照旧忽略。 */
export type TerminalFrame = Record<string, unknown>;

/** 文本帧解析:非 JSON 或非对象(坏帧、别的协议混进来)一律当没看见,不把终端带崩。 */
export function parseTerminalFrame(raw: string): TerminalFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as TerminalFrame) : null;
}

/**
 * error 帧 → ApiError。服务端发的是 sshFailureBody() 那份载荷,与 HTTP 错误体同形
 * (`{error, code, errorCode?, hostKey?, verifyCommand?, expectedFingerprint?}`),
 * 所以套进 ApiError 就复用同一条文案路径:有 errorCode 先查 `errors.<code>`,没码用服务端原文。
 *
 * 字段名是 error,不是 message——这是这次修复的要点。
 */
function terminalErrorInfo(frame: TerminalFrame): ApiError {
  const message = typeof frame.error === "string" ? frame.error : "";
  const code = typeof frame.code === "number" ? frame.code : 0;
  const errorCode = typeof frame.errorCode === "string" && frame.errorCode ? frame.errorCode : undefined;
  return new ApiError(message, code, errorCode, frame);
}

/**
 * error 帧 → 一行可读文案:本地化词条优先,其次服务端原文,两者都空才用兜底。
 * 那个 `|| fallback` 是必需的:message 为空的 Error 过 extractErrorMessage 拿回空串,
 * 空串写进终端就是一条什么都没有的红字,用户看不到任何原因。
 */
export function terminalErrorText(frame: TerminalFrame, fallback: string): string {
  return extractErrorMessage(terminalErrorInfo(frame), fallback) || fallback;
}

/** 主机密钥类错误:唯一修法是在「设置 › 拓展 › SSH」重新信任,所以要单独给横幅而不是埋在红字里。 */
export function isHostKeyError(frame: TerminalFrame): boolean {
  const code = typeof frame.errorCode === "string" ? frame.errorCode : "";
  return code === "ssh.host_key_unknown" || code === "ssh.host_key_changed";
}

/** output 帧的 data 是 base64:远端输出是任意字节,不能塞进 JSON 字符串。 */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
