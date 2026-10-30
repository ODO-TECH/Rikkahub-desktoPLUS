// 内置 fetch 引擎回归：参数契约、正文加工、截断续读、SSRF 守卫、重定向与错误语义。
// 出站全部走 globalThis.fetch 桩，用 TEST-NET 地址（203.0.113.0/24）保证守卫探针不做真实 DNS。
import { afterEach, describe, expect, test } from "bun:test";
import { BUILTIN_FETCH_TOOL_NAME, builtinFetchToolDefinition, runBuiltinFetchTool } from "./mcp-builtin-fetch";

const PUBLIC = "https://203.0.113.10";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: Call[] = [];
type Responder = (url: string, call: Call) => Response;

function stubFetch(respond: Responder) {
  calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: Call = {
      url,
      method: String(init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : init?.body ? "(non-string body)" : undefined,
    };
    calls.push(call);
    return respond(url, call);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function html(text: string, status = 200) {
  restore = stubFetch(() => new Response(text, { status, headers: { "content-type": "text/html; charset=utf-8" } }));
}

function bodyOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ text: string }>;
  return content[0]!.text;
}

describe("内置 fetch 工具定义", () => {
  test("名字、必填项与续读上限都按契约暴露", () => {
    const def = builtinFetchToolDefinition();
    expect(def.name).toBe(BUILTIN_FETCH_TOOL_NAME);
    const schema = def.inputSchema as Record<string, unknown>;
    expect(schema.required).toEqual(["url"]);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.method?.enum).toEqual(["GET", "POST"]);
    expect(props.max_length?.maximum).toBe(20_000);
    expect(props.start_index?.minimum).toBe(0);
  });
});

