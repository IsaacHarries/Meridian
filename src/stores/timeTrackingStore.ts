/**
 * Zustand store for the auto work-hours tracker.
 *
 * State machine:
 *   running ↔ paused
 *
 * Driven by `time-tracker:state` events emitted by the Rust poller every
 * ~5 seconds, plus a once-per-minute heartbeat in the foreground that
 * checks for midnight rollover even when system state hasn't changed.
 *
 * Pause reasons (priority order — first matching wins):
 *   1. Screen locked (always pauses; user opted in by locking)
 *   2. Idle past threshold (only when `idleFallbackEnabled`)
 *
 * Resume happens automatically on the next poll tick that reports
 * !isLocked AND idleSec < threshold (or idle fallback disabled).
 */

import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  type WorkSegment,
  type WorkSegmentEndReason,
  type SystemActivitySnapshot,
  type TimeTrackingSettings,
  DEFAULT_TIME_TRACKING_SETTINGS,
  MIN_IDLE_THRESHOLD_MIN,
  MAX_IDLE_THRESHOLD_MIN,
  dayKey,
  nextLocalMidnightMs,
  getSystemActivityState,
  loadTimeTrackingState,
  saveTimeTrackingState,
} from "@/lib/timeTracking";

/** If we go this long without a poll tick, we assume the system slept and
 *  retroactively close any open segment at the last-known-good time. */
const STALE_GAP_MS = 30_000;

interface TimeTrackingState {
  // ── Persistent ────────────────────────────────────────────────────────────
  segmentsByDay: Record<string, WorkSegment[]>;
  /**
   * Per-day manual deltas (positive or negative ms) the user has entered via
   * the header chip's quick-edit popover. Kept separate from segments so
   * (a) auto-tracked time is never mutated by manual edits and (b) the
   * timeline can show the adjustment as a single, dismissable entry.
   */
  adjustmentMsByDay: Record<string, number>;
  settings: TimeTrackingSettings;

  // ── Transient (not persisted) ────────────────────────────────────────────
  /** Most recent snapshot from the Rust poller — drives pause/resume. */
  lastSnapshot: SystemActivitySnapshot | null;
  /** Wall-clock time we last received any snapshot. 0 until first tick. */
  lastTickMs: number;
  /** Derived: true while no open segment exists. */
  isPaused: boolean;
  /** Why we're paused right now (for the header tooltip / chip badge). */
  pauseReason: WorkSegmentEndReason | "boot" | null;

  hydrated: boolean;
  listenersInstalled: boolean;

  // ── Actions ───────────────────────────────────────────────────────────────
  installListeners: () => Promise<void>;
  handleSnapshot: (snapshot: SystemActivitySnapshot) => void;
  /** Heartbeat — called once per minute; closes any segment whose calendar
   *  day has flipped, even when the system snapshot hasn't changed. */
  rolloverTick: () => void;
  setIdleFallbackEnabled: (enabled: boolean) => void;
  setIdleThresholdMin: (minutes: number) => void;
  setDailyTargetHours: (hours: number) => void;
  setChipHiddenInHeader: (hidden: boolean) => void;
  /** Master tracking switch. Flipping off closes any open segment;
   *  flipping back on lets the next poll tick re-open one. */
  setTrackingEnabled: (enabled: boolean) => void;
  /** Set today's effective total to `targetMs` by storing the delta as an
   *  adjustment. Future segment growth still extends the total beyond the
   *  number the user typed in. */
  adjustTodayTotal: (targetMs: number) => void;
  /** Drop the manual adjustment for `day` (defaults to today). */
  clearAdjustment: (day?: string) => void;
  /** Edit a single segment (e.g. correct a missed lock event). */
  editSegment: (
    day: string,
    idx: number,
    patch: { startMs?: number; endMs?: number | null },
  ) => void;
  deleteSegment: (day: string, idx: number) => void;
  /** Insert a manual closed segment, sorted by startMs. */
  addManualSegment: (day: string, startMs: number, endMs: number) => void;
  /** One-shot bulk import. Returns counts so the caller can toast a
   *  summary. Days that already have segments are skipped — the importer
   *  is idempotent so re-running it is safe. */
  importHistory: (
    entries: Array<{ dayKey: string; segments: { startMs: number; endMs: number }[] }>,
  ) => { added: number; skipped: number };
  /** Force-pause: close any open segment with reason "manual". */
  pauseNow: () => void;
  /** Force-resume: open a new segment now (used when the user wants to
   *  override the idle fallback). */
  resumeNow: () => void;
}

