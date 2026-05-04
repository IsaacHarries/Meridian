/**
 * Compact live counter that shows cumulative LLM token usage on the
 * panel that's currently doing AI work. Renders nothing when the panel
 * has done no work this session AND isn't currently in-flight, so it
 * stays out of the way during normal idle UI.
 *
 * When a workflow on this panel exercised Anthropic prompt caching
 * (currently only the implementation pipeline orchestrator), the badge
 * also shows a `↻ <writes>/<reads>` segment whose colour interpolates
 * between red (cache write premium not amortising — a net loss) and
 * green (cache reads outweighing the premium). The continuous gradient
 * lets the user eyeball at a glance whether the optimisation is
 * actually paying off this session.
 */

import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type PanelKey,
  formatTokens,
  useTokenUsageStore,
} from "@/stores/tokenUsageStore";

export function TokenUsageBadge({
  panel,
  inFlight: inFlightOverride,
  className,
}: {
  panel: PanelKey;
  /** Override the panel's stored inFlight flag — useful when the panel
   *  already tracks its own busy/proceeding state and we want the
   *  badge's spinner + border-glow to mirror that exactly. */
  inFlight?: boolean;
  className?: string;
}) {
  const state = useTokenUsageStore((s) => s.panels[panel]);
  const { cumulative, currentCall } = state;
  const inFlight =
    typeof inFlightOverride === "boolean" ? inFlightOverride : state.inFlight;
  // The displayed total is cumulative + the running in-flight call so
  // the badge climbs live during streaming. When the call's final
  // usage lands, currentCall collapses to zero and the same number is
  // absorbed into cumulative — the displayed total stays stable.
  const displayInput = cumulative.inputTokens + currentCall.inputTokens;
  const displayOutput = cumulative.outputTokens + currentCall.outputTokens;
  const cacheWrites =
    cumulative.cacheCreationInputTokens + currentCall.cacheCreationInputTokens;
  const cacheReads =
    cumulative.cacheReadInputTokens + currentCall.cacheReadInputTokens;
  const total = displayInput + displayOutput;
  // No work done yet AND nothing in-flight → render nothing so the
  // header stays clean.
  if (total === 0 && !inFlight) return null;
  const cacheStats =
    cacheWrites > 0 || cacheReads > 0
      ? computeCacheSavings(cacheWrites, cacheReads)
      : null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground font-medium",
        inFlight && "border-primary/40",
        className,
      )}
      title={[
        `Input: ${displayInput.toLocaleString()}`,
        `Output: ${displayOutput.toLocaleString()}`,
        cacheStats
          ? `Cache: ${cacheWrites.toLocaleString()} written @ 1.25x · ${cacheReads.toLocaleString()} read @ 0.1x`
          : null,
        cacheStats
          ? `Net effect vs no-cache: ${
              cacheStats.savedTokens >= 0
                ? `saved ${formatTokens(cacheStats.savedTokens)} (${(cacheStats.ratio * 100).toFixed(0)}%)`
                : `cost ${formatTokens(-cacheStats.savedTokens)} extra (${(cacheStats.ratio * 100).toFixed(0)}%)`
            }`
          : null,
        currentCall.inputTokens + currentCall.outputTokens > 0
          ? `(current call: +${(currentCall.inputTokens + currentCall.outputTokens).toLocaleString()})`
          : null,
      ]
        .filter((s): s is string => !!s)
        .join(" · ")}
      aria-label={
        inFlight
          ? "AI processing — accumulated tokens"
          : "Accumulated tokens for this session"
      }
    >
      {inFlight ? (
        <Loader2 className="h-2.5 w-2.5 animate-spin text-primary" />
      ) : (
        <Sparkles className="h-2.5 w-2.5 text-muted-foreground/70" />
      )}
      <span className="tabular-nums">
        {formatTokens(displayInput)}
        {" → "}
        {formatTokens(displayOutput)}
      </span>
      {cacheStats && (
        <span
          className="tabular-nums border-l border-border/60 pl-1.5"
          style={{ color: cacheStats.color }}
        >
          ↻ {formatTokens(cacheWrites)}/{formatTokens(cacheReads)}
        </span>
      )}
    </span>
  );
}

/**
 * Compute the cache-savings stats for the badge.
 *
 * Anthropic prompt caching pricing (as of 2025/26): cache writes bill
 * at 1.25x base input, cache reads at 0.1x base input. So compared to
 * sending the same content uncached at 1.0x, every cached token has
 * either cost 0.25x extra (if it was just a write) or saved 0.9x
 * (if it was a read).
 *
 *   savedTokens = 0.9 × reads − 0.25 × writes
 *
 * Positive = caching is amortising; negative = paying the write
 * premium without enough reads to recover.
 *
 * The `ratio` is `savedTokens / (writes + reads)` — clamped to a
 * symmetric ±0.9 range for the colour mapping. We map ratio onto
 * an HSL hue: red (0°) at the worst case, yellow (60°) at break-even,
 * green (120°) at the best case. Continuous interpolation, no buckets.
 */
function computeCacheSavings(
  writes: number,
  reads: number,
): { savedTokens: number; ratio: number; color: string } {
  const savedTokens = 0.9 * reads - 0.25 * writes;
  const total = writes + reads;
  // Best case (all reads): ratio = +0.9. Worst case (all writes): -0.25.
  // Normalise to [-1, +1] for symmetric colour interpolation. Anything
  // beyond ±1 is just clamped — callers can hover for the exact figure.
  const raw = total > 0 ? savedTokens / total : 0;
  const normalised = Math.max(-1, Math.min(1, raw / 0.9));
  // Hue: -1 → 0° (red), 0 → 60° (yellow), +1 → 120° (green).
  const hue = 60 + normalised * 60;
  const color = `hsl(${hue.toFixed(0)}, 70%, 55%)`;
  return { savedTokens, ratio: raw, color };
}
