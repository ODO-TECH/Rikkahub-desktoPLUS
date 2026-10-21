// 6-1 回归:请求日志脱敏——敏感 header 与 URL query 凭据不得以明文进入 logs。
import { describe, expect, test } from "bun:test";

import { sanitizeLogHeaders, sanitizeLogUrl } from "./logs";

describe("sanitizeLogHeaders(6-1)", () => {
  test("Authorization Bearer 保留 scheme,凭据本体打码", () => {
    const out = sanitizeLogHeaders({ Authorization: "Bearer sk-abcdefghijklmnop" });
    expect(out.Authorization).toBe("Bearer sk-***nop");
    expect(out.Authorization).not.toContain("abcdefghijklm");
  });

  test("Basic 凭据打码(SearXNG 用户名密码)", () => {
    const out = sanitizeLogHeaders({ authorization: "Basic dXNlcjpwYXNzd29yZA==" });
    expect(out.authorization).toMatch(/^Basic .{2,3}\*\*\*.{2,3}$/);
  });

  test("x-api-key / X-Subscription-Token / 自定义 token header 全部打码", () => {
    const out = sanitizeLogHeaders({
      "x-api-key": "tvly-1234567890abcdef",
      "X-Subscription-Token": "BSA9876543210",
      "x-custom-auth-token": "secret-value-here",
    });
    expect(out["x-api-key"]).toBe("tvl***def");
    expect(out["X-Subscription-Token"]).toBe("BSA***210");
    expect(out["x-custom-auth-token"]).toBe("sec***ere");
  });

  test("普通 header 原样保留", () => {
    const out = sanitizeLogHeaders({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": "RikkaHub/1.0",
    });
    expect(out["Content-Type"]).toBe("application/json");
    expect(out.Accept).toBe("text/event-stream");
    expect(out["User-Agent"]).toBe("RikkaHub/1.0");
  });

  test("短 key 也不完整暴露", () => {
    const out = sanitizeLogHeaders({ "api-key": "abcd" });
    expect(out["api-key"]).toBe("a***");
  });
});

describe("sanitizeLogUrl(6-1)", () => {
  test("Google 系 ?key= 打码,其余 query 保留", () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyABCDEF123456&pageSize=50";
    const out = sanitizeLogUrl(url);
    expect(out).not.toContain("AIzaSyABCDEF123456");
    expect(out).toContain("key=AIz***456");
    expect(out).toContain("pageSize=50");
  });

  test("access_token / api_key 变体同样打码", () => {
    const out = sanitizeLogUrl("https://api.example.com/v1?api_key=abcdefgh1234&access_token=tok_9876543210");
    expect(out).not.toContain("abcdefgh1234");
    expect(out).not.toContain("tok_9876543210");
  });

  test("URL userinfo 密码打码", () => {
    const out = sanitizeLogUrl("https://user:supersecret@searx.example.com/search?q=hi");
    expect(out).not.toContain("supersecret");
    expect(out).toContain("q=hi");
  });

  test("无敏感参数的 URL 原样返回(不被 URL 序列化改写)", () => {
    const url = "https://api.openai.com/v1/chat/completions";
    expect(sanitizeLogUrl(url)).toBe(url);
  });

  test("非法 URL 原样返回不抛错", () => {
    expect(sanitizeLogUrl("not a url")).toBe("not a url");
  });
});
