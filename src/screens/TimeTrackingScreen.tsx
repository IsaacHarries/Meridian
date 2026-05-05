/**
 * Time Tracking workflow screen.
 *
 * Two stacked panels:
 *   1. Today — live progress toward the daily target, the segment timeline,
 *      and manual pause / resume / add controls.
 *   2. This week — daily totals and the running overtime balance.
 *
 * The store does the heavy lifting; this screen is mostly a renderer with
 * an edit-segment dialog and a manual-entry form. Re-renders driven off a
 * 1s interval so the running stopwatch stays current — kept local to this
 * screen rather than in the store, since the store would otherwise notify
 * every other subscriber every second too.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Pause,
  Play,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import { useTimeTrackingStore } from "@/stores/timeTrackingStore";
import {
  dayKey,
  formatDurationHm,
  formatWeekRange,
  hoursWorkedToday,
  totalMsForDayWithAdjustment,
  weekDayKeys,
  weekOffsetFromReference,
  overtimeBalanceMs,
  MS_PER_HOUR,
} from "@/lib/timeTracking";
import { AdjustmentRow, BalancePill, PauseReasonBadge } from "./time-tracking/_shared";
import { SegmentRow } from "./time-tracking/segment-row";
import { WeekPickerCalendar } from "./time-tracking/week-picker-calendar";
import { HistoryPanel } from "./time-tracking/history-panel";
import { ManualEntryForm } from "./time-tracking/manual-entry-form";

/**
 * Sub-second segments don't represent meaningful work — they tend to come
 * from rapid lock/unlock toggles or from the open-segment-on-shutdown
 * cleanup that closes a segment at its own start time. Filtering them out
 * here keeps the timeline readable without throwing the data away from
 * the underlying store.
 */
const MIN_VISIBLE_SEGMENT_MS = 1000;

