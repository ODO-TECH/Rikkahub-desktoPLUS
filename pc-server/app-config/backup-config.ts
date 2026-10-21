// app-config/backup-config.ts — WebDAV / S3 备份配置的规范化（纯函数,无 IO）
// 0-2:原住 backup/storage.ts,但 persistence/state-load(normalizeState)也要用它,
// 形成 storage → import → state-load → storage 的运行时循环依赖——今天不炸只因环上
// 全是提升的 function 声明,任何人改成 const 箭头函数就是 TDZ ReferenceError。
// 配置规范化不属于 backup 域,下沉到 app-config 断环。

import type { S3Config, WebDavConfig } from "../foundation/types";
import { getStringArray, isRecord } from "../foundation/utils";

export function normalizeWebDavConfig(value: unknown): WebDavConfig {
  const raw = isRecord(value) ? value : {};
  const items = getStringArray(raw.items).filter((item) => item === "DATABASE" || item === "FILES");
  return {
    url: String(raw.url ?? ""),
    username: String(raw.username ?? ""),
    password: String(raw.password ?? ""),
    path: String(raw.path ?? "rikkahub_backups") || "rikkahub_backups",
    items: items.length ? items : ["DATABASE", "FILES"],
  };
}

export function normalizeS3Config(value: unknown): S3Config {
  const raw = isRecord(value) ? value : {};
  const items = getStringArray(raw.items).filter((item) => item === "DATABASE" || item === "FILES");
  // 对齐 APP 字段。兼容旧 PC 值:forcePathStyle → pathStyle(语义相同);prefix 已废弃(APP 用硬编码
  // rikkahub_backups/),忽略。pathStyle/forcePathStyle 都缺失时默认 true(与 APP 默认一致)。
  const hasPath = "pathStyle" in raw;
  const hasForce = "forcePathStyle" in raw;
  const pathStyle = hasPath ? raw.pathStyle === true : hasForce ? raw.forcePathStyle === true : true;
  return {
    endpoint: String(raw.endpoint ?? ""),
    accessKeyId: String(raw.accessKeyId ?? ""),
    secretAccessKey: String(raw.secretAccessKey ?? ""),
    bucket: String(raw.bucket ?? ""),
    region: String(raw.region ?? "auto") || "auto",
    pathStyle,
    items: items.length ? items : ["DATABASE", "FILES"],
  };
}
