import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type WorkSegment,
  dayKey,
  formatDurationHm,
  startOfWeek,
  totalMsForDayWithAdjustment,
  MS_PER_HOUR,
} from "@/lib/timeTracking";

/**
 * Month-view calendar that drops out of the week-grid title. Each cell shows
 * the day number plus the tracked hours (when > 0) for a quick-glance
 * heatmap of how the month went. Clicking any day jumps the parent grid to
 * the week containing that day. Future days are disabled — selecting a
 * week that hasn't started yet is meaningless.
 */
export function WeekPickerCalendar({
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
