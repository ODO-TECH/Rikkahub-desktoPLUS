// conversations/pi-route.test.ts — generateAnswer 路由切换端到端(P3;P7 改 unified 断言)
//
// 钉住编排器的三条 P3 不变式(方案 §六),P7 起观测点从 jsonl 换成会话行数据:
//   1) 工作区会话 → pi 引擎:回答落 parts、保真注解(pi-fidelity)落消息、上下文从
//      DB 历史灌注回放(上游请求体携带历史即硬证据)、压缩记录字段就位;
//   2) 非工作区会话 → 聊天引擎原路(同一编排器入口,零 pi 痕迹);
//   3) 审批 API 全链路:pending 时生成保持在跑,POST tool-approval 原地放行,
//      不重触发生成(上游请求数不涨即硬证据)。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-piroute-test-"));

const conversations = await import("./index");
const { configureWorkingSet, registerConversation } = await import("./working-set");
const { getConversationMeta } = await import("./read-queries");
const { compressing, generating } = await import("./generation-state");
const { compactEngineConversation, generateAnswer, resolveEngineForConversation } = await import("./orchestrator");
const ws = await import("../workspace");
const { defaultAssistant } = await import("../assistants");
const { defaultState } = await import("../app-config/defaults");
const { setState, state } = await import("../persistence/json-store");
// 解构的 state 固化 import 时刻的值(setState 整体换对象后即 stale);命名空间对象的
// 属性访问是 live 的,需要读"当前 state"的测试用 jsonStore.state。
const jsonStore = await import("../persistence/json-store");
const { model, provider } = await import("../model-providers");
const { pendingToolApprovalCount } = await import("../inference-engine/approval-gate");
const { handleConversationRoutes } = await import("../api/handlers/conversations");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
const providers = await import("../inference-engine/providers");

import type { Conversation, State } from "../foundation/types";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../test-utils/fake-openai-sse";
import { DEFAULT_OUTPUT_TOKENS } from "../model-providers/request-dialect";

const priorState = state;
const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: (id) => generating.has(id),
  hasSseClients: () => false,
  hasDirty: () => false,
});

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  setState(priorState);
  await Promise.all(servers.map((server) => server.close()));
});

/** 每用例独立假上游 + 独立 state(chatModelId 指向该上游),脚本互不串扰。
 *  reasoningModel:给模型标 REASONING 能力(pi 侧映射 reasoning=true)——请求口径
 *  回归用(推理模型才触发 pi 的 developer 角色分支,见 model-bridge compat 覆盖)。
 *  maxTokens/systemPrompt:写进助手配置,跨引擎方言平价用例用(两引擎读同一配置)。 */
async function installUpstream(turns: FakeSseTurn[], opts?: { reasoningModel?: boolean; maxTokens?: number; systemPrompt?: string; reasoningLevel?: string; modelId?: string }) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const ourModel = model(opts?.modelId ?? "fake-model", "Route Test Model");
  if (opts?.reasoningModel) ourModel.abilities.push("REASONING");
  const ourProvider = provider({
    id: crypto.randomUUID(),
    name: "Route Test Provider",
    baseUrl: server.baseUrl,
    apiKey: "sk-test",
    enabled: true,
    models: [ourModel],
  });
  const next = defaultState();
  next.settings.assistantId = "a1";
  next.settings.assistants = [{
    ...defaultAssistant(),
    id: "a1",
    name: "route-e2e",
    ...(opts?.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
    ...(opts?.systemPrompt != null ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts?.reasoningLevel != null ? { reasoningLevel: opts.reasoningLevel } : {}),
  }];
  next.settings.providers = [ourProvider];
  next.settings.chatModelId = ourModel.id;
  // 关闭标题/建议等后台任务(快速模型置空),让测试只关注主生成路径。
  next.settings.fastModelId = "";
  setState(next as State);
  return server;
}

/** 写入一份最小 models.dev 目录并加载:自动压缩的阈值来自模型真实窗口,测试必须
 *  给一个确定的数(而不是依赖本机 pc-data 缓存或外网)。qwen-max 走一线厂商
 *  alibaba 键命中——与 demo 的零成本触发手法同源。
 *
 *  注意:测试进程里 paths 的 dataDir 由"首个 import 它的文件"固化(bunfig 预载或
 *  别的测试文件),本文件自设的 RIKKAHUB_PC_DATA_DIR 在合跑时不一定是它;而且别的
 *  文件可能已把完整目录加载进内存,loadModelsDev() 会直接命中内存、根本不再读盘。
 *  所以这里写**实际解析到的**缓存路径,并用临时 fetch 剧本 + force 刷新——force 必须
 *  走 fetch,不换剧本就会真外联 models.dev。 */
