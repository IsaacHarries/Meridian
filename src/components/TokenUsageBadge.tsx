/**
 * Compact live counter that shows cumulative LLM token usage on the
 * panel that's currently doing AI work. Renders nothing when the panel
 * has done no work this session AND isn't currently in-flight, so it
 * stays out of the way during normal idle UI.
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
  const { cumulative } = state;
  const inFlight =
    typeof inFlightOverride === "boolean" ? inFlightOverride : state.inFlight;
  const total = cumulative.inputTokens + cumulative.outputTokens;
  // No work done yet AND nothing in-flight → render nothing so the
  // header stays clean.
  if (total === 0 && !inFlight) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground font-medium",
        inFlight && "border-primary/40",
        className,
      )}
      title={`Input: ${cumulative.inputTokens.toLocaleString()} · Output: ${cumulative.outputTokens.toLocaleString()}`}
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
        {formatTokens(cumulative.inputTokens)}
        {" → "}
        {formatTokens(cumulative.outputTokens)}
      </span>
    </span>
  );
}
