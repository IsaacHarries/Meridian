/**
 * Types and pure helpers for the work-hours time tracker.
 *
 * The data model is segment-oriented: each work day is a list of intervals
 * `{ startMs, endMs }`. The current open interval has `endMs === null`.
 * Total work time for a day = sum of `(endMs - startMs)` across closed
 * segments, plus the live delta `(now - startMs)` for any open segment.
 *
 * Days are keyed by local-calendar `YYYY-MM-DD`. Midnight rollover is
 * handled by the store: if a segment is still open at 23:59:59 local time,
 * it gets closed at the calendar boundary and a fresh segment opens for
 * the new day.
 */
import { invoke } from "@tauri-apps/api/core";

export const MS_PER_HOUR = 60 * 60 * 1000;
export const DEFAULT_DAILY_TARGET_HOURS = 7;
export const DEFAULT_IDLE_THRESHOLD_MIN = 15;
export const MIN_IDLE_THRESHOLD_MIN = 1;
export const MAX_IDLE_THRESHOLD_MIN = 120;

// ── Types ────────────────────────────────────────────────────────────────────

/** Closed: both endpoints set. Open: endMs is null. */
export interface WorkSegment {
  startMs: number;
  endMs: number | null;
  /**
   * Why this segment ended — for the timeline UI to badge "locked screen"
   * vs "idle" vs "manual stop". `null` while the segment is open.
   */
  endReason: WorkSegmentEndReason | null;
}

export type WorkSegmentEndReason =
  | "screen-locked"
  | "idle"
  | "midnight"
  | "manual"
  | "shutdown";

/** State the system poller reports back to us. */
export interface SystemActivitySnapshot {
  isLocked: boolean;
  idleSec: number;
}

export interface TimeTrackingSettings {
  /**
   * Master switch. When false, no new segments are opened, the header
   * chip renders as nothing, and the workflow's pause/resume become
   * no-ops — but every existing segment, adjustment, and import stays
   * intact, so flipping this back on resumes tracking from the next
   * poll tick.
   */
  trackingEnabled: boolean;
  dailyTargetHours: number;
  idleFallbackEnabled: boolean;
  idleThresholdMin: number;
  /**
   * When true, the header stopwatch chip renders as nothing — useful when
   * the user wants the screen-real-estate back. Always reachable through
   * Settings or the Time Tracking workflow to flip back on.
   */
  chipHiddenInHeader: boolean;
}

export const DEFAULT_TIME_TRACKING_SETTINGS: TimeTrackingSettings = {
  trackingEnabled: true,
  dailyTargetHours: DEFAULT_DAILY_TARGET_HOURS,
  idleFallbackEnabled: true,
  idleThresholdMin: DEFAULT_IDLE_THRESHOLD_MIN,
  chipHiddenInHeader: false,
};

// ── Date-key helpers ─────────────────────────────────────────────────────────

/** `YYYY-MM-DD` in the user's local time zone. */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** First instant of the next local day after `d` (i.e. local midnight). */
export function nextLocalMidnightMs(d: Date = new Date()): number {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return next.getTime();
}

/** Monday (or `weekStart`) at 00:00 local time on or before `d`. */
export function startOfWeek(d: Date = new Date(), weekStart: 0 | 1 = 1): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (out.getDay() - weekStart + 7) % 7;
  out.setDate(out.getDate() - diff);
  return out;
}

/** Returns the seven local-day keys of the week containing `d`. */
export function weekDayKeys(d: Date = new Date()): string[] {
  const start = startOfWeek(d);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    out.push(dayKey(day));
  }
  return out;
}

/** Format the Monday→Sunday range of the week containing `d`, e.g.
 *  "Apr 13 – Apr 19, 2026" or "Mar 30 – Apr 5, 2026" if the range
 *  crosses a month. */
