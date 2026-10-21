// 全面审查 1-2/1-3 回归测试:state.json 损坏恢复链、每日滚动备份与批次一收口
// (统一 mtime 新鲜度排序 / 更新鲜 recovery 启动采用 / 过期与超龄清扫)。
// 原缺陷:①performStateSave 兜底写出的 recovery-*.json 全项目零读取;②修复后又按
// "类别优先级"固定顺序,数月前的陈旧 recovery 压过昨天的 daily.bak;③state.json
// 完好但更旧时,更新鲜的 recovery 被静默丢弃;④recovery/.applied 无人清理。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  maybeAdoptFresherRecovery,
  maybeWriteDailyBackupTo,
  recoverStateFromBackups,
  sweepAgedRecoveryArchivesIn,
  sweepObsoleteRecoveryFilesIn,
} from "./json-store";

function tempDataDir(): { dir: string; statePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rkh-state-recovery-"));
  return { dir, statePath: join(dir, "state.json") };
}

/** 写文件并显式指定 mtime(秒精度足够,测试控制时钟)。 */
function writeWithMtime(path: string, content: string, mtimeSec: number): void {
  writeFileSync(path, content);
  utimesSync(path, mtimeSec, mtimeSec);
}

const NOW_SEC = Math.floor(Date.now() / 1000);

describe("recoverStateFromBackups(1-2 恢复链,统一 mtime 新鲜度)", () => {
  test("优先采用最新 recovery 文件;用过的原样保留(重启幂等重采用,成功落盘后统一清扫)", () => {
    const { dir, statePath } = tempDataDir();
    writeWithMtime(join(dir, "state.json.recovery-1000.json"), JSON.stringify({ settings: { assistantId: "旧" } }), NOW_SEC - 100);
    writeWithMtime(join(dir, "state.json.recovery-2000.json"), JSON.stringify({ settings: { assistantId: "新" } }), NOW_SEC - 50);
    writeWithMtime(join(dir, "state.json.pre-sqlite.bak"), JSON.stringify({ settings: { assistantId: "化石" } }), NOW_SEC - 9000);

    const recovered = recoverStateFromBackups(dir, statePath);
    expect((recovered?.state.settings as { assistantId: string }).assistantId).toBe("新");
    expect(recovered?.source).toBe("state.json.recovery-2000.json");
    // 不改名归档:采用后到首次成功落盘之间再崩溃,必须还能重采用同一份数据
    const names = readdirSync(dir);
    expect(names).toContain("state.json.recovery-2000.json");
    expect(names).toContain("state.json.recovery-1000.json");
  });

  test("最新 recovery 损坏时回退到更早的 recovery", () => {
    const { dir, statePath } = tempDataDir();
    writeWithMtime(join(dir, "state.json.recovery-1000.json"), JSON.stringify({ settings: { assistantId: "早但完好" } }), NOW_SEC - 100);
    writeWithMtime(join(dir, "state.json.recovery-2000.json"), "{损坏的json", NOW_SEC - 50);

    const recovered = recoverStateFromBackups(dir, statePath);
    expect((recovered?.state.settings as { assistantId: string }).assistantId).toBe("早但完好");
  });

  test("R1-2 核心:数月前的陈旧 recovery 不得压过昨天的 daily.bak", () => {
    const { dir, statePath } = tempDataDir();
    writeWithMtime(join(dir, "state.json.recovery-1000.json"), JSON.stringify({ settings: { assistantId: "三个月前的抢救件" } }), NOW_SEC - 90 * 24 * 3600);
    writeWithMtime(`${statePath}.daily.bak`, JSON.stringify({ settings: { assistantId: "昨日" } }), NOW_SEC - 24 * 3600);

    const recovered = recoverStateFromBackups(dir, statePath);
    expect((recovered?.state.settings as { assistantId: string }).assistantId).toBe("昨日");
    // daily.bak 不是 recovery,不得被归档改名
    expect(readdirSync(dir)).toContain("state.json.daily.bak");
  });

  test("无 recovery 时用每日滚动备份(1-3 与 1-2 组成梯队)", () => {
    const { dir, statePath } = tempDataDir();
    writeWithMtime(`${statePath}.daily.bak`, JSON.stringify({ settings: { assistantId: "昨日" } }), NOW_SEC - 24 * 3600);
    writeWithMtime(join(dir, "state.json.pre-sqlite.bak"), JSON.stringify({ settings: { assistantId: "化石" } }), NOW_SEC - 9000 * 3600);

    const recovered = recoverStateFromBackups(dir, statePath);
    expect((recovered?.state.settings as { assistantId: string }).assistantId).toBe("昨日");
  });

  test("只剩 pre-sqlite.bak 时仍可用(化石好过默认)", () => {
    const { dir, statePath } = tempDataDir();
    writeFileSync(join(dir, "state.json.pre-sqlite.bak"), JSON.stringify({ settings: { assistantId: "化石" } }));

    const recovered = recoverStateFromBackups(dir, statePath);
    expect((recovered?.state.settings as { assistantId: string }).assistantId).toBe("化石");
    expect(recovered?.source).toContain("pre-sqlite.bak");
  });

  test("空目录返回 null(调用方回默认状态)", () => {
    const { dir, statePath } = tempDataDir();
    expect(recoverStateFromBackups(dir, statePath)).toBeNull();
  });
});

