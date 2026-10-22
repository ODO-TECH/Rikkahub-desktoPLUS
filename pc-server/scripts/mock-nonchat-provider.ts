// scripts/mock-nonchat-provider.ts — 本地假供应商，专门当「嵌入 / 重排」两条线路的实机靶子。
//
// 为什么要它：这两类模型的真实出站只能打到收费接口上，日常验证不该动配额
// （见记忆「Never spend paid API quota silently」）。本脚本在 127.0.0.1 上假装自己是
// OpenAI 兼容供应商，实现 /embeddings 与 /rerank 两个端点，于是可以在真实 UI 里
// 把「添加模型 → 点测试 → 出绿勾」整条链路跑一遍，一分钱不花、数据不出本机。
//
// 用法（在 pc-server 目录下）：
//   bun run scripts/mock-nonchat-provider.ts                    # 起靶子，默认 127.0.0.1:18123
//   bun run scripts/mock-nonchat-provider.ts --alt              # 换成非标准响应形态（见下）
//   bun run scripts/mock-nonchat-provider.ts --seed http://127.0.0.1:17499
//       往一个正在跑的 rdp 实例里注入两个演示供应商 + 四个演示模型，并立刻各跑一次「检测」，
//       把 checks 原样打印出来。UI 里什么都不用填，点进去就是能测的状态。
//
// 两种响应形态都是市场上真实存在的：
//   默认：/embeddings → data[].embedding；/rerank → results[].relevance_score（OpenAI / Jina / SiliconFlow）
//   --alt：/embeddings → embeddings[][]（无 data）；/rerank → scores[] 按输入序（无 results）
//   —— 用来实机验证 parseEmbeddingsPayload / parseRerankPayload 的两族兼容分支，而不是只靠单测。
//
// 向量不是随机数：按字符二元组散列到 768 维上再归一化，所以「相近的文本余弦高」，
// 后面做记忆召回（特性 C 的 M7）时这个靶子仍能给出可解释的排序。

import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const getFlag = (name: string): string | undefined => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const PORT = Number(getFlag("port") ?? 18123);
const DIM = Number(getFlag("dim") ?? 768);
const ALT = has("alt");
const SEED_BASE = getFlag("seed")?.replace(/\/+$/, "");

// ── 确定性伪随机向量 ────────────────────────────────────────────────────────

function seedOf(text: string): number {
  return Number(BigInt("0x" + createHash("sha256").update(text).digest("hex").slice(0, 8)));
}

function xorshift(state: number): () => number {
  let s = state || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s << 17; s >>>= 0; s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}

/** 字符二元组；单字串退化为该字本身，空串退化成一个占位符。 */
function bigrams(text: string): string[] {
  const chars = [...text.trim()];
  if (chars.length === 0) return ["(empty)"];
  if (chars.length === 1) return [chars[0]];
  return chars.slice(0, -1).map((_, i) => chars.slice(i, i + 2).join(""));
}

/** 文本 → DIM 维单位向量；共享的字越多，余弦越接近 1。 */
function embed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  for (const gram of bigrams(text)) {
    const rand = xorshift(seedOf(gram));
    // 每个二元组点 12 个维度：维度稀疏但可分，够算余弦，也不用真跑模型。
    for (let k = 0; k < 12; k++) vec[Math.floor(rand() * DIM)] += 1;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  // 真模型的向量每维都非零；纯稀疏向量的前几维会打出 0.0000，检测预览看着像「没编码成功」。
  // 叠一个极小的均匀底（对余弦的影响 ~0.01），让靶子的输出形态更像真实响应。
  return vec.map((v) => Number(((v + 0.004 * norm) / (norm * 1.004)).toFixed(6)));
}

/**
 * 「重排打分」= 查询与文档的二元组 Dice 系数，另给「整串命中」加成。
 * 用 Dice 而不是「命中数 / 文档长度」：后者让长文档天然占优，演示里会出现不相关的
 * 长句排第一，看着像靶子坏了、其实是被度量骗了。
 */
