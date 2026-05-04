/**
 * Compact live "today's hours" chip for the app header.
 *
 * Click toggles a popover anchored under the chip with three things the
 * user actually wants without leaving their current screen:
 *   1. Pause / Resume
 *   2. A quick hours+minutes editor that adjusts today's tally — for the
 *      "I forgot to start tracking" case.
 *   3. A way to hide the chip itself when it's distracting.
 *
 * The popover is rendered via `createPortal` to `document.body` because the
 * surrounding header sets `overflow-hidden`, which would otherwise clip the
 * popover. Same pattern as HeaderRecordButton.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, EyeOff, ExternalLink, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTimeTrackingStore } from "@/stores/timeTrackingStore";
import { useOpenTimeTracking } from "@/context/OpenTimeTrackingContext";
import {
  dayKey,
  formatDurationHmCompact,
  totalMsForDayWithAdjustment,
  MS_PER_HOUR,
} from "@/lib/timeTracking";

/** Re-render cadence for the running stopwatch. 30s is the smallest visible
 *  unit on the chip (`HH:MM`), so anything more frequent would be wasted. */
const TICK_MS = 30_000;

export function HeaderTimeTracker({ className }: { className?: string }) {
  const segmentsByDay = useTimeTrackingStore((s) => s.segmentsByDay);
  const adjustmentMsByDay = useTimeTrackingStore((s) => s.adjustmentMsByDay);
  const target = useTimeTrackingStore((s) => s.settings.dailyTargetHours);
  const chipHidden = useTimeTrackingStore((s) => s.settings.chipHiddenInHeader);
  const trackingEnabled = useTimeTrackingStore(
    (s) => s.settings.trackingEnabled,
  );
  const isPaused = useTimeTrackingStore((s) => s.isPaused);
  const pauseReason = useTimeTrackingStore((s) => s.pauseReason);

  // Drive the running stopwatch. We don't need second precision on the
  // chip — `HH:MM` only updates at minute boundaries.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isPaused) return; // no need to tick when nothing's moving
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [isPaused]);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  // Recompute popover anchor on every open + when the viewport changes so
  // the popover stays pinned to the button if the user scrolls or resizes.
  useLayoutEffect(() => {
    if (!popoverOpen) return;
    function reposition() {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      setAnchor({ top: r.bottom + 8, right: window.innerWidth - r.right });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [popoverOpen]);

  // Outside-click + Esc closes. Both refs guarded since the popover is
  // portalled out of the button's DOM subtree.
  useEffect(() => {
    if (!popoverOpen) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setPopoverOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPopoverOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [popoverOpen]);

  if (chipHidden || !trackingEnabled) return null;

  const todayKey = dayKey(new Date(now));
  const todaySegs = segmentsByDay[todayKey] ?? [];
  const adjustment = adjustmentMsByDay[todayKey] ?? 0;
  const todayMs = totalMsForDayWithAdjustment(todaySegs, adjustment, now);
  const targetMs = target * MS_PER_HOUR;
  const percent = Math.min(100, Math.max(0, (todayMs / targetMs) * 100));
  const overtime = todayMs > targetMs;
  const isFirstUse = todayMs === 0 && pauseReason === "boot";

  const tooltip = isPaused
    ? pauseReasonLabel(pauseReason)
    : `Tracking — ${formatDurationHmCompact(todayMs)} of ${target}h`;

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        onClick={() => setPopoverOpen((v) => !v)}
        title={tooltip}
        aria-label={tooltip}
        aria-expanded={popoverOpen}
        // `relative` + an absolutely-positioned fill bar makes the chip
        // double as a progress meter. The fill sits behind the text so the
        // numerals stay readable at every percentage.
        className={cn(
          "relative shrink-0 h-9 px-2.5 gap-1.5 overflow-hidden",
          className,
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0 transition-[width] duration-500",
            overtime ? "bg-emerald-500/15" : "bg-primary/15",
          )}
          style={{ width: `${percent}%` }}
        />
        <span
          className={cn(
            "relative font-mono text-xs tabular-nums transition-colors",
            // Reached the daily target → numerals go emerald to give the
            // user the "you're done" cue without needing the secondary dot.
            // First-use sits in muted-foreground so the chip doesn't shout
            // a 00:00 value before any tracking has started.
            overtime
              ? "text-emerald-500"
              : isFirstUse
                ? "text-muted-foreground"
                : undefined,
          )}
        >
          {formatDurationHmCompact(todayMs)}
          <span className="text-muted-foreground"> / {target}h</span>
        </span>
      </Button>

      {popoverOpen && anchor &&
        createPortal(
          <ChipPopover
            popoverRef={popoverRef}
            anchor={anchor}
            todayMs={todayMs}
            target={target}
            isPaused={isPaused}
            onClose={() => setPopoverOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

// ── Popover ───────────────────────────────────────────────────────────────────

function ChipPopover({
  popoverRef,
  anchor,
  todayMs,
  target,
  isPaused,
  onClose,
}: {
  popoverRef: React.RefObject<HTMLDivElement>;
  anchor: { top: number; right: number };
  todayMs: number;
  target: number;
  isPaused: boolean;
  onClose: () => void;
}) {
  const pauseNow = useTimeTrackingStore((s) => s.pauseNow);
  const resumeNow = useTimeTrackingStore((s) => s.resumeNow);
  const adjustTodayTotal = useTimeTrackingStore((s) => s.adjustTodayTotal);
  const setChipHiddenInHeader = useTimeTrackingStore(
    (s) => s.setChipHiddenInHeader,
  );
  const openTimeTracking = useOpenTimeTracking();

  // Local draft state so the user can type freely. Reset whenever the
  // canonical `todayMs` changes via some other path (e.g. a poll tick
  // landing while the popover is open).
  const initialH = Math.floor(todayMs / MS_PER_HOUR);
  const initialM = Math.floor((todayMs % MS_PER_HOUR) / 60_000);
  const [hours, setHours] = useState(String(initialH));
  const [minutes, setMinutes] = useState(String(initialM));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return; // don't clobber the user's in-flight edit
    setHours(String(initialH));
    setMinutes(String(initialM));
  }, [initialH, initialM, dirty]);

  function commitTime() {
    const h = Number.parseInt(hours, 10);
    const m = Number.parseInt(minutes, 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    const targetMs = Math.max(0, h) * MS_PER_HOUR + Math.max(0, m) * 60_000;
    adjustTodayTotal(targetMs);
    setDirty(false);
  }

  return (
    <div
      ref={popoverRef}
      role="dialog"
      style={{
        position: "fixed",
        top: anchor.top,
        right: anchor.right,
        zIndex: 100,
      }}
      className="w-72 rounded-lg border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="px-3 py-2.5 border-b">
        <p className="text-sm font-medium">Today</p>
        <p className="text-[11px] text-muted-foreground">
          {formatDurationHmCompact(todayMs)} of {target}h ·{" "}
          {isPaused ? "Paused" : "Tracking"}
        </p>
      </div>

      <div className="px-3 py-2.5 border-b space-y-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Set today's total
        </p>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            max={24}
            value={hours}
            onChange={(e) => {
              setHours(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTime();
            }}
            className="h-8 w-14 text-center"
            aria-label="Hours"
          />
          <span className="text-xs text-muted-foreground">h</span>
          <Input
            type="number"
            min={0}
            max={59}
            value={minutes}
            onChange={(e) => {
              setMinutes(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTime();
            }}
            className="h-8 w-14 text-center"
            aria-label="Minutes"
          />
          <span className="text-xs text-muted-foreground">m</span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2"
            onClick={commitTime}
            disabled={!dirty}
            title="Apply"
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground leading-snug">
          Recorded as a manual adjustment. Auto-tracking continues in the
          background — additional minutes worked still extend the total.
        </p>
      </div>

      <div className="px-2 py-2 border-b flex items-center gap-1">
        {isPaused ? (
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 h-8"
            onClick={() => {
              resumeNow();
              onClose();
            }}
          >
            <Play className="h-3.5 w-3.5 mr-1.5" />
            Resume
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 h-8"
            onClick={() => {
              pauseNow();
              onClose();
            }}
          >
            <Pause className="h-3.5 w-3.5 mr-1.5" />
            Pause
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 h-8"
          onClick={() => {
            setChipHiddenInHeader(true);
            onClose();
          }}
          title="Show again from Settings or the Time Tracking workflow"
        >
          <EyeOff className="h-3.5 w-3.5 mr-1.5" />
          Hide chip
        </Button>
      </div>

      <button
        type="button"
        onClick={() => {
          onClose();
          openTimeTracking();
        }}
        className="w-full px-3 py-2 text-xs text-muted-foreground hover:bg-muted/60 flex items-center justify-center gap-1.5 rounded-b-lg"
      >
        <ExternalLink className="h-3 w-3" />
        Open Time Tracking
      </button>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PAUSE_REASON_LABELS: Record<string, string> = {
  "screen-locked": "Paused — screen is locked",
  idle: "Paused — no input detected",
  midnight: "Paused — new day, awaiting activity",
  manual: "Paused manually",
  shutdown: "Paused — system was asleep",
  boot: "Awaiting first activity",
};

function pauseReasonLabel(
  reason: ReturnType<typeof useTimeTrackingStore.getState>["pauseReason"],
): string {
  return (reason ? PAUSE_REASON_LABELS[reason] : undefined) ?? "Paused";
}
