// scripts/check-version-sync.ts — 版本一致性检查（N-6）
// 五处版本号必须一致：pc-server/updates/index.ts 的 APP_VERSION、
// web-ui/src-tauri/tauri.conf.json、web-ui/src-tauri/Cargo.toml、
// web-ui/app/components/settings/about.tsx（关于页展示值），
// 以及 compose / Docker 文档 / README 里的镜像 tag。
// 更新检查用 APP_VERSION 对比 GitHub release，Tauri 安装包版本取自 tauri.conf.json/Cargo.toml，
// 镜像 tag 决定用户拉到的版本。任何一处漏改都会导致更新提示错乱、安装包标错或部署旧镜像。
// CI 中运行，漏改直接红灯。
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

// Cargo.lock 的 rikkahub 包版本：Tauri/CI 都用 `cargo build --locked`，lock 与 Cargo.toml
// 不一致时构建直接失败。校验它，比等到 Rust 阶段报错便宜得多。
const cargoLockSource = readFileSync(join(root, "web-ui", "src-tauri", "Cargo.lock"), "utf8");
const cargoLockVersion = cargoLockSource.match(/\[\[package\]\]\nname = "rikkahub"\nversion = "([^"]+)"/)?.[1];

const versions: Record<string, string | undefined> = {
  "pc-server/updates/index.ts APP_VERSION": appVersion,
  "web-ui/src-tauri/tauri.conf.json": tauriVersion,
  "web-ui/src-tauri/Cargo.toml": cargoVersion,
  "web-ui/src-tauri/Cargo.lock (package rikkahub)": cargoLockVersion,
  "web-ui/app/components/settings/about.tsx": aboutVersion,
};

// 镜像 tag：compose 是运行配置，Docker 文档与 README 是给用户的复制示例。
// 全部取 `rikkahub-desktop-plus:<tag>`，每个出现位置都要与 APP_VERSION 一致。
for (const rel of ["docker-compose.yml", "docs/DOCKER.md", "README.md"]) {
  const source = readFileSync(join(root, rel), "utf8");
  const matches = [...source.matchAll(/rikkahub-desktop-plus:([0-9][0-9A-Za-z.+-]*)/g)];
  if (matches.length === 0) {
    versions[`${rel} (image tag)`] = undefined;
    continue;
  }
  matches.forEach((match, index) => {
    versions[`${rel} (image tag #${index + 1})`] = match[1];
  });
}

const values = Object.values(versions);
if (values.some((v) => !v) || new Set(values).size !== 1) {
  console.error("版本号不一致：");
  for (const [where, v] of Object.entries(versions)) console.error(`  ${where}: ${v ?? "（未找到）"}`);
  process.exit(1);
}
console.log(`版本一致性检查通过：${appVersion}`);
