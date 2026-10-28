// api/handlers/ssh.ts — 拓展 › SSH:设备与其「已授权远程目录」的 CRUD、连接探测、一次性命令。
//
// 边界纪律(与安卓端 SshWorkspaceBackend 同构):
// - 远程访问范围由设备条目里的 dirs 授权决定;命令的 cwd 只能落在授权目录内,
//   传了没授权的路径一律 403,不给「先连上再说」的余地。
// - 文件面板与终端通道只认已保存的设备条目(见 fileParamsOf 上方注释):目录授权以落库那份为准。
// - 凭据只在内存/state 间流转,绝不写请求日志;响应里只有结果、耗时与主机密钥指纹。
// - 主机密钥在认证前核对:未信任/变更时错误里带回服务器出示的密钥与核对命令,
//   界面据此弹确认框,用户确认后由设备保存接口落 hostKey(不另开信任端点)。

import type { JsonValue } from "../../foundation/types";
import type { SshDevice } from "../../foundation/types/settings";
import { isRecord } from "../../foundation/utils";
import { state } from "../../persistence/json-store";
import { updateSettings } from "../../app-config";
import { JsonBodyError, error, json, mime, readJson } from "../request";
import {
  findRemoteDir,
  parseSshDevice,
  sshCredentialError,
  sshDeviceInputError,
} from "../../ssh/devices";
import { closeSshDevice, consoleTimeout, probeSshDevice, runSshCommand } from "../../ssh/client";
import { SshInputError } from "../../ssh/errors";
import { sshFailureBody, sshFailureInfo } from "../../ssh/failure";
import { MAX_DOWNLOAD_BYTES } from "../../ssh/constants";
import {
  authorizedRemoteDir,
  deleteRemoteEntry,
  listRemoteDir,
  previewRemoteFile,
  readRemoteBytes,
  uploadRemoteFile,
  writeRemoteText,
} from "../../ssh/remote-files";
import { sshPool } from "../../ssh/pool";

function devices(): SshDevice[] {
  // state 由 state-load 归一;测试/极端手改仍兜一层。
  return Array.isArray(state.settings.sshDevices) ? state.settings.sshDevices : [];
}

/** 测试/执行的目标:请求内联 draft(未保存也能测)优先,否则按 deviceId 取已保存条目。 */
function resolveDevice(body: Record<string, JsonValue>): SshDevice | null {
  if (isRecord(body.device)) return parseSshDevice(body.device);
  const deviceId = String(body.deviceId ?? "").trim();
  if (!deviceId) return null;
  return devices().find((item) => item.id === deviceId) ?? null;
}

function credentialError(device: SshDevice): Response | null {
  const missing = sshCredentialError(device);
  if (missing === "password") return error("Password is required for password authentication", 400, "ssh.missing_password");
  if (missing === "key") return error("Private key is required for key authentication", 400, "ssh.missing_key");
  return null;
}

/** 连接前的完整性:保存允许半成品草稿(自动保存逐键落库),测试/执行才要求能连。 */
function connectionError(device: SshDevice): Response | null {
  if (!device.host || !device.username) return error("host and username are required", 400);
  const oversized = sshDeviceInputError(device);
  if (oversized) return error("SSH device entry is invalid", 400, oversized);
  return credentialError(device);
}

/**
 * 命令的工作目录:dirId 优先(界面只给授权目录的 id),其次 cwd 必须逐字命中某条授权路径。
 * 返回 null 表示越权(403),返回 undefined 表示「不进入任何目录」——控制台的默认形态。
 */
function resolveCwd(device: SshDevice, body: Record<string, JsonValue>): string | null | undefined {
  const dirId = String(body.dirId ?? "").trim();
  if (dirId) {
    const dir = findRemoteDir(device, dirId);
    return dir?.path || null;
  }
  const raw = String(body.cwd ?? "").trim();
  if (!raw) return undefined;
  return device.dirs.some((dir) => dir.path === raw || `${dir.path}/` === `${raw}/`) ? raw : null;
}

/** 主机密钥失败:400 + errorCode + 服务器出示的密钥(界面要拿它做确认与逐字节比对)。 */
function sshFailure(err: unknown): Response {
  // 映射本体在 ssh/failure.ts:终端的 error 帧与这里必须同形,不能两处各写一份。
  const info = sshFailureInfo(err);
  return json(sshFailureBody(info), { status: info.status });
}

/** 文件面板路由的入参(三种来路合并后的形态)。 */
interface FileParams {
  deviceId: string;
  dirId: string;
  relPath: string;
  content?: string;
  overwrite: boolean;
  recursive: boolean;
  download: boolean;
  upload?: { name: string; bytes: Uint8Array };
}