async function installModelCatalog() {
  const catalog = JSON.stringify({
    alibaba: {
      api: "https://dashscope.aliyuncs.com",
      models: { "qwen-max": { limit: { context: 32768, output: 8192 } } },
    },
  });
  const paths = await import("../foundation/paths");
  writeFileSync(paths.MODELS_DEV_CACHE_PATH, catalog);
  // 先排掉可能在途的加载(modelsDevLoading 去重会让 force 也复用它)。
  await providers.loadModelsDev();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(catalog, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  try {
    await providers.loadModelsDev(true);
  } finally {
    globalThis.fetch = realFetch;
  }
}

let seq = 0;
/** 追加一条 USER 消息节点(第二轮 prompt),返回该消息(断言/灌注校验用)。 */
function appendUserNode(conversation: Conversation, text: string) {
  const msg = {
    id: `piroute-m-u${seq}-${conversation.messages.length}`,
    role: "USER",
    parts: [{ type: "text", text }],
    annotations: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
    translation: null,
  };
  conversation.messages.push({ id: `piroute-n-u${seq}-${conversation.messages.length}`, selectIndex: 0, messages: [msg] } as never);
  return msg as unknown as Conversation["messages"][number]["messages"][number];
}

function seedConversation(workspaceId: string | null): Conversation {
  seq += 1;
  const now = Date.now();
  const conversation = {
    id: `piroute-conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `已命名会话 ${seq}`,
    messages: [
      {
        id: `piroute-n-${seq}`,
        selectIndex: 0,
        messages: [
          {
            id: `piroute-m-${seq}`,
            role: "USER",
            parts: [{ type: "text", text: "请干活" }],
            annotations: [],
            createdAt: new Date(now).toISOString(),
            finishedAt: null,
            translation: null,
          },
        ],
      },
    ],
    chatSuggestions: [],
    isPinned: false,
    createAt: now,
    updateAt: now,
    ...(workspaceId ? { workspaceId } : {}),
  } as unknown as Conversation;
  conversations.persistConversation(conversation);
  registerConversation(conversation);
  return conversation;
}

function lastAssistantMessage(conversation: Conversation) {
  const node = conversation.messages[conversation.messages.length - 1]!;
  return node.messages[node.selectIndex] ?? node.messages[0]!;
}

function partsText(conversation: Conversation): string {
  return (lastAssistantMessage(conversation).parts as Array<{ type?: string; text?: string }>)
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("generateAnswer P3 路由", () => {
  test("工作区会话走 pi 引擎:回答落 parts,保真注解落消息,上下文从 DB 灌注回放", async () => {
    const server = await installUpstream([{ content: "工作区回答" }, { content: "第二轮工作区回答" }]);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-pi" });
    const conversation = seedConversation(workspace.id);
    await generateAnswer(conversation);

    const answer = lastAssistantMessage(conversation);
    expect(partsText(conversation)).toContain("工作区回答");
    expect(answer.finishedAt).not.toBeNull();
    // P7:引擎保真注解(P7 桥捕获)落在回答消息上——下一轮编码器靠它无损重建引擎消息。
    const fidelity = (answer.annotations ?? []).find(
      (item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "pi-fidelity",
    ) as { messages?: unknown } | undefined;
    expect(Array.isArray(fidelity?.messages)).toBe(true);
    // P7/T3:压缩记录字段就位(未触发自动压缩时保持 null——语义即"无压缩记录")。
    expect(conversation.engineCompactions ?? null).toBeNull();
    expect(getConversationMeta(db, conversation.id)?.engineCompactions ?? null).toBeNull();
    expect(generating.has(conversation.id)).toBe(false);

    // P7 灌注回放硬证据:追加第二轮用户消息再生成,上游第二请求必须携带
    // 第一轮的 prompt 与回答(历史从 DB 重建进引擎上下文,而不是靠 jsonl)。
    appendUserNode(conversation, "接着干活");
    await generateAnswer(conversation);
    expect(partsText(conversation)).toContain("第二轮工作区回答");
    const secondRequest = server.requests[1] as { messages?: Array<{ role: string; content?: unknown }> };
    const serialized = JSON.stringify(secondRequest?.messages ?? []);
    expect(serialized).toContain("请干活");
    expect(serialized).toContain("工作区回答");
    expect(serialized).toContain("接着干活");
  }, 30_000);

  test("推理模型的工作区请求:系统提示词恒 system 角色 + 上限恒 max_tokens(2.0.0 内测缺陷回归)", async () => {
    // 复现内测环境:第三方 OpenAI 兼容端点(假上游即"未知 baseUrl")+ 标 REASONING 的
    // 模型。修复前 pi 的 compat 自动探测按官方 OpenAI 假设:1)系统消息以 "developer"
    // 角色发出——DashScope 类 400 拒角色、火山方舟报 missing input.role;2)输出上限发
    // max_completion_tokens——第三方端点静默忽略未知字段,上限失效。修复(model-bridge
    // piCompatOverridesFor)后与聊天引擎同发 "system" + max_tokens。断言真实出站请求体,
    // 锁两引擎请求口径一致。
    const server = await installUpstream([{ content: "推理模型工作区回答" }], { reasoningModel: true });
    const workspace = ws.createWorkspace({ type: "managed", name: "route-reasoning-role" });
    const conversation = seedConversation(workspace.id);
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("推理模型工作区回答");
    const request = server.requests[0] as {
      messages?: Array<{ role?: string }>;
      max_tokens?: number;
      max_completion_tokens?: number;
    };
    const roles = (request?.messages ?? []).map((item) => item.role ?? "");
    expect(roles.length).toBeGreaterThan(0);
    expect(roles).toContain("system");
    expect(roles).not.toContain("developer");
    expect(request?.max_completion_tokens).toBeUndefined();
    // 上限**数值**也要锁死,不能只锁"大于 0"。pi 的模型配置要求必须给出 maxTokens
    // (ProviderConfigInput.models[].maxTokens 是必填 number,且 buildBaseOptions 用
    // `options?.maxTokens ?? model.maxTokens` 兜底),所以工作区恒发这个字段——这是与
    // 聊天引擎的**已知结构性差异**:OpenAI 兼容协议下上限可省略,聊天引擎在用户未配置时
    // 就不发。既然省不掉,数值就必须来自 requiredOutputCap 单源。假上游是未知 host、
    // 测试环境无 models.dev 缓存,故落方言兜底 DEFAULT_OUTPUT_TOKENS。
    // 若将来有人让脏目录值或魔数漏进这条路(2026-09-09 GLM-5.3 1210 报障的形态),此断言先红。
    expect(request?.max_tokens).toBe(DEFAULT_OUTPUT_TOKENS);
  }, 30_000);

  test("跨引擎请求方言平价:chat 与 pi 对同一第三方上游,系统角色/上限字段/上限数值逐字一致(T4.7)", async () => {
    // 统一请求方言(model-providers/request-dialect)的层3回归:同一助手配置
    // (maxTokens=1024 + 系统提示词)驱动两个引擎打同一个假上游,断言真实出站请求体的
    // 方言字段完全一致——聊天引擎由构建体直接消费方言,pi 经 model-bridge compat 翻译,
    // 两条翻译路径必须收敛到同一字节。任一引擎将来漂移(如 pi 升级改探测默认),此测试先红。
    const server = await installUpstream(
      [{ content: "chat 侧回答" }, { content: "pi 侧回答" }],
      { reasoningModel: true, maxTokens: 1024, systemPrompt: "平价测试系统提示词", reasoningLevel: "MAX" },
    );
    const chatConversation = seedConversation(null);
    await generateAnswer(chatConversation);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-dialect-parity" });
    const piConversation = seedConversation(workspace.id);
    await generateAnswer(piConversation);

    expect(partsText(chatConversation)).toContain("chat 侧回答");
    expect(partsText(piConversation)).toContain("pi 侧回答");
    expect(server.requests.length).toBe(2);
    for (const request of server.requests as Array<{
      messages?: Array<{ role?: string }>;
      max_tokens?: number;
      max_completion_tokens?: number;
      reasoning_effort?: string;
      store?: boolean;
    }>) {
      const roles = (request.messages ?? []).map((item) => item.role ?? "");
      expect(roles).toContain("system");
      expect(roles).not.toContain("developer");
      expect(request.max_completion_tokens).toBeUndefined();
      expect(request.max_tokens).toBe(1024);
      // 档位平价:MAX 两引擎逐字同值(pi 对 xhigh/max 默认 clamp 到 high,
      // model-bridge 登记同名映射放行;engine-request-diff 实证修复)。
      expect(request.reasoning_effort).toBe("max");
      // store 平价:聊天引擎从不发,pi 经 supportsStore:false 压制。
      expect(request.store).toBeUndefined();
    }
  }, 30_000);

  test("助手未配置上限时:OpenAI 兼容协议下聊天引擎**不发**上限字段(2026-09-09 1210 报障纪律)", async () => {
    // 能省则省:OpenAI completions/responses 与 Google 的上限字段是可选的,不发 =
    // 用服务端默认 = 恒合法;发一个"我们猜的数"才是 400 的来源(报障即此)。
    // 安卓同语义(ChatCompletionsAPI.kt `if (params.maxTokens != null) put(...)`)。
    // Anthropic 协议例外——max_tokens 是必填,那条路由 requiredOutputCap 给真值,
    // 由 model-providers/model-limits.test.ts 覆盖。
    const server = await installUpstream([{ content: "无上限配置回答" }]);
    const conversation = seedConversation(null);
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("无上限配置回答");
    const request = server.requests[0] as { max_tokens?: number; max_completion_tokens?: number };
    expect(request.max_tokens).toBeUndefined();
    expect(request.max_completion_tokens).toBeUndefined();
  }, 30_000);

  test("非工作区会话走聊天引擎原路:零 pi 痕迹", async () => {
    const server = await installUpstream([{ content: "聊天回答" }]);
    const conversation = seedConversation(null);
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("聊天回答");
    // 普通生成不产生压缩记录(聊天引擎只在用户手动压缩时写,见本文件压缩用例),
    // 保真注解也不会出现。
    expect(conversation.engineCompactions).toBeUndefined();
    const answer = lastAssistantMessage(conversation);
    expect((answer.annotations ?? []).some(
      (item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "pi-fidelity",
    )).toBe(false);
    // 聊天引擎请求体特征:messages 含系统提示词(pi 路径的系统提示词是 pi 自建格式)。
    expect(server.requests.length).toBe(1);
  }, 30_000);

  test("审批 API 全链路:pending 原地放行,生成不重触发,文件落盘", async () => {
    const server = await installUpstream([
      { toolCalls: [{ id: "tc-route-w", name: "write", arguments: JSON.stringify({ path: "gated.txt", content: "via-api" }) }] },
      { content: "写完了" },
    ]);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-approval" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    const conversation = seedConversation(workspace.id);

    const generation = generateAnswer(conversation);
    await waitUntil(() => pendingToolApprovalCount() === 1);

    const url = new URL(`http://localhost/api/conversations/${conversation.id}/tool-approval`);
    const response = await handleConversationRoutes(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolCallId: "tc-route-w", approved: true }),
      }),
      url,
      `conversations/${conversation.id}/tool-approval`,
    );
    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ status: "accepted" });

    await generation;
    expect(readFileSync(join(workspace.root, "gated.txt"), "utf-8")).toBe("via-api");
    expect(partsText(conversation)).toContain("写完了");
    // 不重触发的硬证据:上游只收到两轮请求(工具轮 + 终局轮),没有第三次生成。
    expect(server.requests.length).toBe(2);
    const toolPart = (lastAssistantMessage(conversation).parts as Array<Record<string, unknown>>)
      .find((part) => part.type === "tool" && part.toolCallId === "tc-route-w") as
      | { approvalState?: { type?: string } }
      | undefined;
    expect(toolPart?.approvalState?.type).toBe("approved");
    expect(pendingToolApprovalCount()).toBe(0);
    expect(generating.has(conversation.id)).toBe(false);
  }, 30_000);
});

