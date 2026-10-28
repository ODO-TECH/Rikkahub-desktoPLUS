// 终端帧协议的前端解读测试(0.0.4 SSH 对齐)。
// 这一层错一个字段名的后果不是崩,而是「静默」:错误文案变成空红字或通用兜底,远端原文与
// errorCode 的本地化词条一起丢,用户只知道「连不上」。服务端发的是 sshFailureBody() 那份载荷
// ({error, code, errorCode?}),字段名是 error 不是 message——测试就是把这个名字钉住。
import { describe, expect, test } from "bun:test";

import i18n from "~/i18n";
import { base64ToBytes, isHostKeyError, parseTerminalFrame, terminalErrorText } from "./ssh-terminal-frames";

describe("parseTerminalFrame", () => {
  test("文本 JSON 帧照原样交给调用方按 type 分支", () => {
    expect(parseTerminalFrame('{"type":"output","data":"aGk="}')).toEqual({ type: "output", data: "aGk=" });
  });

  test("非 JSON、null、数组、标量都不是帧:返回 null,不把终端带崩", () => {
    expect(parseTerminalFrame("")).toBeNull();
    expect(parseTerminalFrame("not json")).toBeNull();
    expect(parseTerminalFrame("null")).toBeNull();
    expect(parseTerminalFrame("[1,2]")).toBeNull();
    expect(parseTerminalFrame('"output"')).toBeNull();
  });
});

describe("terminalErrorText", () => {
  const fallback = "终端连接失败";

  test("取的是 error 字段:远端原文必须出现在终端里(曾经读 message,只剩兜底)", () => {
    const frame = parseTerminalFrame('{"type":"error","error":"connect 127.0.0.1:2222 ECONNREFUSED","code":502}')!;
    expect(terminalErrorText(frame, fallback)).toBe("connect 127.0.0.1:2222 ECONNREFUSED");
  });

  test("有 errorCode 时先查字典:终端里的红字与其他表面同一句话", () => {
    expect(i18n.exists("errors.ssh.device_not_found")).toBe(true);
    const frame = parseTerminalFrame(
      '{"type":"error","error":"SSH device not found","code":404,"errorCode":"ssh.device_not_found"}',
    )!;
    expect(terminalErrorText(frame, fallback)).toBe(i18n.t("errors.ssh.device_not_found"));
  });

  test("字典里没这个码就退回服务端原文:远端说的话不该被兜底文案吃掉", () => {
    const frame = parseTerminalFrame(
      '{"type":"error","error":"connect 127.0.0.1:2222 ECONNREFUSED","code":502,"errorCode":"ssh.no_such_code"}',
    )!;
    expect(terminalErrorText(frame, fallback)).toBe("connect 127.0.0.1:2222 ECONNREFUSED");
  });

  test("payload 什么文本都没有时用兜底,而不是往终端写一条空红字", () => {
    expect(terminalErrorText({ type: "error" }, fallback)).toBe(fallback);
    expect(terminalErrorText({ type: "error", error: "" }, fallback)).toBe(fallback);
    expect(terminalErrorText({ type: "error", error: 42, code: "502" }, fallback)).toBe(fallback);
  });
});

describe("isHostKeyError", () => {
  test("只有未信任与密钥变更两种码要走「去设置确认」横幅", () => {
    expect(isHostKeyError({ errorCode: "ssh.host_key_unknown" })).toBe(true);
    expect(isHostKeyError({ errorCode: "ssh.host_key_changed" })).toBe(true);
    expect(isHostKeyError({ errorCode: "ssh.terminal_busy" })).toBe(false);
    expect(isHostKeyError({ errorCode: "not.a.host.key" })).toBe(false);
    expect(isHostKeyError({})).toBe(false);
    expect(isHostKeyError({ errorCode: 400 })).toBe(false);
  });
});

describe("base64ToBytes", () => {
  test("解出的是字节而不是字符:远端输出可能是 UTF-8 多字节序列", () => {
    expect(Array.from(base64ToBytes("aGk="))).toEqual([104, 105]);
    expect(Array.from(base64ToBytes(Buffer.from("行", "utf8").toString("base64")))).toEqual([0xe8, 0xa1, 0x8c]);
    expect(base64ToBytes("")).toHaveLength(0);
  });
});