export const useTimeTrackingStore = create<TimeTrackingState>()((set, get) => ({
  segmentsByDay: {},
  adjustmentMsByDay: {},
  settings: DEFAULT_TIME_TRACKING_SETTINGS,
  lastSnapshot: null,
  lastTickMs: 0,
  isPaused: true,
  pauseReason: "boot",
  hydrated: false,
  listenersInstalled: false,

  installListeners: async () => {
    if (get().listenersInstalled) return;
    set({ listenersInstalled: true });

    let _unlisten: UnlistenFn | null = null;
    try {
      _unlisten = await listen<SystemActivitySnapshot>(
        "time-tracker:state",
        (e) => get().handleSnapshot(e.payload),
      );
    } catch (err) {
      console.warn("[time-tracking] failed to install listener", err);
    }

    // Seed with an immediate state read so the chip isn't blank before the
    // first 5s tick lands.
    try {
      const snapshot = await getSystemActivityState();
      get().handleSnapshot(snapshot);
    } catch (err) {
      console.warn("[time-tracking] initial state read failed", err);
    }

    // Heartbeat for midnight rollover. We don't store the interval handle —
    // the listener lives for the lifetime of the page.
    setInterval(() => get().rolloverTick(), 60_000);

    // Drop the unlisten reference into the global so HMR doesn't double-bind
    // it. (Tauri's listen returns an unlisten fn we'd otherwise leak.)
    if (_unlisten) (window as unknown as { __ttUnlisten?: UnlistenFn }).__ttUnlisten = _unlisten;
  },

  handleSnapshot: (snapshot) => {
    const now = Date.now();
    const state = get();

    // Master switch off — don't open or extend segments. Update only the
    // tick checkpoint so the eventual re-enable doesn't mistake the
    // intervening time for a system-sleep gap.
    if (!state.settings.trackingEnabled) {
      set({ lastSnapshot: snapshot, lastTickMs: now });
      return;
    }

    let nextSegments = state.segmentsByDay;
    let nextPauseReason: WorkSegmentEndReason | "boot" | null = state.pauseReason;
    let mutated = false;

    // 1. Detect a wall-clock gap (system slept, app paused). If the previous
    //    tick was >30s ago, close any open segment at that last-known-good
    //    time — anything beyond that we cannot vouch for as "working".
    if (
      state.lastTickMs > 0 &&
      now - state.lastTickMs > STALE_GAP_MS
    ) {
      const closeAt = state.lastTickMs;
      const closed = closeOpenSegments(nextSegments, closeAt, "shutdown");
      if (closed.changed) {
        nextSegments = closed.segments;
        mutated = true;
      }
    }

    // 2. Roll over any segment whose startMs is on a previous calendar day.
    //    `closeOpenSegments` is fine for this since we want the close at the
    //    boundary; opening on the new day happens implicitly in step 4.
    const rolled = rolloverOpenSegments(nextSegments, now);
    if (rolled.changed) {
      nextSegments = rolled.segments;
      mutated = true;
    }

    // 3. Decide whether we should currently be paused.
    const reason = pauseReasonFor(snapshot, state.settings);
    const shouldPause = reason !== null;

    // 4. Apply pause/resume if state diverges.
    const todayKey = dayKey(new Date(now));
    const todaySegs = nextSegments[todayKey] ?? [];
    const lastSeg = todaySegs[todaySegs.length - 1];
    const hasOpen = lastSeg && lastSeg.endMs === null;

    if (shouldPause && hasOpen) {
      // Close the open segment. Backdate to when input actually stopped
      // when the cause is idle — for the lock case we use `now` since the
      // exact lock instant isn't available to us.
      const closeAt =
        reason === "idle"
          ? Math.max(lastSeg.startMs, now - snapshot.idleSec * 1000)
          : now;
      nextSegments = updateSegment(nextSegments, todayKey, todaySegs.length - 1, {
        endMs: closeAt,
        endReason: reason,
      });
      nextPauseReason = reason;
      mutated = true;
    } else if (!shouldPause && !hasOpen) {
      // Open a fresh segment.
      nextSegments = appendSegment(nextSegments, todayKey, {
        startMs: now,
        endMs: null,
        endReason: null,
      });
      nextPauseReason = null;
      mutated = true;
    } else if (shouldPause && !hasOpen) {
      nextPauseReason = reason;
    } else if (!shouldPause && hasOpen) {
      nextPauseReason = null;
    }

    set({
      segmentsByDay: nextSegments,
      lastSnapshot: snapshot,
      lastTickMs: now,
      isPaused: shouldPause,
      pauseReason: nextPauseReason,
    });

    if (mutated) persist(get());
  },

  rolloverTick: () => {
    const now = Date.now();
    const state = get();
    const rolled = rolloverOpenSegments(state.segmentsByDay, now);
    if (rolled.changed) {
      set({ segmentsByDay: rolled.segments });
      persist(get());
    }
  },

  setIdleFallbackEnabled: (enabled) => {
    set((s) => ({ settings: { ...s.settings, idleFallbackEnabled: enabled } }));
    persist(get());
    // Re-evaluate immediately so a setting toggle takes effect without
    // waiting for the next poll.
    const snap = get().lastSnapshot;
    if (snap) get().handleSnapshot(snap);
  },

  setIdleThresholdMin: (minutes) => {
    const clamped = Math.min(
      MAX_IDLE_THRESHOLD_MIN,
      Math.max(MIN_IDLE_THRESHOLD_MIN, Math.round(minutes)),
    );
    set((s) => ({ settings: { ...s.settings, idleThresholdMin: clamped } }));
    persist(get());
    const snap = get().lastSnapshot;
    if (snap) get().handleSnapshot(snap);
  },

  setDailyTargetHours: (hours) => {
    const clamped = Math.min(24, Math.max(0.5, hours));
    set((s) => ({ settings: { ...s.settings, dailyTargetHours: clamped } }));
    persist(get());
  },

  setChipHiddenInHeader: (hidden) => {
    set((s) => ({ settings: { ...s.settings, chipHiddenInHeader: hidden } }));
    persist(get());
  },

  setTrackingEnabled: (enabled) => {
    const state = get();
    if (state.settings.trackingEnabled === enabled) return;
    if (!enabled) {
      // Close any in-flight segment so the user's "today" total reflects
      // exactly what was tracked up to the moment they flipped off.
      const now = Date.now();
      const closed = closeOpenSegments(state.segmentsByDay, now, "manual");
      set({
        segmentsByDay: closed.segments,
        settings: { ...state.settings, trackingEnabled: false },
        isPaused: true,
        pauseReason: "manual",
      });
    } else {
      // Re-enabling: just clear the pause marker. The next poll tick will
      // open a fresh segment if the user is unlocked + active.
      set({
        settings: { ...state.settings, trackingEnabled: true },
        pauseReason: null,
      });
    }
    persist(get());
    // Re-evaluate so the new state propagates without a 5s wait.
    const snap = get().lastSnapshot;
    if (snap) get().handleSnapshot(snap);
  },

  adjustTodayTotal: (targetMs) => {
    const safeTarget = Math.max(0, targetMs);
    const now = Date.now();
    const today = dayKey(new Date(now));
    const segs = get().segmentsByDay[today] ?? [];
    // Sum auto-tracked segments only — never include the existing
    // adjustment, otherwise repeated edits would compound. The new
    // adjustment is the gap between what the user wants and what the
    // tracker has measured.
    let segMs = 0;
    for (const s of segs) {
      const end = s.endMs ?? now;
      if (end > s.startMs) segMs += end - s.startMs;
    }
    const delta = safeTarget - segMs;
    set((s) => ({
      adjustmentMsByDay: { ...s.adjustmentMsByDay, [today]: delta },
    }));
    persist(get());
  },

  clearAdjustment: (day) => {
    const target = day ?? dayKey(new Date());
    set((s) => {
      if (!(target in s.adjustmentMsByDay)) return s;
      const next = { ...s.adjustmentMsByDay };
      delete next[target];
      return { adjustmentMsByDay: next };
    });
    persist(get());
  },

  editSegment: (day, idx, patch) => {
    set((s) => {
      const segs = s.segmentsByDay[day];
      if (!segs || !segs[idx]) return s;
      const updated: WorkSegment = {
        ...segs[idx],
        ...(patch.startMs !== undefined && { startMs: patch.startMs }),
        ...(patch.endMs !== undefined && { endMs: patch.endMs }),
      };
      // If both endpoints exist, ensure end >= start.
      if (updated.endMs !== null && updated.endMs < updated.startMs) {
        return s;
      }
      const newSegs = [...segs];
      newSegs[idx] = updated;
      return {
        segmentsByDay: { ...s.segmentsByDay, [day]: newSegs },
      };
    });
    persist(get());
  },

  deleteSegment: (day, idx) => {
    set((s) => {
      const segs = s.segmentsByDay[day];
      if (!segs || !segs[idx]) return s;
      const newSegs = segs.filter((_, i) => i !== idx);
      const next = { ...s.segmentsByDay };
      if (newSegs.length === 0) delete next[day];
      else next[day] = newSegs;
      return { segmentsByDay: next };
    });
    persist(get());
  },

  addManualSegment: (day, startMs, endMs) => {
    if (endMs <= startMs) return;
    set((s) => {
      const existing = s.segmentsByDay[day] ?? [];
      const newSegs = [
        ...existing,
        { startMs, endMs, endReason: "manual" as const },
      ].sort((a, b) => a.startMs - b.startMs);
      return {
        segmentsByDay: { ...s.segmentsByDay, [day]: newSegs },
      };
    });
    persist(get());
  },

  importHistory: (entries) => {
    let added = 0;
    let skipped = 0;
    set((s) => {
      const next = { ...s.segmentsByDay };
      for (const entry of entries) {
        const existing = next[entry.dayKey] ?? [];
        if (existing.length > 0) {
          // Don't merge — re-import shouldn't double-count days the user
          // already has data for. They can delete a day's segments first
          // if they really want to overwrite.
          skipped += 1;
          continue;
        }
        const segs: WorkSegment[] = entry.segments.map((seg) => ({
          startMs: seg.startMs,
          endMs: seg.endMs,
          endReason: "manual",
        }));
        next[entry.dayKey] = segs;
        added += 1;
      }
      return { segmentsByDay: next };
    });
    persist(get());
    return { added, skipped };
  },

  pauseNow: () => {
    const now = Date.now();
    const state = get();
    const closed = closeOpenSegments(state.segmentsByDay, now, "manual");
    if (!closed.changed) return;
    set({
      segmentsByDay: closed.segments,
      isPaused: true,
      pauseReason: "manual",
    });
    persist(get());
  },

  resumeNow: () => {
    const state = get();
    if (!state.settings.trackingEnabled) return; // master switch wins
    const now = Date.now();
    const todayKey = dayKey(new Date(now));
    const todaySegs = state.segmentsByDay[todayKey] ?? [];
    const last = todaySegs[todaySegs.length - 1];
    if (last && last.endMs === null) return; // already running
    const next = appendSegment(state.segmentsByDay, todayKey, {
      startMs: now,
      endMs: null,
      endReason: null,
    });
    set({
      segmentsByDay: next,
      isPaused: false,
      pauseReason: null,
    });
    persist(get());
  },
}));

