// api/handlers/mood.ts — 心情实验路由（设置、当前状态、时间线、重置）。
// 纪律：与记忆实验平级；总开关关闭时 GET 返回空壳、POST 只改设置，不触发任何判定。
import { error, json, readJson } from "../request";
import { state } from "../../persistence/json-store";
import { updateSettings } from "../../app-config";
import { applyMoodExperimentPatch } from "../../mood/config";
import { getMoodExperimentSettings } from "../../mood/gate";
import { moodKey } from "../../mood/judge";
import {
  buildInjectionText,
  decayMoodState,
  emptyMoodState,
  evaluateInjection,
  moodBandLabel,
  saidToday,
} from "../../mood/model";
import { listMoodTimeline, loadMoodState, openMoodDb, resetMoodState } from "../../mood/sqlite";
import { clearMoodInjectionCache } from "../../mood/injection";

function assistantKey(url: URL, body?: Record<string, unknown>): string {
  const assistantId = String(
    body?.assistantId ?? url.searchParams.get("assistantId") ?? state.settings.assistantId ?? "",
  ).trim();
  return moodKey(assistantId);
}

export async function handleMoodRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  if (path === "settings/mood-experiment" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const current = getMoodExperimentSettings();
    let next;
    try {
      next = applyMoodExperimentPatch(current, body);
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 400);
    }
    updateSettings({ ...state.settings, moodExperimentSettings: next });
    return json({ status: "ok", moodExperimentSettings: next });
  }

  if (path === "mood/experiment/state" && request.method === "GET") {
    const settings = getMoodExperimentSettings();
    if (!settings.enabled) {
      return json({ enabled: false, dryRun: settings.dryRun, state: null });
    }
    const db = openMoodDb();
    if (!db) return json({ enabled: true, dryRun: settings.dryRun, state: null });
    const key = assistantKey(url);
    const now = Date.now();
    const stored = loadMoodState(db, key) ?? emptyMoodState(key, settings.moodBase, now);
    const view = decayMoodState(stored, settings, now);
    const decision = evaluateInjection(view, settings, now);
    const ownerName = String(state.settings.displaySetting?.userNickname ?? "");
    const preview = decision === "say" || decision === "already_said"
      ? buildInjectionText(view, settings, ownerName, now)
      : "";
    return json({
      enabled: true,
      dryRun: settings.dryRun,
      state: {
        mood: Math.round(view.mood * 10) / 10,
        band: moodBandLabel(view.mood),
        dims: view.dims,
        lastReason: view.lastReason,
        lastConfidence: view.lastConfidence,
        minor: view.minor,
        judged: view.kind === "judge",
        updatedAt: view.updatedAt || null,
        judgeCalls: view.judgeCalls,
        judgeFailures: view.judgeFailures,
        saidToday: saidToday(view, now),
        injectPerDay: settings.injectPerDay,
        decision,
        preview,
      },
    });
  }

  if (path === "mood/experiment/timeline" && request.method === "GET") {
    const settings = getMoodExperimentSettings();
    if (!settings.enabled) return json({ timeline: [] });
    const db = openMoodDb();
    if (!db) return json({ timeline: [] });
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.round(rawLimit))) : 100;
    return json({ timeline: listMoodTimeline(db, assistantKey(url), limit) });
  }

  if (path === "mood/experiment/reset" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const db = openMoodDb();
    if (!db) return error("数据库不可用", 503);
    const key = assistantKey(url, body);
    resetMoodState(db, key);
    // 重置后旧注入文本与当前状态脱节，缓存必须一起清；否则同一条消息重编码还会写回旧心情。
    clearMoodInjectionCache();
    return json({ status: "ok" });
  }

  return null;
}
