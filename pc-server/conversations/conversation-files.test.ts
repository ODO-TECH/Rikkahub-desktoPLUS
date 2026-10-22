// conversations/conversation-files.test.ts — 会话文件侧边栏聚合(0.0.3 Feature A)。
// 覆盖:write/edit(含安卓别名)路径折算与去重、失败/未完成状态、附件/产出分类与去重。

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Conversation, Message, MessageNode, MessagePart, Workspace } from "../foundation/types";
import { listConversationFiles } from "./conversation-files";

const root = mkdtempSync(join(tmpdir(), "rkh-conv-files-"));
const cwd = join(root, "sub");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "a.ts"), "export const a = 1;");

const workspace = { id: "w1", root } as Workspace;

function toolPart(toolName: string, args: Record<string, unknown>, output: unknown[] = []): MessagePart {
  return {
    type: "tool",
    toolName,
    input: JSON.stringify(args),
    output,
    approvalState: { type: "auto" },
  } as unknown as MessagePart;
}

function textMessage(id: string, role: Message["role"], parts: MessagePart[], createdAt: string): Message {
  return {
    id,
    role,
    parts,
    annotations: [],
    createdAt,
    finishedAt: null,
    modelId: null,
    usage: null,
    translation: null,
  };
}

function node(id: string, message: Message): MessageNode {
  return { id, messages: [message], selectIndex: 0 };
}

function conversation(nodes: MessageNode[]): Conversation {
  return {
    id: "c1",
    assistantId: "a1",
    systemPrompt: null,
    title: "t",
    messages: nodes,
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
    workspaceId: "w1",
    workspaceCwd: cwd,
    engineCompactions: null,
  };
}

describe("本次改动", () => {
  test("相对 cwd 折算成工作区相对路径;同文件只留最新;按时间倒序", () => {
    const conv = conversation([
      node("n0", textMessage("m0", "USER", [{ type: "text", text: "hi" }], "2026-01-01T00:00:00Z")),
      node(
        "n1",
        textMessage("m1", "ASSISTANT", [toolPart("write", { path: "a.ts" }, [{ type: "text", text: "ok" }])], "2026-01-01T00:00:01Z"),
      ),
      node(
        "n2",
        textMessage("m2", "ASSISTANT", [toolPart("edit", { path: "a.ts" }, [{ type: "text", text: "ok" }])], "2026-01-01T00:00:02Z"),
      ),
    ]);

    const payload = listConversationFiles(conv, workspace);
    expect(payload.workspaceId).toBe("w1");
    // 深链换算所需:会话 cwd 与工作区根都回传,前端按同一口径把工具参数里的原始路径
    // 折算成工作区相对路径(不能用浏览器侧的当前目录猜)。
    expect(payload.cwd).toBe(cwd);
    expect(payload.workspaceRoot).toBe(root);
    expect(payload.changes).toHaveLength(1);
    const change = payload.changes[0]!;
    expect(change.path).toBe("sub/a.ts");
    expect(change.inWorkspace).toBe(true);
    expect(change.changeType).toBe("edit");
    expect(change.fileExists).toBe(true);
    expect(change.finished).toBe(true);
    expect(change.failed).toBe(false);
  });

  test("安卓别名 workspace_write_file 也算改动", () => {
    const conv = conversation([
      node(
        "n0",
        textMessage("m0", "ASSISTANT", [toolPart("workspace_write_file", { path: "a.ts" }, [{ type: "text", text: "ok" }])], "2026-01-01T00:00:00Z"),
      ),
    ]);
    const payload = listConversationFiles(conv, workspace);
    expect(payload.changes).toHaveLength(1);
    expect(payload.changes[0]!.changeType).toBe("write");
    expect(payload.changes[0]!.path).toBe("sub/a.ts");
  });

  test("越界路径保留原文且不可打开;被拒/未完成的动作如实标注", () => {
    const denied = toolPart("write", { path: "../../outside.txt" });
    (denied as { approvalState: unknown }).approvalState = { type: "denied", reason: "nope" };
    const pending = toolPart("edit", { path: "a.ts" });

    const conv = conversation([
      node("n0", textMessage("m0", "ASSISTANT", [denied], "2026-01-01T00:00:00Z")),
      node("n1", textMessage("m1", "ASSISTANT", [pending], "2026-01-01T00:00:01Z")),
    ]);

    const payload = listConversationFiles(conv, workspace);
    const outside = payload.changes.find((item) => !item.inWorkspace)!;
    expect(outside.path).toBe("../../outside.txt");
    expect(outside.failed).toBe(true);

    const unfinished = payload.changes.find((item) => item.inWorkspace)!;
    expect(unfinished.finished).toBe(false);
    expect(unfinished.failed).toBe(false);
  });
});

describe("附件与产出", () => {
  test("用户媒体=附件,助手/工具输出媒体=产出;按 url 去重;工具名与文件名保留", () => {
    const attachment = toolPart("media_generate", { prompt: "一只猫" }, [
      { type: "image", url: "/api/files/9/content" },
      { type: "text", text: "done" },
    ]);
    const conv = conversation([
      node(
        "n0",
        textMessage("m0", "USER", [
          { type: "image", url: "/api/files/7/content" } as MessagePart,
          { type: "document", url: "/api/files/8/content", fileName: "spec.pdf", mime: "application/pdf" } as MessagePart,
        ], "2026-01-01T00:00:00Z"),
      ),
      node(
        "n1",
        textMessage("m1", "ASSISTANT", [
          { type: "image", url: "/api/files/7/content" } as MessagePart,
          attachment,
        ], "2026-01-01T00:00:01Z"),
      ),
      node(
        "n2",
        textMessage("m2", "ASSISTANT", [{ type: "image", url: "/api/files/9/content" } as MessagePart], "2026-01-01T00:00:02Z"),
      ),
    ]);

    const payload = listConversationFiles(conv, workspace);
    // /api/files/7 被用户消息引用两次(第二处仍在用户侧)只留一份。
    const attachments = payload.files.filter((item) => item.kind === "attachment");
    const outputs = payload.files.filter((item) => item.kind === "output");
    expect(attachments).toHaveLength(2);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.url).toBe("/api/files/9/content");
    expect(outputs[0]!.toolName).toBe("media_generate");
    expect(outputs[0]!.prompt).toBe("一只猫");
    expect(attachments.find((item) => item.partType === "document")!.fileName).toBe("spec.pdf");
  });

  test("无工作区时会话仍能列出改动(路径按 cwd 原样展示)", () => {
    const conv = conversation([
      node(
        "n0",
        textMessage("m0", "ASSISTANT", [toolPart("write", { path: "a.ts" }, [{ type: "text", text: "ok" }])], "2026-01-01T00:00:00Z"),
      ),
    ]);
    const payload = listConversationFiles(conv, null);
    expect(payload.workspaceId).toBe("w1");
    expect(payload.workspaceRoot).toBeNull();
    expect(payload.cwd).toBe(cwd);
    expect(payload.changes).toHaveLength(1);
    expect(payload.changes[0]!.path).toBe("a.ts");
    expect(payload.changes[0]!.inWorkspace).toBe(false);
  });
});