describe("maybeAdoptFresherRecovery(R1-2 终极补强:state.json 完好但落后于 recovery)", () => {
  test("recovery 比 state.json 新 → 采用;文件原样保留(幂等重采用)", () => {
    const { dir, statePath } = tempDataDir();
    writeWithMtime(statePath, JSON.stringify({ settings: { assistantId: "上次成功保存" } }), NOW_SEC - 3600);
    writeWithMtime(join(dir, "state.json.recovery-9000.json"), JSON.stringify({ settings: { assistantId: "退出前最后一笔" } }), NOW_SEC - 60);

    const adopted = maybeAdoptFresherRecovery(dir, statePath);
    expect((adopted?.state.settings as { assistantId: string }).assistantId).toBe("退出前最后一笔");
    expect(readdirSync(dir)).toContain("state.json.recovery-9000.json");
    // 幂等:再跑一次采用到同一份
    const again = maybeAdoptFresherRecovery(dir, statePath);
    expect((again?.state.settings as { assistantId: string }).assistantId).toBe("退出前最后一笔");
  });

  test("recovery 比 state.json 旧 → 不采用(后续成功保存已包含其内容)", () => {
    const { dir, statePath } = tempDataDir();
    writeWithMtime(statePath, JSON.stringify({ settings: { assistantId: "最新" } }), NOW_SEC - 60);
    writeWithMtime(join(dir, "state.json.recovery-1000.json"), JSON.stringify({ settings: { assistantId: "早已过期" } }), NOW_SEC - 3600);

    expect(maybeAdoptFresherRecovery(dir, statePath)).toBeNull();
    expect(readdirSync(dir)).toContain("state.json.recovery-1000.json"); // 不动它,成功保存路径负责清
  });

  test("更新鲜的 recovery 损坏 → 回退到次新的更新鲜 recovery", () => {
    const { dir, statePath } = tempDataDir();
    writeWithMtime(statePath, JSON.stringify({ settings: { assistantId: "旧" } }), NOW_SEC - 3600);
    writeWithMtime(join(dir, "state.json.recovery-8000.json"), JSON.stringify({ settings: { assistantId: "次新完好" } }), NOW_SEC - 120);
    writeWithMtime(join(dir, "state.json.recovery-9000.json"), "{损坏", NOW_SEC - 60);

    const adopted = maybeAdoptFresherRecovery(dir, statePath);
    expect((adopted?.state.settings as { assistantId: string }).assistantId).toBe("次新完好");
  });

  test("state.json 不存在 → 返回 null(全新安装不受 recovery 干扰)", () => {
    const { dir, statePath } = tempDataDir();
    writeFileSync(join(dir, "state.json.recovery-9000.json"), JSON.stringify({ settings: {} }));
    expect(maybeAdoptFresherRecovery(dir, statePath)).toBeNull();
  });
});

describe("recovery 清扫(R1-2 ①③)", () => {
  test("sweepObsoleteRecoveryFilesIn 只删 recovery-*.json,不动 .applied 归档与 daily.bak", () => {
    const { dir, statePath } = tempDataDir();
    writeFileSync(join(dir, "state.json.recovery-1000.json"), "{}");
    writeFileSync(join(dir, "state.json.recovery-2000.json"), "{}");
    writeFileSync(join(dir, "state.json.recovery-500.json.applied-600"), "{}");
    writeFileSync(`${statePath}.daily.bak`, "{}");

    expect(sweepObsoleteRecoveryFilesIn(dir)).toBe(2);
    const names = readdirSync(dir);
    expect(names).not.toContain("state.json.recovery-1000.json");
    expect(names).not.toContain("state.json.recovery-2000.json");
    expect(names).toContain("state.json.recovery-500.json.applied-600");
    expect(names).toContain("state.json.daily.bak");
  });

  test("sweepAgedRecoveryArchivesIn 删超龄 .applied,保留近期归档与在用 recovery", () => {
    const { dir } = tempDataDir();
    writeWithMtime(join(dir, "state.json.recovery-1.json.applied-2"), "{}", NOW_SEC - 40 * 24 * 3600);
    writeWithMtime(join(dir, "state.json.recovery-3.json.applied-4"), "{}", NOW_SEC - 3 * 24 * 3600);
    writeWithMtime(join(dir, "state.json.recovery-5000.json"), "{}", NOW_SEC - 40 * 24 * 3600);

    expect(sweepAgedRecoveryArchivesIn(dir)).toBe(1);
    const names = readdirSync(dir);
    expect(names).not.toContain("state.json.recovery-1.json.applied-2");
    expect(names).toContain("state.json.recovery-3.json.applied-4");
    expect(names).toContain("state.json.recovery-5000.json"); // 未采用的 recovery 不按龄清(它可能是唯一救命稻草)
  });
});

describe("maybeWriteDailyBackupTo(1-3 每日滚动备份)", () => {
  test("当日首写落盘,同日不重复,跨日覆盖为单代", () => {
    const { statePath } = tempDataDir();
    const bakPath = `${statePath}.daily.bak`;
    const day1 = new Date("2099-01-01T08:00:00Z");
    const day1Later = new Date("2099-01-01T20:00:00Z");
    const day2 = new Date("2099-01-02T08:00:00Z");

    expect(maybeWriteDailyBackupTo(bakPath, '{"v":1}', day1)).toBe(true);
    expect(statSync(bakPath).size).toBeGreaterThan(0);
    const firstMtime = statSync(bakPath).mtimeMs;

    // 同日第二次:内存记忆命中,不重写
    expect(maybeWriteDailyBackupTo(bakPath, '{"v":2}', day1Later)).toBe(false);
    expect(statSync(bakPath).mtimeMs).toBe(firstMtime);

    // 次日:覆盖同一文件(单代滚动)
    expect(maybeWriteDailyBackupTo(bakPath, '{"v":3}', day2)).toBe(true);
    expect(JSON.parse(require("node:fs").readFileSync(bakPath, "utf8")).v).toBe(3);
  });
});
