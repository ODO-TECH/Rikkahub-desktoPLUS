// 批次二 R7-1 回归:静态服务必须给 HTML 响应下发纵深防御 CSP。Tauri 壳加载的是本服务的
// http 页面,tauri.conf.json 的 csp 对 remote URL 不生效,响应头是唯一有效下发点。
// 静态资源(js/css)不需要也不应带 CSP(按 HTML 生效,资源上是死重)。
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { rootDir } from "../foundation/paths";
import { routeStatic } from "./static";

const built = existsSync(join(rootDir, "web-ui", "build", "client", "index.html"));

describe.skipIf(!built)("routeStatic CSP 头", () => {
  const expectCsp = (res: Response) => {
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
  };

  test("根路径 index.html 带 CSP", async () => {
    const res = await routeStatic(new URL("http://127.0.0.1/"));
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    expectCsp(res);
  });

  test("SPA fallback(未知路由)带 CSP 且不缓存", async () => {
    const res = await routeStatic(new URL("http://127.0.0.1/settings/general"));
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expectCsp(res);
  });

  test("非 HTML 静态资源不带 CSP", async () => {
    const res = await routeStatic(new URL("http://127.0.0.1/favicon.ico"));
    if (res.headers.get("Content-Type")?.includes("text/html")) return; // 资源缺失时走 fallback,不在本用例断言范围
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});
