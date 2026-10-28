// workspace/workspace.test.ts — 工作区实体管理单测(M1-1)
// 覆盖:managed/folder 创建与目录生命周期、folder 根目录准入校验、权限档位、
// 信任门、删除(目录清理 + 归属会话经 working set 权威实例解绑)、列迁移幂等。
// ssh 型(2026-10-26 与移动端对齐)另覆盖:绑定两个 id、root 由设置派生、创建即信任、
// 远程目录的 1:1 open-or-create 与改绑冲突、绑定断裂后的失效原因、老库懒加列。
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-workspace-test-"));

const { workspacesDir, dataDir } = await import("../foundation/paths");
const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("./index");
const store = await import("../persistence/json-store");
const { TEST_PASSWORD: SSH_PASSWORD, fixtureDevice } = await import("../test-utils/ssh-fixtures");

const db = conversations.openConversationsDb();
// working set 注入是模块级全局,会被其他测试文件覆盖。在本文件 beforeAll 重注入,
// 保证本文件用例期间 getConversation 走真实 DB(详见 runtime.test.ts 同款注释)。
function installWorkingSet() {
  configureWorkingSet({
    loadConversation: (convId) => {
      const meta = getConversationMeta(db, convId);
      if (!meta) return undefined;
      meta.messages = conversations.loadConversationNodesFromDb(db, convId);
      return meta;
    },
    isGenerating: () => false,
    hasSseClients: () => false,
    hasDirty: () => false,
  });
}
installWorkingSet();
beforeAll(installWorkingSet);

function makeConversation(convId: string, workspaceId: string | null) {
  return {
    id: convId,
    assistantId: "a1",
    systemPrompt: null,
    title: `t-${convId}`,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    workspaceId,
    workspaceCwd: workspaceId ? "sub" : null,
  };
}

describe("managed 工作区", () => {
  test("创建:托管目录落地、创建即信任、默认平衡档、root 指向 files/", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "  我的工作区  " });
    expect(workspace.name).toBe("我的工作区");
    expect(workspace.type).toBe("managed");
    expect(workspace.permissionPreset).toBe("balanced");
    expect(workspace.trustedAt).not.toBeNull();
    expect(workspace.root).toBe(join(workspacesDir, workspace.id, "files"));
    expect(existsSync(workspace.root)).toBe(true);
    expect(existsSync(ws.workspaceTmpDir(workspace.id))).toBe(true);
    expect(ws.workspaceStatus(workspace)).toBe("ready");
  });

  test("空名回退默认名;列表可见", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "   " });
    expect(workspace.name).toBe("默认工作区");
    expect(ws.listWorkspaces().some((w) => w.id === workspace.id)).toBe(true);
  });
});

