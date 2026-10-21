// assets/fonts.ts — 字体清单与文件解析（内置/自定义/系统字体枚举、CSS 名称、文件定位）
// 纪律：纯搬迁自 server.ts（阶段 5.3b），行为不变。

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BuiltinManifest, FontEntry, FontWeightFile, ManifestEntry } from "../foundation/types";
import { customFontsDir, executableDir, rootDir } from "../foundation/paths";

const FONT_EXTENSIONS = [".woff2", ".woff", ".ttf", ".otf", ".ttc"] as const;
export const FONT_EXTENSIONS_SET = new Set<string>(FONT_EXTENSIONS);
export const FONT_MIME: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
};
const FONT_FORMAT: Record<string, string> = {
  ".woff2": "woff2",
  ".woff": "woff",
  ".ttf": "truetype",
  ".otf": "opentype",
  // .ttc(TrueType Collection)没有独立的 format 值,浏览器只认 truetype/opentype 等;
  // 写 "collection" 会让浏览器跳过整个 @font-face。用 truetype 取集合首个字形,是标准做法。
  ".ttc": "truetype",
};
// CJK 单文件可能十几 MB,留 50MB 余量足够;超过几乎一定是误传。
export const MAX_FONT_BYTES = 50 * 1024 * 1024;
const FONT_DEFAULT_FALLBACK = "system-ui, sans-serif";

// 真枚举失败时的兜底清单(Windows 锁死系统等情况)。
const COMMON_FONTS_FALLBACK: FontEntry[] = [
  "Microsoft YaHei", "DengXian", "Segoe UI", "SimSun", "SimHei", "KaiTi", "FangSong",
  "Consolas", "Times New Roman", "Arial", "Courier New",
].map((name) => ({
  id: `system:${name}`,
  label: name,
  cssName: name,
  family: `"${name}", ${FONT_DEFAULT_FALLBACK}`,
  source: "system" as const,
  weights: [] as FontWeightFile[],
}));

export function fontExtension(name: string): string {
  return name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
}
export function isFontFile(name: string): boolean {
  return FONT_EXTENSIONS_SET.has(fontExtension(name));
}
// 纯文件名:无路径分隔符、无 NUL。用于拒绝 path traversal(../etc/passwd 之类)。
export function isBareFileName(name: string): boolean {
  return !!name && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}
// @font-face family 名 = 文件名去扩展名。用全 stem(不去 -Regular 之类后缀)保证不撞名。
export function fontCssName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}
function fontFormat(fileName: string): string | undefined {
  return FONT_FORMAT[fontExtension(fileName)];
}
// 显示名美化:"LXGWWenKai-Regular" → "LXGWWenKai"。去掉常见字重后缀,空格替分隔符。
function prettifyFontLabel(fileName: string): string {
  return fontCssName(fileName)
    .replace(/[-_](regular|normal|book|light|medium|semibold|demibold|bold|black|thin|extralight|extrabold)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim() || fontCssName(fileName);
}
// 从 CSS font-family 链中取出第一个族名(@font-face 用它做 font-family)。
// `"A B", serif` → `A B`;`Cursive, serif` → `Cursive`。
function firstFamilyName(family: string): string {
  const m = family.trim().match(/^"([^"]+)"|^'([^']+)'|^([^,]+)/);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? family.trim()).trim();
}
function readBuiltinFontManifest(): BuiltinManifest {
  for (const p of [resolve(executableDir, "fonts", "manifest.json"), resolve(rootDir, "fonts", "manifest.json")]) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf-8")) as BuiltinManifest; }
      catch { /* 坏 manifest 忽略,降级到自动派生 */ }
    }
  }
  return {};
}

// 用 manifest 的 weights 定义构造一个字重族 entry。校验每个文件真实存在,过滤掉缺失的。
function makeWeightedFamilyEntry(source: "builtin" | "custom", manifestId: string, entry: ManifestEntry, fontDirs: string[]): FontEntry | null {
  const family = entry.family?.trim();
  if (!family || !Array.isArray(entry.weights) || entry.weights.length === 0) return null;
  const cssName = firstFamilyName(family);
  const weights: FontWeightFile[] = [];
  const seenFiles = new Set<string>();
  for (const w of entry.weights) {
    const fileName = w.file;
    if (!isBareFileName(fileName) || !isFontFile(fileName) || seenFiles.has(fileName.toLowerCase())) continue;
    seenFiles.add(fileName.toLowerCase());
    // 文件必须真实存在(任一目录),否则跳过——避免 @font-face 指向不存在的文件。
    const exists = fontDirs.some((d) => existsSync(join(d, fileName)));
    if (!exists) continue;
    weights.push({ fileName, weight: w.weight || 400, style: w.style === "italic" ? "italic" : "normal", format: fontFormat(fileName) });
  }
  if (weights.length === 0) return null;
  const label = entry.label?.trim() || cssName;
  return { id: `${source}:${manifestId}`, label, cssName, family, source, weights };
}

export function makeBundledFontEntry(source: "builtin" | "custom", fileName: string, override?: { label?: string; family?: string }): FontEntry {
  const cssName = override?.family?.trim() ? firstFamilyName(override.family) : fontCssName(fileName);
  const label = override?.label?.trim() || prettifyFontLabel(fileName);
  const family = override?.family?.trim() || `"${fontCssName(fileName)}", ${FONT_DEFAULT_FALLBACK}`;
  return {
    id: `${source}:${fileName}`,
    label,
    cssName,
    family,
    source,
    weights: [{ fileName, weight: 400, style: "normal", format: fontFormat(fileName) }],
  };
}

