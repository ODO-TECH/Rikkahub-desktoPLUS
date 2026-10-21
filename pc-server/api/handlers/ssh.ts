// api/handlers/ssh.ts — 拓展 › SSH:设备条目 CRUD、连接测试、一次性命令执行。
// 纪律:凭据只在内存/state 间流转,绝不写请求日志;测试与执行只回结果与耗时。
// 每次命令/测试都新建 SSH 连接(非长驻会话),失败/超时由 ssh/client.ts 收掉连接。

import type { JsonValue } from "../../foundation/types";
import type { SshDevice } from "../../foundation/types/settings";
import { isRecord } from "../../foundation/utils";
import { state } from "../../persistence/json-store";
import { updateSettings } from "../../app-config";
import { error, json, readJson } from "../request";
import { parseSshDevice, sshCredentialError } from "../../ssh/devices";
import { runSshCommand, testSshConnection } from "../../ssh/client";

const EXEC_TIMEOUT_DEFAULT_MS = 30_000;
const EXEC_TIMEOUT_MAX_MS = 120_000;

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
  if (missing === "password") return error("Password is required for password authentication", 400);
  if (missing === "key") return error("Private key is required for key authentication", 400);
  return null;
}

/** 连接前的完整性:保存允许半成品草稿(自动保存逐键落库),测试/执行才要求能连。 */
function connectionError(device: SshDevice): Response | null {
  if (!device.host || !device.username) return error("host and username are required", 400);
  return credentialError(device);
}

function sshFailure(err: unknown): Response {
  return error(err instanceof Error ? err.message : String(err), 502);
}

export async function handleSshRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "ssh/device" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const device = parseSshDevice(body);
    // 名称也算内容:新建的空壳先有名字,用户才能在上方标题里认出它;三项全空视为脏请求。
    if (!device || (!device.name && !device.host && !device.username)) {
      return error("name, host or username is required", 400);
    }
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

  if (path === "ssh/test" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const device = resolveDevice(body);
    if (!device) return error("SSH device not found", 404);
    const missing = connectionError(device);
    if (missing) return missing;
    try {
      return json({ status: "ok", ...(await testSshConnection(device)) });
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
    const requested = Number(body.timeoutMs);
    const timeoutMs = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, EXEC_TIMEOUT_MAX_MS)
      : EXEC_TIMEOUT_DEFAULT_MS;
    try {
      return json({ status: "ok", ...(await runSshCommand(device, command, timeoutMs)) });
    } catch (err) {
      return sshFailure(err);
    }
  }

  return null;
}