describe("引擎判定单源(审批旁路/压缩路由收编)", () => {
  test("resolveEngineForConversation:工作区会话命中 pi,普通会话落 chat 兜底", async () => {
    await installUpstream([{ content: "未使用" }]);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-resolve" });

    // 审批端点(tool-approval)据 resumeSemantics 决定"记录状态"还是"重触发续跑",
    // 压缩端点据 compact 有无决定"引擎压缩"还是"回落 UI 历史压缩"——这里锁死两个
    // 引擎的声明,防止 adapter 改动悄悄改变端点行为。
    const piAdapter = resolveEngineForConversation(seedConversation(workspace.id));
    expect(piAdapter.kind).toBe("pi");
    expect(piAdapter.resumeSemantics).toBe("run-and-suspend");
    expect(typeof piAdapter.compact).toBe("function");
    // steering 能力声明:两个引擎都在真边界调 onSteerBoundary(pi=turn_end,chat=工具轮/最终轮),
    // 协调器据此下发回调;声明改成 "none" 会让编排层不再下发,补发退化为收尾派发。
    expect(piAdapter.steering).toBe("boundary");

    const chatAdapter = resolveEngineForConversation(seedConversation(null));
    expect(chatAdapter.kind).toBe("chat");
    expect(chatAdapter.resumeSemantics).toBe("pause-resume");
    expect(chatAdapter.compact).toBeUndefined();
    expect(chatAdapter.steering).toBe("boundary");
  }, 30_000);

  test("compactEngineConversation:普通会话回落(null),工作区会话穿透到 pi 压缩驱动", async () => {
    await installUpstream([{ content: "未使用" }]);
    // chat 无 compact 能力 → null,调用方(compress 端点)回落 UI 历史压缩。
    expect(await compactEngineConversation(seedConversation(null), "")).toBeNull();

    // 工作区会话:注册表命中 pi adapter → runtime 透传 → 压缩装配(富化/资源)→
    // pi session.compact。小会话在发起任何模型请求前抛"上下文过短"(runner 映射成
    // CodedError 人话)——该错误文本即"路由穿透到引擎压缩驱动"的硬证据,且全程无上游请求。
    const workspace = ws.createWorkspace({ type: "managed", name: "route-compact" });
    const conversation = seedConversation(workspace.id);
    await expect(compactEngineConversation(conversation, "")).rejects.toThrow("当前会话上下文过短");

    // 端点面(错误码通道):compress 返回 400 + errorCode,前端按码查 i18n 文案。
    registerConversation(conversation);
    const url = new URL(`http://localhost/api/conversations/${conversation.id}/compress`);
    const response = await handleConversationRoutes(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ additionalPrompt: "" }),
      }),
      url,
      `conversations/${conversation.id}/compress`,
    );
    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { error: string; errorCode?: string };
    expect(body.errorCode).toBe("compact_context_too_short");
    expect(body.error).toContain("当前会话上下文过短");
  }, 30_000);

  test("compactEngineConversation:大会话(超 keepRecentTokens 预算)压缩成功返回摘要", async () => {
    // 内测反馈(/compact 测试):工作区小会话必报"上下文过短"——那是 pi 上游语义
    // (手动 compact 保留最近 keepRecentTokens 预算,只压更早历史;不足预算即无可
    // 压内容;手动压缩预算已调低为 MANUAL_COMPACT_KEEP_RECENT_TOKENS=2000,中文
    // chars/4 低估 rationale 见 runner.ts)。本用例钉住"预算之上必须可压":灌注远超
    // 预算(chars/4 估算)的多轮历史,穿透 pi session.compact 到假上游取摘要,成功
    // 返回。若灌注条目形态漂移导致 pi 估算不识别(token 记 0),会退化成"无论多大
    // 都报过短",本用例即时暴露。
    // 两份脚本:压缩预算 2000 时切点可能落在轮中间(isSplitTurn),pi 会额外发一次
    // turn prefix 摘要请求——主摘要+前缀摘要给同文本,断言与切点形态解耦。
    const server = await installUpstream([
      { content: "早期历史的压缩摘要。" },
      { content: "早期历史的压缩摘要。" },
    ]);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-compact-large" });
    const conversation = seedConversation(workspace.id);
    // 6 轮 user/assistant,每条 2 万字符 ≈ 5000 token,合计 ≈ 6 万 token >> 20000 预算。
    for (let round = 0; round < 6; round++) {
      const filler = `第${round}轮长历史。`.repeat(2000);
      appendUserNode(conversation, filler);
      conversation.messages.push({
        id: `piroute-n-a${seq}-${conversation.messages.length}`,
        selectIndex: 0,
        messages: [{
          id: `piroute-m-a${seq}-${conversation.messages.length}`,
          role: "ASSISTANT",
          parts: [{ type: "text", text: filler }],
          annotations: [],
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          translation: null,
        }],
      } as never);
    }
    const result = await compactEngineConversation(conversation, "");
    expect(result).not.toBeNull();
    expect(result!.engine).toBe("pi");
    expect(result!.summary).toContain("早期历史的压缩摘要");
    expect(result!.tokensBefore).toBeGreaterThan(20_000);
    // 摘要请求确实打到了上游(区别于小会话零请求即抛错);split turn 时多一次前缀摘要。
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
    // 压缩发生点注解落在"当时的最新一条消息"(工作区路径经 applyCapturedEngineCompactions)。
    const tail = conversation.messages.at(-1)!;
    expect(tail.messages[tail.selectIndex].annotations).toContainEqual({ type: "compaction_boundary" });
  }, 60_000);

  test("D2:pi 压缩期间导入运行态 → 拒绝返回成功且不落压缩记录", async () => {
    // settings-only 导入只替换运行态、不重灌活库——正是"旧实例压完想写回同一 id"的最险窗口。
    const { applyBackupPayload } = await import("../backup/import");
    let importDone = false;
    const server = await installUpstream([
      {
        content: "早期历史的压缩摘要。",
        beforeRespond: () => {
          applyBackupPayload({ settings: JSON.parse(JSON.stringify(jsonStore.state.settings)) });
          importDone = true;
        },
      },
      // 切点落在轮中间时 pi 会额外发一次前缀摘要请求;给足剧本,让"导入后的作废判定"
      // 成为唯一失败原因(而不是脚本耗尽)。
      { content: "早期历史的压缩摘要。" },
    ]);
    const workspace = ws.createWorkspace({ type: "managed", name: "route-compact-import" });
    const conversation = seedConversation(workspace.id);
    for (let round = 0; round < 6; round++) {
      const filler = `第${round}轮长历史。`.repeat(2000);
      appendUserNode(conversation, filler);
      conversation.messages.push({
        id: `piroute-n-ai${seq}-${conversation.messages.length}`,
        selectIndex: 0,
        messages: [{
          id: `piroute-m-ai${seq}-${conversation.messages.length}`,
          role: "ASSISTANT",
          parts: [{ type: "text", text: filler }],
          annotations: [],
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          translation: null,
        }],
      } as never);
    }

    await expect(compactEngineConversation(conversation, "")).rejects.toThrow("运行态已在");
    expect(importDone).toBe(true);
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
    // 旧实例的压缩记录没有借脏标记/直写落进导入后的会话行。
    expect(getConversationMeta(db, conversation.id)?.engineCompactions ?? null).toBeNull();
  }, 60_000);
});

