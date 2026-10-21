// SSH 远程设备(拓展 › SSH)。凭据与 providers.apiKey 同级:本地可信 UI 模型,随 settings
// 下发与入 state.json(备份同理)。纪律:凭据绝不进日志/请求记录;测试与执行端点只回结果。

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
}

export interface SshConfig {
  sshDevices: SshDevice[];
}
