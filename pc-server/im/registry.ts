// im/registry.ts — 适配器实例的生命周期
//
// 一个平台最多一个实例,实例的存在性由「用户开关 && 凭据齐备 && 凭据指纹未变」三者决定:
//  - 配置保存(updateSettings)后调 reconcile():新启用的启起来,禁用/删凭据的停掉,改了
//    AppID/Token 的先停旧再起新(旧网关拿着旧凭据不会自己失效,不停就会双开)。
//  - 启动时(bootstrap)同样调一次,已绑定的重启网关。
// reconcile 幂等且同步返回:真正的 connect 在后台跑,失败只记进 status.lastError——
// 配置页保存绝不该因为 QQ 网关连不上而报错。
//
// 运行态(connected / lastError)刻意不落 settings:重启后必然重来一遍,写盘只会让
// state.json 里出现骗人的"上次连上了"。

import type { ImAccessConfig, ImPlatformId, ImPlatformStatus } from "../foundation/types/settings/im-access";
import { state } from "../persistence/json-store";
import { updateSettings } from "../app-config";
import { normalizeImAccess, qqConfigured, wechatConfigured } from "./config";
import { ImRuntime, type ImAdapter, type ImAdapterEvent, type ImPort } from "./runtime";
import { createQqAdapter, createQqPort } from "./qq/adapter";
import { createWechatAdapter, createWechatPort } from "./wechat/adapter";

export type { ImPlatformStatus };


type Instance = {
  adapter: ImAdapter;
  runtime: ImRuntime;
  /** 凭据指纹:变了就要换实例,不能沿用。 */
  signature: string;
  connected: boolean;
  connectedAt: number | null;
  lastError: string | null;
  /** stopInstance 幂等句柄:停机与在途 chain 可能同时收同一个实例。 */
  stopping: Promise<void> | null;
};

const instances = new Map<ImPlatformId, Instance>();
/**
 * 每个平台一条串行的启停链。
 *
 * reconcile 是同步的(配置保存不能等 QQ 握手),但连续两次保存会挤进来两个动作:第二次
 * 必须等第一个做完,否则会对着同一个平台同时起两个网关连接。链挂在模块级而不是实例上,
 * 因为停掉的实例已经不在表里了——链要跨实例存在。
 */
const chains = new Map<ImPlatformId, Promise<void>>();
/** 进程停机开始后禁止任何迟到的 reconcile/queued start 再拉起新连接。 */
let shuttingDown = false;
/** 小于 docker stop 默认宽限(10s),给后续 SQLite/WAL 收尾留足时间。 */
const DEFAULT_STOP_BUDGET_MS = 5_000;
let stopBudgetMs = DEFAULT_STOP_BUDGET_MS;

function currentConfig(): ImAccessConfig {
  // updateSettings 是所有设置的公共写入口,调用方可能带着不含 imAccess 的局部 state
  // (测试夹具、部分恢复路径)。缺切片按"全默认"处理:没有配置就没有要追平的实例。
  return normalizeImAccess(state.settings.imAccess);
}

function signatureOf(platform: ImPlatformId, config: ImAccessConfig): string {
  return platform === "qq"
    ? `${config.qq.appId}|${config.qq.appSecret}`
    : `${config.wechat.accountId}|${config.wechat.botToken}|${config.wechat.baseUrl}`;
}

function desired(platform: ImPlatformId, config: ImAccessConfig): boolean {
  return platform === "qq"
    ? config.qq.enabled && qqConfigured(config.qq)
    : config.wechat.enabled && wechatConfigured(config.wechat);
}

function writeConfig(next: ImAccessConfig): void {
  updateSettings({ ...state.settings, imAccess: next });
}

function build(platform: ImPlatformId, config: ImAccessConfig): Instance {
  // port 与 adapter 共享同一份平台侧连接状态(见各自文件头注),所以 port 不吃配置。
  const port: ImPort = platform === "qq" ? createQqPort() : createWechatPort();
  const instance: Instance = {
    adapter: null as unknown as ImAdapter,
    runtime: new ImRuntime(port, { getConfig: currentConfig, updateConfig: writeConfig }),
    signature: signatureOf(platform, config),
    connected: false,
    connectedAt: null,
    lastError: null,
    stopping: null,
  };
  // 只认还在表里的自己:被停掉的适配器退出时还会补报一次 connected=false,那时新实例可能
  // 已经起来了,不能被旧实例的连接状态误伤。
  const report = (event: ImAdapterEvent) => {
    if (instances.get(platform) === instance) applyEvent(instance, event);
  };
  instance.adapter = platform === "qq"
    ? createQqAdapter(config.qq, instance.runtime, report)
    : createWechatAdapter(config.wechat, instance.runtime, report);
  return instance;
}

function applyEvent(instance: Instance, event: ImAdapterEvent): void {
  if (event.connected && !instance.connected) instance.connectedAt = Date.now();
  if (!event.connected) instance.connectedAt = null;
  instance.connected = event.connected;
  instance.lastError = event.error ?? (event.connected ? null : instance.lastError);
}

