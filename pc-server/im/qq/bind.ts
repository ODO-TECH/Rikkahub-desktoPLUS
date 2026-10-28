// im/qq/bind.ts — QQ 机器人扫码绑定
//
// 官方 SDK `@tencent-connect/qqbot-connector` 把这套流程做成了黑盒(npm 上拿得到,但包
// 是 UNLICENSED 且经过混淆)。它实际只做四次调用 + 一次解密,全部可读:
//
//   1. 本地生成 key = base64(randomBytes(32))            —— 这是解密用的对称密钥
//   2. POST https://q.qq.com/lite/create_bind_task {key} → data.task_id
//   3. 二维码内容 = https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&source=…&_wv=2
//   4. POST https://q.qq.com/lite/poll_bind_result {task_id}
//        → data.status(1 待扫 / 2 完成 / 3 过期)、bot_appid、bot_encrypt_secret
//   5. bot_encrypt_secret = base64( iv(12) ‖ 密文 ‖ GCM tag(16) ),用第 1 步的 key 做
//      AES-256-GCM 解密得到 appSecret 明文
//
// 自己实现有两个实打实的好处:一是发布物里不再嵌一份"作者未授予任何许可"的代码(本项目
// 在 GitHub 上以社区版分发);二是绑定循环从"进程退出才结束"变成服务端常驻会话,界面关掉
// 再回来还能接上同一个 sessionKey。
//
// 过期自动换码:QQ 侧的二维码有时效,过期后旧 task 不会复活,只能重新 create_bind_task
// (连带换一把新的对称密钥)。这里在后台自己完成换码并把 urlVersion +1,界面按版本号重画。

import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { fetchWithTimeout } from "../../foundation/net";

const QQ_BIND_BASE_URL = "https://q.qq.com";
/** 界面轮询本接口的建议间隔;真正的平台轮询在后台跑,不占这个节拍。 */
export const QQ_BIND_POLL_INTERVAL_MS = 2_000;
/** 平台侧 poll_bind_result 的轮询间隔。 */
const PLATFORM_POLL_MS = 2_000;
/** 一次绑定会话的总寿命:超时即销毁,防止设置页开着不管会无限轮询腾讯的接口。 */
const SESSION_TTL_MS = 10 * 60_000;
const QR_READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type QqBindCredentials = { appId: string; appSecret: string; userOpenid?: string };

export type QqBindStartResult = {
  sessionKey: string;
  verificationUrl: string;
  pollIntervalMs: number;
  message: string;
};

export type QqBindPollResult = {
  connected: boolean;
  status: "waiting" | "expired" | "failed" | "not_started";
  message: string;
  /** 仅当平台换了码(urlVersion 前进过)才回传,避免界面每两秒重画一次二维码。 */
  verificationUrl?: string;
  appId?: string;
  appSecret?: string;
  userOpenid?: string;
};

type Session = {
  sessionKey: string;
  verificationUrl: string;
  urlVersion: number;
  deliveredUrlVersion: number;
  status: "waiting" | "success" | "failed";
  credentials?: QqBindCredentials;
  failureMessage?: string;
  startedAt: number;
  aborted: boolean;
  /** 首个二维码是否已就绪(create_bind_task 是异步的,start 会等它,上限 QR_READY_TIMEOUT_MS)。 */
  ready?: (url: string) => void;
  failed?: (err: Error) => void;
  loop?: Promise<void>;
};

const sessions = new Map<string, Session>();

