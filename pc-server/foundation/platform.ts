// foundation/platform.ts — 运行时平台检测
// 纪律：只导出平台相关常量和函数，不依赖业务逻辑。目录创建只发生在 tempDir() 被调用时，
// 模块加载本身无副作用。

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";

// 暂存根目录固定在 dataDir/tmp。曾优先取 %TEMP%，而 Windows 上它在 C 盘：导出/导入/
// Kelivo/云同步的 staging 全落系统盘，任务中途关窗还会留残包（清理是 best-effort），
// 便携版"数据不出目录"的承诺也破了。RIKKAHUB_TEMP_DIR 仅供测试/脚本显式改道。
export const stagingDir = join(dataDir, "tmp");

export function tempDir(): string {
  const override = process.env.RIKKAHUB_TEMP_DIR;
  const dir = override && override.trim().length > 0 ? override : stagingDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function osType(): string {
  if (process.platform === "linux") return "Linux";
  if (process.platform === "darwin") return "macOS";
  return "Windows";
}

// 运行平台（用于自动更新：Windows 走 Tauri NSIS 安装器，Linux 走二进制原地替换）。
// 与 analyticsOs() 的划分保持一致 —— Docker 容器内 process.platform 也是 "linux"，
// 这是对的：Docker 镜像就是 Linux 二进制，只是它的更新路径不同（见下）。
export const RUNTIME_PLATFORM: "win" | "mac" | "linux" =
  process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : "win";

// 容器化部署检测。Docker 内即使替换了 /app/rikkahub-pc，容器一旦重建就会回到镜像里的
// 旧版本，原地更新没有意义 —— 这类部署应当 docker pull 新镜像。检测 /.dockerenv（Docker
// 标准标记）或显式注入的环境变量（兼容其他容器运行时）。
export const RUNNING_IN_CONTAINER = existsSync("/.dockerenv") || process.env.RIKKAHUB_CONTAINER === "1";
