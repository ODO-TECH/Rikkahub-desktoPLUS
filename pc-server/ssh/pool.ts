// ssh/pool.ts — 按设备复用 SSH 连接(镜像安卓端 workspace/ssh/SshConnectionPool.kt)。
//
// 为什么要有这一层:对齐前 rdp 每条命令都重新握手一次,一次交互十几次往返、密码认证被服务器
// 按「多次失败」风控,而且没有任何跨命令状态。安卓端的规则是:一个设备一条连接,用完不拆,
// 空闲 5 分钟且没有进行中操作才关掉,下次用再重连。
//
// 与安卓端的差异(都写在这里,便于两端对表):
// - 安卓端用 ReentrantLock.lockInterruptibly() 串行化建连并支持中断;JS 没有可中断等待,
//   改为「按设备排队的异步队列 + 取消即跳过」:排队期间的取消在建连前就返回,建连中途的取消由
//   SshConnection.connect 的 onAbandoned 规则把晚到的连接直接关掉,两种情况都不留残骸。
// - 安卓端 close/登记共用一把 lifecycleLock;JS 单线程,「取走 map 条目 + 标记 closed」
//   本身就是原子的同步段,不需要额外锁。
//
// 纪律:池只按 deviceId 索引,指纹与错误文案里只出现 user@host:port;凭据不新增副本。

import type { SshDevice } from "../foundation/types/settings";
import { IDLE_TIMEOUT_MS, SWEEP_INTERVAL_MS } from "./constants";
import { SshConnection, type SshProbeResult, type SshTerminalHandle, type SshTerminalOptions } from "./connection";
import { isAbortError, SshAbortedError, SshChannelOpenError, transportError } from "./errors";
import { sshConnectionSignature } from "./devices";

export interface SshPoolUseOptions {
  /**
   * 操作是否可重复执行。默认 true(读类:重连后重试一次)。
   * 写类传 false:只有「确定没送到服务器」(channel 没开成)才重试,否则宁可失败也不把
   * 不可重复的命令跑两遍——这是安卓端 use(retry=false) 的原样语义。
   */
  retry?: boolean;
  signal?: AbortSignal;
}

/** 池里的一条连接:引用计数为 0 且超过空闲时限,才允许被回收。 */
class PooledConnection {
  private activeUses = 0;
  private lastUsedAt = Date.now();

  constructor(readonly connection: SshConnection, readonly signature: string) {}

  retain(): void {
    this.activeUses += 1;
  }

  release(): void {
    this.lastUsedAt = Date.now();
    this.activeUses = Math.max(0, this.activeUses - 1);
  }

  isIdle(now: number, idleTimeoutMs: number): boolean {
    return this.activeUses === 0
      && !this.connection.busy
      && now - this.lastUsedAt >= idleTimeoutMs;
  }
}

