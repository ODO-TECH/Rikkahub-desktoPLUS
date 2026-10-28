// ssh/workspace-binding.ts — 工作区 ↔「远程目录授权」的绑定解析(纯配置层)
//
// 为什么单独一层:工作区实体每次载入都要算边界根与健康状态(列表页、每轮工具挂载判定
// 都读它),这条路径必须无网络、无 ssh2、无 fs——本文件只 import 设备归一的纯函数
// (ssh/devices.ts 只碰 node:crypto)。真实连通性由工具执行与「测试连接」路由各自报错,
// 不在热路径上探测。
//
// 与安卓端的有意分歧(用户 2026-10-26 拍板的入口形态):安卓端把凭据存在工作区行里
// (WorkspaceEntity.ssh_config),rdp 的凭据与授权目录都在「拓展 › SSH」,工作区只存
// (设备 id, 目录 id) 两个引用。因此:
// - 工作区表里没有 root 也没有凭据,root 每次由设置派生——改了授权目录就等于换边界,
//   删了设备就等于工作区失效(managed 型 root 由 dataDir 派生的同一套自愈思路)。
// - 安卓端有常驻的 shellStatus(READY 才挂载工具),rdp 没有落库的连接状态,也就不假装
//   有:配置层三件事决定可用——设备在、目录填了且绝对、主机密钥确认过。
// - 信任门:folder 型要在创建工作区后显式确认;ssh 型的「同意让 AI 碰这台机器」已经
//   由「登记远程目录 + 确认主机密钥」两个动作表达过,创建即信任(见 workspace/index.ts)。

import type { SshDevice, SshRemoteDir } from "../foundation/types/settings";
import { state } from "../persistence/json-store";
import { findRemoteDir } from "./devices";
import { lexicalNormalize } from "./remote-path";

/** 一条可用的远程绑定:设备条目 + 授权目录条目 + 派生的边界根与身份标签。 */
export interface SshWorkspaceTarget {
  device: SshDevice;
  dir: SshRemoteDir;
  /** 边界根 = 授权目录绝对路径(POSIX,词法归一后)。不是本机路径。 */
  root: string;
  /** `user@host:port`——进界面、错误文案与系统提示词的远端身份;绝不含凭据。 */
  label: string;
}

/**
 * 绑定失效的四种原因(码即 `errors.ssh.*` 的 i18n 键尾段,与 ssh/errors.ts 的 SshInputError
 * 同一套通道:reason 是给模型看的英文,界面按码查中文)。
 */
export type SshBindingErrorCode =
  | "ssh.binding_device_missing"
  | "ssh.binding_dir_unauthorized"
  | "ssh.binding_path_invalid"
  | "ssh.binding_host_key_unconfirmed";

export interface SshBindingResult {
  /** null = 设备或授权目录已经不在了(绑定解析不出目标)。 */
  target: SshWorkspaceTarget | null;
  /** null = 工作区可用。非空 = 人话原因,与 runtime.ts 的本地不可用原因同语言(进模型错误文案)。 */
  reason: string | null;
  /** 与 reason 同步:界面按 `errors.<code>` 查文案,免得当着一串英文原因猜。 */
  errorCode: SshBindingErrorCode | null;
}

/** 远端身份标签:与 ssh/remote-files.ts 授权错误文案同一格式,界面上也用它。 */
export function sshDeviceLabel(device: SshDevice): string {
  return `${device.username}@${device.host}:${device.port}`;
}

/** 已保存的设备条目(设置里的 sshDevices)。state 在启动装载前为 undefined(单测常见),
 *  此时按「没有设备」处理,与 workspace/index.ts 的 state?.settings 范式一致。 */
export function savedSshDevice(deviceId: string | null | undefined): SshDevice | null {
  const wanted = String(deviceId ?? "").trim();
  if (!wanted) return null;
  const items = Array.isArray(state?.settings?.sshDevices) ? state.settings.sshDevices : [];
  return items.find((item) => item && item.id === wanted) ?? null;
}

/**
 * 解析工作区的远程绑定。任何一步不成立都给出「用户下一步该做什么」的原因,
 * 但仍然返回 target(只要设备与目录还在)——界面上的失效态要显示原路径才有意义。
 */
export function resolveSshBinding(
  deviceId: string | null | undefined,
  dirId: string | null | undefined,
): SshBindingResult {
  const device = savedSshDevice(deviceId);
  if (!device) {
    return {
      target: null,
      reason: "the SSH device bound to this workspace no longer exists — add it again in Extensions › SSH",
      errorCode: "ssh.binding_device_missing",
    };
  }
  const label = sshDeviceLabel(device);
  // findRemoteDir 认 id,也认逐字登记的旧路径(与文件面 authorizedRemoteDir 同一条查找规则)。
  const dir = dirId ? findRemoteDir(device, String(dirId)) : null;
  if (!dir || !dir.path) {
    return {
      target: null,
      reason: `the remote directory bound to this workspace is no longer authorized on ${label} — add it in Extensions › SSH`,
      errorCode: "ssh.binding_dir_unauthorized",
    };
  }
  let root: string;
  try {
    // 词法归一(不是只做斜杠折叠):授权目录里手写的 `..` 必须在这一步消掉,否则边界根带着
    // `..`、而工具侧的包含性判断是词法归一后的路径,两者永远对不上——表现为"目录明明授权了,
    // read 却说 path_escape"。相对路径仍然抛错(lexicalNormalize 内部走 normalizeRemotePath)。
    root = lexicalNormalize(dir.path);
  } catch {
    return {
      target: null,
      reason: `the authorized remote directory for ${label} is not an absolute path: ${dir.path}`,
      errorCode: "ssh.binding_path_invalid",
    };
  }
  const target: SshWorkspaceTarget = { device, dir, root, label };
  if (!device.hostKey) {
    return {
      target,
      reason: `the host key of ${label} has not been confirmed yet — confirm it in Extensions › SSH before this workspace can be used`,
      errorCode: "ssh.binding_host_key_unconfirmed",
    };
  }
  return { target, reason: null, errorCode: null };
}

/** 绑定是否已经可用(工具挂载/引擎选路用的谓词)。 */
export function sshBindingAvailable(binding: SshBindingResult): binding is SshBindingResult & { target: SshWorkspaceTarget } {
  return binding.target !== null && binding.reason === null;
}