/** AES-256-GCM 解密平台下发的 appSecret。base64 布局见文件头注释第 5 步。 */
export function decryptBotSecret(encryptedBase64: string, keyBase64: string): string {
  const blob = Buffer.from(encryptedBase64, "base64");
  if (blob.length < 28) throw new Error("QQ 返回的凭据密文长度异常");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

type BindTaskResponse = {
  retcode?: number;
  msg?: string;
  data?: { task_id?: string; status?: number; bot_appid?: string; bot_encrypt_secret?: string; user_openid?: string };
};

const BIND_STATUS_PENDING = 1;
const BIND_STATUS_COMPLETED = 2;
const BIND_STATUS_EXPIRED = 3;

async function postJson(url: URL, body: Record<string, string>): Promise<BindTaskResponse> {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url.pathname} 返回 HTTP ${response.status}:${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as BindTaskResponse;
  } catch {
    throw new Error(`${url.pathname} 返回了非 JSON 内容`);
  }
}

async function createBindTask(): Promise<{ taskId: string; key: string }> {
  const key = randomBytes(32).toString("base64");
  const result = await postJson(new URL("/lite/create_bind_task", QQ_BIND_BASE_URL), { key });
  if (result.retcode !== 0) throw new Error(result.msg || "创建 QQ 绑定任务失败");
  const taskId = result.data?.task_id;
  if (!taskId) throw new Error("QQ 绑定任务未返回 task_id");
  return { taskId, key };
}

function connectUrl(taskId: string, source: string): string {
  const url = new URL("/qqbot/openclaw/connect.html", QQ_BIND_BASE_URL);
  url.searchParams.set("task_id", taskId);
  url.searchParams.set("source", source);
  url.searchParams.set("_wv", "2");
  return url.toString();
}

async function pollBindResult(taskId: string): Promise<BindTaskResponse["data"]> {
  const result = await postJson(new URL("/lite/poll_bind_result", QQ_BIND_BASE_URL), { task_id: taskId });
  if (result.retcode !== 0) throw new Error(result.msg || "查询 QQ 绑定结果失败");
  return result.data;
}

function sleep(ms: number, session: Session): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    // 会话销毁时立刻叫醒,不等满节拍。
    const check = setInterval(() => {
      if (session.aborted) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 200);
    check.unref?.();
  });
}

/**
 * 后台绑定循环:一代二维码 = 一个 task。
 *
 * 过期就换新一代(新 task + 新 key)并推进 urlVersion;成功则写 credentials 并退出。
 * 任何一次网络异常都只退避重试——扫码过程中网络抖一下是常态,不该把用户的二维码弄没。
 */
async function runBindLoop(session: Session, source: string): Promise<void> {
  while (!session.aborted && session.status === "waiting") {
    let taskId: string;
    let key: string;
    try {
      const task = await createBindTask();
      taskId = task.taskId;
      key = task.key;
      session.verificationUrl = connectUrl(taskId, source);
      session.urlVersion += 1;
      session.ready?.(session.verificationUrl);
    } catch (err) {
      session.status = "failed";
      session.failureMessage = errMessage(err);
      session.failed?.(err instanceof Error ? err : new Error(session.failureMessage));
      return;
    }

    let consecutiveErrors = 0;
    while (!session.aborted && session.status === "waiting") {
      let data: BindTaskResponse["data"];
      try {
        data = await pollBindResult(taskId);
        consecutiveErrors = 0;
      } catch (err) {
        if (++consecutiveErrors >= 5) {
          session.status = "failed";
          session.failureMessage = errMessage(err);
          return;
        }
        await sleep(PLATFORM_POLL_MS, session);
        continue;
      }
      const status = data?.status ?? BIND_STATUS_PENDING;
      if (status === BIND_STATUS_EXPIRED) break; // 换一代二维码
      if (status !== BIND_STATUS_COMPLETED) {
        await sleep(PLATFORM_POLL_MS, session);
        continue;
      }
      const appId = String(data?.bot_appid ?? "").trim();
      const secret = String(data?.bot_encrypt_secret ?? "").trim();
      if (!appId || !secret) {
        session.status = "failed";
        session.failureMessage = "QQ 返回的机器人凭据不完整,请重新扫码。";
        return;
      }
      try {
        session.credentials = {
          appId,
          appSecret: decryptBotSecret(secret, key),
          userOpenid: data?.user_openid ? String(data.user_openid) : undefined,
        };
        session.status = "success";
      } catch (err) {
        session.status = "failed";
        session.failureMessage = `解密 QQ 凭据失败:${errMessage(err)}`;
      }
      return;
    }
  }
}

