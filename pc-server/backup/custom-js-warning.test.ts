// N-5 custom_js 导入告警单元测试。
// 契约：只对"新增或脚本内容变化"的 custom_js 服务告警；用户已有且未变的服务、
// 无脚本的 custom_js 壳、非 custom_js 服务都不触发。
import { describe, expect, test } from "bun:test";

import { customJsImportWarning, customJsScriptSignatures } from "./import";

const service = (id: string, script: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "custom_js",
  name: `服务${id}`,
  searchScript: script,
  ...extra,
});

describe("customJsScriptSignatures", () => {
  test("只收集带脚本的 custom_js 服务，searchScript 与 scrapeScript 任一即算", () => {
    const signatures = customJsScriptSignatures({
      searchServices: [
        service("a", "return []"),
        { id: "b", type: "custom_js", name: "空壳" },
        { id: "c", type: "custom_js", scrapeScript: "return {}" },
        { id: "d", type: "tavily", searchScript: "irrelevant" },
      ],
    });
    expect([...signatures.keys()].sort()).toEqual(["a", "c"]);
  });

  test("非法输入返回空 Map", () => {
    expect(customJsScriptSignatures(null).size).toBe(0);
    expect(customJsScriptSignatures({ searchServices: "junk" }).size).toBe(0);
  });
});

describe("customJsImportWarning", () => {
  const before = customJsScriptSignatures({ searchServices: [service("a", "return []")] });

  test("导入后无变化不告警", () => {
    expect(customJsImportWarning(before, { searchServices: [service("a", "return []")] })).toBeNull();
  });

  test("新增带脚本的服务触发告警，文案含服务名", () => {
    const warning = customJsImportWarning(before, {
      searchServices: [service("a", "return []"), service("evil", "fetch('http://x')")],
    });
    expect(warning).toContain("1 个自定义 JS 搜索脚本");
    expect(warning).toContain("服务evil");
  });

  test("已有服务脚本内容变化也触发告警", () => {
    const warning = customJsImportWarning(before, {
      searchServices: [service("a", "return ['tampered']")],
    });
    expect(warning).toContain("服务a");
  });

  test("导入把脚本删空则不告警", () => {
    expect(customJsImportWarning(before, { searchServices: [{ id: "a", type: "custom_js", name: "服务a" }] })).toBeNull();
    expect(customJsImportWarning(before, { searchServices: [] })).toBeNull();
  });
});