// 压缩模型公共化:「设置 → 模型 → 场景模型」是公共基础设施,配置的压缩模型对所有
// 引擎生效——pi 的摘要生成也用它(此前 pi 压缩只认会话模型,compressModelId 仅在
// chat 引擎的 UI 历史压缩生效)。窗口锚定/富化裁决仍按会话模型(压缩对象的视角)。
describe("压缩模型公共化(summarizer 装配)", () => {
  function fillLargeHistory(conversation: Conversation) {
    // 远超手动压缩保留预算(MANUAL_COMPACT_KEEP_RECENT_TOKENS=2000,pi chars/4 口径)。
    for (let round = 0; round < 6; round++) {
      const filler = `第${round}轮长历史。`.repeat(2000);
      appendUserNode(conversation, filler);
      conversation.messages.push({
        id: `piroute-n-a${seq}-${conversation.messages.length}`,
        selectIndex: 0,
        messages: [{
          id: `piroute-m-a${seq}-${conversation.messages.length}`,
          role: "ASSISTANT",
          parts: [{ type: "text", text: filler }],
          annotations: [],
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          translation: null,
        }],
      } as never);
    }
  }

  test("配置压缩模型 → pi 摘要请求全部用压缩模型(非会话模型)", async () => {
    const server = await installUpstream([
      { content: "压缩模型产出的摘要。" },
      { content: "压缩模型产出的摘要。" },
    ]);
    // 同 provider 下第二个模型作为公共压缩模型(openai 型标准路径,可映射进 pi)。
    const compressModel = model("compress-model", "Compress Model");
    jsonStore.state.settings.providers[0]!.models.push(compressModel);
    jsonStore.state.settings.compressModelId = compressModel.id;
    const workspace = ws.createWorkspace({ type: "managed", name: "route-compact-summarizer" });
    const conversation = seedConversation(workspace.id);
    fillLargeHistory(conversation);
    const result = await compactEngineConversation(conversation, "");
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("压缩模型产出的摘要");
    // 主摘要与可能的分裂回合前缀摘要,所有上游请求都应打在压缩模型上。
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
    for (const request of server.requests) {
      expect(request.model).toBe("compress-model");
    }
  }, 60_000);

  test("压缩模型映射不进 pi(自定义补全路径) → 回退会话模型,压缩照常完成", async () => {
    const server = await installUpstream([
      { content: "会话模型产出的摘要。" },
      { content: "会话模型产出的摘要。" },
    ]);
    // 自定义 chatCompletionsPath 的 openai 型服务商:聊天引擎可用,pi 映射拒绝
    // (其 OpenAI 客户端固定 /chat/completions)——正是"公共设置是偏好不是硬约束"
    // 要兜住的场景。
    const unmappable = model("unmappable-model", "Custom Path Model");
    jsonStore.state.settings.providers.push(provider({
      id: crypto.randomUUID(),
      name: "Custom Path Provider",
      baseUrl: server.baseUrl,
      apiKey: "sk-test",
      enabled: true,
      chatCompletionsPath: "/v1/custom/completions",
      models: [unmappable],
    }));
    jsonStore.state.settings.compressModelId = unmappable.id;
    const workspace = ws.createWorkspace({ type: "managed", name: "route-compact-fallback" });
    const conversation = seedConversation(workspace.id);
    fillLargeHistory(conversation);
    const result = await compactEngineConversation(conversation, "");
    expect(result).not.toBeNull();
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
    for (const request of server.requests) {
      expect(request.model).toBe("fake-model");
    }
  }, 60_000);
});

