// backup/zip.ts — 备份 zip 打包与条目名卫生(专题3 Z-1 终极修复)
//
// 历史教训:Windows 上 PowerShell [ZipFile]::CreateFromDirectory 的产物条目名用反斜杠
// (upload\a.png)。zip 规范(APPNOTE 4.4.17)要求正斜杠;安卓恢复端按 "upload/" 前缀
// 逐条目匹配,反斜杠永远不命中 → 附件/skills/fonts 全部被静默跳过(用户"导入后图片
// 全裂/头像丢失"的载体级主因);Linux 端 unzip 则把反斜杠当作文件名字符,同样全丢。
// PC(Win)→PC(Win) 不受影响(Expand-Archive 兼容反斜杠),所以旧冒烟测不出来。
//
// 方案:Windows 仍用 PowerShell 打包,随后按中央目录精确遍历做条目名归一化
// (0x5C→0x2F,中央目录与 local header 成对修补;逐记录跳转,绝不全文件扫签名,
// 压缩数据里的伪 PK 签名不会误伤;名字字节长度不变,所有偏移与 CRC 均不受影响)。
// 解析器 zip64 感知(多 GB 附件库的备份必然超 4GiB)。
//
// ⚠️ 不要"优化"成系统自带 bsdtar(C:\Windows\System32\tar.exe):实测它按 ANSI 代码页
// 写条目名,中文/日文附件名和字体名会变成乱码字节,安卓端(UTF-8 解码)导入即损坏。
// .NET ZipFile 对非 ASCII 名字写 UTF-8 并置 EFS 标志,是 Windows 上唯一可靠的免装选择。

import { closeSync, existsSync, fstatSync, openSync, readSync, statSync, writeSync } from "node:fs";

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n <= 0) throw new Error(`zip 读取越界:pos=${position} len=${length}`);
    done += n;
  }
  return buf;
}

type CentralEntry = {
  /** 中央目录记录里 name 字段的绝对偏移。 */
  centralNameAt: number;
  /** 对应 local file header 的绝对偏移(zip64 感知)。 */
  localHeaderAt: number;
  name: Buffer;
};

/** 定位 EOCD → 中央目录,逐记录回调。zip64 感知(EOCD 占位符 0xFFFF/0xFFFFFFFF 时
 *  经 zip64 locator 取 64 位真值;单条记录的 local offset 占位时从 0x0001 扩展字段取)。 */
function forEachCentralEntry(fd: number, cb: (entry: CentralEntry) => void): void {
  const fileSize = fstatSync(fd).size;
  // EOCD 定长 22 字节 + 最长 65535 字节注释,从尾部窗口内倒扫签名 PK\x05\x06。
  const windowLen = Math.min(fileSize, 22 + 65535);
  const tail = readAt(fd, fileSize - windowLen, windowLen);
  let eocdInTail = -1;
  for (let i = windowLen - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocdInTail = i;
      break;
    }
  }
  if (eocdInTail < 0) throw new Error("zip 结构异常:找不到 EOCD");
  const eocdAt = fileSize - windowLen + eocdInTail;
  let totalEntries: number = tail.readUInt16LE(eocdInTail + 10);
  let centralOffset: number = tail.readUInt32LE(eocdInTail + 16);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff) {
    // zip64:EOCD 前 20 字节是 locator(PK\x06\x07),其 +8 处为 zip64 EOCD 的 64 位偏移。
    const locator = readAt(fd, eocdAt - 20, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50) throw new Error("zip 结构异常:zip64 locator 缺失");
    const eocd64At = Number(locator.readBigUInt64LE(8));
    const eocd64 = readAt(fd, eocd64At, 56);
    if (eocd64.readUInt32LE(0) !== 0x06064b50) throw new Error("zip 结构异常:zip64 EOCD 签名不符");
    totalEntries = Number(eocd64.readBigUInt64LE(32));
    centralOffset = Number(eocd64.readBigUInt64LE(48));
  }
  let pos = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    const fixed = readAt(fd, pos, 46);
    if (fixed.readUInt32LE(0) !== 0x02014b50) throw new Error(`zip 结构异常:第 ${i} 条中央目录签名不符`);
    const nameLen = fixed.readUInt16LE(28);
    const extraLen = fixed.readUInt16LE(30);
    const commentLen = fixed.readUInt16LE(32);
    const name = readAt(fd, pos + 46, nameLen);
    let localHeaderAt: number = fixed.readUInt32LE(42);
    if (localHeaderAt === 0xffffffff) {
      // local offset 在 0x0001 扩展字段里。字段内数据按"哪个定长域是占位符"依序排列:
      // 未压缩大小(8)→ 压缩大小(8)→ local offset(8)→ 磁盘号(4),只含占位的那些。
      const extra = readAt(fd, pos + 46 + nameLen, extraLen);
      let cursor = 0;
      let found = false;
      while (cursor + 4 <= extra.length) {
        const id = extra.readUInt16LE(cursor);
        const size = extra.readUInt16LE(cursor + 2);
        if (id === 0x0001) {
          let dataOff = cursor + 4;
          if (fixed.readUInt32LE(24) === 0xffffffff) dataOff += 8; // uncompressed size 占位
          if (fixed.readUInt32LE(20) === 0xffffffff) dataOff += 8; // compressed size 占位
          localHeaderAt = Number(extra.readBigUInt64LE(dataOff));
          found = true;
          break;
        }
        cursor += 4 + size;
      }
      if (!found) throw new Error(`zip 结构异常:第 ${i} 条 zip64 扩展字段缺 local offset`);
    }
    cb({ centralNameAt: pos + 46, localHeaderAt, name });
    pos += 46 + nameLen + extraLen + commentLen;
  }
}