export function TimeTrackingScreen({ onBack }: { onBack: () => void }) {
  const segmentsByDay = useTimeTrackingStore((s) => s.segmentsByDay);
  const adjustmentMsByDay = useTimeTrackingStore((s) => s.adjustmentMsByDay);
  const settings = useTimeTrackingStore((s) => s.settings);
  const isPaused = useTimeTrackingStore((s) => s.isPaused);
  const pauseReason = useTimeTrackingStore((s) => s.pauseReason);
  const pauseNow = useTimeTrackingStore((s) => s.pauseNow);
  const resumeNow = useTimeTrackingStore((s) => s.resumeNow);
  const editSegment = useTimeTrackingStore((s) => s.editSegment);
  const deleteSegment = useTimeTrackingStore((s) => s.deleteSegment);
  const addManualSegment = useTimeTrackingStore((s) => s.addManualSegment);
  const clearAdjustment = useTimeTrackingStore((s) => s.clearAdjustment);
  const setTrackingEnabled = useTimeTrackingStore((s) => s.setTrackingEnabled);

  // Local 1s tick so the running segment's display advances. Keeping this
  // local (vs. in the store) means we don't notify every store consumer
  // every second; only this screen re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Which calendar week the grid is showing. 0 = this week, -1 = last week.
  // Future offsets are blocked at the navigator level so the grid never
  // displays days that haven't happened yet.
  const [viewedWeekOffset, setViewedWeekOffset] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const weekGridRef = useRef<HTMLDivElement>(null);
  function jumpToWeekOffset(offset: number) {
    setViewedWeekOffset(offset);
    // Wait a frame so the grid has updated to the new week before we
    // scroll it into view.
    requestAnimationFrame(() => {
      weekGridRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  const todayKey = dayKey(new Date(now));
  const todaySegs = segmentsByDay[todayKey] ?? [];
  const todayAdjustment = adjustmentMsByDay[todayKey] ?? 0;
  // Segments shown in the timeline — drop sub-second slivers (lock/unlock
  // bounces and open-on-shutdown clean-ups). Totals stay derived from the
  // unfiltered list so we don't lie about the running clock.
  const visibleTodaySegs = useMemo(
    () =>
      todaySegs.filter((seg) => {
        const end = seg.endMs ?? now;
        return end - seg.startMs >= MIN_VISIBLE_SEGMENT_MS;
      }),
    [todaySegs, now],
  );
  const todayMs = totalMsForDayWithAdjustment(todaySegs, todayAdjustment, now);
  const targetMs = settings.dailyTargetHours * MS_PER_HOUR;
  const remainingMs = Math.max(0, targetMs - todayMs);
  const progressPct = Math.min(100, (todayMs / targetMs) * 100);
  const reachedTarget = todayMs >= targetMs;
  const overshootMs = Math.max(0, todayMs - targetMs);

  const todayHours = hoursWorkedToday(todaySegs, now);

  // The week we're displaying may be in the past. Compute its anchor date
  // by shifting `now` by the offset, then derive the seven keys from it.
  const viewedWeekDate = useMemo(() => {
    const d = new Date(now);
    d.setDate(d.getDate() + viewedWeekOffset * 7);
    return d;
  }, [now, viewedWeekOffset]);
  const weekKeys = useMemo(() => weekDayKeys(viewedWeekDate), [viewedWeekDate]);
  const weekTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const key of weekKeys) {
      const segs = segmentsByDay[key] ?? [];
      const adj = adjustmentMsByDay[key] ?? 0;
      out[key] = totalMsForDayWithAdjustment(segs, adj, now);
    }
    return out;
  }, [weekKeys, segmentsByDay, adjustmentMsByDay, now]);

  // Overtime balance scoped to the displayed week. When the user navigates
  // to a previous week, the pill reflects that week's surplus / deficit
  // rather than a running all-time total — which made it impossible to read
  // "how was last week" from a glance. `overtimeBalanceMs` already skips
  // future-dated days within the week (e.g. Wed when today is Mon) and
  // refuses to debit today's incomplete day.
  const weekBalanceMs = useMemo(() => {
    return overtimeBalanceMs(weekTotals, todayKey, settings.dailyTargetHours);
  }, [weekTotals, todayKey, settings.dailyTargetHours]);

  return (
    <div className="min-h-screen">
      <WorkflowPanelHeader
        leading={
          <>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className={APP_HEADER_TITLE}>Time Tracking</h1>
          </>
        }
      />

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Master-switch banner — only renders when tracking is off so the
            user can re-enable from anywhere in the workflow without going
            to Settings. Existing history stays visible below. */}
        {!settings.trackingEnabled && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span className="flex-1">
              Time tracking is turned off. New work isn't being recorded.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTrackingEnabled(true)}
              className="border-amber-500/40 text-amber-700 hover:bg-amber-500/10"
            >
              Resume tracking
            </Button>
          </div>
        )}

        {/* ── Today panel ──────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">Today</CardTitle>
              <div className="flex items-center gap-2">
                {isPaused ? (
                  <Button size="sm" variant="outline" onClick={resumeNow}>
                    <Play className="h-3.5 w-3.5 mr-1.5" />
                    Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={pauseNow}>
                    <Pause className="h-3.5 w-3.5 mr-1.5" />
                    Pause
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Big-number summary + progress meter */}
            <div className="space-y-2">
              <div className="flex items-baseline gap-3">
                <span className="text-4xl font-bold tabular-nums">
                  {formatDurationHm(todayMs)}
                </span>
                <span className="text-sm text-muted-foreground">
                  of {settings.dailyTargetHours}h
                </span>
                {reachedTarget && (
                  <Badge variant="default" className="ml-auto">
                    Done — banking {formatDurationHm(overshootMs)} of overtime
                  </Badge>
                )}
              </div>
              <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full transition-[width] duration-500 ${
                    reachedTarget ? "bg-emerald-500" : "bg-primary"
                  }`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {reachedTarget
                  ? "You've hit your target — every additional minute banks toward the week's balance."
                  : `${formatDurationHm(remainingMs)} to go.`}
                {isPaused && pauseReason && (
                  <span className="ml-2">
                    · <PauseReasonBadge reason={pauseReason} />
                  </span>
                )}
                {!isPaused && <span className="ml-2 text-emerald-600">· Tracking</span>}
              </p>
            </div>

            {/* Segment timeline */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Segments</h3>
                <span className="text-xs text-muted-foreground">
                  {visibleTodaySegs.length}{" "}
                  {visibleTodaySegs.length === 1 ? "session" : "sessions"} ·{" "}
                  {todayHours.toFixed(1)}h
                </span>
              </div>
              {visibleTodaySegs.length === 0 && todayAdjustment === 0 ? (
                <p className="text-sm text-muted-foreground italic">
                  No tracked time yet today. Move your mouse or press a key — tracking
                  starts automatically.
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {visibleTodaySegs.map((seg) => {
                    // Re-derive the original index so edit/delete still
                    // target the right entry in the underlying array.
                    const originalIdx = todaySegs.indexOf(seg);
                    return (
                      <SegmentRow
                        key={`${seg.startMs}-${originalIdx}`}
                        day={todayKey}
                        idx={originalIdx}
                        seg={seg}
                        now={now}
                        onEdit={editSegment}
                        onDelete={deleteSegment}
                      />
                    );
                  })}
                  {todayAdjustment !== 0 && (
                    <AdjustmentRow
                      adjustmentMs={todayAdjustment}
                      onClear={() => clearAdjustment(todayKey)}
                    />
                  )}
                </ul>
              )}
              <ManualEntryForm
                day={todayKey}
                onAdd={(start, end) => addManualSegment(todayKey, start, end)}
              />
            </div>
          </CardContent>
        </Card>

        {/* ── Week grid (navigable) ────────────────────────────────────── */}
        <Card ref={weekGridRef}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => setViewedWeekOffset((o) => o - 1)}
                  aria-label="Previous week"
                  title="Previous week"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {/* Title doubles as the trigger for the month-view picker.
                    Wrapped in a `relative` div so the picker can position
                    itself underneath the trigger via absolute positioning. */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setPickerOpen((o) => !o)}
                    aria-haspopup="dialog"
                    aria-expanded={pickerOpen}
                    className="inline-flex items-center gap-1 px-1 mx-0.5 rounded hover:bg-muted transition-colors"
                    title="Pick a week"
                  >
                    <CardTitle className="text-base">
                      {viewedWeekOffset === 0
                        ? "This week"
                        : viewedWeekOffset === -1
                          ? "Last week"
                          : formatWeekRange(viewedWeekDate)}
                    </CardTitle>
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                        pickerOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {pickerOpen && (
                    <WeekPickerCalendar
                      anchorDate={viewedWeekDate}
                      now={now}
                      segmentsByDay={segmentsByDay}
                      adjustmentMsByDay={adjustmentMsByDay}
                      selectedWeekKeys={new Set(weekKeys)}
                      onPickDay={(date) => {
                        const offset = weekOffsetFromReference(
                          date,
                          new Date(now),
                        );
                        setViewedWeekOffset(offset);
                        setPickerOpen(false);
                      }}
                      onClose={() => setPickerOpen(false)}
                    />
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => setViewedWeekOffset((o) => o + 1)}
                  disabled={viewedWeekOffset >= 0}
                  aria-label="Next week"
                  title="Next week"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                {viewedWeekOffset !== 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 ml-1"
                    onClick={() => setViewedWeekOffset(0)}
                  >
                    Jump to current
                  </Button>
                )}
              </div>
              <BalancePill ms={weekBalanceMs} />
            </div>
            {viewedWeekOffset !== 0 && (
              <p className="text-xs text-muted-foreground">
                {formatWeekRange(viewedWeekDate)}
              </p>
            )}
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-7 gap-2">
              {weekKeys.map((key) => {
                const ms = weekTotals[key] ?? 0;
                const hours = ms / MS_PER_HOUR;
                const pct = Math.min(100, (ms / targetMs) * 100);
                const over = ms > targetMs;
                const isToday = key === todayKey;
                const isFuture = key > todayKey;
                const day = new Date(`${key}T12:00:00`);
                return (
                  <div
                    key={key}
                    className={`rounded-md border p-2 ${
                      isToday ? "border-primary/60 bg-primary/5" : ""
                    } ${isFuture ? "opacity-50" : ""}`}
                  >
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {day.toLocaleDateString(undefined, { weekday: "short" })}{" "}
                      <span className="text-muted-foreground/70">
                        {day.getDate()}
                      </span>
                    </p>
                    <p className="text-sm font-semibold tabular-nums">
                      {hours > 0 ? `${hours.toFixed(1)}h` : "—"}
                    </p>
                    <div className="h-1 w-full bg-muted rounded-full overflow-hidden mt-1">
                      <div
                        className={`h-full ${over ? "bg-emerald-500" : "bg-primary"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Balance is the sum of overtime credits and shortfalls across every day
              you've worked. Days you didn't work (no segments) don't count toward the
              target — only days where you logged something do.
            </p>
          </CardContent>
        </Card>

        {/* ── History (all tracked weeks) ──────────────────────────────── */}
        <HistoryPanel
          segmentsByDay={segmentsByDay}
          adjustmentMsByDay={adjustmentMsByDay}
          now={now}
          dailyTargetHours={settings.dailyTargetHours}
          onJumpToWeek={(date) =>
            jumpToWeekOffset(weekOffsetFromReference(date, new Date(now)))
          }
        />

      </main>
    </div>
  );
}
