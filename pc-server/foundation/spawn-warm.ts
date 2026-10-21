// foundation/spawn-warm.ts — 启动期"垫刀":把 Bun 在 Windows 上首次 spawn 子进程的停顿挪出主线程。
//
// 实测(Bun 1.4.2 / Win10,单文件 exe 与 bun 直跑同样复现):进程内**第一次子进程调用会同步
// 阻塞调用线程约 3.1–3.3 秒**,第二次起只要 12–25ms;Bun.spawn 与 Bun.spawnSync 共用同一份
// 初始化(先 spawnSync 3289ms,紧随的 spawn 就只要 19ms),且与命令无关(cmd / reg query 都是
// 3.1s),同机 Node 首次 spawn 仅 24ms。本应用启动期唯一的 spawn 是 MCP stdio 探活,它正好
// 压在 bootstrap 关键路径上 —— 用户说的"每次启动都要卡一会"主要就是这 3 秒。
//
// 对策:进程一起来就在独立线程里做一次丢弃式 spawn,让那条线程吃掉停顿。对照实验:线程里
// spawn 时主线程 200ms 后的首次 spawn 只要 25ms 且子进程输出正确;线程只建不 spawn 时主线程
// 依旧 3.1s。可见代价在 spawn 初始化本身,不在建线程。
//
// 为什么是 Blob 而不是 worker 文件:Bun --compile 不把 `new Worker("./x.ts")` 的路径打进单文件
// exe,运行时按当前工作目录去磁盘找(实测报 ModuleNotFound,便携版 CWD 里当然没有 .ts)。
// Blob 源码随二进制走,才是自包含的。

/** worker 源码:起一个立刻退出的子进程,等它退出后报个平安。 */
const WARM_SOURCE = `
const proc = Bun.spawn(["cmd", "/c", "exit"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await proc.exited;
postMessage("warm");
`;

/** 幂等:进程内只垫一次刀。非 Windows 或任何失败一律静默,顶多是回到旧的 3.1s。 */
export function primeFirstSpawn(): void {
  if (primeFirstSpawn.done || process.platform !== "win32") return;
  primeFirstSpawn.done = true;
  try {
    const worker = new Worker(URL.createObjectURL(new Blob([WARM_SOURCE], { type: "text/javascript" })), { type: "module" });
    const retire = () => { void worker.terminate(); };
    worker.onmessage = retire;
    worker.onerror = retire;
    // 垫刀线程跑完就该收线(它只为吸收那 3 秒,常驻只会多占一份线程内存);若它连消息都回不来,
    // 15s 兜底强制收线。定时器 unref,绝不拖住退出。
    const backstop = setTimeout(retire, 15000);
    if (typeof backstop === "object" && "unref" in backstop) backstop.unref();
  } catch {
    // 垫刀失败绝不影响启动。
  }
}
primeFirstSpawn.done = false;
