import {
  Lock,
  MoonStar,
  Sun,
  Hand,
  Sunrise,
  Sliders,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type WorkSegmentEndReason,
  formatDurationHm,
} from "@/lib/timeTracking";

// ── Reason / balance presentation ────────────────────────────────────────────

export function EndReasonBadge({ reason }: { reason: WorkSegmentEndReason }) {
  const meta = endReasonMeta(reason);
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

export function PauseReasonBadge({
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

const END_REASON_META: Record<WorkSegmentEndReason, {
  label: string;
  pausedLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
}> = {
  "screen-locked": { label: "Locked", pausedLabel: "Screen locked", icon: Lock },
  idle:            { label: "Idle", pausedLabel: "No input detected", icon: MoonStar },
  midnight:        { label: "Midnight", pausedLabel: "New day", icon: Sun },
  manual:          { label: "Manual", pausedLabel: "Paused manually", icon: Hand },
  shutdown:        { label: "Slept", pausedLabel: "System slept", icon: MoonStar },
};

export function endReasonMeta(reason: WorkSegmentEndReason) {
  return END_REASON_META[reason];
}

export function BalancePill({ ms }: { ms: number }) {
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

export function AdjustmentRow({
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

// ── Time-input helpers ───────────────────────────────────────────────────────

/** `13:42` for an HTML `<input type="time">` from a millisecond timestamp. */
export function toTimeInput(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Apply `HH:MM` to the calendar day of `referenceMs`. Returns null on invalid input. */
export function fromTimeInput(referenceMs: number, value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  const ref = new Date(referenceMs);
  const out = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hh, mm, 0, 0);
  return out.getTime();
}
