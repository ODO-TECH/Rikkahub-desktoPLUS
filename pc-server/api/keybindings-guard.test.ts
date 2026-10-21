// 批次二 R5-6 回归:settings/keybindings 的 action 校验必须只认默认列表的自有键。
// 旧实现用 `body.action in defaults`——in 含原型链,"__proto__" 会把 current 对象的原型
// 换成请求体(本次写入静默丢失),"constructor"/"toString" 等则以垃圾键持久化进
// settings.keybindings。只测拒绝路径:合法 action 的成功路径会走 updateSettings 真实
// 持久化,由应用层与既有 e2e 覆盖。
import { describe, expect, test } from "bun:test";

import { handleSettingsRoutes } from "./handlers/settings";

async function postKeybinding(action: unknown): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/keybindings");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, keys: ["ctrl", "x"] }),
  });
  return handleSettingsRoutes(request, url, "settings/keybindings");
}

describe("settings/keybindings action 白名单(原型链防护)", () => {
  test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "原型链键 %s 被 400 拒绝",
    async (key) => {
      const res = await postKeybinding(key);
      expect(res?.status).toBe(400);
    },
  );

  test("非字符串 action 被 400 拒绝", async () => {
    const res = await postKeybinding(123);
    expect(res?.status).toBe(400);
  });

  test("默认列表外的未知 action 被 400 拒绝", async () => {
    const res = await postKeybinding("definitely-not-a-real-action");
    expect(res?.status).toBe(400);
  });
});
