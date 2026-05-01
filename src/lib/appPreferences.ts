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
} as const;

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
  };
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
