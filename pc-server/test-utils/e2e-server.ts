// test-utils/e2e-server.ts — 子进程 e2e 测试共用:等待服务器真正就绪。
// R1-1 之后端口标记先于就绪打出(先绑端口,bootstrap 状态装载/迁移异步跑,期间 /api
// 一律 503),真实前端靠轮询 /api/startup/status 渲染进度页;e2e 同样必须等 ready 再发
// 业务请求。此前 5 个 e2e 文件各自复制"只等端口标记"的 waitForPortLine,一直踩着
// "端口出现≠可服务"的竞态,批7 R1-7 给 bootstrap 加了系统代理预热耗时后被集体暴露,
// 统一收敛到本助手(等端口 + 轮询就绪闸门)。

export async function waitForServerReady(proc: ReturnType<typeof Bun.spawn>, timeoutMs = 20_000): Promise<number> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + timeoutMs;
  let port = 0;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    const m = acc.match(/RIKKAHUB_PORT:(\d+)/);
    if (m) {
      port = Number(m[1]);
      break;
    }
  }
  reader.releaseLock();
  if (!port) throw new Error(`服务端未打印端口标记,输出:\n${acc.slice(0, 2000)}`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/startup/status`);
      const status = (await res.json()) as { ready?: boolean; failed?: boolean; error?: string };
      if (status.failed) throw new Error(`服务端引导失败:${String(status.error ?? "")}`);
      if (status.ready) return port;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("服务端引导失败")) throw err;
      // 端口刚绑上的瞬间 fetch 可能被拒,继续轮询
    }
    await Bun.sleep(25);
  }
  throw new Error("服务端超时未就绪(startup/status.ready 未变 true)");
}