describe("内置 fetch 正文加工", () => {
  test("HTML 转 Markdown 并带上标题", async () => {
    html(`<html><head><title>标题页</title></head><body><nav>菜单</nav><main><h1>大标题</h1><p>正文段落 <a href="/next">下一跳</a></p></main></body></html>`);
    const result = await runBuiltinFetchTool({ url: `${PUBLIC}/docs` });
    expect(result.isError).toBe(false);
    const text = bodyOf(result);
    expect(text).toContain("Title: 标题页");
    expect(text).toContain("# 大标题");
    expect(text).toContain("正文段落");
    expect(text).not.toContain("菜单");
    // 相对链接按落地地址绝对化，模型可以照着继续 fetch
    expect(text).toContain(`${PUBLIC}/next`);
  });

  test("raw=true 原样返回源码，不转 Markdown", async () => {
    const source = "<html><body><p>原文</p></body></html>";
    html(source);
    const result = await runBuiltinFetchTool({ url: `${PUBLIC}/x`, raw: true });
    expect(bodyOf(result)).toBe(source);
  });

  test("JSON 响应紧凑重写，畸形 JSON 原样保留", async () => {
    restore = stubFetch(() => new Response('{\n  "a": 1,\n  "b": [2]\n}', { headers: { "content-type": "application/json" } }));
    expect(bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/api` }))).toBe('{"a":1,"b":[2]}');

    restore = stubFetch(() => new Response("{not json", { headers: { "content-type": "application/json" } }));
    expect(bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/api` }))).toBe("{not json");
  });

  test("声明的字符集优先于 UTF-8 严格解码", async () => {
    const latin1 = new Uint8Array([0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9]);
    restore = stubFetch(() => new Response(latin1, { headers: { "content-type": "text/plain; charset=windows-1252" } }));
    expect(bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/latin1` }))).toBe("Résumé");
  });

  test("二进制响应说明读不了，而不是回一堆乱码", async () => {
    restore = stubFetch(() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), { headers: { "content-type": "image/png" } }));
    const result = await runBuiltinFetchTool({ url: `${PUBLIC}/logo.png` });
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toContain("Cannot read this response as text");
  });
});

describe("内置 fetch 截断与续读", () => {
  const long = "x".repeat(100);

  test("截断时给出下一段起点", async () => {
    restore = stubFetch(() => new Response(long, { headers: { "content-type": "text/plain" } }));
    const first = bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/long`, max_length: 30 }));
    expect(first).toContain("[Content truncated: showing characters 0-29 of 100.");
    expect(first).toContain("Call fetch with start_index=30 to continue.]");

    const second = bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/long`, max_length: 30, start_index: 30 }));
    expect(second).toContain("showing characters 30-59 of 100.");
    expect(second).toContain("start_index=60");

    const tail = bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/long`, max_length: 90, start_index: 30 }));
    expect(tail).not.toContain("Content truncated");
  });

  test("起点越界只回一句没有更多内容", async () => {
    restore = stubFetch(() => new Response(long, { headers: { "content-type": "text/plain" } }));
    expect(bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/long`, start_index: 100 }))).toBe("No more content available.");
  });

  test("断点不落在代理对中间", async () => {
    // 「😀」占两个 code unit：切在它中间会让模型看到半个 emoji。
    restore = stubFetch(() => new Response(`ab${"😀".repeat(5)}cd`, { headers: { "content-type": "text/plain" } }));
    const text = bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/emoji`, max_length: 4 }));
    expect(text.split("[Content truncated")[0]!.trim()).toBe("ab😀");
    expect(text).toContain("start_index=4");
  });

  test("切点落在表情中间时退到整对之前", async () => {
    restore = stubFetch(() => new Response(`a${"😀".repeat(3)}b`, { headers: { "content-type": "text/plain" } }));
    const text = bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/emoji2`, max_length: 2 }));
    // 长度 2 会切在第一个表情的低半上，必须回退到只留 "a"
    expect(text.split("[Content truncated")[0]!.trim()).toBe("a");
    expect(text).toContain("start_index=1");
  });

  test("POST 截断只让改 max_length，不许续读", async () => {
    restore = stubFetch(() => new Response(long, { headers: { "content-type": "text/plain" } }));
    const text = bodyOf(await runBuiltinFetchTool({ url: `${PUBLIC}/api`, method: "POST", body: "{}", max_length: 10 }));
    expect(text).toContain("Raise max_length to see more; a POST cannot be continued with start_index.]");
  });
});

describe("内置 fetch 请求构造", () => {
  test("带浏览器 UA 与自定义头，POST 对象体自动编码", async () => {
    restore = stubFetch(() => new Response("ok", { headers: { "content-type": "text/plain" } }));
    await runBuiltinFetchTool({
      url: `${PUBLIC}/api`,
      method: "POST",
      body: { hello: "world" },
      headers: { "X-Token": "abc" },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.body).toBe('{"hello":"world"}');
    expect(call.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(call.headers["x-token"]).toBe("abc");
    expect(call.headers["user-agent"]).toContain("Chrome/120.0.0.0");
    expect(call.headers["user-agent"]).not.toContain("RikkaHub");
  });

  test("POST 声明非 UTF-8 字符集会拒绝而不是撒谎", async () => {
    restore = stubFetch(() => new Response("ok"));
    const result = await runBuiltinFetchTool({
      url: `${PUBLIC}/api`,
      method: "POST",
      body: "x",
      headers: { "Content-Type": "text/plain; charset=gbk" },
    });
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toContain("cannot declare charset=gbk");
    expect(calls).toHaveLength(0);
  });
});

describe("内置 fetch 出站守卫", () => {
  test.each([
    ["http://127.0.0.1:17455/api/settings", "回环"],
    ["http://localhost:17455/api/settings", "localhost"],
    ["http://[::1]:17455/", "IPv6 回环"],
    ["http://169.254.169.254/latest/meta-data/", "云元数据"],
    ["http://100.100.100.200/latest/meta-data/", "阿里云元数据"],
    ["http://0.0.0.0:8080/", "任意地址"],
    ["http://app.localhost/", "后缀"],
  ])("%s 直接拒绝且不发起请求（%s）", async (url) => {
    restore = stubFetch(() => new Response("should never be reached"));
    const result = await runBuiltinFetchTool({ url, method: "POST", body: "{\"x\":1}" });
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toContain("cannot reach local or link-local addresses");
    expect(calls).toHaveLength(0);
  });

  test("字面量打包形态（2130706433）也归一成回环后拒绝", async () => {
    restore = stubFetch(() => new Response("nope"));
    const result = await runBuiltinFetchTool({ url: "http://2130706433/api" });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("域名解析到回环时拒绝", async () => {
    restore = stubFetch(() => new Response("nope"));
    const original = Bun.dns.lookup;
    // @ts-expect-error 仅在测试里替换探针
    Bun.dns.lookup = async () => [{ address: "127.0.0.1", family: 4 }];
    try {
      const result = await runBuiltinFetchTool({ url: "https://rebind.example/" });
      expect(result.isError).toBe(true);
      expect(bodyOf(result)).toContain("resolves to 127.0.0.1");
    } finally {
      Bun.dns.lookup = original;
    }
    expect(calls).toHaveLength(0);
  });

  test("局域网地址照常放行（NAS 场景）", async () => {
    restore = stubFetch(() => new Response("内网页面", { headers: { "content-type": "text/plain" } }));
    const result = await runBuiltinFetchTool({ url: "http://192.168.1.20:5000/api" });
    expect(result.isError).toBe(false);
    expect(bodyOf(result)).toBe("内网页面");
  });

  test("重定向跳回回环被拒", async () => {
    restore = stubFetch((url) =>
      url.startsWith(PUBLIC)
        ? new Response("", { status: 302, headers: { location: "http://127.0.0.1:17455/api/settings" } })
        : new Response("leaked"),
    );
    const result = await runBuiltinFetchTool({ url: `${PUBLIC}/redirect` });
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toContain("cannot reach local or link-local addresses");
    expect(calls).toHaveLength(1);
  });

  test("跨站重定向丢掉 Authorization 与 Cookie", async () => {
    restore = stubFetch((url) =>
      url.includes("/start")
        ? new Response("", { status: 302, headers: { location: "https://203.0.113.99/target" } })
        : new Response("done", { headers: { "content-type": "text/plain" } }),
    );
    await runBuiltinFetchTool({
      url: `${PUBLIC}/start`,
      headers: { Authorization: "Bearer secret", Cookie: "s=1", "X-Keep": "1" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://203.0.113.99/target");
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
    expect(calls[1]!.headers["cookie"]).toBeUndefined();
    expect(calls[1]!.headers["x-keep"]).toBe("1");
  });

  test("301 把 POST 降级成 GET 并丢掉请求体", async () => {
    restore = stubFetch((url) =>
      url.endsWith("/moved")
        ? new Response("", { status: 301, headers: { location: `${PUBLIC}/final` } })
        : new Response("ok", { headers: { "content-type": "text/plain" } }),
    );
    await runBuiltinFetchTool({ url: `${PUBLIC}/moved`, method: "POST", body: "{}" });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(calls[1]!.body).toBeUndefined();
  });

  test("重定向成环时报上限而不是无限跳", async () => {
    restore = stubFetch(() => new Response("", { status: 302, headers: { location: `${PUBLIC}/again` } }));
    const result = await runBuiltinFetchTool({ url: `${PUBLIC}/loop` });
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toContain("Too many redirects");
  });

  test("非法 Location 归到配置类错误", async () => {
    restore = stubFetch(() => new Response("", { status: 302, headers: { location: "ftp://nope" } }));
    const result = await runBuiltinFetchTool({ url: `${PUBLIC}/x` });
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toContain("unsupported scheme: ftp:");
  });
});

describe("内置 fetch 失败语义", () => {
  test("非 2xx 回状态码 + 响应体详情", async () => {
    restore = stubFetch(() =>
      new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await runBuiltinFetchTool({ url: `${PUBLIC}/api` });
    expect(result.isError).toBe(true);
    const text = bodyOf(result);
    expect(text).toStartWith("HTTP 429");
    expect(text).toContain("quota exceeded");
  });

  test.each([
    ["缺 url", {}],
    ["裸域名", { url: "example.com" }],
    ["非 HTTP 协议", { url: "file:///C:/secret" }],
    ["不支持的方法", { url: `${PUBLIC}/x`, method: "DELETE" }],
    ["GET 带请求体", { url: `${PUBLIC}/x`, body: "hi" }],
    ["max_length 越界", { url: `${PUBLIC}/x`, max_length: 99_999 }],
    ["max_length 非整数", { url: `${PUBLIC}/x`, max_length: 1.5 }],
    ["POST 用 start_index", { url: `${PUBLIC}/x`, method: "POST", body: "{}", start_index: 5000 }],
    ["raw 非布尔", { url: `${PUBLIC}/x`, raw: "yes" }],
  ])("%s → isError 且不发请求", async (_label, args) => {
    restore = stubFetch(() => new Response("never"));
    const result = await runBuiltinFetchTool(args);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("上游异常也转成 isError，不冒泡打断健康层", async () => {
    restore = stubFetch(() => {
      throw new Error("socket hang up");
    });
    const result = await runBuiltinFetchTool({ url: `${PUBLIC}/x` });
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toContain("socket hang up");
  });

  test("结果是标准 tool_result 形状", async () => {
    restore = stubFetch(() => new Response("ok", { headers: { "content-type": "text/plain" } }));
    const result = await runBuiltinFetchTool({ url: `${PUBLIC}/x` });
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      isStreaming: false,
      isError: false,
    });
  });
});
