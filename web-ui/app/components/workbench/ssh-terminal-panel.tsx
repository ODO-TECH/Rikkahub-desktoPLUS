import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plug, PlugZap } from "lucide-react";

import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import type { Terminal as TerminalType } from "@xterm/xterm";

import { Button } from "~/components/ui/button";
import { appendWebAuthQuery } from "~/services/api";
import { openSettingsDialog } from "~/stores/settings-dialog-store";
import { base64ToBytes, isHostKeyError, parseTerminalFrame, terminalErrorText } from "./ssh-terminal-frames";

// 交互式终端面板:Workbench 面板类型 "ssh-terminal"。
// 与移动端 Termux 内嵌终端对应的那一半是 pc-server/ssh/terminal-session.ts:
// 帧协议(文本帧 JSON,远端输出 base64)与状态行都已在服务端写好并写进缓冲区
// (`[Connecting to user@host:port...]`、`Process completed (code N) - press Enter`、
// `Connection lost`、`[Terminal closed]`),所以前端只管 term.write,不再自己拼文案。
//
// 为什么单独一个面板而不是文件面板里的第五个标签:xterm 要按容器像素算行列数,
// 藏在隐藏容器里 fit 出来是 0 列,得等可见再重算;单独面板既没有这个问题,
// 也能在卡片头部把 `user@host:port` 常驻显示——同一屏里可能同时开着别的机器的终端。
//
// 生命周期与移动端一致:面板被替换/卸载就等于关掉终端界面,那条 PTY 通道也就结束
// (ws 关闭 → 服务端 disposeTerminalSession)。没有后台常驻会话。
//
// 纪律:键盘输入与远端回显都不落日志、不进 store、不进 URL——终端里敲的可能是密码。

interface SshTerminalPanelProps {
  deviceId: string;
  dirId: string;
  /** 显示用的 `user@host:port`(不含凭据)与授权目录路径,由打开方从工作区 DTO 带来。 */
  label: string;
  root: string;
}

type Phase = "loading" | "connecting" | "running" | "ended";

/**
 * 起步与可读尺寸:容器量不出来的时候(面板刚挂载、被折叠、或整个页面在后台)按 80x24 起,
 * 别让远端开出一个 2 列的 shell——那既读不了也敲不了,而且 resize 帧之前整条会话都是坏的。
 */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 20;
const MIN_ROWS = 3;
/** 容器要小到这个程度就说明它根本不可见,这时 fit 出来的行列数没有意义。 */
const MIN_CONTAINER_WIDTH = 40;
const MIN_CONTAINER_HEIGHT = 20;

/** 浏览器直连(WebSocket 带不上请求头),所以取址与 iframe/anchor 同一套路:补 web-auth query。 */
function terminalSocketUrl(): string {
  const base = new URL(window.location.href);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  // appendWebAuthQuery 只会在这条 /api/ 路径后面接 query,不会改写成相对查询串。
  return `${protocol}//${base.host}${appendWebAuthQuery("/api/ssh/terminal")}`;
}

/**
 * 令牌色解析:主题变量可能是 oklch(xterm 的解析器只吃 CSS 颜色的常见子集),
 * 所以走一次 DOM——把值挂到元素上再读 computed color,浏览器会替我们换算成 rgb()。
 * 这样无论哪套主题(浅色/深色/高对比),终端底色与左右两侧面板都是同一个色。
 */
function resolveColors(tokens: string[]): Record<string, string> {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  probe.style.opacity = "0";
  document.body.append(probe);
  const out: Record<string, string> = {};
  try {
    for (const token of tokens) {
      probe.style.color = `var(${token})`;
      const value = getComputedStyle(probe).color;
      if (value) out[token] = value;
    }
  } finally {
    probe.remove();
  }
  return out;
}

