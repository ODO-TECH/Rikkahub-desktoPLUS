// updates/update-channel.test.ts — 更新通道的护栏。
//
// 契约：本分支的更新检查只能查**本仓库**的 Release，资产选择只能给出本分支的更新流程
// 真正能消费的东西。两条都是自伤面：
//   1. 查上游 → 上游发新 tag 时，用户点一下「检查更新」就被覆盖安装成上游形态，
//      SQLite 活库 / stdio MCP / WebView2 壳一起消失，且 pc-data 会被上游代码接手。
//   2. 把便携 zip 当安装器下发 → Windows 前端只会把路径交给 launch_installer 执行，
//      zip 不可执行；要么失败，要么让用户以为更新成功。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "rkh-update-channel-"));
process.env.RIKKAHUB_PC_DATA_DIR = dataDir;

const { UPDATE_REPO, UPDATE_R2_BASE, hasUpdateMirror, pickUpdateAsset, predictUpdateAssetName } =
  await import("./index");

afterAll(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// 本分支实际发布的资产名（2026-10-21 的 0.0.2 包），用于钉住「zip 不算安装器」。
const PORTABLE_ZIP = "RikkaHub-Desktop-PLUS-0.0.2-windows-x64-portable.zip";
const NSIS_EXE = "Rikkahub_0.0.2_x64-setup.exe";
const LINUX_TAR = "Rikkahub_0.0.2_linux_x64.tar.gz";

const assets = [
  { name: PORTABLE_ZIP, browser_download_url: "https://example.invalid/portable.zip", size: 83638889 },
  { name: NSIS_EXE, browser_download_url: "https://example.invalid/setup.exe", size: 1 },
  { name: LINUX_TAR, browser_download_url: "https://example.invalid/linux.tar.gz", size: 1 },
];

describe("更新通道指向本仓库", () => {
  test("仓库不是上游", () => {
    expect(UPDATE_REPO).not.toBe("yuh-G/rikkahub-desktop");
    expect(UPDATE_REPO.endsWith("/rikkahub-desktop")).toBe(false);
  });

  test("仓库是 ODO-TECH 的 PLUS 分支", () => {
    expect(UPDATE_REPO).toBe("ODO-TECH/Rikkahub-desktoPLUS");
  });

  test("镜像不指向上游 R2 桶", () => {
    // 上游桶里只有上游的安装包，用它当下载源等于把上游二进制装给本分支用户。
    expect(UPDATE_R2_BASE).not.toContain("pub-d26eee7d911c4bab937ebe1729a4cefe");
    if (hasUpdateMirror()) {
      expect(UPDATE_R2_BASE.startsWith("https://")).toBe(true);
    }
  });
});

describe("资产选择：只给本分支更新流程能消费的产物", () => {
  test("Windows 不把便携 zip 当安装器", () => {
    const picked = pickUpdateAsset([assets[0]], "win", false);
    expect(picked).toBeUndefined();
  });

  test("Windows 认 NSIS 安装器", () => {
    expect(pickUpdateAsset(assets, "win", false)?.name).toBe(NSIS_EXE);
  });

  test("Linux 认 tar.gz", () => {
    expect(pickUpdateAsset(assets, "linux", false)?.name).toBe(LINUX_TAR);
  });

  test("容器化部署不给资产（提示 docker pull）", () => {
    expect(pickUpdateAsset(assets, "linux", true)).toBeUndefined();
    expect(pickUpdateAsset(assets, "win", true)).toBeUndefined();
  });

  test("macOS 无发布物时不给资产", () => {
    expect(pickUpdateAsset(assets, "mac", false)).toBeUndefined();
  });
});

describe("API 限流兜底：不猜一个不存在的 Windows 安装器名", () => {
  test("Windows 返回 null", () => {
    expect(predictUpdateAssetName("0.0.2", "win")).toBeNull();
    expect(predictUpdateAssetName("0.0.2", "mac")).toBeNull();
  });

  test("Linux 沿用 tar.gz 命名约定", () => {
    expect(predictUpdateAssetName("0.0.2", "linux"))
      .toBe("Rikkahub_0.0.2_linux_x64.tar.gz");
  });
});
