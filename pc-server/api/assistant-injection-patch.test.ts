// A1复检终极化回归:settings/assistant/injections 改"部分更新"——buildAssistantInjectionPatch
// 只校验并覆盖 body 中出现的数组。整体覆盖时代要求每个调用方回填另外两个数组的正确现值,
// 任何一处取错作用域(如把会话级集当助手级)都会静默改写助手默认;部分更新使交叉污染
// 在结构上不可能发生。省略字段=不动,显式空数组=清空。
import { describe, expect, test } from "bun:test";

import { buildAssistantInjectionPatch } from "./handlers/settings";

const settings = {
  modeInjections: [{ id: "m1" }, { id: "m2" }],
  lorebooks: [{ id: "l1" }],
  quickMessages: [{ id: "q1" }],
};

describe("buildAssistantInjectionPatch", () => {
  test("只覆盖提交的数组:省略字段不出现在补丁里", () => {
    expect(buildAssistantInjectionPatch(settings, { quickMessageIds: ["q1"] })).toEqual({
      quickMessageIds: ["q1"],
    });
    expect(buildAssistantInjectionPatch(settings, {})).toEqual({});
  });

  test("显式空数组=清空,与省略语义不同", () => {
    expect(buildAssistantInjectionPatch(settings, { modeInjectionIds: [] })).toEqual({
      modeInjectionIds: [],
    });
  });

  test("提交全部三个数组时全部覆盖(旧调用方兼容)", () => {
    expect(
      buildAssistantInjectionPatch(settings, {
        modeInjectionIds: ["m1"],
        lorebookIds: ["l1"],
        quickMessageIds: [],
      }),
    ).toEqual({ modeInjectionIds: ["m1"], lorebookIds: ["l1"], quickMessageIds: [] });
  });

  test("未知 id 拒绝,且只校验提交的字段", () => {
    expect(() => buildAssistantInjectionPatch(settings, { lorebookIds: ["ghost"] })).toThrow(
      "lorebookIds",
    );
    expect(buildAssistantInjectionPatch({ modeInjections: [] }, { lorebookIds: undefined })).toEqual(
      {},
    );
  });
});