export function listBuiltinFonts(): FontEntry[] {
  const manifest = readBuiltinFontManifest();
  // 单文件 override 按文件名小写建索引,方便不区分大小写查找。
  const manifestByLowerFile: Record<string, ManifestEntry> = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (!v.weights) manifestByLowerFile[k.toLowerCase()] = v;
  }
  const fontDirs = [resolve(executableDir, "fonts"), resolve(rootDir, "fonts")];
  const out: FontEntry[] = [];
  const consumedFiles = new Set<string>();   // 已被某个 manifest 族消费的文件,跳过自动派生
  const seenAutoFiles = new Set<string>();

  // 1) 先处理 manifest 里带 weights 的字重族定义(HarmonyOS Sans 等)。
  for (const [manifestId, entry] of Object.entries(manifest)) {
    if (!entry.weights) continue;
    const built = makeWeightedFamilyEntry("builtin", manifestId, entry, fontDirs);
    if (built) {
      out.push(built);
      for (const w of built.weights) consumedFiles.add(w.fileName.toLowerCase());
    }
  }

  // 2) 扫描目录,对未被 manifest weights 消费的文件,自动派生(或读 manifest 单文件 override)。
  for (const dir of fontDirs) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!isFontFile(name)) continue;
      const key = name.toLowerCase();
      if (seenAutoFiles.has(key) || consumedFiles.has(key)) continue;
      seenAutoFiles.add(key);
      out.push(makeBundledFontEntry("builtin", name, manifestByLowerFile[key]));
    }
  }
  return out;
}

export function listCustomFonts(): FontEntry[] {
  try {
    mkdirSync(customFontsDir, { recursive: true });
    return readdirSync(customFontsDir)
      .filter(isFontFile)
      .map((name) => makeBundledFontEntry("custom", name));
  } catch {
    return [];
  }
}

// 系统字体枚举结果缓存(平台层一次)。去重(剔除与 builtin 重名的)在 listFontCatalog 做,
// 因为那依赖 builtin 列表,而 builtin 可能随 manifest 变化。
let cachedRawSystemFamilies: string[] | null = null;
function readSystemFontFamilies(): string[] {
  if (cachedRawSystemFamilies) return cachedRawSystemFamilies;
  const families = new Set<string>();
  try {
    if (process.platform === "linux") {
      // fc-list 的 family 字段:每行一个或多个族名(逗号分隔)。
      const proc = Bun.spawnSync(["fc-list", ":", "family"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
      const out = proc.stdout instanceof Buffer ? proc.stdout.toString("utf8") : String(proc.stdout ?? "");
      for (const line of out.split(/\r?\n/)) {
        for (const f of line.split(",")) {
          const name = f.trim();
          if (name && !name.includes(":")) families.add(name);
        }
      }
    } else if (process.platform === "win32") {
      // powershell.exe = Windows PowerShell 5.1,全 Windows 自带,System.Drawing 开箱即用。
      // InstalledFontCollection 返回干净的族名(无需解析字体二进制 name 表)。
      const script = "Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";
      const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      const out = proc.stdout instanceof Buffer ? proc.stdout.toString("utf8") : String(proc.stdout ?? "");
      for (const line of out.split(/\r?\n/)) {
        const name = line.trim();
        if (name) families.add(name);
      }
    }
  } catch {
    /* 枚举失败 → families 为空 → 走兜底清单 */
  }
  cachedRawSystemFamilies = families.size > 0 ? [...families].sort((a, b) => a.localeCompare(b)) : null;
  // 枚举失败时返回 []（而非 null）：签名是 string[]，null 会让调用方遍历崩溃；
  // 缓存仍存 null 保持"失败不缓存、下次重试"语义。（strictNullChecks 暴露的真实缺陷）
  return cachedRawSystemFamilies ?? [];
}

// 系统 FontEntry:剔除与 builtin/custom 同名的(用户:自带与系统重合的用自带的,不重复显示)。
export function listSystemFonts(excludeNames: Set<string>): FontEntry[] {
  const raw = readSystemFontFamilies();
  if (!raw) return COMMON_FONTS_FALLBACK.filter((entry) => !excludeNames.has(entry.cssName.toLowerCase()));
  return raw
    .filter((name) => !excludeNames.has(name.toLowerCase()))
    .map((name) => ({
      id: `system:${name}`,
      label: name,
      cssName: name,
      family: `"${name}", ${FONT_DEFAULT_FALLBACK}`,
      source: "system" as const,
      weights: [] as FontWeightFile[],
    }));
}

// 服务字体文件:builtin 从 executableDir/fonts 或 rootDir/fonts 找;custom 从 pc-data/fonts 找。
export function resolveFontFile(source: "builtin" | "custom", fileName: string): string | null {
  if (!isBareFileName(fileName) || !isFontFile(fileName)) return null;
  if (source === "custom") {
    const p = join(customFontsDir, fileName);
    return existsSync(p) ? p : null;
  }
  for (const dir of [resolve(executableDir, "fonts"), resolve(rootDir, "fonts")]) {
    const p = join(dir, fileName);
    if (existsSync(p)) return p;
  }
  return null;
}
