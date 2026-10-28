// test-utils/ssh-fixtures.ts — SSH 测试共用的设备样本与假服务器脚手架。
//
// 只有一个设备形态是刻意的一致性:rdp 的连接层/池/SFTP/终端测试都得拿「同一份凭据」去连同一台假服务器,
// 一旦各处各写各的,改字段时就会出现半数测试编译不过、半数测试静默走默认值的情况。
// 全部是测试常量,不含任何真实主机、账号或密钥。

import type { SshDevice } from "../foundation/types/settings";
import { encodeHostKey } from "../ssh/host-key";
import { startFakeSshServer, type FakeSshServer } from "./fake-ssh-server";

export const TEST_PASSWORD = "test-password";
export const TEST_USERNAME = "tester";

export function fixtureDevice(patch: Partial<SshDevice> = {}, port = 1): SshDevice {
  return {
    id: "dev",
    name: "假服务器",
    host: "127.0.0.1",
    port,
    username: TEST_USERNAME,
    authType: "password",
    password: TEST_PASSWORD,
    privateKey: "",
    passphrase: "",
    hostKey: null,
    dirs: [],
    ...patch,
  };
}

/** 把假服务器的主机密钥变成「已信任」条目(与界面确认后的写入形态一致)。 */
export function trustedHostKey(server: FakeSshServer): SshDevice["hostKey"] {
  return encodeHostKey(Buffer.from(server.hostKeyBase64, "base64"));
}

/** 已信任 + 端口指向假服务器的完整设备:连接层测试的默认入参。 */
export function trustedDevice(server: FakeSshServer, patch: Partial<SshDevice> = {}): SshDevice {
  return { ...fixtureDevice(patch, server.port), hostKey: trustedHostKey(server) };
}

/** 起一台假服务器,跑完一定关掉(端口与凭据都在闭包里)。 */
export async function withFakeServer<T>(
  options: Parameters<typeof startFakeSshServer>[0],
  run: (server: FakeSshServer) => Promise<T>,
): Promise<T> {
  const server = await startFakeSshServer(options);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
