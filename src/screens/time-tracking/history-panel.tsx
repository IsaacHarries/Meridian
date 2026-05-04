import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type WorkSegment,
  dayKey,
  formatDurationHm,
  formatWeekRange,
  overtimeBalanceMs,
  startOfWeek,
  totalMsForDayWithAdjustment,
  MS_PER_HOUR,
} from "@/lib/timeTracking";
import { BalancePill } from "./_shared";

/** One row in the history list — aggregates everything for a single week. */
interface WeekSummary {
  startMs: number;
  startKey: string;
  totalMs: number;
  daysWorked: number;
  /** Net overtime / shortfall this week alone (not cumulative). */
  netBalanceMs: number;
}

export function HistoryPanel({
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
