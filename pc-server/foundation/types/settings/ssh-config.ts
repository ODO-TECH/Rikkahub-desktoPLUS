// SSH 远程设备(拓展 › SSH)。凭据与 providers.apiKey 同级:本地可信 UI 模型,随 settings
// 下发与入 state.json;但绝不进 Android 兼容备份(见 backup/export.ts 的剥离块)。
// 纪律:凭据绝不进日志/请求记录/错误文案;测试与执行只回结果。
// 字段语义与安卓端 SshWorkspaceSettings 对齐(主机密钥、远程目录授权),差异见 ssh/host-key.ts 头注。

/** 服务器出示的公钥:比对用的原始 blob 与给人看的指纹。 */
export interface SshHostKey {
  /** 算法名,取自 blob 头部,如 `ssh-ed25519`。 */
  type: string;
  /** 原始公钥 blob 的标准 base64。逐字节比较只认这个字段(指纹只是展示用)。 */
  key: string;
  /** `SHA256:<base64>`(OpenSSH 格式)。派生值:写入边界一律按 `key` 重算,不信客户端回传。 */
  fingerprint: string;
}

/** 设备上一个「允许访问的远程目录」授权;工作区只能绑定这里的条目,不能任意填路径。 */
export interface SshRemoteDir {
  id: string;
  /** 给人认的名字,如「编译机」。 */
  name: string;
  /** 绝对路径,尾斜杠已归一;空串归一为 `/`。 */
  path: string;
}

export interface SshDevice {
  id: string;
  name: string;
  host: string;
  /** 1–65535;缺省/非法按 22 归一。 */
  port: number;
  username: string;
  authType: "password" | "key";
  /** authType=password 时使用。 */
  password: string;
  /** authType=key 时使用(OpenSSH 私钥文本,可带口令)。 */
  privateKey: string;
  passphrase: string;
  /**
   * 已信任的主机密钥;null = 尚未确认,任何连接都会在认证前被拒绝(与安卓端一致:
   * 未确认的服务器不会收到凭据)。改 host/port 时由界面清空,强制重新确认。
   */
  hostKey: SshHostKey | null;
  /** 授权给工作区绑定的远程目录,按顺序展示。 */
  dirs: SshRemoteDir[];
}

export interface SshConfig {
  sshDevices: SshDevice[];
}
