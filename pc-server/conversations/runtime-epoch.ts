// conversations/runtime-epoch.ts — 运行态代际(导入等整体替换动作的作废令牌)
//
// 备份导入替换设置/会话/记忆后,导入前启动的异步任务(生成收尾、压缩、收尾建议)
// 可能仍在途。abort 只能停下"看得见的流",停不住已拿到 LLM 结果、只差落库的
// 任务——它们必须自己核对"我还是不是当前运行态"。会话对象身份可覆盖会话域的
// 场景(旧实例已不在 working set),但像"同一会话 id 被备份原样恢复"这种,身份
// 检查会误判,所以另设单调递增代际:任务开始时取号,写回前核对。
let epoch = 0;

export function runtimeEpoch(): number {
  return epoch;
}

/** 整体替换运行态时递增。调用方负责在递增后立即完成旧产者的收口。 */
export function bumpRuntimeEpoch(): void {
  epoch += 1;
}

export function isRuntimeEpochCurrent(value: number): boolean {
  return value === epoch;
}
