// inference-engine/approval-gate.test.ts — 在途审批等待注册表(P3)单测
// 纯内存模块,无环境依赖。语义:登记→决定/中止/接管/清扫,等待者绝不悬挂、绝不泄漏。
import { describe, expect, test } from "bun:test";
import {
  clearToolApprovalWaiters,
  pendingToolApprovalCount,
  resolveToolApproval,
  waitForToolApproval,
} from "./approval-gate";

describe("approval-gate 等待/决定汇合", () => {
  test("放行决定唤醒等待者并注销", async () => {
    const wait = waitForToolApproval("conv-a", "call-1");
    expect(pendingToolApprovalCount()).toBe(1);
    expect(resolveToolApproval("conv-a", "call-1", { approved: true })).toBe(true);
    await expect(wait).resolves.toEqual({ approved: true });
    expect(pendingToolApprovalCount()).toBe(0);
  });

  test("拒绝决定携带理由", async () => {
    const wait = waitForToolApproval("conv-a", "call-2");
    expect(resolveToolApproval("conv-a", "call-2", { approved: false, reason: "危险操作" })).toBe(true);
    await expect(wait).resolves.toEqual({ approved: false, reason: "危险操作" });
  });

  test("无在途等待者时决定返回 false(孤儿审批:仅记录状态)", () => {
    expect(resolveToolApproval("conv-a", "call-ghost", { approved: true })).toBe(false);
  });

  test("中止信号 → AbortError 拒绝并注销;迟到的决定返回 false", async () => {
    const controller = new AbortController();
    const wait = waitForToolApproval("conv-b", "call-3", controller.signal);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingToolApprovalCount()).toBe(0);
    expect(resolveToolApproval("conv-b", "call-3", { approved: true })).toBe(false);
  });

  test("预先已中止的信号 → 立即拒绝,不登记", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForToolApproval("conv-b", "call-4", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(pendingToolApprovalCount()).toBe(0);
  });

  test("同键重复登记:旧等待者按中止收敛,新等待者接管决定", async () => {
    const stale = waitForToolApproval("conv-c", "call-5");
    const fresh = waitForToolApproval("conv-c", "call-5");
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    expect(resolveToolApproval("conv-c", "call-5", { approved: true })).toBe(true);
    await expect(fresh).resolves.toEqual({ approved: true });
  });

  test("clearToolApprovalWaiters 只清目标会话,其他会话不受波及", async () => {
    const mine = waitForToolApproval("conv-d", "call-6");
    const other = waitForToolApproval("conv-e", "call-7");
    clearToolApprovalWaiters("conv-d");
    await expect(mine).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingToolApprovalCount()).toBe(1);
    expect(resolveToolApproval("conv-e", "call-7", { approved: true })).toBe(true);
    await expect(other).resolves.toEqual({ approved: true });
    expect(pendingToolApprovalCount()).toBe(0);
  });

  test("按 scope 清扫只杀本作用域,同会话并发兄弟等待者照常唤醒(子智能体场景)", async () => {
    const parent = waitForToolApproval("conv-f", "call-8");
    const childA = waitForToolApproval("conv-f", "call-9", undefined, "conv-f#sub-1");
    const childB = waitForToolApproval("conv-f", "call-10", undefined, "conv-f#sub-2");
    // 子 A 收工:不得波及子 B 与父生成
    clearToolApprovalWaiters("conv-f", "conv-f#sub-1");
    await expect(childA).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingToolApprovalCount()).toBe(2);
    expect(resolveToolApproval("conv-f", "call-10", { approved: true })).toBe(true);
    await expect(childB).resolves.toEqual({ approved: true });
    expect(resolveToolApproval("conv-f", "call-8", { approved: false, reason: "拒绝" })).toBe(true);
    await expect(parent).resolves.toEqual({ approved: false, reason: "拒绝" });
    expect(pendingToolApprovalCount()).toBe(0);
  });

  test("不传 scope 的清扫保持旧语义:清该会话全部作用域", async () => {
    const parent = waitForToolApproval("conv-g", "call-11");
    const child = waitForToolApproval("conv-g", "call-12", undefined, "conv-g#sub-1");
    clearToolApprovalWaiters("conv-g");
    await expect(parent).rejects.toMatchObject({ name: "AbortError" });
    await expect(child).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingToolApprovalCount()).toBe(0);
  });

  test("同 toolCallId 不同 scope 互不顶替;决议跨 scope 命中", async () => {
    const a = waitForToolApproval("conv-h", "call-13", undefined, "conv-h#sub-1");
    const b = waitForToolApproval("conv-h", "call-13", undefined, "conv-h#sub-2");
    expect(pendingToolApprovalCount()).toBe(2);
    // 先登记者先被唤醒(Map 插入序),另一个继续等;再决议一次命中后者。
    expect(resolveToolApproval("conv-h", "call-13", { approved: true })).toBe(true);
    await expect(a).resolves.toEqual({ approved: true });
    expect(pendingToolApprovalCount()).toBe(1);
    expect(resolveToolApproval("conv-h", "call-13", { approved: false, reason: "第二个" })).toBe(true);
    await expect(b).resolves.toEqual({ approved: false, reason: "第二个" });
    expect(pendingToolApprovalCount()).toBe(0);
  });
});