// 内测反馈两连修:①310K"少而长"会话 /compact 报"消息数量不足"——按条数保留的语义
// 对少而长会话不成立,改为条数不足时自动降级保留一半;②切页回来"过程条消失"且互斥
// 失忆——压缩状态改服务端权威(compressing 集合 + engine-status 广播 + SSE 连接期快照),
// 并发第二个压缩被 409 挡住。
describe("压缩状态服务端权威 + 保留条数降级", () => {
  async function postCompress(conversationId: string, body: object = {}) {
    const url = new URL(`http://localhost/api/conversations/${conversationId}/compress`);
    return handleConversationRoutes(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      url,
      `conversations/${conversationId}/compress`,
    );
  }

  async function postPin(conversationId: string, messageId: string, pinned: boolean) {
    const url = new URL(`http://localhost/api/conversations/${conversationId}/messages/${messageId}/pin`);
    return handleConversationRoutes(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned }),
      }),
      url,
      `conversations/${conversationId}/messages/${messageId}/pin`,
    );
  }

  test("对话模式少而长会话:条数不足默认保留 32 时自动降级为压一半,不再报'消息数量不足'", async () => {
    await installUpstream([{ content: "早期历史的压缩摘要。" }]);
    const conversation = seedConversation(null);
    // 共 6 条消息(远少于默认保留 32 条),每条都很长——修复前直接 400"消息数量不足"。
    for (let round = 0; round < 5; round++) {
      appendUserNode(conversation, `第${round}轮超长消息。`.repeat(500));
    }
    const response = await postCompress(conversation.id);
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { status: string };
    expect(body.status).toBe("compressed");
    // 非破坏性语义:6 条原文一条不删,压缩只追加一条会话级记录。
    expect(conversation.messages.length).toBe(6);
    const records = conversation.engineCompactions as Array<{ cutMessageId: string; summary: string; tokensBefore: number }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.summary).toContain("早期历史的压缩摘要");
    expect(records[0]!.tokensBefore).toBeGreaterThan(0);
    // 降级语义:floor(6/2)=3 条保留原文 → 切点是第 4 条(index 3);
    // 分割线锚在切点前一条(index 2)下方,切点行本身不带标记。
    expect(records[0]!.cutMessageId).toBe(conversation.messages[3]!.messages[0]!.id);
    expect(conversation.messages[2]!.messages[0]!.annotations).toContainEqual({ type: "compaction_cut" });
    expect(conversation.messages[3]!.messages[0]!.annotations ?? []).not.toContainEqual({ type: "compaction_cut" });
    // 旧破坏式标记不再产生(没有摘要节点,历史不存在第二副本)。
    expect(JSON.stringify(conversation.messages)).not.toContain("compaction_boundary");
    // 记录落库(单一事实源):重开库也能读到同一份压缩状态。
    const meta = getConversationMeta(db, conversation.id);
    expect((meta?.engineCompactions as Array<{ summary: string }> | null)?.[0]?.summary).toContain("早期历史的压缩摘要");
    // 结束后服务端压缩态归零(finally 清理)。
    expect(compressing.has(conversation.id)).toBe(false);
  }, 30_000);

  test("压缩后的下一轮生成:上游只收到摘要 + 切点后原文,切点前的原文不再进提示词", async () => {
    const server = await installUpstream([
      { content: "早期历史的压缩摘要。" },
      { content: "压缩后的回答" },
    ]);
    const conversation = seedConversation(null);
    for (let round = 0; round < 5; round++) {
      appendUserNode(conversation, `第${round}轮历史。`.repeat(200));
    }
    // 保留 2 条 → 第 0~3 条进摘要,切点落在 index 4。
    const compressed = await postCompress(conversation.id, { keepRecentMessages: 2 });
    expect(compressed?.status).toBe(200);

    appendUserNode(conversation, "压缩后的新问题");
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("压缩后的回答");
    const request = server.requests[1] as { messages?: Array<{ role?: string; content?: unknown }> };
    const serialized = JSON.stringify(request?.messages ?? []);
    // 摘要以合成 USER 行注入序列最前(记忆边界对上游可见)。
    expect(serialized).toContain("context_summary");
    expect(serialized).toContain("早期历史的压缩摘要");
    expect(serialized).toContain("压缩后的新问题");
    // 切点(index 4 = "第3轮")及之后的原文逐字在场;切点之前的被摘要取代,绝不再发。
    expect(serialized).toContain("第3轮历史");
    expect(serialized).toContain("第4轮历史");
    expect(serialized).not.toContain("第0轮历史");
    expect(serialized).not.toContain("第2轮历史");
  }, 30_000);

  test("链式压缩:第二次只压新增段,新摘要带上旧摘要(否则早期上下文整段丢失)", async () => {
    await installUpstream([
      { content: "第一次摘要。" },
      { content: "第二次摘要。" },
    ]);
    const conversation = seedConversation(null);
    for (let round = 0; round < 5; round++) {
      appendUserNode(conversation, `第${round}轮历史。`.repeat(200));
    }
    expect((await postCompress(conversation.id, { keepRecentMessages: 2 }))?.status).toBe(200);
    // 新增两轮后再次压缩:compressible 从旧切点起算,只压"还没被摘要吸收"的段。
    appendUserNode(conversation, "第一轮新内容。".repeat(200));
    appendUserNode(conversation, "第二轮新内容。".repeat(200));
    expect((await postCompress(conversation.id, { keepRecentMessages: 1 }))?.status).toBe(200);

    const records = conversation.engineCompactions as Array<{ cutMessageId: string; summary: string }>;
    expect(records).toHaveLength(2);
    const latest = records[1]!;
    expect(latest.summary).toContain("第一次摘要");
    expect(latest.summary).toContain("第二次摘要");
    // 最新切点是最后一条(保留 1 条);旧切点标记被清除,界面只留一条记忆边界线。
    expect(latest.cutMessageId).toBe(conversation.messages.at(-1)!.messages[0]!.id);
    const cutAnnotations = conversation.messages.flatMap((node) =>
      node.messages.flatMap((msg) => (msg.annotations ?? []).filter((a) => (a as { type?: string }).type === "compaction_cut")),
    );
    expect(cutAnnotations).toHaveLength(1);
    expect(conversation.messages.at(-2)!.messages[0]!.annotations).toContainEqual({ type: "compaction_cut" });
  }, 30_000);

  test("摘要超预算:链式摘要走二次浓缩,只把摘要本身再喂给模型", async () => {
    const longSummary = "很长的压缩摘要。".repeat(800);
    const server = await installUpstream([
      { content: longSummary },
      { content: "二次浓缩后的摘要。" },
    ]);
    const conversation = seedConversation(null);
    for (let round = 0; round < 5; round++) {
      appendUserNode(conversation, `第${round}轮历史。`.repeat(200));
    }
    // 目标 256 → 预算 max(1024, 512)。长摘要约 5k tokens,必然触发二次浓缩。
    const response = await postCompress(conversation.id, { targetTokens: 256, keepRecentMessages: 2 });
    expect(response?.status).toBe(200);
    expect(server.requests).toHaveLength(2);
    // 第二次请求的输入是"摘要再浓缩"提示词 + 上一轮摘要,不是会话原文。
    const secondRequest = JSON.stringify(server.requests[1]?.messages ?? []);
    expect(secondRequest).toContain("<summary>");
    expect(secondRequest).toContain("很长的压缩摘要");
    expect(secondRequest).not.toContain("第0轮历史");
    const records = conversation.engineCompactions as Array<{ summary: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.summary).toBe("二次浓缩后的摘要。");
  }, 30_000);

  test("二次浓缩失败不毁主压缩:保留链式摘要并正常落库", async () => {
    const longSummary = "很长的压缩摘要。".repeat(800);
    // 只给一轮剧本:第二次(浓缩)请求由假上游返回 500。
    const server = await installUpstream([{ content: longSummary }]);
    const conversation = seedConversation(null);
    for (let round = 0; round < 5; round++) {
      appendUserNode(conversation, `第${round}轮历史。`.repeat(200));
    }
    const response = await postCompress(conversation.id, { targetTokens: 256, keepRecentMessages: 2 });
    expect(response?.status).toBe(200);
    // 流式失败后辅助调用会回落一次非流式,所以浓缩尝试可能是 1~2 次请求;至少要发生。
    expect(server.requests.length).toBeGreaterThan(1);
    const records = conversation.engineCompactions as Array<{ summary: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.summary).toContain("很长的压缩摘要");
  }, 30_000);

  test("keepRecentMessages=0(尽量压)仍保留 1 条做切点锚点,不产生空压缩", async () => {
    await installUpstream([{ content: "全量摘要。" }]);
    const conversation = seedConversation(null);
    for (let round = 0; round < 5; round++) {
      appendUserNode(conversation, `第${round}轮历史。`.repeat(200));
    }
    const response = await postCompress(conversation.id, { keepRecentMessages: 0 });
    expect(response?.status).toBe(200);
    expect(conversation.messages.length).toBe(6);
    const records = conversation.engineCompactions as Array<{ cutMessageId: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.cutMessageId).toBe(conversation.messages.at(-1)!.messages[0]!.id);
  }, 30_000);


  test("阶段三:开关开启且越过阈值 → 生成前自动压缩一次,请求只带摘要+切点后原文", async () => {
    await installModelCatalog();
    const server = await installUpstream(
      [{ content: "自动压缩摘要。" }, { content: "自动压缩后的回答" }],
      { modelId: "qwen-max" },
    );
    jsonStore.state.settings.chatAutoCompact = true;
    const conversation = seedConversation(null);
    // 12 轮 × 2000 字 ≈ 1.97 万 token > 32768 − 16384 阈值;仍远小于 32768 窗口。
    for (let round = 0; round < 12; round++) {
      appendUserNode(conversation, `第${round}轮超长历史。`.repeat(250));
    }
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("自动压缩后的回答");
    // 非破坏性:13 条原文一条不删(另加本轮助手回答 = 14),只追加一条压缩记录;
    // 压缩与生成各一次上游请求。
    expect(conversation.messages.length).toBe(14);
    const records = conversation.engineCompactions as Array<{ cutMessageId: string; summary: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.summary).toContain("自动压缩摘要");
    expect(server.requests).toHaveLength(2);

    // 保留 ceil(13×0.25)=4 条 → 前 9 条进摘要;切点后第 8~11 轮逐字可见。
    const summarizer = JSON.stringify(server.requests[0]?.messages ?? []);
    expect(summarizer).toContain("第0轮超长历史");
    expect(summarizer).toContain("第7轮超长历史");
    const generation = JSON.stringify(server.requests[1]?.messages ?? []);
    expect(generation).toContain("context_summary");
    expect(generation).toContain("自动压缩摘要");
    expect(generation).toContain("第8轮超长历史");
    expect(generation).toContain("第11轮超长历史");
    expect(generation).not.toContain("第0轮超长历史");
    expect(generation).not.toContain("第7轮超长历史");
    // 结束后服务端压缩态归零。
    expect(compressing.has(conversation.id)).toBe(false);
  }, 30_000);

  test("阶段三:开关默认关闭 → 上下文超阈值也不静默调用压缩模型", async () => {
    await installModelCatalog();
    const server = await installUpstream([{ content: "直接回答" }], { modelId: "qwen-max" });
    expect(jsonStore.state.settings.chatAutoCompact).toBe(false);
    const conversation = seedConversation(null);
    // 与开启用例同样的规模(越过阈值),差别只在开关——请求数不涨即硬证据。
    for (let round = 0; round < 12; round++) {
      appendUserNode(conversation, `第${round}轮超长历史。`.repeat(250));
    }
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("直接回答");
    expect(server.requests).toHaveLength(1);
    expect(conversation.engineCompactions ?? null).toBeNull();
  }, 30_000);

  test("阶段三:压缩模型失败 → 记 warn 后按原上下文继续生成(best-effort)", async () => {
    await installModelCatalog();
    // 前两轮是压缩的首发 + 非流式回退(空响应/非 JSON → 失败);第三轮才是生成本体。
    const server = await installUpstream(
      [{ content: "" }, { content: "" }, { content: "兜底回答" }],
      { modelId: "qwen-max" },
    );
    jsonStore.state.settings.chatAutoCompact = true;
    const conversation = seedConversation(null);
    for (let round = 0; round < 12; round++) {
      appendUserNode(conversation, `第${round}轮超长历史。`.repeat(250));
    }
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("兜底回答");
    expect(conversation.engineCompactions ?? null).toBeNull();
    expect(server.requests.length).toBeGreaterThanOrEqual(3);
    // 生成请求确实带上了原上下文(没有被失败的压缩截断)。
    const generation = JSON.stringify(server.requests.at(-1)?.messages ?? []);
    expect(generation).toContain("第0轮超长历史");
    expect(generation).not.toContain("context_summary");
    expect(compressing.has(conversation.id)).toBe(false);
  }, 30_000);

  test("阶段四:钉住的消息不进摘要,生成时以 <pinned_messages> 原文注入", async () => {
    const server = await installUpstream([{ content: "阶段四摘要。" }, { content: "阶段四回答" }]);
    const conversation = seedConversation(null);
    for (let round = 0; round < 5; round++) {
      appendUserNode(conversation, `第${round}轮要点:${"细节".repeat(60)}`);
    }
    const pinnedId = conversation.messages[1]!.messages[0]!.id;
    expect((await postPin(conversation.id, pinnedId, true))?.status).toBe(200);
    // 保留 2 条 → 切点在第 3 轮;切点前 = 首条 + 第0~2轮,其中第0轮被钉住。
    expect((await postCompress(conversation.id, { keepRecentMessages: 2 }))?.status).toBe(200);

    const summarizer = JSON.stringify(server.requests[0]?.messages ?? []);
    expect(summarizer).toContain("第2轮要点");
    expect(summarizer).not.toContain("第0轮要点");

    appendUserNode(conversation, "继续");
    await generateAnswer(conversation);
    expect(partsText(conversation)).toContain("阶段四回答");
    const body = JSON.stringify(server.requests[1]?.messages ?? []);
    // 钉住全文原样进摘要行;切点后原文逐字在场;未钉住的切点前原文不再出现。
    expect(body).toContain("pinned_messages");
    expect(body).toContain("第0轮要点");
    expect(body).toContain("第3轮要点");
    expect(body).toContain("第4轮要点");
    expect(body).not.toContain("第2轮要点");
  }, 30_000);

  test("钉住 API:置位/幂等/取消;非布尔 400、未知消息 404", async () => {
    await installUpstream([{ content: "未使用" }]);
    const conversation = seedConversation(null);
    const messageId = conversation.messages[0]!.messages[0]!.id;
    const on = await postPin(conversation.id, messageId, true);
    expect(on?.status).toBe(200);
    expect(await on?.json()).toEqual({ status: "updated", pinned: true });
    expect(conversation.messages[0]!.messages[0]!.annotations).toContainEqual({ type: "pinned" });
    // 幂等:重复钉住不产生第二条注解(前端重试/双击不制造脏数据)。
    expect((await postPin(conversation.id, messageId, true))?.status).toBe(200);
    expect(
      (conversation.messages[0]!.messages[0]!.annotations ?? []).filter(
        (annotation) => (annotation as { type?: string }).type === "pinned",
      ),
    ).toHaveLength(1);
    const off = await postPin(conversation.id, messageId, false);
    expect(await off?.json()).toEqual({ status: "updated", pinned: false });
    expect(conversation.messages[0]!.messages[0]!.annotations ?? []).not.toContainEqual({ type: "pinned" });
    // 缺省/非布尔不猜意图。
    const badUrl = new URL(`http://localhost/api/conversations/${conversation.id}/messages/${messageId}/pin`);
    const bad = await handleConversationRoutes(
      new Request(badUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: "yes" }),
      }),
      badUrl,
      `conversations/${conversation.id}/messages/${messageId}/pin`,
    );
    expect(bad?.status).toBe(400);
    expect((await postPin(conversation.id, "missing-id", true))?.status).toBe(404);
  });

  test("落库防线:摘要生成期间有新消息写入 → 压缩作废,消息一条不丢", async () => {
    // 审计修复回归:压缩落库是"按开头快照覆盖 messages"——期间写入若不作废压缩,
    // 会被覆盖吞掉。API 三入口已 409 互斥,此处验证第二道防线(绕过入口的直接写入)。
    let conversation!: Conversation;
    await installUpstream([{
      content: "早期历史的压缩摘要。",
      // fake server 收到摘要请求后、响应前注入:确定性模拟压缩窗口内的并发写入。
      beforeRespond: () => {
        appendUserNode(conversation, "压缩期间溜进来的消息");
      },
    }]);
    conversation = seedConversation(null);
    for (let round = 0; round < 5; round++) {
      appendUserNode(conversation, `第${round}轮历史。`.repeat(200));
    }
    const lengthBefore = conversation.messages.length;

    const response = await postCompress(conversation.id);
    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { error: string };
    expect(body.error).toContain("压缩期间发生变更");
    // 会话未被覆盖:原历史 + 溜入的消息全部健在,没有摘要节点。
    expect(conversation.messages.length).toBe(lengthBefore + 1);
    const tail = conversation.messages.at(-1)!.messages[0];
    expect(JSON.stringify(tail.parts)).toContain("压缩期间溜进来的消息");
    expect(JSON.stringify(conversation.messages[0].messages[0].parts)).not.toContain("压缩摘要");
    // finally 清理:压缩态归零,后续可重新发起。
    expect(compressing.has(conversation.id)).toBe(false);
  }, 30_000);

  test("侧边栏绿灯:列表 isGenerating 在压缩中为 true(生成或压缩都算忙碌)", async () => {
    await installUpstream([{ content: "未使用" }]);
    const conversation = seedConversation(null);
    compressing.set(conversation.id, Date.now());
    try {
      const url = new URL("http://localhost/api/conversations");
      const response = await handleConversationRoutes(new Request(url), url, "conversations");
      expect(response?.status).toBe(200);
      const list = (await response?.json()) as { id: string; isGenerating: boolean }[];
      expect(list.find((item) => item.id === conversation.id)?.isGenerating).toBe(true);
    } finally {
      compressing.delete(conversation.id);
    }
  });

  test("并发防线:压缩进行中再次 compress 返回 409 + 业务码", async () => {
    await installUpstream([{ content: "未使用" }]);
    const conversation = seedConversation(null);
    compressing.set(conversation.id, Date.now());
    try {
      const response = await postCompress(conversation.id);
      expect(response?.status).toBe(409);
      const body = (await response?.json()) as { errorCode?: string };
      expect(body.errorCode).toBe("compress_in_progress");
    } finally {
      compressing.delete(conversation.id);
    }
  });

  test("SSE 连接期快照:压缩进行中建立会话流,补发 engine-status busy 帧(切页回来状态恢复)", async () => {
    await installUpstream([{ content: "未使用" }]);
    const conversation = seedConversation(null);
    compressing.set(conversation.id, Date.now());
    try {
      const url = new URL(`http://localhost/api/conversations/${conversation.id}/stream`);
      const response = await handleConversationRoutes(
        new Request(url),
        url,
        `conversations/${conversation.id}/stream`,
      );
      expect(response?.status).toBe(200);
      const reader = response!.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      // initial 帧在 start 里同步 enqueue;读到 engine-status 即证——最多读 3 块防波动。
      for (let i = 0; i < 3 && !received.includes("event: engine-status"); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
      expect(received).toContain("event: engine-status");
      expect(received).toContain('"busy":true');
      expect(received).toContain('"phase":"compacting"');
      // 快照帧带服务端权威起点,"已处理 xx秒"计时跨重连连续。
      expect(received).toContain('"startedAt":');
    } finally {
      compressing.delete(conversation.id);
    }
  });
});

