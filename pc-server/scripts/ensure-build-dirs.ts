// scripts/ensure-build-dirs.ts — 干净检出后的构建前置：把两个「产物目录」先建出来。
//
// 为什么需要：`bun build --compile --outfile ../dist/rikkahub-pc.exe` 与紧随其后的
// `Bun.write('../web-ui/src-tauri/binaries/…')` 都不会自建缺失的目录，直接
// ENOENT: could not open output directory "../dist"。而 dist/ 与 src-tauri/binaries/*.exe
// 都是 gitignore 的构建产物（117 MB sidecar 不入库），所以全新 clone 上第一次
// `bun run compile` 必然踩到——本机开发时目录早就存在，看不出问题。
// 两个平台的 compile 脚本都在最前面挂这一步。
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const dirs = [
  join(repoRoot, "dist"),
  join(repoRoot, "web-ui", "src-tauri", "binaries"),
];

for (const dir of dirs) mkdirSync(dir, { recursive: true });
console.log(`[ensure-build-dirs] 就位: ${dirs.map((d) => d.slice(repoRoot.length + 1)).join(", ")}`);