/**
 * 文件路由的参数来路:GET/DELETE 在查询串,PUT/POST 在 JSON 体,upload 在 multipart 表单。
 * 字段名三处一致(deviceId/dirId/path),前端只维护一份参数构造。
 *
 * 为什么这三条只认已保存的设备条目,而 ssh/test 与 ssh/exec 允许内联 draft:那两条是
 * 「还没保存就想先看看」的正当需求,而目录授权跟着设备落库——面板与终端能浏览哪些目录,
 * 必须以用户在拓展页确认过的那份 dirs 为准,不能由一次请求现造一份。
 */
async function fileParamsOf(request: Request, url: URL, path: string): Promise<FileParams> {
  const base: FileParams = { deviceId: "", dirId: "", relPath: "", overwrite: true, recursive: false, download: false };
  if (request.method === "GET" || request.method === "DELETE") {
    const query = url.searchParams;
    return {
      ...base,
      deviceId: query.get("deviceId") ?? "",
      dirId: query.get("dirId") ?? "",
      relPath: query.get("path") ?? "",
      recursive: query.get("recursive") === "1" || query.get("recursive") === "true",
      download: query.get("download") === "1",
    };
  }
  if (path === "ssh/files/upload") {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      // 非 multipart 请求体(前端忘了设 Content-Type、或 body 干脆是 JSON):按「用户能改对的输入」
      // 抛 SshInputError,由本路由的 catch 统一回 400;裸 TypeError 会被 sshFailure 算成 502。
      throw new SshInputError("multipart/form-data body is required", "ssh.file_required");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new SshInputError("file is required", "ssh.file_required");
    return {
      ...base,
      deviceId: String(form.get("deviceId") ?? ""),
      dirId: String(form.get("dirId") ?? ""),
      relPath: String(form.get("path") ?? ""),
      upload: { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    };
  }
  const body = await readJson<Record<string, JsonValue>>(request);
  return {
    ...base,
    deviceId: String(body.deviceId ?? ""),
    dirId: String(body.dirId ?? ""),
    relPath: String(body.path ?? ""),
    content: typeof body.content === "string" ? body.content : undefined,
    // 编辑器保存就是「有意覆盖」:面板打开的已经是远端存在的那份内容。
    overwrite: body.overwrite !== false,
    recursive: body.recursive === true,
  };
}

/** 下载文件名:去掉引号、反斜杠与换行(响应头注入面),空则兜底。 */
function dispositionName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/["\\\r\n]/g, "").trim() || "download";
}

export async function handleSshRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "ssh/device" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const device = parseSshDevice(body);
    // 名称也算内容:新建的空壳先有名字,用户才能在上方标题里认出它;三项全空视为脏请求。
    if (!device || (!device.name && !device.host && !device.username)) {
      return error("name, host or username is required", 400);
    }
    const invalid = sshDeviceInputError(device);
    if (invalid) return error("SSH device entry is invalid", 400, invalid);
    const items = devices();
    const exists = items.some((item) => item.id === device.id);
    updateSettings({
      ...state.settings,
      sshDevices: exists ? items.map((item) => (item.id === device.id ? device : item)) : [...items, device],
    });
    return json({ status: "ok", device });
  }

  const deviceDelete = path.match(/^ssh\/device\/([^/]+)$/);
  if (deviceDelete && request.method === "DELETE") {
    const deviceId = decodeURIComponent(deviceDelete[1]);
    // 删设备顺手把它那条带凭据的活连接收掉,不等空闲 5 分钟。
    closeSshDevice(deviceId);
    updateSettings({
      ...state.settings,
      sshDevices: devices().filter((item) => item.id !== deviceId),
    });
    return json({ status: "deleted" });
  }

  if (path === "ssh/reorder" && request.method === "POST") {
    const body = await readJson<{ ids?: string[] }>(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const byId = new Map(devices().map((item) => [item.id, item]));
    const ordered = ids.flatMap((itemId) => {
      const item = byId.get(itemId);
      return item ? [item] : [];
    });
    const rest = devices().filter((item) => !ids.includes(item.id));
    updateSettings({ ...state.settings, sshDevices: [...ordered, ...rest] });
    return json({ status: "ok" });
  }

  // 测试连接 = 探测:除耗时外还回 shell/主目录/目标目录状态,界面据此显示「远端实情」。
  if (path === "ssh/test" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const device = resolveDevice(body);
    if (!device) return error("SSH device not found", 404);
    const missing = connectionError(device);
    if (missing) return missing;
    // 探测的两条来路:dirId/cwd 走授权校验;remoteDir 是给编辑表单用的「先看看这个路径存不存在」,
    // 它只做一次 stat 与报告,不构成授权——受授权约束的是 exec 与后面的文件/终端通道。
    const granted = resolveCwd(device, body);
    if (granted === null) return error("Path is not an authorized remote directory", 403, "ssh.path_escape");
    const target = granted ?? String(body.remoteDir ?? "");
    try {
      const result = await probeSshDevice(device, target, request.signal);
      return json({ status: "ok", ...result });
    } catch (err) {
      return sshFailure(err);
    }
  }

  if (path === "ssh/exec" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const command = String(body.command ?? "").trim();
    if (!command) return error("command is required", 400);
    const device = resolveDevice(body);
    if (!device) return error("SSH device not found", 404);
    const missing = connectionError(device);
    if (missing) return missing;
    const cwd = resolveCwd(device, body);
    if (cwd === null) return error("Path is not an authorized remote directory", 403, "ssh.path_escape");
    try {
      const result = await runSshCommand(device, command, {
        cwd,
        timeoutMs: consoleTimeout(Number(body.timeoutMs)),
        signal: request.signal,
      });
      return json({ status: "ok", ...result });
    } catch (err) {
      return sshFailure(err);
    }
  }

  // ---- 远程文件面板(路由形状与 workspaces/<id>/files* 对齐,前端一套组件两用) ----
  if (path === "ssh/files" || path.startsWith("ssh/files/")) {
    try {
      // 取参也在 try 里:fileParamsOf 会抛 SshInputError(file 字段不是文件),而 formData()
      // 对非 multipart 请求体同样抛错——落在 try 之外就是 500,而这些都是用户能改对的输入。
      const params = await fileParamsOf(request, _url, path);
      const device = devices().find((item) => item.id === params.deviceId.trim()) ?? null;
      if (!device) return error("SSH device not found", 404, "ssh.device_not_found");
      // 授权判定统一交给 authorizedRemoteDir:目录不在设备上就直接抛,连都不连。
      // 拿到的是登记条目本身,后面一律用它的 id,省掉「按路径进来的那次匹配」再走一遍。
      if (path === "ssh/files" && request.method === "GET") {
        const dir = authorizedRemoteDir(device, params.dirId);
        return json({ entries: await listRemoteDir(device, dir.id, params.relPath), dir, path: params.relPath });
      }
      if (path === "ssh/files/content" && request.method === "GET") {
        const dir = authorizedRemoteDir(device, params.dirId);
        return json({ preview: await previewRemoteFile(device, dir.id, params.relPath) });
      }
      if (path === "ssh/files/raw" && request.method === "GET") {
        const dir = authorizedRemoteDir(device, params.dirId);
        const bytes = await readRemoteBytes(device, dir.id, params.relPath, MAX_DOWNLOAD_BYTES);
        // 只有 PDF 允许 inline(与本地工作区同一规则:远端的 HTML/SVG 以本应用同源内联
        // 就是脚本执行面)。其余一律 attachment——浏览器只落盘,不解释内容。
        const inline = /\.pdf$/i.test(params.relPath) && !params.download;
        // 零拷贝交给响应:TS 的 DOM 声明把 Buffer 背后的缓冲算成 ArrayBufferLike,与 BodyInit
        // 对不上(SharedArrayBuffer 之嫌),运行时 Bun 收 Buffer 没有任何问题。
        return new Response(bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": mime(params.relPath),
            "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${dispositionName(params.relPath)}"`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (path === "ssh/files/content" && request.method === "PUT") {
        if (typeof params.content !== "string") return error("content is required", 400);
        const dir = authorizedRemoteDir(device, params.dirId);
        return json({ entry: await writeRemoteText(device, dir.id, params.relPath, params.content, params.overwrite) });
      }
      if (path === "ssh/files/upload" && request.method === "POST") {
        const dir = authorizedRemoteDir(device, params.dirId);
        const upload = params.upload;
        if (!upload) return error("file is required", 400);
        // 上限判定在 domain 层(uploadRemoteFile):表单已经整份进内存了才拒,
        // 与仓库里其它 formData 端点同一条已知取舍(见 backup/import.ts 上方注释)。
        return json({ entry: await uploadRemoteFile(device, dir.id, params.relPath, upload.name, upload.bytes) });
      }
      if (path === "ssh/files" && request.method === "DELETE") {
        const dir = authorizedRemoteDir(device, params.dirId);
        // 回 boolean 而不是本地路由的 204:目标本就不存在时安卓端回 false,界面按「已删除」处理
        // 并继续刷新列表,不该为此弹一个错误。
        return json({ deleted: await deleteRemoteEntry(device, dir.id, params.relPath, params.recursive) });
      }
      return null;
    } catch (err) {
      // 坏 JSON 交回 router 的统一映射(api/router.ts 里 JsonBodyError → 400):取参在 try 内,
      // 不重抛会被 sshFailure 当成远端失败报 502。
      if (err instanceof JsonBodyError) throw err;
      return sshFailure(err);
    }
  }

  // 连接池状态:界面显示「哪台设备正复用着连接」,也让「空闲断开」这件事可观察。
  if (path === "ssh/connections" && request.method === "GET") {
    return json({ status: "ok", deviceIds: sshPool.connectedDevices() });
  }

  if (path === "ssh/disconnect" && request.method === "POST") {
    const body = await readJson<{ deviceId?: string }>(request);
    const deviceId = String(body.deviceId ?? "").trim();
    if (deviceId) closeSshDevice(deviceId);
    else sshPool.closeAll();
    return json({ status: "ok" });
  }

  return null;
}