describe("folder 工作区准入校验", () => {
  test("操作系统系统目录被拒(等于或位于其内)", () => {
    if (process.platform === "win32") {
      const winDir = process.env.SystemRoot ?? "C:\\Windows";
      expect(() => ws.validateFolderRoot(winDir)).toThrow("不能以操作系统目录作为工作区");
      expect(() => ws.validateFolderRoot(winDir.toLowerCase())).toThrow("不能以操作系统目录作为工作区");
      expect(() => ws.validateFolderRoot(join(winDir, "System32"))).toThrow("不能以操作系统目录作为工作区");
    } else {
      expect(() => ws.validateFolderRoot("/etc")).toThrow("不能以操作系统目录作为工作区");
      expect(() => ws.validateFolderRoot("/usr/lib")).toThrow("不能以操作系统目录作为工作区");
    }
  });

  test("拒绝:相对路径/不存在/文件/盘符根/与数据目录重叠", () => {
    expect(() => ws.createWorkspace({ type: "folder", root: "relative/path" })).toThrow("绝对路径");
    expect(() => ws.createWorkspace({ type: "folder", root: join(tmpdir(), "rkh-definitely-missing-xyz") })).toThrow("不存在");
    const filePath = join(mkdtempSync(join(tmpdir(), "rkh-ws-f-")), "a.txt");
    writeFileSync(filePath, "x");
    expect(() => ws.createWorkspace({ type: "folder", root: filePath })).toThrow("不是目录");
    const diskRoot = parse(tmpdir()).root;
    expect(() => ws.createWorkspace({ type: "folder", root: diskRoot })).toThrow("根目录");
    expect(() => ws.createWorkspace({ type: "folder", root: dataDir })).toThrow("重叠");
    expect(() => ws.createWorkspace({ type: "folder", root: join(dataDir, "workspaces") })).toThrow("重叠");
    const parentOfData = join(dataDir, "..");
    expect(() => ws.createWorkspace({ type: "folder", root: parentOfData })).toThrow("重叠");
  });

  test("档位记忆:用户上次的选择成为新建工作区的默认档位", async () => {
    const store = await import("../persistence/json-store");
    const prev = store.state;
    // 最小合法 settings:只有本特性读写的键。finally 恢复原值,不向后续测试文件泄漏。
    store.setState({ settings: { workspaceLastPermissionPreset: null } } as never);
    try {
      const first = ws.createWorkspace({ type: "managed", name: "mem-1" });
      expect(first.permissionPreset).toBe("balanced"); // 无记忆 → 默认权限
      ws.updateWorkspace(first.id, { permissionPreset: "full_access" });
      const second = ws.createWorkspace({ type: "managed", name: "mem-2" });
      expect(second.permissionPreset).toBe("full_access"); // 继承上次选择
      const dir = mkdtempSync(join(tmpdir(), "rkh-ws-mem-"));
      const folder = ws.createWorkspace({ type: "folder", root: dir });
      expect(folder.permissionPreset).toBe("full_access"); // folder 型同样继承
    } finally {
      store.saveState(); // 冲掉可能挂起的节流定时器
      await store.flushSaveState(); // 等在飞/尾随写结算后再恢复,防止落盘协程读到恢复后的 undefined
      store.setState(prev as never);
    }
  });

  test("合法目录:未信任、默认权限档、默认名取目录名;信任门幂等", () => {
    const realDir = mkdtempSync(join(tmpdir(), "rkh-ws-real-"));
    const workspace = ws.createWorkspace({ type: "folder", root: realDir });
    expect(workspace.type).toBe("folder");
    expect(workspace.trustedAt).toBeNull();
    // 权限档位改版:folder 型不再默认最严档,风险由信任门把守,档位统一默认 balanced
    expect(workspace.permissionPreset).toBe("balanced");
    expect(workspace.name).toBe(realDir.split(sep).filter(Boolean).pop() ?? "");
    expect(workspace.root).toBe(realDir);

    const trusted = ws.trustWorkspace(workspace.id);
    expect(trusted?.trustedAt).not.toBeNull();
    const again = ws.trustWorkspace(workspace.id);
    expect(again?.trustedAt).toBe(trusted?.trustedAt);
  });

  test("根目录丢失 → status=missing(记录保留,对齐安卓 BROKEN)", () => {
    const goneDir = mkdtempSync(join(tmpdir(), "rkh-ws-gone-"));
    const workspace = ws.createWorkspace({ type: "folder", root: goneDir });
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(goneDir, { recursive: true, force: true });
    expect(ws.workspaceStatus(ws.getWorkspace(workspace.id)!)).toBe("missing");
    expect(ws.getWorkspace(workspace.id)).not.toBeNull();
  });
});