/** 读取 zip 全部条目名(中央目录序)。测试与冒烟断言用。 */
export function listZipEntryNames(zipPath: string): string[] {
  const fd = openSync(zipPath, "r");
  try {
    const names: string[] = [];
    forEachCentralEntry(fd, ({ name }) => names.push(name.toString("utf-8")));
    return names;
  } finally {
    closeSync(fd);
  }
}

/** 把条目名里的反斜杠归一化为正斜杠(中央目录与 local header 成对修补,两处名字
 *  按 zip 规范必须一致)。名字字节长度不变,所有偏移/校验和(CRC 只覆盖数据)不受
 *  影响。返回修补的条目数。 */
export function normalizeZipEntrySeparators(zipPath: string): number {
  const fd = openSync(zipPath, "r+");
  try {
    let patched = 0;
    forEachCentralEntry(fd, ({ centralNameAt, localHeaderAt, name }) => {
      if (!name.includes(0x5c)) return;
      const fixedName = Buffer.from(name);
      for (let i = 0; i < fixedName.length; i++) {
        if (fixedName[i] === 0x5c) fixedName[i] = 0x2f;
      }
      writeSync(fd, fixedName, 0, fixedName.length, centralNameAt);
      const localFixed = readAt(fd, localHeaderAt, 30);
      if (localFixed.readUInt32LE(0) !== 0x04034b50) throw new Error("zip 结构异常:local header 签名不符");
      const localNameLen = localFixed.readUInt16LE(26);
      if (localNameLen === fixedName.length) {
        writeSync(fd, fixedName, 0, fixedName.length, localHeaderAt + 30);
      }
      patched++;
    });
    return patched;
  } finally {
    closeSync(fd);
  }
}

/** 把 stage 目录打成 zip。Windows 用 PowerShell(唯一可靠处理非 ASCII 名字的免装
 *  方案,见头注)+ 条目名归一化;非 Windows 用 zip CLI(本就是正斜杠)。 */
export function createZipFromDirectory(stageDir: string, targetZipPath: string, timeoutMs: number): void {
  if (process.platform !== "win32") {
    const proc = Bun.spawnSync(["zip", "-rq", targetZipPath, "."], { cwd: stageDir, timeout: timeoutMs });
    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 500);
      throw new Error(`Zip creation failed (exit ${proc.exitCode}): ${stderr || "unknown error"}`);
    }
    return;
  }
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${stageDir.replace(/'/g, "''")}', '${targetZipPath.replace(/'/g, "''")}')`,
  ].join("; ");
  const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: timeoutMs });
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 500);
    const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).slice(0, 200);
    throw new Error(`Zip creation failed (exit ${proc.exitCode}): ${stderr || stdout || "unknown error"}`);
  }
  if (!existsSync(targetZipPath) || statSync(targetZipPath).size === 0) {
    throw new Error("Zip creation failed: archive missing or empty after PowerShell exited 0");
  }
  normalizeZipEntrySeparators(targetZipPath);
}
