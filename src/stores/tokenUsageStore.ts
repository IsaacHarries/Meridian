/**
 * Cross-app accumulator for LLM token usage.
 *
 * Each panel reports its workflow `usage` after every call (or piece of
 * a call) via `addUsage(panelKey, usage)`. The TokenUsageBadge consumes
 * the per-panel total + the in-flight flag to render a small live
 * counter while the agent is processing.
 *
 * "Session" semantics:
 *   - Per-panel totals reset when the user starts a new logical run on
 *     that panel (e.g. picking a new ticket in Implement Ticket).
 *     Callers signal this via `resetPanel(panelKey)`.
 *   - `dailyTotal` is the lifetime-of-the-day sum across every panel.
 *     It rolls over at local midnight via the rollover tick.
 *   - When the user has set a `dailyTokenBudget` preference the store
 *     fires a single toast the moment cumulative tokens cross the
 *     threshold, then suppresses further toasts until the day rolls.
 */

import { create } from "zustand";
import { toast } from "sonner";
import { getAppPreferences } from "@/lib/appPreferences";

/** Stable identifier per panel that reports usage. Keep narrow so a
 *  typo at a call site shows up in TS rather than silently bucketing
 *  into a stray key. */
export type PanelKey =
  | "implement_ticket"
  | "pr_review"
  | "ticket_quality"
  | "address_pr"
  | "sprint_dashboard"
  | "retrospectives"
  | "trends"
  | "meetings";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface PanelState {
  cumulative: TokenUsage;
  inFlight: boolean;
  /** Last call's usage — handy for "this turn cost X" displays. */
  lastCall: TokenUsage | null;
}

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

interface TokenUsageState {
  panels: Record<PanelKey, PanelState>;
  /** Sum across every panel for the current local day. Persisted only
   *  in memory — restarting the app clears it. */
  dailyTotal: TokenUsage;
  /** ISO date (yyyy-mm-dd) of the day `dailyTotal` represents. */
  dailyDate: string;
  /** True after we've fired the over-budget toast for the current day,
   *  so we don't spam. Resets on day rollover. */
  budgetToastFired: boolean;

  /** Mark a panel as actively running an AI request. Toggle off when
   *  the workflow finishes (success or error). */
  setInFlight: (panel: PanelKey, inFlight: boolean) => void;
  /** Add tokens to the panel + day totals. */
  addUsage: (panel: PanelKey, usage: TokenUsage) => void;
  /** Wipe a panel's cumulative + lastCall counters. Call when the user
   *  starts a new logical run on that panel. */
  resetPanel: (panel: PanelKey) => void;
}

function emptyPanel(): PanelState {
  return { cumulative: { ...EMPTY_USAGE }, inFlight: false, lastCall: null };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyPanels(): Record<PanelKey, PanelState> {
  return {
    implement_ticket: emptyPanel(),
    pr_review: emptyPanel(),
    ticket_quality: emptyPanel(),
    address_pr: emptyPanel(),
    sprint_dashboard: emptyPanel(),
    retrospectives: emptyPanel(),
    trends: emptyPanel(),
    meetings: emptyPanel(),
  };
}

export const useTokenUsageStore = create<TokenUsageState>()((set, get) => ({
  panels: emptyPanels(),
  dailyTotal: { ...EMPTY_USAGE },
  dailyDate: todayIso(),
  budgetToastFired: false,

  setInFlight: (panel, inFlight) =>
    set((s) => ({
      panels: {
        ...s.panels,
        [panel]: { ...s.panels[panel], inFlight },
      },
    })),

  addUsage: (panel, usage) => {
    if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
    set((s) => {
      // Day rollover — wipe the accumulator without touching panels.
      const today = todayIso();
      const dayChanged = s.dailyDate !== today;
      const baseDaily = dayChanged ? { ...EMPTY_USAGE } : s.dailyTotal;
      const dailyTotal = {
        inputTokens: baseDaily.inputTokens + usage.inputTokens,
        outputTokens: baseDaily.outputTokens + usage.outputTokens,
      };
      const prior = s.panels[panel];
      const cumulative = {
        inputTokens: prior.cumulative.inputTokens + usage.inputTokens,
        outputTokens: prior.cumulative.outputTokens + usage.outputTokens,
      };
      return {
        panels: {
          ...s.panels,
          [panel]: { ...prior, cumulative, lastCall: usage },
        },
        dailyTotal,
        dailyDate: today,
        budgetToastFired: dayChanged ? false : s.budgetToastFired,
      };
    });
    // Fire-and-forget budget check. Skip when we've already toasted
    // today, to avoid every subsequent call re-asking the user.
    if (!get().budgetToastFired) {
      void getAppPreferences().then((p) => {
        const budget = p.dailyTokenBudget;
        if (budget == null) return;
        const total = get().dailyTotal;
        if (total.inputTokens + total.outputTokens < budget) return;
        if (get().budgetToastFired) return;
        set({ budgetToastFired: true });
        toast.warning("Daily token budget reached", {
          description: `You've used ${formatTokens(
            total.inputTokens + total.outputTokens,
          )} tokens today (budget: ${formatTokens(budget)}). Toast won't repeat until tomorrow.`,
        });
      });
    }
  },

  resetPanel: (panel) =>
    set((s) => ({ panels: { ...s.panels, [panel]: emptyPanel() } })),
}));

/** Format a token count for compact display: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  const v = n / 1_000_000;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}M`;
}
