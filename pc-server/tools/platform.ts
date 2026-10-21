// tools/platform.ts — 本地工具调用的平台能力（剪贴板、系统 TTS）
// 纪律：只封装 OS 命令调用，不依赖业务状态。

import { existsSync, rmSync, readFileSync } from "node:fs";
import { bumpAnalyticsTtsCount } from "../app-config/analytics";
import { join } from "node:path";
import { tempDir } from "../foundation/platform";

export async function runPowerShell(command: string, input = "") {
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input) {
    proc.stdin.write(input);
  }
  proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `PowerShell exited with code ${exitCode}`);
  return stdout;
}

export function clipboardCommand(): string | null {
  if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
    return "wl";
  }
  if (process.env.DISPLAY || process.env.XDG_SESSION_TYPE === "x11") {
    return "x11";
  }
  return null;
}

export async function readSystemClipboardText() {
  if (process.platform === "win32") {
    return runPowerShell("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw");
  }
  const backend = clipboardCommand();
  try {
    if (backend === "wl") {
      const proc = Bun.spawnSync(["wl-paste"]);
      if (proc.exitCode === 0) return new TextDecoder().decode(proc.stdout).trim();
    } else if (backend === "x11") {
      const proc = Bun.spawnSync(["xclip", "-selection", "clipboard", "-o"]);
      if (proc.exitCode === 0) return new TextDecoder().decode(proc.stdout).trim();
    }
  } catch (e) { console.warn("[clipboard] read failed:", e); }
  return "";
}

export async function writeSystemClipboardText(text: string) {
  if (process.platform === "win32") {
    await runPowerShell("[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())", text);
    return;
  }
  const backend = clipboardCommand();
  try {
    if (backend === "wl") {
      const proc = Bun.spawn(["wl-copy"], { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      await proc.exited;
    } else if (backend === "x11") {
      const proc = Bun.spawn(["xclip", "-selection", "clipboard"], { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      await proc.exited;
    }
  } catch (e) { console.warn("[clipboard] write failed:", e); }
}

// Global serialization lock for system TTS. Without this, parallel client
// fetches (chunked-playback prefetch) would each spawn their own TTS process,
// producing the "multiple voices speaking at once" bug.
let systemTtsChain: Promise<void> = Promise.resolve();

// All currently-spawned system-TTS processes — keyed by Subprocess so we can
// `kill()` them when the client calls /api/tts/cancel.
const activeSystemTtsProcs = new Set<ReturnType<typeof Bun.spawn>>();

export async function speakSystemText(text: string, speechRate = 1) {
  bumpAnalyticsTtsCount();
  const prev = systemTtsChain;
  let release: () => void = () => {};
  systemTtsChain = new Promise<void>((resolve): void => { release = resolve; });
  try {
    await prev.catch((): undefined => undefined);
    if (process.platform === "win32") {
      const rate = Math.max(-10, Math.min(10, Math.round((speechRate - 1) * 5)));
      const script = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        `$s.Rate = ${rate}`,
        "$s.Speak([Console]::In.ReadToEnd())",
        "$s.Dispose()",
      ].join("; ");
      const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      activeSystemTtsProcs.add(proc);
      try {
        proc.stdin.write(text);
        proc.stdin.end();
        const exitCode = await proc.exited;
        if (exitCode !== 0 && exitCode !== null) {
          const stderrText = await new Response(proc.stderr).text().catch(() => "");
          if (stderrText.trim()) console.warn(`[tts] System TTS exited ${exitCode}: ${stderrText.slice(0, 200)}`);
        }
      } finally {
        activeSystemTtsProcs.delete(proc);
      }
    } else {
      const speed = Math.max(80, Math.min(450, Math.round(175 * speechRate)));
      const proc = Bun.spawn(["espeak-ng", "--stdin", "-s", String(speed)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      activeSystemTtsProcs.add(proc);
      try {
        proc.stdin.write(text);
        proc.stdin.end();
        const exitCode = await proc.exited;
        if (exitCode !== 0 && exitCode !== null) {
          const stderrText = await new Response(proc.stderr).text().catch(() => "");
          if (stderrText.trim()) console.warn(`[tts] espeak-ng exited ${exitCode}: ${stderrText.slice(0, 200)}`);
        }
      } finally {
        activeSystemTtsProcs.delete(proc);
      }
    }
  } finally {
    release();
  }
}

export async function synthesizeSystemTtsToWav(text: string, speechRate = 1): Promise<Buffer> {
  const prev = systemTtsChain;
  let release: () => void = () => {};
  systemTtsChain = new Promise<void>((resolve): void => { release = resolve; });
  const tmpWav = join(tempDir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
  try {
    await prev.catch((): undefined => undefined);
    if (process.platform === "win32") {
      const rate = Math.max(-10, Math.min(10, Math.round((speechRate - 1) * 5)));
      const script = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        `$s.Rate = ${rate}`,
        `$s.SetOutputToWaveFile('${tmpWav.replace(/'/g, "''")}')`,
        "$s.Speak([Console]::In.ReadToEnd())",
        "$s.Dispose()",
      ].join("; ");
      const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      activeSystemTtsProcs.add(proc);
      try {
        proc.stdin.write(text);
        proc.stdin.end();
        const exitCode = await proc.exited;
        if (exitCode !== 0 && exitCode !== null) {
          const stderrText = await new Response(proc.stderr).text().catch(() => "");
          if (stderrText.trim()) console.warn(`[tts] System TTS exited ${exitCode}: ${stderrText.slice(0, 200)}`);
        }
      } finally {
        activeSystemTtsProcs.delete(proc);
      }
    } else {
      const speed = Math.max(80, Math.min(450, Math.round(175 * speechRate)));
      const proc = Bun.spawn(["espeak-ng", "-w", tmpWav, "-s", String(speed), "--stdin"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      activeSystemTtsProcs.add(proc);
      try {
        proc.stdin.write(text);
        proc.stdin.end();
        const exitCode = await proc.exited;
        if (exitCode !== 0 && exitCode !== null) {
          const stderrText = await new Response(proc.stderr).text().catch(() => "");
          if (stderrText.trim()) console.warn(`[tts] espeak-ng exited ${exitCode}: ${stderrText.slice(0, 200)}`);
        }
      } finally {
        activeSystemTtsProcs.delete(proc);
      }
    }
    if (!existsSync(tmpWav)) throw new Error("System TTS failed to produce audio file");
    return readFileSync(tmpWav);
  } finally {
    release();
    try { if (existsSync(tmpWav)) rmSync(tmpWav); } catch { /* best-effort */ }
  }
}

export function cancelAllSystemTts() {
  for (const proc of activeSystemTtsProcs) {
    try { proc.kill(); } catch { /* best-effort */ }
  }
  activeSystemTtsProcs.clear();
}
