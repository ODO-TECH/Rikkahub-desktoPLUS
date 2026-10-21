// scripts/check-version-sync.ts — 版本一致性检查（N-6）
// 四处版本号必须一致：pc-server/updates/index.ts 的 APP_VERSION、
// web-ui/src-tauri/tauri.conf.json、web-ui/src-tauri/Cargo.toml、
// web-ui/app/components/settings/about.tsx（关于页展示值）。
// 更新检查用 APP_VERSION 对比 GitHub release，Tauri 安装包版本取自 tauri.conf.json/Cargo.toml，
// 任何一处漏改都会导致更新提示错乱或安装包版本标错。CI 中运行，漏改直接红灯。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

const updatesSource = readFileSync(join(root, "pc-server", "updates", "index.ts"), "utf8");
const appVersion = updatesSource.match(/export const APP_VERSION = "([^"]+)"/)?.[1];

const tauriVersion = (JSON.parse(readFileSync(join(root, "web-ui", "src-tauri", "tauri.conf.json"), "utf8")) as { version?: string }).version;

const cargoSource = readFileSync(join(root, "web-ui", "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = cargoSource.match(/^version = "([^"]+)"/m)?.[1];

const aboutSource = readFileSync(join(root, "web-ui", "app", "components", "settings", "about.tsx"), "utf8");
const aboutVersion = aboutSource.match(/const APP_VERSION = "([^"]+)"/)?.[1];

const versions: Record<string, string | undefined> = {
  "pc-server/updates/index.ts APP_VERSION": appVersion,
  "web-ui/src-tauri/tauri.conf.json": tauriVersion,
  "web-ui/src-tauri/Cargo.toml": cargoVersion,
  "web-ui/app/components/settings/about.tsx": aboutVersion,
};

const values = Object.values(versions);
if (values.some((v) => !v) || new Set(values).size !== 1) {
  console.error("版本号不一致：");
  for (const [where, v] of Object.entries(versions)) console.error(`  ${where}: ${v ?? "（未找到）"}`);
  process.exit(1);
}
console.log(`版本一致性检查通过：${appVersion}`);
