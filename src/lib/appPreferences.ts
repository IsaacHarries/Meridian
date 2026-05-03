/**
 * Typed accessors for the user-tunable preferences exposed in Settings.
 *
 * Each preference has a default and a parser. Reading is fault-tolerant —
 * missing or malformed values fall back to the default rather than
 * propagating errors, so a preference file corrupted by a manual edit
 * never blocks the app from starting.
 */

import { getPreferences, setPreference, deletePreference } from "@/lib/preferences";

// ── Keys ──────────────────────────────────────────────────────────────────────

const KEY = {
  prReviewDefaultChunkChars: "pr_review_default_chunk_chars",
  prTasksPollIntervalMinutes: "pr_tasks_poll_interval_minutes",
  buildCheckTimeoutSecs: "build_check_timeout_secs",
  buildCheckMaxAttempts: "build_check_max_attempts",
  streamingPartialsEnabled: "streaming_partials_enabled",
  workloadOverloadThresholdPct: "workload_overload_threshold_pct",
  dailyTokenBudget: "daily_token_budget",
  notifyPrTaskAdded: "notify_pr_task_added",
  notifyAgentStageComplete: "notify_agent_stage_complete",
  aiDebugEnabled: "ai_debug_enabled",
  aiDebugDockMode: "ai_debug_dock_mode",
  meetingsEmbeddingModel: "meetings_embedding_model",
  meetingsSearchMinScore: "meetings_search_min_score",
} as const;

// ── Defaults ──────────────────────────────────────────────────────────────────
//
// Centralised so the Settings UI can render placeholder text matching the
// runtime fallback, and so a "Reset to default" button can target the
// canonical value.

export const APP_PREFERENCE_DEFAULTS = {
  prReviewDefaultChunkChars: 12000,
  prTasksPollIntervalMinutes: 60,
  buildCheckTimeoutSecs: 300,
  buildCheckMaxAttempts: 3,
  streamingPartialsEnabled: true,
  workloadOverloadThresholdPct: 140,
  /** Null = no budget set; positive integer = soft daily cap (UI alert
   *  when exceeded, no enforcement). */
  dailyTokenBudget: null as number | null,
  notifyPrTaskAdded: false,
  notifyAgentStageComplete: false,
  /** Capture every LLM round-trip (prompt + response + usage) and emit
   *  an event the in-app debug panel renders. Off by default — capture
   *  costs IPC bandwidth and only matters when the user is actively
   *  inspecting prompts. */
  aiDebugEnabled: false,
  /** Where the debug panel docks: edge of the main window or a popped-
   *  out separate window. Persisted so the layout sticks across
   *  app restarts. */
  aiDebugDockMode: "bottom" as AiDebugDockMode,
  /** Ollama embedding model used by the cross-meetings RAG search.
   *  `nomic-embed-text` is a sensible default — 768 dims, English-
   *  optimised, runs on consumer hardware. Users can switch via
   *  Settings → Meetings; doing so clears existing embeddings (they
   *  live in different vector spaces) and triggers a re-embed. */
  meetingsEmbeddingModel: "nomic-embed-text",
  /** Cross-meetings search relevance threshold. Hits with a fused
   *  score below this value are filtered out before reaching the
   *  user. Calibrated against raw cosine similarity from
   *  nomic-embed-text on English conversational prose:
   *    ≥ 0.70  paraphrase / direct match
   *    ≥ 0.55  likely relevant
   *    ≥ 0.45  loosely related
   *    < 0.45  noise
   *  0.61 lands just above "likely relevant" — strict enough to cut
   *  tail noise, lenient enough to allow on-topic non-paraphrase
   *  matches through. */
  meetingsSearchMinScore: 0.61,
} as const;

export type AiDebugDockMode = "bottom" | "right" | "left" | "window" | "hidden";

