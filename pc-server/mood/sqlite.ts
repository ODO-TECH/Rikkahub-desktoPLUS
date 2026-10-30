// mood/sqlite.ts — 心情状态的落盘（与对话同库 rikka_hub.db）。
// 纪律：只做行级读写，不持有内存状态、不发网络请求。衰减不在读取时写回——
// 展示值由 model.decayMoodState 现算，落盘只发生在判定与记账。
import type { Database } from "bun:sqlite";
import { getConversationsDb } from "../conversations";
import { MOOD_DIMS, type MoodDim, type MoodDims, type MoodState } from "./model";

export interface MoodTimelineEntry {
  at: number;
  mood: number;
  delta: number;
  reason: string;
  confidence: number;
  dims: MoodDims;
  dimsDelta: Partial<Record<MoodDim, number>>;
  /** 追加时的判定口径：judge = 正常判定。 */
  kind: string;
}

interface MoodRow {
  key: string;
  mood: number;
  dims: string;
  last_reason: string;
  last_confidence: number;
  minor: number;
  kind: string;
  updated_at: number;
  last_decay_at: number;
  last_noted_mood: number;
  injected_for: number | null;
  said_at: string;
  judge_calls: number;
  judge_failures: number;
}

interface TimelineRow {
  at: number;
  mood: number;
  delta: number;
  reason: string;
  confidence: number;
  dims: string;
  dims_delta: string;
  kind: string;
}

export function ensureMoodTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pc_mood (
      key             TEXT PRIMARY KEY NOT NULL,
      mood            REAL NOT NULL DEFAULT 70,
      dims            TEXT NOT NULL DEFAULT '{}',
      last_reason     TEXT NOT NULL DEFAULT '',
      last_confidence INTEGER NOT NULL DEFAULT 0,
      minor           INTEGER NOT NULL DEFAULT 0,
      kind            TEXT NOT NULL DEFAULT '',
      updated_at      INTEGER NOT NULL DEFAULT 0,
      last_decay_at   INTEGER NOT NULL DEFAULT 0,
      last_noted_mood REAL NOT NULL DEFAULT 70,
      injected_for    INTEGER,
      said_at         TEXT NOT NULL DEFAULT '[]',
      judge_calls     INTEGER NOT NULL DEFAULT 0,
      judge_failures  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pc_mood_timeline (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT NOT NULL,
      at         INTEGER NOT NULL,
      mood       REAL NOT NULL,
      delta      REAL NOT NULL,
      reason     TEXT NOT NULL DEFAULT '',
      confidence INTEGER NOT NULL DEFAULT 0,
      dims       TEXT NOT NULL DEFAULT '{}',
      dims_delta TEXT NOT NULL DEFAULT '{}',
      kind       TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_pc_mood_timeline_key ON pc_mood_timeline(key, at DESC);
  `);
}

export function openMoodDb(): Database | null {
  const db = getConversationsDb();
  if (!db) return null;
  ensureMoodTables(db);
  return db;
}

function parseDims(raw: string | null): MoodDims {
  const dims: MoodDims = { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0 };
  if (!raw) return dims;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const dim of MOOD_DIMS) {
      const value = Number(parsed?.[dim]);
      dims[dim] = Number.isFinite(value) ? value : 0;
    }
  } catch {
    // 坏行按零向量读：宁可少一份细节，也不让面板整块失效。
  }
  return dims;
}

function parseDimsDelta(raw: string | null): Partial<Record<MoodDim, number>> {
  const out: Partial<Record<MoodDim, number>> = {};
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const dim of MOOD_DIMS) {
      const value = Number(parsed?.[dim]);
      if (Number.isFinite(value) && value !== 0) out[dim] = value;
    }
  } catch {
    return out;
  }
  return out;
}

function parseSaidAt(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function rowToState(row: MoodRow): MoodState {
  return {
    key: row.key,
    mood: Number(row.mood),
    dims: parseDims(row.dims),
    lastReason: row.last_reason ?? "",
    lastConfidence: Number(row.last_confidence),
    minor: Number(row.minor) === 1,
    kind: row.kind === "judge" ? "judge" : "",
    updatedAt: Number(row.updated_at),
    lastDecayAt: Number(row.last_decay_at),
    lastNotedMood: Number(row.last_noted_mood),
    injectedFor: row.injected_for == null ? null : Number(row.injected_for),
    saidAt: parseSaidAt(row.said_at),
    judgeCalls: Number(row.judge_calls),
    judgeFailures: Number(row.judge_failures),
  };
}

export function loadMoodState(db: Database, key: string): MoodState | null {
  ensureMoodTables(db);
  const row = db.query("SELECT * FROM pc_mood WHERE key = ?").get(key) as MoodRow | null;
  return row ? rowToState(row) : null;
}

export function saveMoodState(
  db: Database,
  state: MoodState,
  timeline?: MoodTimelineEntry,
): void {
  ensureMoodTables(db);
  const write = db.transaction(() => {
    db.query(
      `INSERT INTO pc_mood (
         key, mood, dims, last_reason, last_confidence, minor, kind, updated_at,
         last_decay_at, last_noted_mood, injected_for, said_at, judge_calls, judge_failures
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         mood = excluded.mood,
         dims = excluded.dims,
         last_reason = excluded.last_reason,
         last_confidence = excluded.last_confidence,
         minor = excluded.minor,
         kind = excluded.kind,
         updated_at = excluded.updated_at,
         last_decay_at = excluded.last_decay_at,
         last_noted_mood = excluded.last_noted_mood,
         injected_for = excluded.injected_for,
         said_at = excluded.said_at,
         judge_calls = excluded.judge_calls,
         judge_failures = excluded.judge_failures`,
    ).run(
      state.key,
      state.mood,
      JSON.stringify(state.dims),
      state.lastReason,
      Math.round(state.lastConfidence),
      state.minor ? 1 : 0,
      state.kind,
      state.updatedAt,
      state.lastDecayAt,
      state.lastNotedMood,
      state.injectedFor,
      JSON.stringify(state.saidAt.slice(-200)),
      state.judgeCalls,
      state.judgeFailures,
    );
    if (timeline) {
      db.query(
        `INSERT INTO pc_mood_timeline (key, at, mood, delta, reason, confidence, dims, dims_delta, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        state.key,
        timeline.at,
        timeline.mood,
        timeline.delta,
        timeline.reason,
        Math.round(timeline.confidence),
        JSON.stringify(timeline.dims),
        JSON.stringify(timeline.dimsDelta),
        timeline.kind,
      );
    }
  });
  write();
}

export function listMoodTimeline(db: Database, key: string, limit: number): MoodTimelineEntry[] {
  ensureMoodTables(db);
  const rows = db.query(
    "SELECT at, mood, delta, reason, confidence, dims, dims_delta, kind FROM pc_mood_timeline WHERE key = ? ORDER BY at DESC LIMIT ?",
  ).all(key, limit) as TimelineRow[];
  return rows.map((row) => ({
    at: Number(row.at),
    mood: Number(row.mood),
    delta: Number(row.delta),
    reason: row.reason ?? "",
    confidence: Number(row.confidence),
    dims: parseDims(row.dims),
    dimsDelta: parseDimsDelta(row.dims_delta),
    kind: row.kind ?? "",
  }));
}

export function resetMoodState(db: Database, key: string): void {
  ensureMoodTables(db);
  const write = db.transaction(() => {
    db.query("DELETE FROM pc_mood WHERE key = ?").run(key);
    db.query("DELETE FROM pc_mood_timeline WHERE key = ?").run(key);
  });
  write();
}
