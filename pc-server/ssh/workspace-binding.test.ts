// ssh/workspace-binding.test.ts — 工作区远程绑定解析的配置层契约(纯函数,不起服务器)。
//
// 为什么单独测:这一层决定「工作区列表上那枚失效徽标」「工具到底挂不挂」「模型看到的开场
// 提示词走哪一支」,而它判的是配置而不是连通性。四种失效原因必须各归各位——把它们混成
// 一句"SSH 不可用",界面就没法告诉用户下一步该点哪里(重新加设备 / 重新授权目录 /
// 改成绝对路径 / 确认主机密钥是四个完全不同的动作)。
//
// 纪律:fixture 全是测试常量;断言只认 errorCode(界面按 errors.<code> 查文案),
// reason 只断言"是给模型看的英文"这一属性,不锁措辞。

import { describe, expect, test } from "bun:test";
import type { State } from "../foundation/types";
import type { SshDevice, SshRemoteDir } from "../foundation/types/settings";
import { setState } from "../persistence/json-store";
import { fixtureDevice } from "../test-utils/ssh-fixtures";
import { resolveSshBinding, savedSshDevice, sshBindingAvailable, sshDeviceLabel } from "./workspace-binding";

const APP: SshRemoteDir = { id: "dir-app", name: "应用目录", path: "/srv/app" };
const DRAFT: SshRemoteDir = { id: "dir-draft", name: "", path: "   " };

/** 把设备写进全局 state.settings(工作区侧唯一读取点),返回原样设备便于断言。 */
function withDevices(devices: SshDevice[]): SshDevice[] {
  setState({ settings: { sshDevices: devices } } as unknown as State);
  return devices;
}

function bound(overrides: Partial<SshDevice> = {}) {
  return fixtureDevice({ hostKey: { type: "ssh-ed25519", key: "AAAAB3Nj", fingerprint: "SHA256:test" }, dirs: [APP, DRAFT], ...overrides });
}

describe("绑定解析成功的形状", () => {
  test("设备在、目录已授权、主机密钥已确认 → target 齐全且无 reason", () => {
    const device = withDevices([bound()])[0];
    const binding = resolveSshBinding(device.id, APP.id);
    expect(sshBindingAvailable(binding)).toBe(true);
    expect(binding.reason).toBeNull();
    expect(binding.errorCode).toBeNull();
    expect(binding.target?.root).toBe("/srv/app");
    // label 只带 user@host:port:界面与提示词都用它,凭据字段绝不允许出现在里面。
    const label = `${device.username}@${device.host}:${device.port}`;
    expect(binding.target?.label).toBe(label);
    expect(sshDeviceLabel(device)).toBe(label);
    expect(binding.target?.dir.id).toBe(APP.id);
  });

  test("dirId 认 id 也认逐字登记的旧路径(与文件面同一条查找规则)", () => {
    const device = withDevices([bound()])[0];
    expect(resolveSshBinding(device.id, APP.path).target?.dir.id).toBe(APP.id);
  });

  test("根路径词法归一:尾斜杠/重复斜杠消掉,`..` 也消——边界根与工具侧包含性判断同一口径", () => {
    const device = withDevices([bound({ dirs: [{ id: "d", name: "", path: "/srv/app/logs///../" }] })])[0];
    expect(resolveSshBinding(device.id, "d").target?.root).toBe("/srv/app");
    // 归一到根:授权整个文件系统时边界根是 "/"(不是空串,否则 cwd 拼接会拼出 "//")。
    const rootDevice = withDevices([bound({ dirs: [{ id: "r", name: "", path: "//" }] })])[0];
    expect(resolveSshBinding(rootDevice.id, "r").target?.root).toBe("/");
  });
});

describe("四种失效原因各归各位", () => {
  test("设备不存在(含 id 为空) → binding_device_missing", () => {
    withDevices([bound()]);
    const missing = resolveSshBinding("gone", APP.id);
    expect(missing.errorCode).toBe("ssh.binding_device_missing");
    expect(missing.target).toBeNull();
    expect(resolveSshBinding(null, APP.id).errorCode).toBe("ssh.binding_device_missing");
    expect(resolveSshBinding("", APP.id).errorCode).toBe("ssh.binding_device_missing");
    // 原因文案是给模型读的英文,界面走 errorCode——这里只钉住"不是中文"这一点。
    expect(missing.reason).not.toMatch(/[\u4e00-\u9fff]/);
  });

  test("目录被取消授权 / 目录 id 空 → binding_dir_unauthorized;target 仍为 null", () => {
    const device = withDevices([bound()])[0];
    const gone = resolveSshBinding(device.id, "dir-nope");
    expect(gone.errorCode).toBe("ssh.binding_dir_unauthorized");
    expect(gone.target).toBeNull();
    expect(resolveSshBinding(device.id, null).errorCode).toBe("ssh.binding_dir_unauthorized");
    // 只填了名字的草稿目录:条目还在(所以不是"取消授权"),但路径是空白 —— 与文件面
    // authorizedRemoteDir 同一判据,归到"路径非法"而不是"没授权",两条出口的修法不同。
    expect(resolveSshBinding(device.id, DRAFT.id).errorCode).toBe("ssh.binding_path_invalid");
  });

  test("授权目录不是绝对路径 → binding_path_invalid(配置错了,不是连不上)", () => {
    const device = withDevices([bound({ dirs: [{ id: "rel", name: "", path: "srv/app" }] })])[0];
    const bad = resolveSshBinding(device.id, "rel");
    expect(bad.errorCode).toBe("ssh.binding_path_invalid");
    expect(bad.target).toBeNull();
  });

  test("主机密钥未确认 → 仍给出 target 但 reason 非空(界面要显示原路径才有意义)", () => {
    const device = withDevices([bound({ hostKey: null })])[0];
    const unconfirmed = resolveSshBinding(device.id, APP.id);
    expect(unconfirmed.errorCode).toBe("ssh.binding_host_key_unconfirmed");
    expect(unconfirmed.target?.root).toBe("/srv/app");
    expect(sshBindingAvailable(unconfirmed)).toBe(false);
  });

  test("state 尚未装载(启动前/单测常态)按「没有设备」处理,不抛", () => {
    setState({ settings: {} } as unknown as State);
    expect(savedSshDevice("dev")).toBeNull();
    expect(resolveSshBinding("dev", APP.id).errorCode).toBe("ssh.binding_device_missing");
  });

  test("sshDevices 不是数组的脏 state 也不炸", () => {
    setState({ settings: { sshDevices: null } } as unknown as State);
    expect(resolveSshBinding("dev", APP.id).errorCode).toBe("ssh.binding_device_missing");
  });
});