/**
 * 开始一次扫码绑定。
 *
 * 同一时刻只保留一个会话:每次 start 先销毁在途的旧会话。否则用户反复打开设置页会叠出
 * 一串后台轮询,每一串都在打腾讯的接口,而界面上只看得到最后一个。
 */
export async function startQqBind(opts: { sessionKey?: string; source?: string } = {}): Promise<QqBindStartResult> {
  purgeExpired();
  for (const key of [...sessions.keys()]) destroySession(key);

  const sessionKey = opts.sessionKey || randomUUID();
  const session: Session = {
    sessionKey,
    verificationUrl: "",
    urlVersion: 0,
    deliveredUrlVersion: 0,
    status: "waiting",
    startedAt: Date.now(),
    aborted: false,
  };
  sessions.set(sessionKey, session);

  const ready = new Promise<string>((resolve, reject) => {
    session.ready = resolve;
    session.failed = reject;
  });
  session.loop = runBindLoop(session, opts.source || "rikkahub-desktop").catch((err) => {
    session.status = "failed";
    session.failureMessage = errMessage(err);
    session.failed?.(err instanceof Error ? err : new Error(session.failureMessage));
  });

  let verificationUrl: string;
  try {
    verificationUrl = await withTimeout(ready, QR_READY_TIMEOUT_MS, "获取 QQ 二维码超时,请重试。");
  } catch (err) {
    destroySession(sessionKey);
    throw err;
  }

  session.deliveredUrlVersion = session.urlVersion;
  return {
    sessionKey,
    verificationUrl,
    pollIntervalMs: QQ_BIND_POLL_INTERVAL_MS,
    message: "使用手机 QQ 扫描二维码,创建并授权机器人。",
  };
}

/** 界面轮询:读取会话状态。拿到凭据即销毁会话(一次性)。 */
export function pollQqBind(sessionKey: string): QqBindPollResult {
  purgeExpired();
  const session = sessions.get(sessionKey);
  if (!session) {
    return { connected: false, status: "not_started", message: "当前没有进行中的 QQ 绑定,请重新生成二维码。" };
  }
  if (session.status === "success" && session.credentials) {
    const credentials = session.credentials;
    destroySession(sessionKey);
    return {
      connected: true,
      status: "waiting",
      message: "QQ 机器人绑定成功。",
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      userOpenid: credentials.userOpenid,
    };
  }
  if (session.status === "failed") {
    const message = session.failureMessage || "QQ 授权失败,请重新扫码。";
    destroySession(sessionKey);
    return { connected: false, status: "failed", message };
  }
  const rotated = session.urlVersion !== session.deliveredUrlVersion;
  session.deliveredUrlVersion = session.urlVersion;
  return {
    connected: false,
    status: "waiting",
    message: "等待手机 QQ 扫码确认…",
    ...(rotated ? { verificationUrl: session.verificationUrl } : {}),
  };
}

export function cancelQqBind(sessionKey: string): void {
  destroySession(sessionKey);
}

function destroySession(sessionKey: string): void {
  const session = sessions.get(sessionKey);
  if (!session) return;
  sessions.delete(sessionKey);
  session.aborted = true;
  // 用 failed 而不是 ready:销毁时的语义是"没拿到码"。若 start 还在 await 首个二维码,
  // 让它 reject;已经 settle 过的 promise 再调一次是空操作。
  session.failed?.(new Error("QQ 绑定会话已结束,请重新生成二维码。"));
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.startedAt > SESSION_TTL_MS) destroySession(key);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 测试隔离:模块级会话表不能跨用例泄漏。 */
export function __resetQqBindForTest(): void {
  for (const key of [...sessions.keys()]) destroySession(key);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
