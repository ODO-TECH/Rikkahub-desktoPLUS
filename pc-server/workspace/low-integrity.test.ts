// low-integrity.test.ts — 纯函数段单测(FFI 段由验收测试覆盖,见 tools/sandbox-spike)
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildLowSandboxEnvironment, encodeUtf16EnvironmentBlock, quoteWindowsArgument } from "./low-integrity";

describe("Windows 命令行参数引用", () => {
  test("无特殊字符原样通过;空串成对引号", () => {
    expect(quoteWindowsArgument("--no-open")).toBe("--no-open");
    expect(quoteWindowsArgument("")).toBe('""');
  });

  test("含空格的路径包引号(本仓库路径常态)", () => {
    expect(quoteWindowsArgument("D:\\Users Data\\Desktop\\x.exe")).toBe('"D:\\Users Data\\Desktop\\x.exe"');
  });

  test("内嵌引号转义、引号前的反斜杠翻倍", () => {
    expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
  });

  test("纯反斜杠结尾无空格无需引号;含空格时结尾反斜杠在闭引号前翻倍", () => {
    expect(quoteWindowsArgument("dir\\")).toBe("dir\\");
    expect(quoteWindowsArgument("my dir\\")).toBe('"my dir\\\\"');
  });
});

describe("Low 后端环境构造", () => {
  const DATA = join("D:\\pc-data");

  test("四组重定向 + LAUNCHED 标记全部就位", () => {
    const env = buildLowSandboxEnvironment(DATA, { PATH: "C:\\bin" });
    expect(env.TEMP).toBe(join(DATA, "tmp"));
    expect(env.TMP).toBe(join(DATA, "tmp"));
    expect(env.HOME).toBe(join(DATA, "home"));
    expect(env.USERPROFILE).toBe(join(DATA, "home"));
    expect(env.RIKKAHUB_PC_DATA_DIR).toBe(DATA);
    expect(env.RIKKAHUB_SANDBOX).toBe("restricted");
    expect(env.RIKKAHUB_SANDBOX_LAUNCHED).toBe("1");
    expect(env.PATH).toBe("C:\\bin");
  });

  test("base 里的重定向目标与 LAUNCHED 被强制覆盖(防循环硬不变量)", () => {
    const env = buildLowSandboxEnvironment(DATA, {
      TEMP: "C:\\Windows\\Temp",
      RIKKAHUB_SANDBOX_LAUNCHED: "0",
      RIKKAHUB_SANDBOX: "off",
    });
    expect(env.TEMP).toBe(join(DATA, "tmp"));
    expect(env.RIKKAHUB_SANDBOX_LAUNCHED).toBe("1");
    expect(env.RIKKAHUB_SANDBOX).toBe("restricted");
  });

  test("Windows 大小写不敏感:base 的 Path/PATH 去重、后者胜", () => {
    const env = buildLowSandboxEnvironment(DATA, { Path: "a", PATH: "b" });
    expect(env.PATH).toBe("b");
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
  });

  test("undefined 值跳过(不产生空串环境变量)", () => {
    const env = buildLowSandboxEnvironment(DATA, { UNSET_VAR: undefined });
    expect("UNSET_VAR" in env).toBe(false);
  });
});

describe("UTF-16 环境块编码", () => {
  function decodeBlock(block: Uint16Array): string[] {
    const entries: string[] = [];
    let current = "";
    for (const unit of block) {
      if (unit === 0) {
        if (current === "") break;
        entries.push(current);
        current = "";
        continue;
      }
      current += String.fromCharCode(unit);
    }
    return entries;
  }

  test("每项 NAME=value\\0,末尾双 \\0 终止,可无损往返", () => {
    const block = encodeUtf16EnvironmentBlock({ B: "2", A: "1", C: "" });
    expect(decodeBlock(block)).toEqual(["A=1", "B=2", "C="]);
  });

  test("空环境 → 单个 \\0(合法空块)", () => {
    expect(encodeUtf16EnvironmentBlock({}).length).toBe(1);
    expect(encodeUtf16EnvironmentBlock({}).every((unit) => unit === 0)).toBe(true);
  });

  test("键按字典序排列(输出确定)", () => {
    const block = encodeUtf16EnvironmentBlock({ Z: "z", A: "a", M: "m" });
    expect(decodeBlock(block)).toEqual(["A=a", "M=m", "Z=z"]);
  });

  test("中文值按 UTF-16 正确编码(代理对往返)", () => {
    const value = "工作区/🚀";
    const block = encodeUtf16EnvironmentBlock({ K: value });
    const decoded = decodeBlock(block)[0]!;
    expect(decoded).toBe(`K=${value}`);
  });
});