async function stopInstance(platform: ImPlatformId, instance: Instance): Promise<void> {
  if (instances.get(platform) === instance) instances.delete(platform);
  if (instance.stopping) return instance.stopping;
  instance.stopping = (async () => {
    try {
      await instance.adapter.stop();
    } catch (err) {
      console.error(`[IM] 停止 ${platform} 适配器时出错:`, err);
    }
    instance.runtime.destroy();
    console.info(`[IM] ${platform} 适配器已停止`);
  })();
  return instance.stopping;
}

/**
 * 让实例集合追上配置。同步返回,启停动作挂在后台 Promise 上。
 *
 * 启动失败(网络不通、凭据被吊销)不会抛出:状态里留 lastError,界面按它显示"连接失败",
 * 用户可以在界面上关掉开关。重连由适配器自己管(QQ 网关 SDK 内置,微信是轮询循环重试)。
 */
export function reconcileImAdapters(): void {
  if (shuttingDown) return;
  const config = currentConfig();
  for (const platform of ["qq", "wechat"] as const) {
    // 队列里还有动作没跑完:那个动作起来时会重新读配置,这里不叠加。
    if (chains.has(platform)) continue;

    const instance = instances.get(platform);
    const wanted = desired(platform, config);

    if (!wanted) {
      if (instance) schedule(platform, () => stopInstance(platform, instance));
      continue;
    }

    if (!instance) {
      schedule(platform, () => startFresh(platform));
      continue;
    }
    if (instance.signature === signatureOf(platform, config)) continue;

    console.info(`[IM] ${platform} 凭据已变更,重启适配器`);
    schedule(platform, async () => {
      await stopInstance(platform, instance);
      await startFresh(platform);
    });
  }
}

function schedule(platform: ImPlatformId, task: () => Promise<void>): void {
  const run = task().catch((err) => {
    console.error(`[IM] ${platform} 适配器操作失败:`, err);
  });
  chains.set(platform, run);
  void run.finally(() => {
    if (chains.get(platform) === run) chains.delete(platform);
  });
}

async function startFresh(platform: ImPlatformId): Promise<void> {
  if (shuttingDown) return;
  // 重新读一次配置:排队的这几毫秒里用户可能又改了一次,不能沿用 reconcile 开头的快照。
  const config = currentConfig();
  if (!desired(platform, config)) return;
  const instance = build(platform, config);
  instances.set(platform, instance);
  try {
    await instance.adapter.start();
    console.info(`[IM] ${platform} 适配器启动中`);
  } catch (err) {
    applyEvent(instance, { connected: false, error: errMessage(err) });
    console.error(`[IM] ${platform} 适配器启动失败:`, err);
  }
}

export function getImStatus(): ImPlatformStatus[] {
  const config = currentConfig();
  return (["qq", "wechat"] as const).map((platform) => {
    const instance = instances.get(platform);
    const platformConfig = platform === "qq" ? config.qq : config.wechat;
    return {
      platform,
      configured: platform === "qq" ? qqConfigured(config.qq) : wechatConfigured(config.wechat),
      enabled: platformConfig.enabled,
      running: Boolean(instance),
      connected: Boolean(instance?.connected),
      connectedAt: instance?.connectedAt ?? null,
      lastError: instance?.lastError ?? null,
      pairedCount: platformConfig.pairedUsers.length,
      chatCount: config.chats.filter((chat) => chat.platform === platform).length,
    };
  });
}

/** 退出前收口:与 server.ts 里其它 closeAll* 同位置调用。
 *  必须先停实例(adapter.stop 会取消 QQ 首连/微信长轮询),再等 chain;
 *  先等 chain 会把 QQ 最长 20 秒的首连预算整段拖进停机路径。 */
export async function stopAllImAdapters(): Promise<void> {
  shuttingDown = true;
  const active = [...instances.entries()].map(([platform, instance]) => stopInstance(platform, instance));
  const pendingChains = [...chains.values()].map((run) => run.catch(() => undefined));
  const finished = await waitWithin(Promise.all([...active, ...pendingChains]), stopBudgetMs);
  if (!finished) {
    console.warn(`[IM] 停机收口超过 ${stopBudgetMs}ms,继续刷新持久化状态(不再等待后台连接)`);
  }
  chains.clear();
}

async function waitWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  const done = work.then(
    () => true,
    () => true,
  );
  const finished = await Promise.race([done, timeout]);
  if (timer) clearTimeout(timer);
  return finished;
}

/** 测试隔离:清掉所有实例,不触碰 settings。 */
export function __resetImRegistryForTest(): void {
  for (const instance of instances.values()) {
    instance.runtime.destroy();
    void instance.adapter.stop().catch(() => undefined);
  }
  instances.clear();
  chains.clear();
  shuttingDown = false;
  stopBudgetMs = DEFAULT_STOP_BUDGET_MS;
}

/** 测试用:缩短停机预算,避免真实等待 5 秒。传 null 恢复默认。 */
export function __setImStopBudgetForTest(ms: number | null): void {
  stopBudgetMs = ms ?? DEFAULT_STOP_BUDGET_MS;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