describe("更新与删除", () => {
  test("更新:改名+档位;无效档位拒绝", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "改名前" });
    const updated = ws.updateWorkspace(workspace.id, { name: "改名后", permissionPreset: "full_access" });
    expect(updated?.name).toBe("改名后");
    expect(updated?.permissionPreset).toBe("full_access");
    expect(() => ws.updateWorkspace(workspace.id, { permissionPreset: "yolo" })).toThrow("档位");
  });

  // B6-①b:folder 型重绑新目录 → root 更新且信任门重置(新边界需用户重确认);
  // managed 型 root 由 dataDir 派生不可改绑。
  test("重绑:folder 型改 root 重置信任门;managed 型拒改 root", () => {
    const dirA = mkdtempSync(join(tmpdir(), "rkh-ws-rebind-a-"));
    const folder = ws.createWorkspace({ type: "folder", root: dirA });
    ws.trustWorkspace(folder.id);
    expect(ws.getWorkspace(folder.id)?.trustedAt).not.toBeNull();

    const dirB = mkdtempSync(join(tmpdir(), "rkh-ws-rebind-b-"));
    const rebound = ws.updateWorkspace(folder.id, { root: dirB });
    expect(rebound?.root).toBe(dirB);
    expect(rebound?.trustedAt).toBeNull(); // 信任门重置,待重确认

    // 未信任工作区重绑仍保持未信任(不得因重绑意外获得信任)
    const dirC = mkdtempSync(join(tmpdir(), "rkh-ws-rebind-c-"));
    const rebound2 = ws.updateWorkspace(folder.id, { root: dirC });
    expect(rebound2?.root).toBe(dirC);
    expect(rebound2?.trustedAt).toBeNull();

    const managed = ws.createWorkspace({ type: "managed", name: "不可改绑" });
    expect(() => ws.updateWorkspace(managed.id, { root: dirA })).toThrow("folder");
  });

  test("删除 managed:宿主目录清除、归属会话解绑为对话模式(库行+权威实例)", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "待删" });
    const conv = makeConversation("conv-detach-1", workspace.id);
    conversations.persistConversation(conv);
    // 命中 working set:模拟活跃实例(检验解绑写的是权威实例而非仅库行)
    const held = conversations.getConversation(conv.id);
    expect(held?.workspaceId).toBe(workspace.id);

    expect(ws.deleteWorkspace(workspace.id)).toBe(true);
    expect(ws.getWorkspace(workspace.id)).toBeNull();
    expect(existsSync(join(workspacesDir, workspace.id))).toBe(false);
    // 权威实例已解绑
    expect(conversations.getConversation(conv.id)?.workspaceId).toBeNull();
    // 库行已解绑
    const row = db.prepare("SELECT workspace_id, workspace_cwd FROM pc_conversation WHERE id = ?").get(conv.id) as { workspace_id: string | null; workspace_cwd: string | null };
    expect(row.workspace_id).toBeNull();
    expect(row.workspace_cwd).toBeNull();
  });

  test("删除 folder:用户目录不动,仅宿主目录与记录消失", () => {
    const realDir = mkdtempSync(join(tmpdir(), "rkh-ws-keep-"));
    writeFileSync(join(realDir, "keep.txt"), "data");
    const workspace = ws.createWorkspace({ type: "folder", root: realDir });
    expect(ws.deleteWorkspace(workspace.id)).toBe(true);
    expect(existsSync(join(realDir, "keep.txt"))).toBe(true);
    expect(existsSync(join(workspacesDir, workspace.id))).toBe(false);
  });

  test("删除不存在的工作区返回 false", () => {
    expect(ws.deleteWorkspace("no-such-id")).toBe(false);
  });
});