function fakeScore(query: string, document: string): number {
  const q = new Set(bigrams(query));
  const d = new Set(bigrams(document));
  let hit = 0;
  for (const gram of d) if (q.has(gram)) hit++;
  const dice = (2 * hit) / (q.size + d.size);
  const exact = query.trim() && document.includes(query.trim()) ? 0.5 : 0;
  return Math.max(0.001, Math.min(0.999, Number((dice + exact).toFixed(6))));
}

const tokenCount = (text: string) => Math.max(1, Math.ceil([...text.trim()].length / 2));

// ── 日志：让「rdp 到底发了什么」肉眼可见 ────────────────────────────────────

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (line: string) => console.log(`\x1b[36m[${stamp()}]\x1b[0m ${line}`);

// ── 模型目录（GET）：OpenAI 与 Google 两种解析形态同时给，测试流程第一步才不会卡 ──

const CATALOG = [
  { id: "mock-embedding", name: "mock-embedding", displayName: "演示嵌入模型", type: "EMBEDDING" },
  { id: "mock-rerank", name: "mock-rerank", displayName: "演示重排模型", type: "RERANK" },
];

// ── 路由 ────────────────────────────────────────────────────────────────────

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();

  if (method === "GET") {
    log(`← GET ${path} 200（模型目录 ${CATALOG.length} 个）`);
    return json({ object: "list", data: CATALOG, models: CATALOG.map((m) => m.id), names: CATALOG.map((m) => m.id) });
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch { /* 让下面按缺字段报错，比在这儿吞掉诚实 */ }

  // /embeddings：批大小不设限，但按契约要求 input 是 string 或 string[]。
  if (/\/embeddings?$/.test(path)) {
    const rawInput = body?.input;
    const inputs = Array.isArray(rawInput) ? rawInput.map(String) : typeof rawInput === "string" ? [rawInput] : null;
    if (!body?.model || !inputs) {
      log(`→ POST ${path} 400（请求体不合契约：model / input 缺失）`);
      return json({ error: { message: "mock: expect {model, input: string|string[]}" } }, 400);
    }
    const vectors = inputs.map(embed);
    const tokens = inputs.reduce((acc, t) => acc + tokenCount(t), 0);
    log(`→ POST ${path} model=${body.model} input=${inputs.length} 条（首条 ${[...inputs[0]].length} 字） ← ${ALT ? "embeddings[][]" : "data[].embedding"} dim=${DIM} tokens=${tokens}`);
    if (ALT) return json({ object: "list", model: body.model, embeddings: vectors, usage: { total_tokens: tokens } });
    return json({
      object: "list",
      model: body.model,
      data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  }

  // /rerank 与 Cohere 风格 /v2/rerank：{model, query, documents, top_n}
  if (/\/rerank$/.test(path)) {
    const documents: string[] | null = Array.isArray(body?.documents) ? (body.documents as unknown[]).map(String) : null;
    if (!body?.model || typeof body?.query !== "string" || !documents) {
      log(`→ POST ${path} 400（请求体不合契约：model / query / documents 缺失）`);
      return json({ error: { message: "mock: expect {model, query, documents: string[], top_n?}" } }, 400);
    }
    const scored: { index: number; relevance_score: number }[] = documents
      .map((doc, index) => ({ index, relevance_score: Number(fakeScore(body.query, doc).toFixed(6)) }))
      .sort((a, b) => b.relevance_score - a.relevance_score);
    const topN = Number(body?.top_n ?? documents.length);
    const kept = Number.isFinite(topN) && topN > 0 ? scored.slice(0, topN) : scored;
    const tokens = documents.reduce((acc, t) => acc + tokenCount(t), tokenCount(body.query));
    log(`→ POST ${path} model=${body.model} query=${[...body.query].length} 字 documents=${documents.length} top_n=${body?.top_n ?? "-"} ← ${ALT ? "scores[]" : "results[]"} 首位=${kept[0]?.index}(${kept[0]?.relevance_score})`);
    if (ALT) {
      // 非标准形态：只给按输入序对齐的 scores[]，没有 results[]。
      const byIndex: number[] = documents.map((_, i) => scored.find((s) => s.index === i)?.relevance_score ?? 0);
      return json({ model: body.model, scores: byIndex, usage: { total_tokens: tokens } });
    }
    return json({ model: body.model, results: kept, usage: { total_tokens: tokens } });
  }

  log(`→ ${method} ${path} 404（本靶子只实现 /embeddings 与 /rerank）`);
  return json({ error: { message: `mock: no route for ${method} ${path}` } }, 404);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// 端口被占时不报错退出：--seed 常常是「靶子已在跑，我只是再注入一遍演示数据」的第二次调用。
let serving = true;
try {
  Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: handle });
  console.log(`\x1b[1mmock 供应商已就绪\x1b[0m  http://127.0.0.1:${PORT}/v1  ${ALT ? "[非标准响应形态]" : "[标准响应形态]"}`);
  console.log(`  在 rdp 里新建供应商时 Base URL 填：http://127.0.0.1:${PORT}/v1`);
} catch (err) {
  if (!SEED_BASE) throw err;
  serving = false;
  console.log(`端口 ${PORT} 已有靶子在监听，--seed 直接复用它（${(err as Error).name}）。`);
}

// ── --seed：把演示供应商写进一个正在跑的 rdp 实例，并当场各测一次 ──────────────

if (SEED_BASE) {
  const api = (p: string) => `${SEED_BASE}/api/${p}`;
  const post = async (p: string, body: unknown) => {
    const res = await fetch(api(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* 原样返回，打印时看得见 */ }
    return { status: res.status, parsed };
  };
  const model = (id: string, type: "EMBEDDING" | "RERANK", name: string) => ({
    id, modelId: id, displayName: name, type, manuallyAdded: true,
    inputModalities: ["text"], outputModalities: ["text"], abilities: [], tools: [],
  });
  const baseProvider = {
    type: "openai" as const, enabled: true, builtIn: false, apiKey: "mock-key-not-a-real-secret",
    baseUrl: `http://127.0.0.1:${PORT}/v1`, shortDescription: "本机演示用，零请求出网",
    description: "本地 mock，用于实机验证 /embeddings 与 /rerank 两条线路与模型检测分流。",
    balanceOption: { enabled: false, apiPath: "", resultPath: "" },
  };

  const providers = [
    { ...baseProvider, id: "demo-nonchat", name: "演示 · 嵌入与重排（本地 Mock）", models: [model("mock-embedding", "EMBEDDING", "演示嵌入 768 维"), model("mock-rerank", "RERANK", "演示重排 top_n")] },
    // google 型专门用来实机演示那条拒绝路径：不该发出任何 /embeddings 请求。
    { ...baseProvider, id: "demo-nonchat-google", type: "google" as const, name: "演示 · Google 型（应被拒绝）", models: [model("mock-embedding", "EMBEDDING", "演示嵌入（google 型）")] },
  ];

  for (const p of providers) {
    const saved = await post("settings/provider", p);
    console.log(`  注入供应商 ${p.id} → HTTP ${saved.status}`);
    for (const m of p.models) {
      const tested = await post("settings/provider/test", { providerId: p.id, modelId: m.id });
      const checks = (tested.parsed as any)?.checks ?? [];
      console.log(`    检测 ${m.id}（${m.type}）→ HTTP ${tested.status}`);
      for (const c of checks) {
        console.log(`      · mode=${c.mode} ok=${c.ok} status=${c.status}`);
        console.log(`        endpoint ${c.endpoint}`);
        console.log(`        preview   ${String(c.preview ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
      }
      if (!checks.length) console.log(`      · 无 checks，返回体：${JSON.stringify(tested.parsed).slice(0, 240)}`);
    }
  }
  console.log(`\n  打开 ${SEED_BASE} → 设置 › 模型供应商，就能看到这两个演示供应商和它们的检测结果。`);
  console.log(serving ? "  Ctrl+C 结束靶子与日志输出。" : `  靶子仍在 :${PORT} 监听（另一次调用），日志在那边。`);
}
