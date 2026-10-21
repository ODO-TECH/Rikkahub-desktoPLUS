// 全面审查 4-1(P1)回归测试:SSE 广播遇到死 controller(客户端断开但 cancel 尚未摘除)
// 必须①不抛错(尤其 33ms 节点广播跑在 setTimeout 里,未捕获异常会杀死整个 Bun 进程)、
// ②把死 controller 从集合摘除(防永久驻留反复抛)、③不中断遍历(存活客户端照常收到事件)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  broadcastConversation,
  broadcastList,
  broadcastNodeUpdate,
  conversationClients,
  appClients,
} from "./sse";
import { setState, state } from "../persistence/json-store";
import type { Conversation, MessageNode, State } from "../foundation/types";

// broadcastList 读 state.settings.assistantId;测试进程没跑 loadState,注入最小 state。
const priorState = state;
beforeAll(() => setState({ settings: { assistantId: "a1" } } as unknown as State));
afterAll(() => setState(priorState));

type Ctl = ReadableStreamDefaultController<Uint8Array>;

/** 造一个可控的 SSE controller。close() 后 enqueue 抛 "Controller is already closed"。 */
function makeController(): { ctl: Ctl; received: Uint8Array[] } {
  let ctl!: Ctl;
  const received: Uint8Array[] = [];
  new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  const rawEnqueue = ctl.enqueue.bind(ctl);
  ctl.enqueue = ((chunk: Uint8Array) => { rawEnqueue(chunk); received.push(chunk); }) as Ctl["enqueue"];
  return { ctl, received };
}

function deadController(): Ctl {
  const { ctl } = makeController();
  ctl.close();
  return ctl;
}

const node: MessageNode = { id: "n1", messages: [], selectIndex: 0 };
const conv = {
  id: "c-sse",
  assistantId: "a1",
  title: "t",
  systemPrompt: null,
  messages: [node],
  chatSuggestions: [],
  isPinned: false,
  createAt: 1,
  updateAt: 2,
} as Conversation;

describe("4-1 缺陷复现:死 controller 上裸 enqueue 抛错", () => {
  test("close 后 enqueue 抛 TypeError(证明原崩溃机制真实存在)", () => {
    const ctl = deadController();
    expect(() => ctl.enqueue(new Uint8Array([1]))).toThrow();
  });
});

describe("broadcastTo 语义(经公开广播函数验证)", () => {
  test("broadcastList:死连接不抛错、被摘除,存活连接照常收到", () => {
    appClients.clear();
    const dead = deadController();
    const live = makeController();
    appClients.add(dead);
    appClients.add(live.ctl);

    expect(() => broadcastList()).not.toThrow();
    expect(appClients.has(dead)).toBe(false); // 死连接被摘除
    expect(appClients.has(live.ctl)).toBe(true);
    expect(live.received.length).toBe(1); // 遍历未被中断
    appClients.clear();
  });

  test("broadcastNodeUpdate(33ms 节流的最终路径):死连接不抛错且被摘除", () => {
    const set = new Set<Ctl>();
    const dead = deadController();
    const live = makeController();
    set.add(dead);
    set.add(live.ctl);
    conversationClients.set(conv.id, set);

    expect(() => broadcastNodeUpdate(conv, node)).not.toThrow();
    expect(set.has(dead)).toBe(false);
    expect(live.received.length).toBe(1);
    conversationClients.delete(conv.id);
  });

  test("broadcastConversation:死连接排首位也不影响后续客户端", () => {
    appClients.clear();
    const set = new Set<Ctl>();
    const dead = deadController();
    const live1 = makeController();
    const live2 = makeController();
    set.add(dead); // Set 保持插入序,dead 首个被遍历
    set.add(live1.ctl);
    set.add(live2.ctl);
    conversationClients.set(conv.id, set);

    expect(() => broadcastConversation(conv)).not.toThrow();
    expect(set.size).toBe(2);
    expect(live1.received.length).toBe(1);
    expect(live2.received.length).toBe(1);
    conversationClients.delete(conv.id);
  });
});
