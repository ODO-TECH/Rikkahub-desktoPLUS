// 5-2/5-3 回归:zip 超时按体积自适应;附件暂存失败计数返回而非静默吞。
// R4-6 回归:staging 文件名跨平台清洗(非法字符/尾缀/设备保留名/超长名)。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adaptiveZipTimeoutMs, sanitizeStagingFileName, stageUploadFilesInto } from "./export";

describe("adaptiveZipTimeoutMs(5-2)", () => {
  test("小库维持 120s 基础值", () => {
    expect(adaptiveZipTimeoutMs(0)).toBe(120_000);
    expect(adaptiveZipTimeoutMs(10 * 1024 * 1024)).toBe(120_000 + 1250);
  });

  test("多 GB 附件库超时随体积增长(原 120s 硬上限的回归点)", () => {
    const fourGb = 4 * 1024 * 1024 * 1024;
    const ms = adaptiveZipTimeoutMs(fourGb);
    expect(ms).toBeGreaterThan(120_000);
    expect(ms).toBe(120_000 + 4096 * 125);
  });

  test("上限 30 分钟,不会无限增长", () => {
    expect(adaptiveZipTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(30 * 60_000);
  });
});

describe("stageUploadFilesInto(5-3)", () => {
  test("成功与失败分别计数,失败不中断后续文件,首个错误被记录", () => {
    const root = mkdtempSync(join(tmpdir(), "rikka-stage-test-"));
    try {
      const stage = join(root, "upload");
      mkdirSync(stage, { recursive: true });
      const okSrc = join(root, "ok.bin");
      writeFileSync(okSrc, "hello");

      const progress: string[] = [];
      const result = stageUploadFilesInto(
        stage,
        [
          { srcPath: join(root, "missing-a.bin"), name: "1.bin" },
          { srcPath: okSrc, name: "2.bin" },
          { srcPath: join(root, "missing-b.bin"), name: "3.bin" },
        ],
        (msg) => progress.push(msg),
      );

      expect(result.staged).toBe(1);
      expect(result.failed).toBe(2);
      expect(result.firstError).toContain("1.bin");
      expect(readFileSync(join(stage, "2.bin"), "utf8")).toBe("hello");
      expect(progress.length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("全部成功时 failed=0 且无 firstError", () => {
    const root = mkdtempSync(join(tmpdir(), "rikka-stage-test-"));
    try {
      const stage = join(root, "upload");
      mkdirSync(stage, { recursive: true });
      const src = join(root, "a.bin");
      writeFileSync(src, "x");
      const result = stageUploadFilesInto(stage, [{ srcPath: src, name: "a.bin" }]);
      expect(result).toEqual({ staged: 1, failed: 0, firstError: undefined });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sanitizeStagingFileName(R4-6)", () => {
  test("Windows 非法字符与控制符清洗为 _,结尾点/空格剥除", () => {
    expect(sanitizeStagingFileName("安卓:截图*2024?.png")).toBe("安卓_截图_2024_.png");
    expect(sanitizeStagingFileName("a<b>c|d.txt")).toBe("a_b_c_d.txt");
    expect(sanitizeStagingFileName("附件#3.png")).toBe("附件_3.png"); // D4:# 是引用锚分隔符
    expect(sanitizeStagingFileName(`tab${String.fromCharCode(9)}name.txt`)).toBe("tab_name.txt");
    expect(sanitizeStagingFileName("trailing. ")).toBe("trailing");
    expect(sanitizeStagingFileName("normal-file.pdf")).toBe("normal-file.pdf");
  });

  test("设备保留名(裸名/带扩展名/大小写)加前缀,前缀相似的正常名不误伤", () => {
    expect(sanitizeStagingFileName("CON.png")).toBe("_CON.png");
    expect(sanitizeStagingFileName("nul")).toBe("_nul");
    expect(sanitizeStagingFileName("aux.tar.gz")).toBe("_aux.tar.gz");
    expect(sanitizeStagingFileName("Com1.txt")).toBe("_Com1.txt");
    expect(sanitizeStagingFileName("console.png")).toBe("console.png");
    expect(sanitizeStagingFileName("communication.md")).toBe("communication.md");
  });

  test("超长名截干保尾缀,清洗后为空返回空串(调用方回退 id 名)", () => {
    const long = "x".repeat(300) + ".jpeg";
    const out = sanitizeStagingFileName(long);
    expect(out.length).toBe(150);
    expect(out.endsWith(".jpeg")).toBe(true);
    expect(sanitizeStagingFileName("???")).toBe("___");
    expect(sanitizeStagingFileName("")).toBe("");
    expect(sanitizeStagingFileName("...")).toBe("");
  });
});
