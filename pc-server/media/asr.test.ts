// media/asr.test.ts — ASR 归一化的跨端保真(backup C4)。
// APP 有 5 家 ASR(openai_realtime/dashscope/volcengine/mimo/step),桌面端实现前 4 家。
// normalizeAsrProviders 必须把 step 等未实现类型的判别符**原样保留**,而不是收敛成
// openai_realtime——否则 APP→PC→APP 往返会无声没收用户的阶跃 ASR 配置(这正是
// "导入了一点反应都没有"的实锤之一)。isPcKnownAsrType 是「本端能否消费」的唯一判定入口。
import { describe, expect, test } from "bun:test";

import { PC_KNOWN_ASR_TYPES } from "../foundation/types";
import { defaultAsrProvider, isPcKnownAsrType, normalizeAsrProviders } from "./asr";

describe("normalizeAsrProviders 跨端保真(backup C4)", () => {
  test("本端认识的各家照常套默认模板", () => {
    const list = normalizeAsrProviders([
      { type: "dashscope", id: "d1", name: "D", apiKey: "k" },
    ]);
    const d = list.find((p) => p.id === "d1");
    expect(d?.type).toBe("dashscope");
    expect(d?.websocketUrl).toContain("dashscope"); // 套了 dashscope 默认模板
  });

  test("mimo 已是本端类型:套 MiMo 默认模板,保留用户值", () => {
    const list = normalizeAsrProviders([
      { type: "mimo", id: "m1", name: "MiMo ASR", apiKey: "k", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-asr" },
    ]);
    const mimo = list.find((p) => p.id === "m1");
    expect(mimo?.type).toBe("mimo");
    expect(mimo?.websocketUrl).toBe("");
    expect(mimo?.sampleRate).toBe(16000);
    expect(mimo?.segmentDurationSec).toBe(30);
    expect((mimo as unknown as Record<string, unknown>)?.model).toBe("mimo-v2.5-asr");
  });

  test("step(APP 独家、桌面端未实现)判别符原样保留,不收敛成 openai_realtime", () => {
    const list = normalizeAsrProviders([
      { type: "step", id: "s1", name: "Step ASR", apiKey: "k", baseUrl: "https://api.stepfun.com", model: "stepaudio-2.5-asr" },
    ]);
    const step = list.find((p) => p.id === "s1");
    expect(step?.type).toBe("step");
    // 未实现类型不套 openai 默认模板,字段原样透传待 APP 取回。
    expect(step?.websocketUrl).toBe("");
    expect((step as unknown as Record<string, unknown>)?.model).toBe("stepaudio-2.5-asr");
  });

  test("未知类型缺 id 时补骨架 id,name 兜底为 type 串", () => {
    const list = normalizeAsrProviders([{ type: "bogus_future", apiKey: "k" } as any]);
    const item = list.find((p) => p.type === "bogus_future");
    expect(item).toBeTruthy();
    expect(typeof item!.id).toBe("string");
    expect(item!.id.length).toBeGreaterThan(0);
    expect(item!.name).toBe("bogus_future");
  });

  test("mimo 缺字段时沿用 MiMo 默认值(不套 openai 模板)", () => {
    const list = normalizeAsrProviders([{ type: "mimo", apiKey: "k" } as any]);
    const item = list.find((p) => p.type === "mimo");
    expect(item!.name).toBe("MiMo ASR");
    expect(item!.baseUrl).toBe(defaultAsrProvider("mimo").baseUrl);
  });

  test("缺 type 的脏数据回退 openai_realtime(防 crashes)", () => {
    const list = normalizeAsrProviders([{ id: "x1", name: "X", apiKey: "k" } as any]);
    expect(list.find((p) => p.id === "x1")?.type).toBe("openai_realtime");
  });
});

describe("isPcKnownAsrType(消费点降级判定单源)", () => {
  test("本端 4 家为 true,step/未知为 false", () => {
    for (const t of PC_KNOWN_ASR_TYPES) expect(isPcKnownAsrType(t)).toBe(true);
    expect(isPcKnownAsrType("mimo")).toBe(true);
    expect(isPcKnownAsrType("step")).toBe(false);
    expect(isPcKnownAsrType("bogus")).toBe(false);
    expect(isPcKnownAsrType(undefined)).toBe(false);
  });
});