export class SshConnectionPool {
  private readonly connections = new Map<string, PooledConnection>();
  /** 按设备串行化建连的队尾(永不 reject,只为把下一个任务排在它后面)。 */
  private readonly gates = new Map<string, Promise<void>>();
  private closed = false;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly idleTimeoutMs: number = IDLE_TIMEOUT_MS,
    sweepIntervalMs: number = SWEEP_INTERVAL_MS,
  ) {
    // unref:空闲扫描不该把进程钉住(测试退出与壳硬杀都指望这个)。
    // 扫描里的异常一律吞掉:回收是尽力而为,一条连接关不掉不能影响其它设备,更不能冒成未捕获错误。
    this.sweeper = setInterval(() => {
      try {
        this.closeIdle();
      } catch {
        /* 忽略:下个周期再试 */
      }
    }, sweepIntervalMs);
    if (typeof this.sweeper === "object" && "unref" in this.sweeper) this.sweeper.unref();
  }

  /** 设备是否已有可用连接(界面与测试观察空闲断开用;只回布尔,不含凭据)。 */
  isConnected(deviceId: string): boolean {
    return this.connections.get(deviceId)?.connection.isConnected === true;
  }

  /** 当前挂着连接的设备 id,顺序即登记顺序。 */
  connectedDevices(): string[] {
    return [...this.connections.keys()];
  }

  /**
   * 在设备对应的连接上执行 block;连接已断或 channel 没开成时重连并重试一次。
   * retry=false 表示操作不可重复,只在「请求肯定没发出」时重试。
   */
  async use<T>(
    device: SshDevice,
    block: (connection: SshConnection) => Promise<T>,
    options: SshPoolUseOptions = {},
  ): Promise<T> {
    const retry = options.retry ?? true;
    const pooled = await this.acquire(device, options.signal);
    try {
      return await block(pooled.connection);
    } catch (error) {
      // 调用方取消:绝不重连重试,否则「停止」之后还会冒出一次远端执行。
      if (isAbortError(error)) throw error;
      const channelNotOpened = channelNotOpen(error);
      if (pooled.connection.isConnected && !channelNotOpened) throw error;
      this.evict(device.id, pooled);
      if (!retry && !channelNotOpened) throw error;
      const retried = await this.acquire(device, options.signal);
      try {
        return await block(retried.connection);
      } finally {
        retried.release();
      }
    } finally {
      pooled.release();
    }
  }

  /**
   * 打开交互式终端:终端关闭前一直占着这条连接(引用计数 +1),空闲回收不会拆它。
   * 只在 channel 没开成时重连重试一次(安卓端 openShell 的规则)。
   */
  async openTerminal(
    device: SshDevice,
    options: SshTerminalOptions,
  ): Promise<SshTerminalHandle> {
    const pooled = await this.acquire(device, options.signal);
    const release = once(() => pooled.release());
    try {
      const handle = await pooled.connection.openTerminal({
        ...options,
        onExit: (code, connectionLost) => {
          release();
          options.onExit(code, connectionLost);
        },
      });
      return handle;
    } catch (error) {
      release();
      if (isAbortError(error)) throw error;
      const channelNotOpened = channelNotOpen(error);
      if (pooled.connection.isConnected && !channelNotOpened) throw error;
      this.evict(device.id, pooled);
      if (!channelNotOpened) throw error;
      const retried = await this.acquire(device, options.signal);
      const retriedRelease = once(() => retried.release());
      try {
        return await retried.connection.openTerminal({
          ...options,
          onExit: (code, connectionLost) => {
            retriedRelease();
            options.onExit(code, connectionLost);
          },
        });
      } catch (retryError) {
        retriedRelease();
        throw retryError;
      }
    }
  }

  /**
   * 用一条临时连接探测远端(测试连接、首次确认主机密钥)。
   * 不进池:确认密钥前那条连接本来也建不起来,更不该把一个未经确认的服务器留在池里。
   */
  async probe(
    device: SshDevice,
    remoteDir?: string | null,
    signal?: AbortSignal,
  ): Promise<SshProbeResult> {
    const connection = await SshConnection.connect(device, { signal });
    try {
      return await connection.probe(remoteDir);
    } finally {
      connection.close();
    }
  }

  /** 丢掉某台设备的连接(删除/保存后调用;配置变化由 acquire 自己按指纹重连)。 */
  close(deviceId: string): void {
    const pooled = this.connections.get(deviceId);
    if (!pooled) return;
    this.connections.delete(deviceId);
    pooled.connection.close();
  }

  /** 停止空闲扫描并关闭所有连接;之后池不可再用(进程退出前调用)。 */
  closeAll(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    const remaining = [...this.connections.values()];
    this.connections.clear();
    for (const pooled of remaining) pooled.connection.close();
  }

  /**
   * 取一条可用连接:同设备同配置且在线就复用,否则关掉旧的再建。
   * 拿到手即引用计数 +1,调用方负责 release(含终端:关闭时释放)。
   */
  private acquire(device: SshDevice, signal?: AbortSignal): Promise<PooledConnection> {
    return this.enqueue(device.id, async () => {
      if (this.closed) throw transportError("SSH connection pool is closed");
      if (signal?.aborted) throw new SshAbortedError();
      const signature = sshConnectionSignature(device);
      const existing = this.connections.get(device.id);
      if (existing) {
        const reusable = existing.signature === signature && existing.connection.isConnected;
        if (reusable) {
          existing.retain();
          return existing;
        }
        this.connections.delete(device.id);
        existing.connection.close();
      }
      const connection = await SshConnection.connect(device, { signal });
      const pooled = new PooledConnection(connection, signature);
      // 建连期间池可能已经关了(退出流程):这条连接自行释放,不遗留在死池里。
      if (this.closed) {
        connection.close();
        throw transportError("SSH connection pool is closed");
      }
      // 队列按设备串行,这里不会再撞车;直接登记。删设备与建连撞同一窗口时,
      // 这条迟到的连接会被空闲扫描收掉,不会永久挂着凭据。
      pooled.retain();
      this.connections.set(device.id, pooled);
      return pooled;
    });
  }

  private evict(deviceId: string, pooled: PooledConnection): void {
    // 只踢自己这一条:并发下别人可能已经换了新连接(安卓端 remove(id, pooled) 的同款判据)。
    if (this.connections.get(deviceId) === pooled) this.connections.delete(deviceId);
    pooled.connection.close();
  }

  private closeIdle(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [deviceId, pooled] of [...this.connections]) {
      // 同步段:判空闲与摘除之间不会插入任何 release,不需要锁。
      if (this.connections.get(deviceId) !== pooled) continue;
      if (!pooled.isIdle(now, this.idleTimeoutMs)) continue;
      this.connections.delete(deviceId);
      pooled.connection.close();
    }
  }

  /** 按设备排队执行;队尾本身吞掉错误,保证下一个任务一定排得上。 */
  private enqueue<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(deviceId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const gate = result.then(
      () => undefined,
      () => undefined,
    );
    this.gates.set(deviceId, gate);
    gate.then(() => {
      if (this.gates.get(deviceId) === gate) this.gates.delete(deviceId);
    });
    return result;
  }
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/**
 * 「确定没送到服务器」的失败:连接层把这类统一收成 SshChannelOpenError(判据见 connection.ts
 * 的 isChannelOpenFailure)。只有它能触发无条件重连——其它错误到达池时,远端可能已经在执行,
 * 重一次就是把不可重复的命令跑两遍。
 */
function channelNotOpen(error: unknown): boolean {
  return error instanceof SshChannelOpenError;
}

/** 进程级单例:所有 handler 与工具共用一套连接,和安卓端 App 级连接池同一位置。 */
export const sshPool = new SshConnectionPool();
