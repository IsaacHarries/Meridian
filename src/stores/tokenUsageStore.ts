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
  /** Anthropic prompt-cache breakdown — subset of `inputTokens` that
   *  was billed at the 1.25x cache-write rate. Always 0 for providers
   *  that don't support prompt caching, and for Anthropic workflows
   *  that don't opt into it. Tracked separately from `inputTokens` so
   *  the badge can report whether the write premium is amortising. */
  cacheCreationInputTokens: number;
  /** Anthropic prompt-cache breakdown — subset of `inputTokens` that
   *  was billed at the 0.1x cache-read rate. */
  cacheReadInputTokens: number;
}

/** Permissive input shape callers pass to addUsage / setCurrentCallUsage.
 *  Cache-token fields are optional — workflows that don't opt into
 *  prompt caching simply don't supply them, and the store treats the
 *  missing fields as zero contributions. */
export interface UsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

interface PanelState {
  cumulative: TokenUsage;
  inFlight: boolean;
  /** Running token total for the current in-flight call. Updated as
   *  the sidecar emits `usagePartial` events from streaming workflows.
   *  Reset to zero when a final usage lands (via `addUsage`) so the
   *  badge total = cumulative + currentCall stays stable across the
   *  stream/finish boundary. */
  currentCall: TokenUsage;
  /** Last call's usage — handy for "this turn cost X" displays. */
  lastCall: TokenUsage | null;
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Stable identifier for a (provider, model) pair. The HeaderModelPicker
 *  uses this to bucket tokens by the model that actually produced them
 *  — switching providers or models in the dropdown surfaces the count
 *  for that exact combination. */
export type ModelKey = string; // `${provider}:${model}`

export function modelKey(provider: string, model: string): ModelKey {
  return `${provider}:${model}`;
}

/** Latest snapshot of provider rate-limit headers. Anthropic returns
 *  per-window remaining/limit/reset for requests + total tokens +
 *  input tokens + output tokens; the snapshot is keyed by provider so
 *  the dropdown can show "X% remaining, resets in Ym" without polling
 *  the provider directly. */
export interface RateLimitSnapshot {
  capturedAt: string;
  requestsRemaining: number | null;
  requestsLimit: number | null;
  requestsResetAt: string | null;
  tokensRemaining: number | null;
  tokensLimit: number | null;
  tokensResetAt: string | null;
  inputTokensRemaining: number | null;
  inputTokensLimit: number | null;
  outputTokensRemaining: number | null;
  outputTokensLimit: number | null;
}

interface TokenUsageState {
  panels: Record<PanelKey, PanelState>;
  /** Cumulative tokens bucketed by model (provider:model). Survives
   *  panel switches so the dropdown can show "this model's spend so
   *  far" regardless of which workflow consumed them. */
  modelCumulative: Record<ModelKey, TokenUsage>;
  /** Running token total for the call currently streaming on each
   *  model. Reset to zero by `addUsage` when the call's final usage
   *  lands. The HeaderModelPicker shows `modelCumulative + currentCall`
   *  for the active model so the count climbs live. */
  modelCurrentCall: Record<ModelKey, TokenUsage>;
  /** Most recent completed call's input-token count per model. Used
   *  by the context-window progress ring to show "this prompt filled
   *  X% of the model's context" — sticky across calls so the ring
   *  stays informative between requests instead of snapping back to
   *  zero. Updated by addUsage; superseded by `modelCurrentCall`'s
   *  input field while a fresh call is mid-stream. */
  modelLastInputTokens: Record<ModelKey, number>;
  /** Most recent chat-style call's input-token count per panel.
   *  "Chat-style" means a call whose prompt replays accumulated
   *  conversation history (orchestrator chat, triage chat, grooming
   *  chat, dashboard chat, meeting chat, PR-review chat, address-PR
   *  chat). The HeaderModelPicker prefers this over the per-model
   *  last-input when rendering the context ring on a panel that has
   *  a chat thread, because that thread is what actually grows toward
   *  the model's context cap and drives compression decisions.
   *  One-shot stage calls do NOT update this slot — their input size
   *  isn't a meaningful "how big is my conversation" signal. */
  panelChatLastInputTokens: Record<PanelKey, number>;
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
  /** Add tokens to the panel + day totals. When `model` is supplied
   *  the same usage also accumulates into the per-model bucket so the
   *  HeaderModelPicker dropdown can show per-model spend. Cache-token
   *  fields are optional on the input — callers that don't pass them
   *  contribute zeros to the cumulative cache totals. */
  addUsage: (
    panel: PanelKey,
    usage: UsageInput,
    model?: ModelKey,
  ) => void;
  /** Replace the current-call running total. The badge shows
   *  `cumulative + currentCall` so the user sees tokens climb as the
   *  agent streams; the value is reset to zero when the call's
   *  authoritative final usage lands via `addUsage`. */
  setCurrentCallUsage: (
    panel: PanelKey,
    usage: UsageInput,
    model?: ModelKey,
  ) => void;
  /** Wipe a panel's cumulative + lastCall counters. Call when the user
   *  starts a new logical run on that panel. */
  resetPanel: (panel: PanelKey) => void;
  /** Record the input-token size of the most recent chat-style call
   *  on a panel — i.e. one whose prompt replays accumulated history
   *  and so represents the panel's running conversation context. */
  setPanelChatLastInput: (panel: PanelKey, inputTokens: number) => void;
  /** Forget the recorded chat-context size for a panel. Call when the
   *  panel's chat history is cleared (user hits /clear, sprint switch,
   *  ticket switch, etc.) so the context ring drops back to empty
   *  instead of showing a stale figure from the prior conversation. */
  clearPanelChatLastInput: (panel: PanelKey) => void;
  /** Latest rate-limit snapshots keyed by provider id (e.g. `claude`).
   *  Updated when the sidecar forwards `data.rateLimits` events from
   *  the OAuth fetch interceptor's response-header parser. */
  rateLimits: Record<string, RateLimitSnapshot>;
  /** Replace the snapshot for one provider. */
  setRateLimits: (provider: string, snap: RateLimitSnapshot) => void;
  /** Internal — set once the rate-limit warn-toast fires for the
   *  current low-remaining episode, so we don't spam. Cleared the
   *  next time remaining climbs back above the threshold. */
  rateLimitWarnFiredFor: Record<string, boolean>;
}

function emptyPanel(): PanelState {
  return {
    cumulative: { ...EMPTY_USAGE },
    inFlight: false,
    currentCall: { ...EMPTY_USAGE },
    lastCall: null,
  };
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
  modelCumulative: {},
  modelCurrentCall: {},
  modelLastInputTokens: {},
  panelChatLastInputTokens: {} as Record<PanelKey, number>,
  rateLimits: {},
  rateLimitWarnFiredFor: {},
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

  addUsage: (panel, usage, model) => {
    if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
    set((s) => {
      const cacheWrite = usage.cacheCreationInputTokens ?? 0;
      const cacheRead = usage.cacheReadInputTokens ?? 0;
      // Day rollover — wipe the accumulator without touching panels.
      const today = todayIso();
      const dayChanged = s.dailyDate !== today;
      const baseDaily = dayChanged ? { ...EMPTY_USAGE } : s.dailyTotal;
      const dailyTotal: TokenUsage = {
        inputTokens: baseDaily.inputTokens + usage.inputTokens,
        outputTokens: baseDaily.outputTokens + usage.outputTokens,
        cacheCreationInputTokens:
          baseDaily.cacheCreationInputTokens + cacheWrite,
        cacheReadInputTokens: baseDaily.cacheReadInputTokens + cacheRead,
      };
      const prior = s.panels[panel];
      const cumulative: TokenUsage = {
        inputTokens: prior.cumulative.inputTokens + usage.inputTokens,
        outputTokens: prior.cumulative.outputTokens + usage.outputTokens,
        cacheCreationInputTokens:
          prior.cumulative.cacheCreationInputTokens + cacheWrite,
        cacheReadInputTokens:
          prior.cumulative.cacheReadInputTokens + cacheRead,
      };
      // Per-model bucket — only when the caller knew which model ran.
      // Same collapse logic as the panel: model's currentCall resets
      // since the authoritative usage just rolled into modelCumulative.
      const modelCumulative = { ...s.modelCumulative };
      const modelCurrentCall = { ...s.modelCurrentCall };
      const modelLastInputTokens = { ...s.modelLastInputTokens };
      if (model) {
        const priorModel = modelCumulative[model] ?? { ...EMPTY_USAGE };
        modelCumulative[model] = {
          inputTokens: priorModel.inputTokens + usage.inputTokens,
          outputTokens: priorModel.outputTokens + usage.outputTokens,
          cacheCreationInputTokens:
            priorModel.cacheCreationInputTokens + cacheWrite,
          cacheReadInputTokens: priorModel.cacheReadInputTokens + cacheRead,
        };
        delete modelCurrentCall[model];
        // Remember this call's prompt size so the context-progress
        // ring stays meaningful between requests.
        modelLastInputTokens[model] = usage.inputTokens;
      }
      return {
        panels: {
          ...s.panels,
          [panel]: {
            ...prior,
            cumulative,
            // The authoritative usage just landed for this call —
            // collapse the streaming current-call counter so the badge
            // total stays stable as cumulative absorbs the same value.
            currentCall: { ...EMPTY_USAGE },
            lastCall: usage,
          },
        },
        modelCumulative,
        modelCurrentCall,
        modelLastInputTokens,
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

  setCurrentCallUsage: (panel, usage, model) =>
    set((s) => {
      const normalized: TokenUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      };
      const next: Partial<TokenUsageState> = {
        panels: {
          ...s.panels,
          [panel]: { ...s.panels[panel], currentCall: normalized },
        },
      };
      if (model) {
        next.modelCurrentCall = { ...s.modelCurrentCall, [model]: normalized };
      }
      return next;
    }),

  resetPanel: (panel) =>
    set((s) => {
      const nextChat = { ...s.panelChatLastInputTokens };
      delete nextChat[panel];
      return {
        panels: { ...s.panels, [panel]: emptyPanel() },
        panelChatLastInputTokens: nextChat,
      };
    }),

  setPanelChatLastInput: (panel, inputTokens) =>
    set((s) => ({
      panelChatLastInputTokens: {
        ...s.panelChatLastInputTokens,
        [panel]: Math.max(0, Math.floor(inputTokens)),
      },
    })),

  clearPanelChatLastInput: (panel) =>
    set((s) => {
      const next = { ...s.panelChatLastInputTokens };
      delete next[panel];
      return { panelChatLastInputTokens: next };
    }),

  setRateLimits: (provider, snap) => {
    set((s) => ({
      rateLimits: { ...s.rateLimits, [provider]: snap },
    }));
    // Toast at most once per low-remaining episode. We pick the
    // tightest "remaining %" across the four counters Anthropic
    // returns; whichever is closest to zero is the one that'll throttle
    // the user first.
    const pct = computeMinRemainingPct(snap);
    if (pct == null) return;
    const fired = get().rateLimitWarnFiredFor[provider] ?? false;
    if (pct < 10 && !fired) {
      set((s) => ({
        rateLimitWarnFiredFor: {
          ...s.rateLimitWarnFiredFor,
          [provider]: true,
        },
      }));
      toast.warning(`${provider} rate limit: ${pct.toFixed(0)}% remaining`, {
        description: snap.tokensResetAt
          ? `Resets at ${new Date(snap.tokensResetAt).toLocaleTimeString()}.`
          : "Resets at the end of the current rate-limit window.",
      });
    } else if (pct >= 25 && fired) {
      set((s) => ({
        rateLimitWarnFiredFor: {
          ...s.rateLimitWarnFiredFor,
          [provider]: false,
        },
      }));
    }
  },
}));

/** Smallest "% remaining" across the snapshot's four counters, or null
 *  when the snapshot has no counter pairs. Used to decide whether to
 *  surface the low-remaining toast. */
export function computeMinRemainingPct(snap: RateLimitSnapshot): number | null {
  const candidates: number[] = [];
  const pairs: [number | null, number | null][] = [
    [snap.requestsRemaining, snap.requestsLimit],
    [snap.tokensRemaining, snap.tokensLimit],
    [snap.inputTokensRemaining, snap.inputTokensLimit],
    [snap.outputTokensRemaining, snap.outputTokensLimit],
  ];
  for (const [remaining, limit] of pairs) {
    if (remaining == null || limit == null || limit <= 0) continue;
    candidates.push((remaining / limit) * 100);
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

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