describe("generateAnswer × subagent(聊天引擎面)", () => {
  // model() 默认不带 TOOL 能力 → 聊天引擎整包工具声明为空;要验证"声明面"必须先给能力。
  // (脚本化 SSE 即使工具未声明也会产生 tool_call 并被分发执行——这正是"历史残留调用"
  // 的形态,第二用例特意利用它。)
  function giveChatModelToolAbility() {
    for (const providerItem of jsonStore.state.settings.providers) {
      for (const modelEntry of providerItem.models) modelEntry.abilities.push("TOOL");
    }
  }

  // 聊天引擎没有工作区:子会话跑在独立 scratch 目录、只挂通用工具——这条路径的
  // 端到端证据与 pi 面不同(pi 面见 pi-engine/subagent-tools.test.ts):子上下文
  // 干净、摘要回灌父请求、父终局照常落 parts。
  test("非工作区会话派子智能体:子上下文独立、摘要回灌父请求、父终局落 parts", async () => {
    const server = await installUpstream([
      {
        toolCalls: [{
          id: "tc-dispatch-chat",
          name: "subagent_dispatch",
          arguments: JSON.stringify({ mode: "single", tasks: [{ title: "调研", prompt: "写一句暗号" }] }),
        }],
      },
      { content: "chat-child-marker" },
      { content: "父终局" },
    ]);
    jsonStore.state.settings.subagent = { ...jsonStore.state.settings.subagent, enabled: true };
    giveChatModelToolAbility();
    const conversation = seedConversation(null);
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("父终局");
    expect(server.requests.length).toBe(3);
    // 开关开启 → 父会话第一次请求就声明了 subagent_dispatch。
    const parentTools = (server.requests[0] as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [];
    expect(parentTools.some((tool) => tool.function?.name === "subagent_dispatch")).toBe(true);
    // 子上下文是干净的(父 prompt 不进子请求);子摘要作为工具结果进父第三轮请求。
    expect(JSON.stringify(server.requests[1])).not.toContain("请干活");
    expect(JSON.stringify(server.requests[2])).toContain("chat-child-marker");
  }, 30_000);

  test("开关关闭:工具面不声明;历史残留调用被拒执并回灌模型", async () => {
    const server = await installUpstream([
      {
        toolCalls: [{
          id: "tc-dispatch-stale",
          name: "subagent_dispatch",
          arguments: JSON.stringify({ mode: "single", tasks: [{ title: "旧任务", prompt: "p" }] }),
        }],
      },
      { content: "不派了" },
    ]);
    // defaultState 的 subagent.enabled 默认 false,本用例不开启。
    giveChatModelToolAbility();
    const conversation = seedConversation(null);
    await generateAnswer(conversation);

    expect(partsText(conversation)).toContain("不派了");
    const tools = (server.requests[0] as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [];
    expect(tools.some((tool) => tool.function?.name === "subagent_dispatch")).toBe(false);
    // 残留调用拒执:第二轮请求携带明确拒执文案,模型据此收手。
    expect(JSON.stringify(server.requests[1])).toContain("Subagent dispatch is currently disabled");
    // 拒执不触发任何子生成:总请求数 = 父轮数(2)。
    expect(server.requests.length).toBe(2);
  }, 30_000);
});
