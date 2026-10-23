// 侧栏助手列表的右键条目操作(编辑 / 复制 / 删除)。zustand 快照在静态渲染里不可见
// (见 collapse-all-steps.test.tsx 的说明),所以这里锁源码结构:
//   - 选择器每行都有受控右键菜单,编辑带 assistantId 深链进设置;
//   - 复制 / 删除与设置页共用 useAssistantActions,记忆感知确认只有一份实现。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...segments: string[]) =>
  readFileSync(join(import.meta.dir, "..", ...segments), "utf8");

const SIDEBAR = read("components", "conversation-sidebar.tsx");
const ASSISTANTS = read("components", "settings", "assistants.tsx");
const ACTIONS = read("hooks", "use-assistant-actions.tsx");

describe("侧栏助手列表右键菜单", () => {
  test("每行包在 ContextMenu 里,菜单含编辑与复制", () => {
    expect(SIDEBAR).toContain("<ContextMenu key={assistant.id}>");
    expect(SIDEBAR).toContain("<ContextMenuTrigger asChild>");
    expect(SIDEBAR).toContain('t("conversation_sidebar.assistant_edit")');
    expect(SIDEBAR).toContain('t("conversation_sidebar.assistant_copy")');
  });

  test("只剩一个助手时不给删除(与设置页列表同口径)", () => {
    expect(SIDEBAR).toContain("{assistants.length > 1 && (");
    expect(SIDEBAR).toContain('t("conversation_sidebar.assistant_delete")');
  });

  test("编辑 = 设置 → 助手 + assistantId 深链,桌面走模态、窄屏走整页", () => {
    expect(SIDEBAR).toContain(
      "`?section=assistants&assistantId=${encodeURIComponent(assistantId)}`",
    );
    expect(SIDEBAR).toContain("if (isDesktopViewport()) openSettingsDialog(search);");
    expect(SIDEBAR).toContain("else navigate(`/settings${search}`);");
  });

  test("设置页只在挂载时读一次 assistantId 深链", () => {
    expect(ASSISTANTS).toContain('getSettingsParam("assistantId")');
    expect(ASSISTANTS).toContain("React.useState(() => {");
  });

  test("复制/删除与设置页共用同一套流程,记忆确认不在侧栏重写", () => {
    expect(SIDEBAR).toContain("useAssistantActions()");
    expect(ASSISTANTS).toContain("useAssistantActions({");
    expect(SIDEBAR).toContain("{copyDialog}");
    expect(ASSISTANTS).toContain("{copyDialog}");
    // 记忆感知确认的唯一实现:先查记忆数,再决定问不问「同时复制 / 同时删除」。
    expect(ACTIONS).toContain("memory/assistant/");
    expect(ACTIONS).toContain("copyMemories");
    expect(ACTIONS).toContain("deleteMemories=true");
    expect(ACTIONS).toContain("settings/assistant/copy");
  });
});
