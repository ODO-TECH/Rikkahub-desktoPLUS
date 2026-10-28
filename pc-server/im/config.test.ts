// im/config.test.ts — state.json 里的老配置升级:缺字段不能变成 undefined 漏进运行时。

import { describe, expect, test } from "bun:test";

import { normalizeImAccess } from "./config";

describe("plainText 缺省", () => {
  test("老配置没有 plainText 字段:两个平台都按纯文本输出(true)升级", () => {
    const legacy = {
      qq: { enabled: true, appId: "1024", appSecret: "s" },
      wechat: { enabled: false, botToken: "", accountId: "" },
    };

    const config = normalizeImAccess(legacy);

    expect(config.qq.plainText).toBe(true);
    expect(config.wechat.plainText).toBe(true);
  });

  test("显式关闭后重新归一化仍为 false", () => {
    const config = normalizeImAccess({ qq: { plainText: false }, wechat: { plainText: false } });

    expect(config.qq.plainText).toBe(false);
    expect(config.wechat.plainText).toBe(false);
  });
});
