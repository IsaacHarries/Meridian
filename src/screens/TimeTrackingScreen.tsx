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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Pause,
  Play,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Lock,
  MoonStar,
  Sun,
  Hand,
  Sunrise,
  AlertTriangle,
  Sliders,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CalendarDays,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import { useTimeTrackingStore } from "@/stores/timeTrackingStore";
import {
  type WorkSegment,
  type WorkSegmentEndReason,
  dayKey,
  formatDurationHm,
  formatTimeOfDay,
  formatWeekRange,
  hoursWorkedToday,
  startOfWeek,
  totalMsForDayWithAdjustment,
  weekDayKeys,
  weekOffsetFromReference,
  overtimeBalanceMs,
  MS_PER_HOUR,
} from "@/lib/timeTracking";

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
            <Button variant="ghost" size="icon" onClick={onBack}>
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

// ── Segment row ──────────────────────────────────────────────────────────────

function SegmentRow({
  day,
  idx,
  seg,
  now,
  onEdit,
  onDelete,
}: {
  day: string;
  idx: number;
  seg: WorkSegment;
  now: number;
  onEdit: (
    day: string,
    idx: number,
    patch: { startMs?: number; endMs?: number | null },
  ) => void;
  onDelete: (day: string, idx: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const open = seg.endMs === null;
  const endValue = seg.endMs ?? now;
  const durationMs = Math.max(0, endValue - seg.startMs);

  if (editing) {
    return (
      <li className="px-3 py-2">
        <SegmentEditor
          start={seg.startMs}
          end={seg.endMs}
          onCancel={() => setEditing(false)}
          onSave={(nextStart, nextEnd) => {
            onEdit(day, idx, { startMs: nextStart, endMs: nextEnd });
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="px-3 py-2 flex items-center gap-3 text-sm">
      <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0 w-32">
        {formatTimeOfDay(seg.startMs)} →{" "}
        {open ? "now" : formatTimeOfDay(seg.endMs!)}
      </span>
      <span className="font-medium tabular-nums shrink-0 w-16">
        {formatDurationHm(durationMs)}
      </span>
      {open ? (
        <Badge variant="default" className="text-[10px]">
          Live
        </Badge>
      ) : (
        seg.endReason && <EndReasonBadge reason={seg.endReason} />
      )}
      <span className="flex-1" />
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => setEditing(true)}
        aria-label="Edit segment"
        title="Edit"
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => onDelete(day, idx)}
        aria-label="Delete segment"
        title="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

// ── Week picker calendar ─────────────────────────────────────────────────────

/**
 * Month-view calendar that drops out of the week-grid title. Each cell shows
 * the day number plus the tracked hours (when > 0) for a quick-glance
 * heatmap of how the month went. Clicking any day jumps the parent grid to
 * the week containing that day. Future days are disabled — selecting a
 * week that hasn't started yet is meaningless.
 */
function WeekPickerCalendar({
  anchorDate,
  now,
  segmentsByDay,
  adjustmentMsByDay,
  selectedWeekKeys,
  onPickDay,
  onClose,
}: {
  /** A date inside the currently-displayed week. Drives initial month. */
  anchorDate: Date;
  now: number;
  segmentsByDay: Record<string, WorkSegment[]>;
  adjustmentMsByDay: Record<string, number>;
  selectedWeekKeys: Set<string>;
  onPickDay: (date: Date) => void;
  onClose: () => void;
}) {
  const [monthCursor, setMonthCursor] = useState(
    () => new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1),
  );

  const containerRef = useRef<HTMLDivElement>(null);

  // Click-outside / Esc closes. Container ref scopes the outside-click test;
  // the parent wraps both the trigger and the picker in a `relative` div
  // but the trigger lives outside this ref — so a click on the trigger
  // will close the picker, and the parent's onClick will reopen it. Net
  // effect: the trigger toggles, which is what we want.
  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target as Node)) return;
      // Allow the trigger button (immediate previous sibling in the DOM)
      // to handle its own click — without this guard the outside-click
      // would close the picker before the trigger's onClick reopens it,
      // resulting in a no-op flicker.
      const trigger = containerRef.current.previousElementSibling;
      if (trigger?.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const todayStr = dayKey(new Date(now));

  // Build a fixed 6-row grid (42 cells) that always starts on the Monday
  // on/before the first of the month. Days outside the current month are
  // shown muted so the user has continuous context across boundaries.
  const cells = useMemo(() => {
    const monthStart = new Date(
      monthCursor.getFullYear(),
      monthCursor.getMonth(),
      1,
    );
    const gridStart = startOfWeek(monthStart);
    const out: Array<{
      date: Date;
      key: string;
      inMonth: boolean;
      ms: number;
      isToday: boolean;
      isFuture: boolean;
      isSelected: boolean;
    }> = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + i,
      );
      const k = dayKey(d);
      const segs = segmentsByDay[k] ?? [];
      const adj = adjustmentMsByDay[k] ?? 0;
      const ms = totalMsForDayWithAdjustment(segs, adj, now);
      out.push({
        date: d,
        key: k,
        inMonth: d.getMonth() === monthCursor.getMonth(),
        ms,
        isToday: k === todayStr,
        isFuture: k > todayStr,
        isSelected: selectedWeekKeys.has(k),
      });
    }
    return out;
  }, [
    monthCursor,
    segmentsByDay,
    adjustmentMsByDay,
    now,
    todayStr,
    selectedWeekKeys,
  ]);

  // Disable forward month nav once we'd be paging past the present month.
  const isAtCurrentMonth =
    monthCursor.getFullYear() === new Date(now).getFullYear() &&
    monthCursor.getMonth() === new Date(now).getMonth();

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Pick a week"
      // `top-full mt-2 left-0` parks it directly under the trigger; w-72
      // is enough room for 7 squares + nav. z-50 keeps it above the
      // weekly grid below.
      className="absolute top-full left-0 mt-2 z-50 w-72 rounded-lg border bg-popover text-popover-foreground shadow-lg p-3"
    >
      <div className="flex items-center justify-between mb-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() =>
            setMonthCursor(
              (d) => new Date(d.getFullYear(), d.getMonth() - 1, 1),
            )
          }
          aria-label="Previous month"
          title="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <p className="text-sm font-medium inline-flex items-center gap-1.5">
          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
          {monthCursor.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        </p>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() =>
            setMonthCursor(
              (d) => new Date(d.getFullYear(), d.getMonth() + 1, 1),
            )
          }
          disabled={isAtCurrentMonth}
          aria-label="Next month"
          title="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-[10px] text-muted-foreground mb-1 text-center">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((cell) => {
          const hours = cell.ms / MS_PER_HOUR;
          // Hours label rounding: under 10h show one decimal so 5.3h
          // doesn't get hidden as "5h"; 10+ shows whole hours so the
          // square doesn't overflow.
          const hoursLabel =
            hours <= 0
              ? null
              : hours < 10
                ? `${hours.toFixed(1)}h`
                : `${Math.round(hours)}h`;
          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => onPickDay(cell.date)}
              disabled={cell.isFuture}
              className={`
                aspect-square rounded flex flex-col items-center justify-center text-[11px]
                transition-colors
                ${cell.inMonth ? "" : "opacity-40"}
                ${cell.isSelected ? "bg-primary/15 ring-1 ring-primary/50" : ""}
                ${cell.isToday && !cell.isSelected ? "ring-1 ring-primary/70" : ""}
                ${cell.isFuture
                  ? "cursor-not-allowed text-muted-foreground/40"
                  : "hover:bg-muted"}
              `}
              aria-label={`Jump to week containing ${cell.date.toLocaleDateString()}`}
              title={
                cell.isFuture
                  ? "Future day"
                  : hoursLabel
                    ? `${cell.date.toLocaleDateString()} — ${formatDurationHm(cell.ms)}`
                    : `${cell.date.toLocaleDateString()} — no tracked time`
              }
            >
              <span className="font-medium leading-tight">
                {cell.date.getDate()}
              </span>
              {hoursLabel && (
                <span
                  className={`text-[9px] tabular-nums leading-tight ${
                    hours >= 7 ? "text-emerald-500" : "text-muted-foreground"
                  }`}
                >
                  {hoursLabel}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground leading-snug">
        Click any day to jump the grid to the week containing it.
      </p>
    </div>
  );
}

// ── History panel ────────────────────────────────────────────────────────────

/** One row in the history list — aggregates everything for a single week. */
interface WeekSummary {
  startMs: number;
  startKey: string;
  totalMs: number;
  daysWorked: number;
  /** Net overtime / shortfall this week alone (not cumulative). */
  netBalanceMs: number;
}

function HistoryPanel({
  segmentsByDay,
  adjustmentMsByDay,
  now,
  dailyTargetHours,
  onJumpToWeek,
}: {
  segmentsByDay: Record<string, WorkSegment[]>;
  adjustmentMsByDay: Record<string, number>;
  now: number;
  dailyTargetHours: number;
  onJumpToWeek: (date: Date) => void;
}) {
  const summaries = useMemo<WeekSummary[]>(() => {
    const targetMs = dailyTargetHours * MS_PER_HOUR;
    // Group every day-key (from segments OR adjustments) by its week's
    // Monday key, accumulating totals as we go.
    const byWeek = new Map<string, WeekSummary>();
    const allKeys = new Set([
      ...Object.keys(segmentsByDay),
      ...Object.keys(adjustmentMsByDay),
    ]);
    for (const dKey of allKeys) {
      const dayDate = new Date(`${dKey}T12:00:00`);
      const weekStart = startOfWeek(dayDate);
      const weekKey = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;
      const segs = segmentsByDay[dKey] ?? [];
      const adj = adjustmentMsByDay[dKey] ?? 0;
      const dayMs = totalMsForDayWithAdjustment(segs, adj, now);
      if (dayMs <= 0) continue;
      let bucket = byWeek.get(weekKey);
      if (!bucket) {
        bucket = {
          startMs: weekStart.getTime(),
          startKey: weekKey,
          totalMs: 0,
          daysWorked: 0,
          netBalanceMs: 0,
        };
        byWeek.set(weekKey, bucket);
      }
      bucket.totalMs += dayMs;
      bucket.daysWorked += 1;
      bucket.netBalanceMs += dayMs - targetMs;
    }
    // Newest week first.
    return [...byWeek.values()].sort((a, b) => b.startMs - a.startMs);
  }, [segmentsByDay, adjustmentMsByDay, now, dailyTargetHours]);

  const currentWeekKey = useMemo(() => {
    const start = startOfWeek(new Date(now));
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  }, [now]);

  // Cap the History card so the page exactly fills the viewport — History
  // scrolls internally, and the window scrollbar only appears once the
  // viewport is shorter than the absolute floor we set below. We compute the
  // available height by subtracting:
  //   • the card's viewport-top (everything above it in `<main>`)
  //   • the height of anything that renders AFTER the card inside `<main>`
  //     (main's bottom-padding)
  //   • a small padding for sub-pixel rounding so the window scrollbar
  //     doesn't flicker on certain zoom levels.
  // ResizeObserver on `<main>` re-runs on layout shifts above OR below the
  // card; the setState bail-out (prev === next) breaks the recompute loop
  // that capping the card itself would otherwise trigger.
  const cardRef = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    function recompute() {
      const node = cardRef.current;
      if (!node) return;
      const cardRect = node.getBoundingClientRect();
      const main = node.closest("main") ?? document.body;
      const mainRect = main.getBoundingClientRect();
      const afterCard = Math.max(0, mainRect.bottom - cardRect.bottom);
      const BOTTOM_PADDING = 8;
      const next = Math.max(
        200,
        window.innerHeight - cardRect.top - afterCard - BOTTOM_PADDING,
      );
      setMaxHeight((prev) => (prev === next ? prev : next));
    }
    recompute();
    window.addEventListener("resize", recompute);
    const ro = new ResizeObserver(recompute);
    const main = cardRef.current?.closest("main") ?? document.body;
    ro.observe(main);
    return () => {
      window.removeEventListener("resize", recompute);
      ro.disconnect();
    };
  }, []);

  // Cumulative net balance across every recorded day. Mirrors the rules of
  // the per-week pill (today only credits overtime, never debits) but
  // aggregated all-time, so the user can see how much overtime is "banked"
  // overall while still reading the visible week's surplus from the Week
  // panel pill.
  const totalBalanceMs = useMemo(() => {
    const today = dayKey(new Date(now));
    const totals: Record<string, number> = {};
    for (const [key, segs] of Object.entries(segmentsByDay)) {
      const adj = adjustmentMsByDay[key] ?? 0;
      totals[key] = totalMsForDayWithAdjustment(segs, adj, now);
    }
    for (const [key, adj] of Object.entries(adjustmentMsByDay)) {
      if (!(key in totals)) totals[key] = Math.max(0, adj);
    }
    return overtimeBalanceMs(totals, today, dailyTargetHours);
  }, [segmentsByDay, adjustmentMsByDay, dailyTargetHours, now]);

  return (
    <Card
      ref={cardRef}
      className="flex flex-col"
      style={maxHeight !== null ? { maxHeight: `${maxHeight}px` } : undefined}
    >
      <CardHeader className="pb-3 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">History</CardTitle>
          {summaries.length > 0 && <BalancePill ms={totalBalanceMs} />}
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-y-auto">
        {summaries.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No tracked weeks yet — your first week will show up here once you've
            logged some time.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {summaries.map((w) => {
              const isCurrent = w.startKey === currentWeekKey;
              const balancePositive = w.netBalanceMs >= 0;
              return (
                <li key={w.startKey}>
                  <button
                    type="button"
                    onClick={() => onJumpToWeek(new Date(w.startMs))}
                    className="w-full px-3 py-2 flex items-center gap-3 text-sm text-left hover:bg-muted/40 transition-colors"
                    title="Jump to this week"
                  >
                    <span className="font-medium shrink-0 w-44">
                      {formatWeekRange(new Date(w.startMs))}
                      {isCurrent && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-primary">
                          current
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground tabular-nums shrink-0 w-24">
                      {formatDurationHm(w.totalMs)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 w-28">
                      {w.daysWorked} {w.daysWorked === 1 ? "day" : "days"} worked
                    </span>
                    <span className="flex-1" />
                    <span
                      className={`text-xs tabular-nums shrink-0 ${
                        balancePositive ? "text-emerald-600" : "text-amber-600"
                      }`}
                    >
                      {balancePositive ? "+" : "−"}
                      {formatDurationHm(Math.abs(w.netBalanceMs))}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {summaries.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Per-week balance is the net of that week alone. The pill at the top
            of the grid is the cumulative balance across every tracked week.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AdjustmentRow({
  adjustmentMs,
  onClear,
}: {
  adjustmentMs: number;
  onClear: () => void;
}) {
  const positive = adjustmentMs >= 0;
  return (
    <li className="px-3 py-2 flex items-center gap-3 text-sm bg-muted/30">
      <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0 w-32 inline-flex items-center gap-1">
        <Sliders className="h-3 w-3" />
        Manual
      </span>
      <span className="font-medium tabular-nums shrink-0 w-16">
        {positive ? "+" : "−"}
        {formatDurationHm(Math.abs(adjustmentMs))}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Adjustment
      </span>
      <span className="flex-1" />
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={onClear}
        aria-label="Remove manual adjustment"
        title="Clear adjustment"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

function SegmentEditor({
  start,
  end,
  onSave,
  onCancel,
}: {
  start: number;
  end: number | null;
  onSave: (start: number, end: number | null) => void;
  onCancel: () => void;
}) {
  const [startStr, setStartStr] = useState(() => toTimeInput(start));
  const [endStr, setEndStr] = useState(() => (end == null ? "" : toTimeInput(end)));
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const startMs = fromTimeInput(start, startStr);
    if (startMs == null) {
      setError("Invalid start time");
      return;
    }
    let endMs: number | null;
    if (endStr.trim() === "") {
      endMs = end;
    } else {
      const parsed = fromTimeInput(end ?? start, endStr);
      if (parsed == null) {
        setError("Invalid end time");
        return;
      }
      if (parsed < startMs) {
        setError("End must be after start");
        return;
      }
      endMs = parsed;
    }
    onSave(startMs, endMs);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="time"
        value={startStr}
        onChange={(e) => setStartStr(e.target.value)}
        className="w-28 h-8"
      />
      <span className="text-muted-foreground text-xs">→</span>
      <Input
        type="time"
        value={endStr}
        onChange={(e) => setEndStr(e.target.value)}
        placeholder="end"
        className="w-28 h-8"
      />
      {error && (
        <span className="text-xs text-destructive flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {error}
        </span>
      )}
      <span className="flex-1" />
      <Button size="sm" variant="ghost" className="h-8" onClick={commit}>
        <Check className="h-3.5 w-3.5 mr-1" />
        Save
      </Button>
      <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
        <X className="h-3.5 w-3.5 mr-1" />
        Cancel
      </Button>
    </div>
  );
}

// ── Manual entry ─────────────────────────────────────────────────────────────

function ManualEntryForm({
  day,
  onAdd,
}: {
  day: string;
  onAdd: (start: number, end: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [startStr, setStartStr] = useState("09:00");
  const [endStr, setEndStr] = useState("10:00");
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const baseDate = new Date(`${day}T12:00:00`);
    const startMs = fromTimeInput(baseDate.getTime(), startStr);
    const endMs = fromTimeInput(baseDate.getTime(), endStr);
    if (startMs == null || endMs == null) {
      setError("Enter both start and end times");
      return;
    }
    if (endMs <= startMs) {
      setError("End must be after start");
      return;
    }
    onAdd(startMs, endMs);
    setOpen(false);
    setError(null);
  }

  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        className="h-8 text-muted-foreground"
      >
        <Plus className="h-3.5 w-3.5 mr-1.5" />
        Add a segment
      </Button>
    );
  }

  return (
    <div className="rounded-md border px-3 py-2 flex flex-wrap items-center gap-2">
      <Input
        type="time"
        value={startStr}
        onChange={(e) => setStartStr(e.target.value)}
        className="w-28 h-8"
      />
      <span className="text-muted-foreground text-xs">→</span>
      <Input
        type="time"
        value={endStr}
        onChange={(e) => setEndStr(e.target.value)}
        className="w-28 h-8"
      />
      {error && (
        <span className="text-xs text-destructive flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {error}
        </span>
      )}
      <span className="flex-1" />
      <Button size="sm" variant="ghost" className="h-8" onClick={commit}>
        <Check className="h-3.5 w-3.5 mr-1" />
        Add
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
      >
        <X className="h-3.5 w-3.5 mr-1" />
        Cancel
      </Button>
    </div>
  );
}

// ── Reason / balance presentation ────────────────────────────────────────────

function EndReasonBadge({ reason }: { reason: WorkSegmentEndReason }) {
  const meta = endReasonMeta(reason);
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

function PauseReasonBadge({
  reason,
}: {
  reason: WorkSegmentEndReason | "boot";
}) {
  if (reason === "boot") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-600">
        <Sunrise className="h-3 w-3" />
        Awaiting first activity
      </span>
    );
  }
  const meta = endReasonMeta(reason);
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-600">
      <Icon className="h-3 w-3" />
      {meta.pausedLabel ?? meta.label}
    </span>
  );
}

function endReasonMeta(reason: WorkSegmentEndReason): {
  label: string;
  pausedLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
} {
  switch (reason) {
    case "screen-locked":
      return { label: "Locked", pausedLabel: "Screen locked", icon: Lock };
    case "idle":
      return { label: "Idle", pausedLabel: "No input detected", icon: MoonStar };
    case "midnight":
      return { label: "Midnight", pausedLabel: "New day", icon: Sun };
    case "manual":
      return { label: "Manual", pausedLabel: "Paused manually", icon: Hand };
    case "shutdown":
      return { label: "Slept", pausedLabel: "System slept", icon: MoonStar };
  }
}

function BalancePill({ ms }: { ms: number }) {
  const positive = ms >= 0;
  const formatted = formatDurationHm(Math.abs(ms));
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs ${
        positive
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
          : "border-amber-500/40 bg-amber-500/10 text-amber-600"
      }`}
      title={
        positive
          ? "Banked overtime — you can cash this in by working less on a future day"
          : "Shortfall — you owe this back to hit your target"
      }
    >
      {positive ? "+" : "−"}
      {formatted} balance
    </span>
  );
}

// ── Time-input helpers ───────────────────────────────────────────────────────

/** `13:42` for an HTML `<input type="time">` from a millisecond timestamp. */
function toTimeInput(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Apply `HH:MM` to the calendar day of `referenceMs`. Returns null on invalid input. */
function fromTimeInput(referenceMs: number, value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  const ref = new Date(referenceMs);
  const out = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hh, mm, 0, 0);
  return out.getTime();
}