export function SshTerminalPanel({ deviceId, dirId, label, root }: SshTerminalPanelProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = React.useState<Phase>("loading");
  // 主机密钥类错误单独给一条横幅:唯一的修法是在设置里重新信任,让用户在那儿办完再回来。
  const [hostKeyIssue, setHostKeyIssue] = React.useState<string | null>(null);
  // 递增即整条会话重建(断开后点「连接」= 新开一条终端,复用一个已经死掉的 ws 是没有意义的)。
  const [sessionKey, setSessionKey] = React.useState(0);

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let term: TerminalType | null = null;
    let fit: FitAddonType | null = null;
    let observer: ResizeObserver | null = null;
    let socket: WebSocket | null = null;
    // 服务端是否已经给过结论(exit 帧或 error 帧)。给了就别再补「连接已断开」——
    // 连接失败时服务端先发 error 再关通道,再补一行只会把真正的原因挤走。
    let answered = false;

    const send = (frame: Record<string, unknown>) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };

    void (async () => {
      // xterm 只有这个面板用,动态导入把 ~300KB 的模拟器和它的 CSS 留在异步块里。
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      await import("@xterm/xterm/css/xterm.css");
      if (disposed) return;

      const colors = resolveColors(["--background", "--foreground", "--primary", "--border", "--muted-foreground"]);
      const mono = getComputedStyle(document.body).getPropertyValue("--font-mono").trim();

      term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: mono || "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        // 行距取 1,与右侧栏其它等宽块一致;默认 1.0 以上会让终端看起来比面板松。
        lineHeight: 1.15,
        scrollback: 2000,
        theme: {
          background: colors["--background"] ?? "#101010",
          foreground: colors["--foreground"] ?? "#e6e6e6",
          cursor: colors["--primary"] ?? "#e6e6e6",
          selectionBackground: colors["--border"] ?? "#3a3a3a",
        },
      });
      term.open(container);
      fit = new FitAddon();
      term.loadAddon(fit);
      // 容器不可见时 fit 量到的是退化值(实测隐藏页面里能量出 2x1):保持 Terminal 默认的 80x24,
      // 等 ResizeObserver 那一路再把尺寸校正到实际布局。
      if (container.clientWidth >= MIN_CONTAINER_WIDTH && container.clientHeight >= MIN_CONTAINER_HEIGHT) fit.fit();
      if (disposed) return;

      term.onData((data) => send({ type: "input", data }));
      // 尺寸变化由两条路触发(用户拖面板、远端要求换窗口),都要转成 resize 帧——
      // 服务端会夹到 MAX_COLS/MAX_ROWS,这里不必重复设限。
      term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));

      observer = new ResizeObserver(() => {
        // 容器高度为 0(面板正在被关掉)时 fit 会算出 0 行,把终端压扁后回不去。
        if (container.clientHeight < MIN_CONTAINER_HEIGHT || container.clientWidth < MIN_CONTAINER_WIDTH) return;
        try {
          fit?.fit();
        } catch {
          /* 忽略:终端已 dispose */
        }
      });
      observer.observe(container);

      setPhase("connecting");
      socket = new WebSocket(terminalSocketUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed || !term) return;
        setPhase("running");
        setHostKeyIssue(null);
        // 容器不可见时 fit 量出的行列数是真的荒谬(2x1),照着它开出来的 shell 没法用:
        // 低于可读尺寸先退回 80x24,等面板可见后 ResizeObserver→fit→onResize 会补一条 resize 帧。
        if (term.cols < MIN_COLS || term.rows < MIN_ROWS) term.resize(DEFAULT_COLS, DEFAULT_ROWS);
        send({ type: "start", deviceId, dirId, cols: term.cols, rows: term.rows });
        term.focus();
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const frame = parseTerminalFrame(event.data);
        if (!frame) return;
        if (frame.type === "output" && typeof frame.data === "string") {
          try {
            term?.write(base64ToBytes(frame.data));
          } catch {
            /* 忽略:坏帧不该把整个终端带崩 */
          }
          return;
        }
        if (frame.type === "exit") {
          answered = true;
          setPhase("ended");
          return;
        }
        if (frame.type === "error") {
          answered = true;
          // 红字只写一行:文案取服务端 errorCode 的本地化词条或远端原文,退出/断连状态行由服务端写缓冲。
          const text = terminalErrorText(frame, t("workbench.terminal.failed"));
          term?.write(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
          setPhase("ended");
          // 主机密钥问题的唯一修法是在设置里重新信任,单独给横幅比埋在红字里更容易看见。
          if (isHostKeyError(frame)) setHostKeyIssue(text);
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        // exit/error 帧都没来过,说明通道自己断了(后端重启、网络掉线):服务端连状态行都来不及写,
        // 这里补一行,否则界面只是「光标停住」,用户不知道还要不要重连。
        if (!answered) term?.writeln(`[${t("workbench.terminal.disconnected")}]`);
        setPhase("ended");
      };
      socket.onerror = () => {
        if (disposed) return;
        setPhase("ended");
      };
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      // 主动发 close:服务端会照移动端的样子写退出行再收通道。socket 已经关了就算了。
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: "close" }));
        } catch {
          /* 忽略 */
        }
      }
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
      socketRef.current = null;
      fit?.dispose();
      term?.dispose();
      setPhase("loading");
    };
  }, [deviceId, dirId, sessionKey, t]);

  const target = [label, root].filter(Boolean).join(" · ");
  const running = phase === "running" || phase === "connecting";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-mini text-muted-foreground" title={target}>
          {target || t("workbench.terminal.title")}
        </span>
        {phase === "loading" ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={phase === "loading"}
          aria-label={running ? t("workbench.terminal.disconnect") : t("workbench.terminal.reconnect")}
          title={running ? t("workbench.terminal.disconnect") : t("workbench.terminal.reconnect")}
          onClick={() => {
            // 连接与断开同一个动作:重建会话。effect 的 cleanup 负责发 close 帧并 dispose,
            // 这里不碰 socket——复用一个已经死掉的 ws 没有意义,移动端也是重开一个终端。
            setSessionKey((key) => key + 1);
            setHostKeyIssue(null);
          }}
        >
          {running ? <PlugZap className="size-3.5" /> : <Plug className="size-3.5" />}
        </Button>
      </div>

      {hostKeyIssue ? (
        <div className="flex items-start gap-2 border-b bg-warning/10 px-3 py-2 text-warning text-xs">
          <span className="min-w-0 flex-1 leading-5">{hostKeyIssue}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2"
            onClick={() => openSettingsDialog("?section=extensions&sub=ssh")}
          >
            {t("workbench.terminal.confirm_host_key")}
          </button>
        </div>
      ) : null}

      {/* 终端本体:背景用 --background(与主题同一色),不留内边距——
          xterm 的行列数是按像素算的,内边距会让最后一列在右侧被切掉。 */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-[var(--background)]" />
    </div>
  );
}