export type AppPreferences = {
  prReviewDefaultChunkChars: number;
  prTasksPollIntervalMinutes: number;
  buildCheckTimeoutSecs: number;
  buildCheckMaxAttempts: number;
  streamingPartialsEnabled: boolean;
  workloadOverloadThresholdPct: number;
  dailyTokenBudget: number | null;
  notifyPrTaskAdded: boolean;
  notifyAgentStageComplete: boolean;
  aiDebugEnabled: boolean;
  aiDebugDockMode: AiDebugDockMode;
  meetingsEmbeddingModel: string;
  meetingsSearchMinScore: number;
};

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseOptionalPositiveInt(
  raw: string | undefined,
  fallback: number | null,
): number | null {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function parseFloatPositive(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Bulk read ─────────────────────────────────────────────────────────────────

/**
 * Read every app preference in one round-trip and apply defaults to any
 * missing or malformed entries. Use this in places where you need the
 * full set (e.g. the Settings screen). For one-off reads, prefer the
 * dedicated getters below — they each fetch the prefs map.
 */
export async function getAppPreferences(): Promise<AppPreferences> {
  let prefs: Record<string, string>;
  try {
    prefs = await getPreferences();
  } catch {
    prefs = {};
  }
  return {
    prReviewDefaultChunkChars: parsePositiveInt(
      prefs[KEY.prReviewDefaultChunkChars],
      APP_PREFERENCE_DEFAULTS.prReviewDefaultChunkChars,
    ),
    prTasksPollIntervalMinutes: parsePositiveInt(
      prefs[KEY.prTasksPollIntervalMinutes],
      APP_PREFERENCE_DEFAULTS.prTasksPollIntervalMinutes,
    ),
    buildCheckTimeoutSecs: parsePositiveInt(
      prefs[KEY.buildCheckTimeoutSecs],
      APP_PREFERENCE_DEFAULTS.buildCheckTimeoutSecs,
    ),
    buildCheckMaxAttempts: parsePositiveInt(
      prefs[KEY.buildCheckMaxAttempts],
      APP_PREFERENCE_DEFAULTS.buildCheckMaxAttempts,
    ),
    streamingPartialsEnabled: parseBool(
      prefs[KEY.streamingPartialsEnabled],
      APP_PREFERENCE_DEFAULTS.streamingPartialsEnabled,
    ),
    workloadOverloadThresholdPct: parseFloatPositive(
      prefs[KEY.workloadOverloadThresholdPct],
      APP_PREFERENCE_DEFAULTS.workloadOverloadThresholdPct,
    ),
    dailyTokenBudget: parseOptionalPositiveInt(
      prefs[KEY.dailyTokenBudget],
      APP_PREFERENCE_DEFAULTS.dailyTokenBudget,
    ),
    notifyPrTaskAdded: parseBool(
      prefs[KEY.notifyPrTaskAdded],
      APP_PREFERENCE_DEFAULTS.notifyPrTaskAdded,
    ),
    notifyAgentStageComplete: parseBool(
      prefs[KEY.notifyAgentStageComplete],
      APP_PREFERENCE_DEFAULTS.notifyAgentStageComplete,
    ),
    aiDebugEnabled: parseBool(
      prefs[KEY.aiDebugEnabled],
      APP_PREFERENCE_DEFAULTS.aiDebugEnabled,
    ),
    aiDebugDockMode: parseDockMode(
      prefs[KEY.aiDebugDockMode],
      APP_PREFERENCE_DEFAULTS.aiDebugDockMode,
    ),
    meetingsEmbeddingModel:
      (prefs[KEY.meetingsEmbeddingModel] || "").trim() ||
      APP_PREFERENCE_DEFAULTS.meetingsEmbeddingModel,
    meetingsSearchMinScore: parseClampedFloat(
      prefs[KEY.meetingsSearchMinScore],
      APP_PREFERENCE_DEFAULTS.meetingsSearchMinScore,
      0,
      1,
    ),
  };
}

function parseClampedFloat(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseDockMode(
  raw: string | undefined,
  fallback: AiDebugDockMode,
): AiDebugDockMode {
  if (
    raw === "bottom" ||
    raw === "right" ||
    raw === "left" ||
    raw === "window" ||
    raw === "hidden"
  ) {
    return raw;
  }
  return fallback;
}

// ── Setters ───────────────────────────────────────────────────────────────────

export async function setPrReviewDefaultChunkChars(value: number): Promise<void> {
  await setPreference(KEY.prReviewDefaultChunkChars, String(value));
}
export async function setPrTasksPollIntervalMinutes(value: number): Promise<void> {
  await setPreference(KEY.prTasksPollIntervalMinutes, String(value));
}
export async function setBuildCheckTimeoutSecs(value: number): Promise<void> {
  await setPreference(KEY.buildCheckTimeoutSecs, String(value));
}
export async function setBuildCheckMaxAttempts(value: number): Promise<void> {
  await setPreference(KEY.buildCheckMaxAttempts, String(value));
}
export async function setStreamingPartialsEnabled(value: boolean): Promise<void> {
  await setPreference(KEY.streamingPartialsEnabled, value ? "true" : "false");
}
export async function setWorkloadOverloadThresholdPct(value: number): Promise<void> {
  await setPreference(KEY.workloadOverloadThresholdPct, String(value));
}
export async function setDailyTokenBudget(value: number | null): Promise<void> {
  if (value === null) {
    await deletePreference(KEY.dailyTokenBudget);
  } else {
    await setPreference(KEY.dailyTokenBudget, String(value));
  }
}
export async function setNotifyPrTaskAdded(value: boolean): Promise<void> {
  await setPreference(KEY.notifyPrTaskAdded, value ? "true" : "false");
}
export async function setNotifyAgentStageComplete(value: boolean): Promise<void> {
  await setPreference(KEY.notifyAgentStageComplete, value ? "true" : "false");
}
export async function setAiDebugEnabled(value: boolean): Promise<void> {
  await setPreference(KEY.aiDebugEnabled, value ? "true" : "false");
}
export async function setAiDebugDockMode(value: AiDebugDockMode): Promise<void> {
  await setPreference(KEY.aiDebugDockMode, value);
}
export async function setMeetingsEmbeddingModel(value: string): Promise<void> {
  await setPreference(KEY.meetingsEmbeddingModel, value);
}
export async function setMeetingsSearchMinScore(value: number): Promise<void> {
  const clamped = Math.min(1, Math.max(0, value));
  // Format with 2 decimals to keep the on-disk pref readable.
  await setPreference(KEY.meetingsSearchMinScore, clamped.toFixed(2));
}
