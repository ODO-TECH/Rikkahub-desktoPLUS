// 文件面分派与能力表的纯函数测试(0.0.4 SSH 对齐)。
// 这里定的每一条都直接决定「点了会发生什么」:选错源就是拿本地路由打远程工作区(必 400),
// 能力表错一格就是画出一个必定失败的菜单项,remoteEditInfo 错判会把截断过的前 512KB
// 当成完整文件存回远端(静默丢尾巴)。所以只测这些判定,不测 fetch 本身。
import { describe, expect, test } from "bun:test";

import {
  capabilitiesOf,
  downloadFileUrl,
  fileSourceOf,
  rawFileUrl,
  remoteEditInfo,
} from "./workspace-file-source";

const LOCAL = { id: "w1", type: "local" as const, root: "C:/ws", sshDeviceId: null, sshDirId: null };
const REMOTE = { id: "w2", type: "ssh" as const, root: "/srv/app", sshDeviceId: "d1", sshDirId: "r1" };

describe("fileSourceOf", () => {
  test("本地工作区按 id 走 files*", () => {
    expect(fileSourceOf(LOCAL)).toEqual({ kind: "local", workspaceId: "w1" });
  });

  test("ssh 工作区按 (设备, 授权目录) 走 ssh/files*", () => {
    expect(fileSourceOf(REMOTE)).toEqual({ kind: "remote", deviceId: "d1", dirId: "r1" });
  });

  test("ssh 绑定断了(目录或设备 id 缺失)不给来源,而不是发一条注定 400 的请求", () => {
    expect(fileSourceOf({ ...REMOTE, sshDirId: "" })).toBeNull();
    expect(fileSourceOf({ ...REMOTE, sshDeviceId: null })).toBeNull();
  });

  test("工作区不在 store 里就没有文件面", () => {
    expect(fileSourceOf(null)).toBeNull();
    expect(fileSourceOf(undefined)).toBeNull();
  });
});

describe("capabilitiesOf", () => {
  test("本地:能改名/定位/AGENTS.md,不给上传下载终端", () => {
    expect(capabilitiesOf({ kind: "local", workspaceId: "w1" })).toEqual({
      rename: true,
      reveal: true,
      agents: true,
      remove: true,
      upload: false,
      download: false,
      terminal: false,
    });
  });

  test("远程:反过来——SFTP 没有改名,也没有宿主文件管理器,AGENTS.md 模型不读", () => {
    expect(capabilitiesOf({ kind: "remote", deviceId: "d1", dirId: "r1" })).toEqual({
      rename: false,
      reveal: false,
      agents: false,
      remove: true,
      upload: true,
      download: true,
      terminal: true,
    });
  });

  test("没有来源时一个动作都不给(连删除也不行——没有可删的对象)", () => {
    expect(capabilitiesOf(null).remove).toBe(false);
    expect(Object.values(capabilitiesOf(null)).every((value) => value === false)).toBe(true);
  });
});

describe("remoteEditInfo", () => {
  test("未截断的文本可编辑,行尾照文件实况报", () => {
    const info = remoteEditInfo({ kind: "text", text: "a\r\nb\r\n", truncated: false, size: 6 });
    expect(info.editable).toBe(true);
    expect(info.eol).toBe("\r\n");
    expect(info.etag).toBeNull();
    expect(info.limitBytes).toBe(2 * 1024 * 1024);
  });

  test("截断过的文本不可编辑:存回去会静默丢掉后半截", () => {
    const info = remoteEditInfo({ kind: "text", text: "前 512KB", truncated: true, size: 900_000 });
    expect(info.editable).toBe(false);
    expect(info.reason).toBe("too_large");
    // 提示的上限是「读到的那半截」的阈值,不是写入阈值,否则文案会说谎。
    expect(info.limitBytes).toBe(512 * 1024);
  });

  test("LF 文本报 LF", () => {
    expect(remoteEditInfo({ kind: "text", text: "a\nb", truncated: false, size: 3 }).eol).toBe("\n");
  });

  test("图片与二进制按各自原因拒绝", () => {
    expect(remoteEditInfo({ kind: "image", dataUrl: "data:image/png;base64,AA", size: 8 }).reason).toBe("image");
    expect(remoteEditInfo({ kind: "binary", size: 8 }).reason).toBe("binary");
  });
});

describe("rawFileUrl / downloadFileUrl", () => {
  test("本地走工作区 raw,路径做编码", () => {
    expect(rawFileUrl({ kind: "local", workspaceId: "w 1" }, "docs/a b.pdf")).toBe(
      "/api/workspaces/w%201/files/raw?path=docs%2Fa%20b.pdf",
    );
  });

  test("远程走 ssh/files/raw,三个参数都在 query 里", () => {
    const url = rawFileUrl({ kind: "remote", deviceId: "d 1", dirId: "r/1" }, "a b.txt");
    expect(url).toContain("/api/ssh/files/raw?");
    expect(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("deviceId")).toBe("d 1");
    expect(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("path")).toBe("a b.txt");
  });

  test("下载只在远程侧补 download=1(非 PDF 服务端本来就回 attachment,重复一次是为了 PDF)", () => {
    expect(downloadFileUrl({ kind: "local", workspaceId: "w1" }, "a.pdf")).toBe(
      "/api/workspaces/w1/files/raw?path=a.pdf",
    );
    expect(downloadFileUrl({ kind: "remote", deviceId: "d1", dirId: "r1" }, "a.pdf")).toBe(
      "/api/ssh/files/raw?deviceId=d1&dirId=r1&path=a.pdf&download=1",
    );
  });
});
