// 批7 R5-2 卫兵:api 层所有 SSE 响应头必须经 request.ts 的 sseHeaders() 单源构造
// (它带 X-Accel-Buffering: no,反代自动关缓冲)。修复前 7 处手写头里有 4 处是审查
// 漏记的同病(data.ts 的 WebDAV/S3 进度流),单源化之后用本测试锁死"新增 SSE 端点
// 又手写响应头"的回归路径。出站请求的 Accept: text/event-stream 不在约束范围。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("SSE 响应头单源卫兵(R5-2)", () => {
  test("api/ 下除 request.ts 外不得手写 text/event-stream 响应头", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(import.meta.dir)) {
      if (file.endsWith("request.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (/["']Content-Type["']\s*:\s*["']text\/event-stream/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