export function formatWeekRange(d: Date): string {
  const start = startOfWeek(d);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  const startStr = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const endStr = end.toLocaleDateString(undefined, {
    month: sameMonth ? undefined : "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startStr} – ${endStr}`;
}

/** Days a calendar week is offset from the week containing `reference`.
 *  Negative for past weeks, 0 for the current week. */
export function weekOffsetFromReference(target: Date, reference: Date): number {
  const a = startOfWeek(target).getTime();
  const b = startOfWeek(reference).getTime();
  return Math.round((a - b) / (7 * 24 * 60 * 60 * 1000));
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Sum the elapsed time of every segment for a day. `nowMs` is used to
 * extend any still-open segment up to the present so the running stopwatch
 * stays in sync with wall-clock time.
 */
export function totalMsForDay(segments: WorkSegment[], nowMs: number): number {
  let total = 0;
  for (const seg of segments) {
    const end = seg.endMs ?? nowMs;
    if (end > seg.startMs) total += end - seg.startMs;
  }
  return total;
}

/**
 * `totalMsForDay` plus a per-day manual adjustment (positive or negative).
 * Used everywhere the user-visible total is shown — segments alone don't
 * include corrections the user has made via the chip popover.
 */
export function totalMsForDayWithAdjustment(
  segments: WorkSegment[],
  adjustmentMs: number,
  nowMs: number,
): number {
  return Math.max(0, totalMsForDay(segments, nowMs) + adjustmentMs);
}

export function hoursWorkedToday(
  segments: WorkSegment[],
  nowMs: number,
): number {
  return totalMsForDay(segments, nowMs) / MS_PER_HOUR;
}

/** `5h 32m`. Negative durations come back as `0m`. */
export function formatDurationHm(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** `05:32` style — used in the header chip where a fixed-width display reads cleaner. */
export function formatDurationHmCompact(ms: number): string {
  const safe = Math.max(0, ms);
  const totalMin = Math.floor(safe / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** `9:32 AM`-style local time of a millisecond timestamp. */
export function formatTimeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Overtime balance ─────────────────────────────────────────────────────────

/**
 * Net overtime (in ms) across the days passed in:
 *   sum(actualMs) - sum(targetMsForCompletedDays)
 *
 * "Completed" means the day is strictly before today — today's deficit isn't
 * counted as a debit because the day is still in progress. Same idea for
 * weekend days the user didn't work: they don't contribute to the target.
 *
 * Implementation note: we treat any day where the user logged work as a
 * "working day" that contributes to the target. Days with zero segments are
 * ignored (weekends, sick days, holidays). This avoids the user having to
 * configure their workweek explicitly — we infer it from behaviour.
 */
export function overtimeBalanceMs(
  perDayMs: Record<string, number>,
  todayKey: string,
  dailyTargetHours: number,
): number {
  const targetMs = dailyTargetHours * MS_PER_HOUR;
  let balance = 0;
  for (const [key, actualMs] of Object.entries(perDayMs)) {
    if (actualMs <= 0) continue;
    const isPastDay = key < todayKey;
    if (isPastDay) {
      balance += actualMs - targetMs;
    } else if (key === todayKey) {
      // Today: only credit overtime past the target, never debit.
      balance += Math.max(0, actualMs - targetMs);
    }
    // Future-dated entries (shouldn't happen) are ignored.
  }
  return balance;
}

// ── Tauri bridge ─────────────────────────────────────────────────────────────

export async function getSystemActivityState(): Promise<SystemActivitySnapshot> {
  return invoke<SystemActivitySnapshot>("get_system_activity_state");
}

/**
 * Read the persisted state from disk. Returns `null` when there's no file
 * yet (first run or after a manual reset). Parses with our standard
 * reviver so Sets/Maps round-trip correctly — although the time-tracking
 * shape is currently plain objects, future-proofing costs nothing.
 */
export async function loadTimeTrackingState<T>(): Promise<T | null> {
  const raw = await invoke<string | null>("load_time_tracking_state");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn("[time-tracking] failed to parse persisted state", err);
    return null;
  }
}

/**
 * Debounced write of the entire state blob. We deliberately keep the
 * debounce timer module-scoped (vs. inside the store) so repeated calls
 * across the boundary collapse into a single disk write — matching the
 * behaviour the previous `saveCache` helper provided.
 */
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 800;

export function saveTimeTrackingState(state: unknown): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    let json: string;
    try {
      json = JSON.stringify(state);
    } catch (err) {
      console.warn("[time-tracking] serialise failed", err);
      return;
    }
    invoke("save_time_tracking_state", { json }).catch((err) =>
      console.warn("[time-tracking] save failed", err),
    );
  }, SAVE_DEBOUNCE_MS);
}