// ── Hydration ────────────────────────────────────────────────────────────────

export async function hydrateTimeTrackingStore(): Promise<void> {
  try {
    // Reads from `<data_dir>/time_tracking.json`, with a one-time
    // migration from the old `store_cache/` location handled in Rust.
    const cached = await loadTimeTrackingState<{
      segmentsByDay: Record<string, WorkSegment[]>;
      adjustmentMsByDay: Record<string, number>;
      settings: TimeTrackingSettings;
    }>();
    if (cached) {
      const settings = {
        ...DEFAULT_TIME_TRACKING_SETTINGS,
        ...(cached.settings ?? {}),
      };
      const segs = cached.segmentsByDay ?? {};
      const adjustments = cached.adjustmentMsByDay ?? {};
      // Clean up any segment that was open at the time of the previous
      // shutdown — we cannot trust the user was at the keyboard for any
      // span beyond the last-tick checkpoint, so close it at startMs (zero
      // duration is the safest default).
      const cleaned: Record<string, WorkSegment[]> = {};
      for (const [day, list] of Object.entries(segs)) {
        cleaned[day] = list.map((seg) =>
          seg.endMs === null
            ? { ...seg, endMs: seg.startMs, endReason: "shutdown" as const }
            : seg,
        );
      }
      useTimeTrackingStore.setState({
        segmentsByDay: cleaned,
        adjustmentMsByDay: adjustments,
        settings,
        hydrated: true,
      });
    } else {
      useTimeTrackingStore.setState({ hydrated: true });
    }
  } catch (err) {
    console.warn("[time-tracking] hydrate failed", err);
    useTimeTrackingStore.setState({ hydrated: true });
  }

  // Fire-and-forget: install the system-state listener. Returns once
  // wired so subsequent UI reads get fresh data.
  void useTimeTrackingStore.getState().installListeners();
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function persist(state: TimeTrackingState): void {
  saveTimeTrackingState({
    segmentsByDay: state.segmentsByDay,
    adjustmentMsByDay: state.adjustmentMsByDay,
    settings: state.settings,
  });
}

function pauseReasonFor(
  snapshot: SystemActivitySnapshot,
  settings: TimeTrackingSettings,
): WorkSegmentEndReason | null {
  if (snapshot.isLocked) return "screen-locked";
  if (settings.idleFallbackEnabled) {
    const thresholdSec = settings.idleThresholdMin * 60;
    if (snapshot.idleSec >= thresholdSec) return "idle";
  }
  return null;
}

interface CloseResult {
  segments: Record<string, WorkSegment[]>;
  changed: boolean;
}

function closeOpenSegments(
  segments: Record<string, WorkSegment[]>,
  closeAt: number,
  reason: WorkSegmentEndReason,
): CloseResult {
  let changed = false;
  const next: Record<string, WorkSegment[]> = {};
  for (const [day, list] of Object.entries(segments)) {
    let dayChanged = false;
    const updated = list.map((seg) => {
      if (seg.endMs !== null) return seg;
      dayChanged = true;
      const safeEnd = Math.max(seg.startMs, closeAt);
      return { ...seg, endMs: safeEnd, endReason: reason };
    });
    next[day] = dayChanged ? updated : list;
    if (dayChanged) changed = true;
  }
  return { segments: changed ? next : segments, changed };
}

function rolloverOpenSegments(
  segments: Record<string, WorkSegment[]>,
  nowMs: number,
): CloseResult {
  let changed = false;
  let working = segments;
  const todayKey = dayKey(new Date(nowMs));

  for (const [day, list] of Object.entries(segments)) {
    if (day === todayKey) continue;
    const lastIdx = list.findIndex((s) => s.endMs === null);
    if (lastIdx === -1) continue;
    const open = list[lastIdx];
    // Close at the boundary that follows the segment's start day.
    const midnight = nextLocalMidnightMs(new Date(open.startMs));
    working = updateSegment(working, day, lastIdx, {
      endMs: midnight,
      endReason: "midnight",
    });
    changed = true;
    // Note: we deliberately do NOT auto-open a new segment on the new
    // calendar day. The next poll will do that if the system reports the
    // user is still active. This avoids inflating the new day's tally
    // when the user actually walked away overnight.
  }

  return { segments: working, changed };
}

function appendSegment(
  segments: Record<string, WorkSegment[]>,
  day: string,
  seg: WorkSegment,
): Record<string, WorkSegment[]> {
  const existing = segments[day] ?? [];
  return { ...segments, [day]: [...existing, seg] };
}

function updateSegment(
  segments: Record<string, WorkSegment[]>,
  day: string,
  idx: number,
  patch: Partial<WorkSegment>,
): Record<string, WorkSegment[]> {
  const existing = segments[day];
  if (!existing) return segments;
  const newList = [...existing];
  newList[idx] = { ...newList[idx], ...patch };
  return { ...segments, [day]: newList };
}