describe("会话工作区列迁移", () => {
  test("workspace_id/workspace_cwd 随会话行写读回;老行缺省为 null", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "列迁移" });
    const bound = makeConversation("conv-cols-1", workspace.id);
    conversations.persistConversation(bound);
    const metas = conversations.loadConversationMetasFromDb(db);
    const boundMeta = metas.find((m) => m.id === bound.id);
    expect(boundMeta?.workspaceId).toBe(workspace.id);
    expect(boundMeta?.workspaceCwd).toBe("sub");

    const plain = makeConversation("conv-cols-2", null);
    conversations.persistConversation(plain);
    const plainMeta = conversations.loadConversationMetasFromDb(db).find((m) => m.id === plain.id);
    expect(plainMeta?.workspaceId).toBeNull();
    expect(plainMeta?.workspaceCwd).toBeNull();
  });

  test("建表/迁移幂等:对同一库重复执行不报错不丢数据", () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM pc_workspace").get() as { n: number };
    conversations.ensureConversationTables(db);
    // 重新触发工作区模块的懒建路径(同一 Database 实例走 WeakSet 直通,再显式建一次表验证幂等)
    db.exec("CREATE TABLE IF NOT EXISTS pc_workspace (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, root TEXT NOT NULL DEFAULT '', permission_preset TEXT NOT NULL, trusted_at INTEGER, create_at INTEGER NOT NULL, update_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL)");
    const after = db.prepare("SELECT COUNT(*) AS n FROM pc_workspace").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(ws.listWorkspaces().length).toBeGreaterThan(0);
  });

  test("ssh 绑定列懒迁移:建 ssh 工作区之前建的库补两列,老行读出 null 而不是崩", () => {
    // 2.x 之前的库里没有 ssh_device_id / ssh_dir_id。这里把列摘掉模拟那份老库(连一行
    // 不含新列的老数据),再让生产代码路径自己把它长回来——迁移只能这么验,抄一份
    // ALTER 语句自测等于什么都没测。
    db.exec("ALTER TABLE pc_workspace DROP COLUMN ssh_device_id");
    db.exec("ALTER TABLE pc_workspace DROP COLUMN ssh_dir_id");
    db.prepare(
      "INSERT INTO pc_workspace (id, name, type, root, permission_preset, trusted_at, create_at, update_at, last_access_at) VALUES ('legacy-row', '老库工作区', 'managed', '', 'balanced', 1, 1, 1, 1)",
    ).run();

    // 懒迁移挂在 Database 实例上(WeakSet 记"这个句柄已确保过表结构"),所以必须换一个
    // 新实例才走得到补列那段——真实启动路径每次都是新实例,老句柄只服务本条用例的 DROP。
    const reopened = conversations.openConversationsDb();
    expect(ws.listWorkspaces().length).toBeGreaterThan(0); // 这一句就是触发 db() 的补列

    const columns = (reopened.prepare("PRAGMA table_info(pc_workspace)").all() as { name: string }[]).map((column) => column.name);
    expect(columns).toContain("ssh_device_id");
    expect(columns).toContain("ssh_dir_id");
    // 老行:两个引用列为 null,类型仍按 managed 收敛(NULL 不会被认成 ssh)
    const legacy = ws.getWorkspace("legacy-row");
    expect(legacy?.type).toBe("managed");
    expect(legacy?.sshDeviceId).toBeNull();
    expect(legacy?.sshDirId).toBeNull();
    // 补列幂等:再开一个新实例(列已存在)不报错、不丢数据
    conversations.openConversationsDb();
    expect(ws.getWorkspace("legacy-row")?.name).toBe("老库工作区");
    conversations.getConversationsDb()!.prepare("DELETE FROM pc_workspace WHERE id = 'legacy-row'").run();
  });
});

describe("工作区 ↔ 文件夹 1:1 不变式(2.0.0 内测反馈)", () => {
  test("同目录重复创建 = 打开既有工作区:同 id、不建新行、名字与信任状态保持", () => {
    const dir = mkdtempSync(join(tmpdir(), "rkh-ws-dup-"));
    const first = ws.createWorkspace({ type: "folder", root: dir });
    ws.trustWorkspace(first.id);
    const before = ws.listWorkspaces().length;
    const again = ws.createWorkspace({ type: "folder", root: dir });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe(first.name);
    expect(again.trustedAt).not.toBeNull(); // 打开既有工作区,信任状态原样保留
    expect(ws.listWorkspaces().length).toBe(before);
  });

  test("路径写法归一:尾部斜杠与大小写变体(win32)命中同一工作区", () => {
    const dir = mkdtempSync(join(tmpdir(), "rkh-ws-norm-"));
    const first = ws.createWorkspace({ type: "folder", root: dir });
    const withTrailing = ws.createWorkspace({ type: "folder", root: dir + sep });
    expect(withTrailing.id).toBe(first.id);
    if (process.platform === "win32") {
      const upper = ws.createWorkspace({ type: "folder", root: dir.toUpperCase() });
      expect(upper.id).toBe(first.id);
    }
  });

  test("重绑到已被其他工作区绑定的目录 → 拒绝;自身大小写变体 → 视为无变化不重置信任", () => {
    const dirA = mkdtempSync(join(tmpdir(), "rkh-ws-rb-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "rkh-ws-rb-b-"));
    const a = ws.createWorkspace({ type: "folder", root: dirA });
    const b = ws.createWorkspace({ type: "folder", root: dirB });
    expect(() => ws.updateWorkspace(b.id, { root: dirA })).toThrow("已绑定");
    // 重绑到空闲目录仍然可用(B6-①b 能力保留,信任门重置)
    const dirC = mkdtempSync(join(tmpdir(), "rkh-ws-rb-c-"));
    ws.trustWorkspace(b.id);
    const rebound = ws.updateWorkspace(b.id, { root: dirC });
    expect(rebound?.root).toBe(dirC);
    expect(rebound?.trustedAt).toBeNull();
    // 自身同目录的大小写变体:非换绑,信任与原路径写法保持
    ws.trustWorkspace(a.id);
    if (process.platform === "win32") {
      const updated = ws.updateWorkspace(a.id, { root: dirA.toUpperCase() });
      expect(updated?.trustedAt).not.toBeNull();
      expect(updated?.root).toBe(dirA); // 保留原写法
    }
    // managed 型不受不变式影响:root 由 id 派生天然互异,可并存多个
    const m1 = ws.createWorkspace({ type: "managed", name: "inv-m1" });
    const m2 = ws.createWorkspace({ type: "managed", name: "inv-m2" });
    expect(m1.id).not.toBe(m2.id);
  });
});

// ssh 型(2026-10-26 与移动端对齐)。入口形态是用户拍板的分歧点:凭据与授权目录都在
// 「拓展 › SSH」,工作区行里只有两个引用 id——所以这一节的所有用例都先 setState 注入设置,
// 再断言"工作区表里查不到任何凭据"。
describe("ssh 工作区绑定", () => {
  const HOST_KEY = { type: "ssh-ed25519", key: "AAAAB3Nj", fingerprint: "SHA256:test" };
  const APP = { id: "app", name: "应用目录", path: "/srv/app" };
  const WEB = { id: "web", name: "站点目录", path: "/srv/web" };

  // 本文件的用例共用一个库:每条用例一套独立的设备 id,否则 open-or-create 会命中
  // 上一条用例留下的工作区("重复创建返回既有行"反倒像是名字没生效)。
  let deviceSeq = 0;
  function deviceWithDirs(dirs: typeof APP[], hostKey: unknown = HOST_KEY) {
    deviceSeq += 1;
    return { ...fixtureDevice({ id: `dev-${deviceSeq}`, dirs }), hostKey };
  }

  /** 在给定设备清单下跑一段用例,结束把设置恢复原值(不向后续文件泄漏 sshDevices)。 */
  async function withDevices<T>(devices: unknown[], run: () => Promise<T> | T): Promise<T> {
    const prev = store.state;
    store.setState({ settings: { sshDevices: devices } } as never);
    try {
      return await run();
    } finally {
      store.setState(prev as never);
    }
  }

  test("创建:root 由授权目录派生、只存两个 id、创建即信任、默认名取目录末段", async () => {
    const device = deviceWithDirs([APP]);
    await withDevices([device], () => {
      const workspace = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app" });
      expect(workspace.type).toBe("ssh");
      expect(workspace.root).toBe("/srv/app");
      expect(workspace.sshDeviceId).toBe(device.id);
      expect(workspace.sshDirId).toBe("app");
      // 信任门:允许 AI 碰这台机器已由「登记授权目录 + 确认主机密钥」表达过,不再弹第三次。
      expect(workspace.trustedAt).not.toBeNull();
      expect(workspace.permissionPreset).toBe("balanced");
      expect(workspace.name).toBe("app");
      expect(ws.workspaceStatus(workspace)).toBe("ready");
      expect(ws.workspaceUnavailableReasonOf(workspace)).toBeNull();
      // 本机宿主目录照建(引擎的本地 cwd 与超长输出落盘处),远端路径不在本机磁盘上。
      expect(existsSync(ws.workspaceTmpDir(workspace.id))).toBe(true);

      // 库行里只有两个引用 id:凭据一个字节都不落工作区表。
      const row = db.prepare("SELECT * FROM pc_workspace WHERE id = ?").get(workspace.id) as Record<string, unknown>;
      expect(JSON.stringify(row)).not.toContain(SSH_PASSWORD);
      expect(Object.keys(row)).toEqual(expect.arrayContaining(["ssh_device_id", "ssh_dir_id"]));
    });
  });

  test("显式名字优先;root 是远端 POSIX 路径也不 stat(列表页不探网络)", async () => {
    const device = deviceWithDirs([APP]);
    await withDevices([device], () => {
      const workspace = ws.createWorkspace({ type: "ssh", name: "生产服务器", sshDeviceId: device.id, sshDirId: "app" });
      expect(workspace.name).toBe("生产服务器");
      // /srv/app 在本机不存在:folder 型那条 stat 规则对 ssh 型不适用,否则列表页会说「目录丢了」。
      expect(existsSync(workspace.root)).toBe(false);
      expect(ws.workspaceStatus(workspace)).toBe("ready");
    });
  });

  test("授权目录写法归一:带尾斜杠与 .. 的路径派生出同一个边界根", async () => {
    const device = deviceWithDirs([{ id: "app", name: "", path: "/srv/app///logs/.." }]);
    await withDevices([device], () => {
      const workspace = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app" });
      expect(workspace.root).toBe("/srv/app");
    });
  });

  test("同一远程目录只开一个工作区:重复创建 = 打开既有;不同目录各开一个", async () => {
    const device = deviceWithDirs([APP, WEB]);
    await withDevices([device], () => {
      const first = ws.createWorkspace({ type: "ssh", name: "先建的", sshDeviceId: device.id, sshDirId: "app" });
      const before = ws.listWorkspaces().length;
      const again = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app" });
      expect(again.id).toBe(first.id);
      expect(again.name).toBe("先建的"); // 打开既有工作区不改名
      expect(ws.listWorkspaces().length).toBe(before);
      // 界面传旧式「路径当 id」也命中同一条目录(findRemoteDir 的同一条兼容规则)。
      expect(ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "/srv/app" }).id).toBe(first.id);

      const web = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "web" });
      expect(web.id).not.toBe(first.id);
      expect(web.root).toBe("/srv/web");
      // 另一台设备的同一目录是另一个工作区:查重键是 (设备 id, 目录 id),不是路径。
      const otherDevice = deviceWithDirs([APP]);
      store.setState({ settings: { sshDevices: [device, otherDevice] } } as never);
      try {
        const twin = ws.createWorkspace({ type: "ssh", sshDeviceId: otherDevice.id, sshDirId: "app" });
        expect(twin.id).not.toBe(first.id);
        expect(twin.root).toBe("/srv/app");
      } finally {
        store.setState({ settings: { sshDevices: [device] } } as never);
      }
    });
  });

  test("改绑:换授权目录同步 root 且不重置信任;目标已被别的 ssh 工作区绑定则拒", async () => {
    const device = deviceWithDirs([APP, WEB]);
    await withDevices([device], () => {
      const a = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app" });
      const same = ws.updateWorkspace(a.id, { sshDeviceId: device.id, sshDirId: "app" });
      expect(same?.root).toBe("/srv/app");
      expect(same?.trustedAt).not.toBeNull(); // 换绑不重置信任:新目标同样是已授权、已确认密钥的目录
      const moved = ws.updateWorkspace(a.id, { sshDeviceId: device.id, sshDirId: "web" });
      expect(moved?.sshDirId).toBe("web");
      expect(moved?.root).toBe("/srv/web");
      // app 现在空着:开一个新工作区,再把它改绑到 a 占着的 web → 拒。
      const b = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app" });
      expect(() => ws.updateWorkspace(b.id, { sshDeviceId: device.id, sshDirId: "web" })).toThrow("已绑定");
      // 已被占用的目录再"创建"只会 open-or-create,不会开出第二个绑定同一目录的工作区。
      expect(ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "web" }).id).toBe(a.id);
    });
  });

  test("非 ssh 型不接受绑定改绑;ssh 型不接受本机 root 改绑", async () => {
    const device = deviceWithDirs([APP]);
    await withDevices([device], () => {
      const managed = ws.createWorkspace({ type: "managed", name: "nssh" });
      expect(() => ws.updateWorkspace(managed.id, { sshDeviceId: device.id, sshDirId: "app" })).toThrow("SSH 工作区");
      const folder = ws.createWorkspace({ type: "folder", root: mkdtempSync(join(tmpdir(), "rkh-ws-ssh-x-")) });
      expect(() => ws.updateWorkspace(folder.id, { sshDirId: "app" })).toThrow("SSH 工作区");
      const ssh = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app" });
      expect(() => ws.updateWorkspace(ssh.id, { root: join(tmpdir()) })).toThrow("folder");
    });
  });

  test("绑定准入的拒:都带 errorCode,原因不含中文与凭据", async () => {
    const device = deviceWithDirs([{ id: "draft", name: "没填完", path: "   " }, { id: "rel", name: "相对的", path: "srv/app" }]);
    await withDevices([device], () => {
      const cases: Array<{ patch: { sshDeviceId?: string; sshDirId?: string }; code: string }> = [
        // 两个 id 没给全:界面不该让它走到建连,这里当场拒。
        { patch: { sshDeviceId: "", sshDirId: "" }, code: "ssh.binding_dir_unauthorized" },
        { patch: { sshDeviceId: device.id, sshDirId: "   " }, code: "ssh.binding_dir_unauthorized" },
        { patch: { sshDeviceId: "nope", sshDirId: "app" }, code: "ssh.binding_device_missing" },
        { patch: { sshDeviceId: device.id, sshDirId: "gone" }, code: "ssh.binding_dir_unauthorized" },
        { patch: { sshDeviceId: device.id, sshDirId: "draft" }, code: "ssh.binding_path_invalid" },
        { patch: { sshDeviceId: device.id, sshDirId: "rel" }, code: "ssh.binding_path_invalid" },
      ];
      for (const { patch, code } of cases) {
        let caught: unknown = null;
        try {
          ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app", ...patch });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        const error = caught as { message: string; errorCode?: string };
        expect(error.errorCode).toBe(code);
        // 原因进模型上下文,也走界面的 errors.<code> 通道:正文是英文,中文由码去查。
        expect(error.message).not.toMatch(/[\u4e00-\u9fff]/);
        expect(error.message).not.toContain(SSH_PASSWORD);
      }
    });
  });

  test("主机密钥没确认:创建被拒;创建后取消确认则工作区变失效但记录留着", async () => {
    const unconfirmed = deviceWithDirs([APP], null);
    await withDevices([unconfirmed], () => {
      expect(() => ws.createWorkspace({ type: "ssh", sshDeviceId: unconfirmed.id, sshDirId: "app" })).toThrow(/host key/);
    });
    const device = deviceWithDirs([APP]);
    await withDevices([device], () => {
      const workspace = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app" });
      expect(ws.workspaceStatus(workspace)).toBe("ready");
      // 用户在设置里撤销了主机密钥确认(换了台机器)——工作区不可用,但不会静默删记录。
      store.setState({ settings: { sshDevices: [{ ...device, hostKey: null }] } } as never);
      try {
        const loaded = ws.getWorkspace(workspace.id)!;
        expect(ws.workspaceStatus(loaded)).toBe("missing");
        expect(ws.workspaceUnavailableReasonOf(loaded)).toMatch(/host key/);
        expect(loaded.root).toBe("/srv/app"); // target 还在:边界根照由设置派生
      } finally {
        store.setState({ settings: { sshDevices: [] } } as never);
      }
    });
  });

  test("设备删了/目录撤了:失效原因与码各归各,root 退回落库快照供界面解释", async () => {
    const device = deviceWithDirs([APP, WEB]);
    await withDevices([device], () => {
      const workspace = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "web" });
      expect((db.prepare("SELECT root FROM pc_workspace WHERE id = ?").get(workspace.id) as { root: string }).root).toBe("/srv/web");

      // 设备整台没了(换 id 等于删了重加):派生不出 target,root 用落库的那份快照。
      store.setState({ settings: { sshDevices: [{ ...deviceWithDirs([APP]), hostKey: HOST_KEY }] } } as never);
      try {
        const loaded = ws.getWorkspace(workspace.id)!;
        expect(ws.workspaceStatus(loaded)).toBe("missing");
        expect(ws.workspaceUnavailableReasonOf(loaded)).toMatch(/device .* no longer exists/);
        expect(loaded.root).toBe("/srv/web");
        expect(loaded.sshDeviceId).toBe(device.id); // 两个引用原样留着,用户把设备加回来就自愈
      } finally {
        store.setState({ settings: { sshDevices: [device] } } as never);
      }

      // 设备还在、只把这条目录的授权撤了:原因换成「不再授权」。
      store.setState({ settings: { sshDevices: [{ ...device, dirs: [APP] }] } } as never);
      try {
        const loaded = ws.getWorkspace(workspace.id)!;
        expect(ws.workspaceStatus(loaded)).toBe("missing");
        expect(ws.workspaceUnavailableReasonOf(loaded)).toMatch(/no longer authorized/);
      } finally {
        store.setState({ settings: { sshDevices: [device] } } as never);
      }

      // 设置还没装载(state 为 undefined,单测与启动早期常见)同样不抛,按设备缺失处理。
      store.setState(undefined as never);
      try {
        const loaded = ws.getWorkspace(workspace.id)!;
        expect(ws.workspaceStatus(loaded)).toBe("missing");
        expect(ws.workspaceUnavailableReasonOf(loaded)).toMatch(/device/);
      } finally {
        store.setState({ settings: { sshDevices: [] } } as never);
      }
    });
  });

  test("删除 ssh 工作区:本机宿主目录清掉,授权与远端文件都不因删除而改变", async () => {
    const device = deviceWithDirs([APP]);
    await withDevices([device], () => {
      const workspace = ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app" });
      expect(ws.deleteWorkspace(workspace.id)).toBe(true);
      expect(ws.getWorkspace(workspace.id)).toBeNull();
      expect(existsSync(join(workspacesDir, workspace.id))).toBe(false);
      // 授权仍留在设置里:撤销授权是「拓展 › SSH」单独的动作,删工作区不该顺带改掉它。
      expect(store.state.settings.sshDevices).toHaveLength(1);
      // 删完可以再开一个(1:1 查重只看现存工作区,不看历史)。
      expect(ws.createWorkspace({ type: "ssh", sshDeviceId: device.id, sshDirId: "app" }).id).not.toBe(workspace.id);
    });
  });
});
