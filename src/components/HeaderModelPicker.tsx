import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cpu, Loader2, Lock, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useAiSelectionStore,
  type AiProvider,
  type PanelId,
  type StageId,
  PROVIDER_LABELS,
  STAGE_LABELS,
  PANEL_LABELS,
} from "@/stores/aiSelectionStore";
import {
  useTokenUsageStore,
  modelKey,
  formatTokens,
  type TokenUsage,
  type PanelKey,
} from "@/stores/tokenUsageStore";
import { getAppPreferences } from "@/lib/appPreferences";
import { ContextProgressRing } from "@/components/ContextProgressRing";
import { getModelContextWindow } from "@/lib/modelContext";

const PROVIDER_OPTIONS: AiProvider[] = ["claude", "gemini", "copilot", "local"];

type Scope = "stage" | "panel";

/** Bridge the aiSelectionStore's PanelId enum to the tokenUsageStore's
 *  PanelKey enum. The two diverge on `address_pr_comments` vs
 *  `address_pr` (history: aiSelectionStore was first to settle, the
 *  token bucket store followed with a shorter id). */
function panelIdToKey(panel: PanelId): PanelKey {
  if (panel === "address_pr_comments") return "address_pr";
  return panel;
}

export function HeaderModelPicker({
  panel,
  stage,
  className,
}: {
  panel: PanelId;
  stage?: StageId | null;
  className?: string;
}) {
  const hydrated = useAiSelectionStore((s) => s.hydrated);
  const hydrate = useAiSelectionStore((s) => s.hydrate);
  const refresh = useAiSelectionStore((s) => s.refreshFromPrefs);
  const loadModels = useAiSelectionStore((s) => s.loadModels);
  const setPanelOverride = useAiSelectionStore((s) => s.setPanelOverride);
  const setStageOverride = useAiSelectionStore((s) => s.setStageOverride);
  const modelsByProvider = useAiSelectionStore((s) => s.modelsByProvider);
  const modelsLoading = useAiSelectionStore((s) => s.modelsLoading);
  const stageOverrides = useAiSelectionStore((s) => s.stageOverrides);
  const resolve = useAiSelectionStore((s) => s.resolve);

  // Re-render whenever any selection-relevant slice changes.
  useAiSelectionStore((s) => s.priority);
  useAiSelectionStore((s) => s.panelOverrides);
  useAiSelectionStore((s) => s.stageOverrides);
  useAiSelectionStore((s) => s.providerDefaultModel);

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );

  const stageScopable = panel === "implement_ticket" && !!stage;
  const [scope, setScope] = useState<Scope>(
    stageScopable ? "stage" : "panel",
  );

  useEffect(() => {
    setScope(stageScopable ? "stage" : "panel");
  }, [stageScopable, stage]);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useLayoutEffect(() => {
    if (!open) return;
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
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const resolved = resolve(panel, stage ?? undefined);
  const stageHasOverride = stage ? !!stageOverrides[stage] : false;

  // The provider currently shown in the picker body. When locked, always the
  // locked provider. Otherwise, the resolved one (or the first option).
  const [draftProvider, setDraftProvider] = useState<AiProvider>(
    resolved.provider,
  );

  useEffect(() => {
    setDraftProvider(resolved.provider);
  }, [open, resolved.provider]);

  useEffect(() => {
    if (!open) return;
    void loadModels(draftProvider);
  }, [open, draftProvider, loadModels]);

  const models = modelsByProvider[draftProvider] ?? [];
  const loadingModels = !!modelsLoading[draftProvider];

  async function selectModel(modelId: string) {
    if (resolved.locked) {
      // Locked: write override on the locked provider only.
      const value = { provider: resolved.provider, model: modelId };
      if (scope === "stage" && stage) {
        await setStageOverride(stage, value);
      } else {
        await setPanelOverride(panel, value);
      }
    } else {
      const value = { provider: draftProvider, model: modelId };
      if (scope === "stage" && stage) {
        await setStageOverride(stage, value);
      } else {
        await setPanelOverride(panel, value);
      }
    }
    setOpen(false);
  }

  async function clearStageOverride() {
    if (!stage) return;
    await setStageOverride(stage, null);
  }

  const buttonLabel = (() => {
    if (!resolved.model) return PROVIDER_LABELS[resolved.provider];
    const list = modelsByProvider[resolved.provider] ?? [];
    const display = list.find((m) => m[0] === resolved.model)?.[1];
    return display || resolved.model;
  })();

  // Token usage for the active provider, summed across every model
  // we've ever bucketed for it this session. Per-provider (rather
  // than per-model) is what actually matters: Claude.ai OAuth shares
  // a single quota window across all Claude models, so switching from
  // Haiku to Sonnet doesn't reset anything. The dropdown rows below
  // keep per-model breakdowns as a diagnostic, but the trigger reads
  // the aggregate. Sums any in-flight streaming totals so the count
  // climbs live during a request.
  const modelCumulative = useTokenUsageStore((s) => s.modelCumulative);
  const modelCurrentCall = useTokenUsageStore((s) => s.modelCurrentCall);
  const providerPrefix = `${resolved.provider}:`;
  const activeUsage = useMemo<TokenUsage>(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const [key, u] of Object.entries(modelCumulative)) {
      if (!key.startsWith(providerPrefix)) continue;
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
    }
    for (const [key, u] of Object.entries(modelCurrentCall)) {
      if (!key.startsWith(providerPrefix)) continue;
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
    }
    return { inputTokens, outputTokens };
  }, [providerPrefix, modelCumulative, modelCurrentCall]);
  const activeUsageTotal = activeUsage.inputTokens + activeUsage.outputTokens;

  // Daily token budget — pulled fresh whenever the dropdown opens so a
  // setting just changed in another tab is reflected the next time the
  // user looks. The session-usage progress bar uses this to render the
  // "X% of daily budget" indicator; absent budget = bar still shown
  // against an undefined ceiling so the user sees raw consumption.
  const [dailyBudget, setDailyBudget] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void getAppPreferences().then((p) => {
      if (alive) setDailyBudget(p.dailyTokenBudget);
    });
    return () => {
      alive = false;
    };
  }, [open]);
  const sessionTotal = activeUsage.inputTokens + activeUsage.outputTokens;
  const budgetPct =
    dailyBudget && dailyBudget > 0
      ? Math.min(100, (sessionTotal / dailyBudget) * 100)
      : null;

  // Context-window utilisation for the active model.
  //
  // When the panel has a chat thread that replays history each turn
  // (orchestrator chat, triage, grooming chat, etc.) we prefer the
  // panel's last chat-call input — that's the running conversation
  // size, which is what drives compress-or-not decisions. A small
  // one-shot stage call shouldn't reset the displayed value to its
  // own tiny input.
  //
  // When no chat context is recorded for this panel (yet, or never —
  // e.g. one-shot panels), fall back to the per-model last-input so
  // the ring still reflects something useful.
  //
  // The running prompt size during a streaming call still wins over
  // both, so the ring fills live as a fresh call is in flight.
  const modelLastInputTokens = useTokenUsageStore(
    (s) => s.modelLastInputTokens,
  );
  const panelChatLastInputTokens = useTokenUsageStore(
    (s) => s.panelChatLastInputTokens,
  );
  const activeMk = resolved.model
    ? modelKey(resolved.provider, resolved.model)
    : null;
  const activeContextUsed = (() => {
    if (!activeMk) return 0;
    const liveInput = modelCurrentCall[activeMk]?.inputTokens ?? 0;
    if (liveInput > 0) return liveInput;
    // Prefer the panel's chat-thread last-input over the per-model
    // last-input, so on every chat panel the ring tracks the running
    // conversation (which is the actual driver of "should I compress?"
    // decisions). Cleared back to zero when chat history is wiped.
    const chatInput = panelChatLastInputTokens[panelIdToKey(panel)];
    if (typeof chatInput === "number" && chatInput > 0) {
      return chatInput;
    }
    return modelLastInputTokens[activeMk] ?? 0;
  })();
  const activeContextMax = resolved.model
    ? getModelContextWindow(resolved.provider, resolved.model)
    : 0;

  return (
    <div className={cn("relative", className)}>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title={
          resolved.locked
            ? `Locked to ${PROVIDER_LABELS[resolved.provider]} via Settings → AI Provider Priority`
            : "Change AI provider/model for this panel"
        }
        className="h-9 gap-1.5 px-2.5"
      >
        {resolved.locked ? (
          <Lock className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="text-[11px] font-medium leading-tight">
          {PROVIDER_LABELS[resolved.provider]}
        </span>
        <span className="text-[11px] text-muted-foreground leading-tight max-w-[120px] truncate">
          {buttonLabel}
        </span>
        <span
          className={cn(
            "text-[10px] leading-tight tabular-nums ml-1 pl-1.5 border-l border-border/60",
            activeUsageTotal > 0 ? "text-muted-foreground" : "text-muted-foreground/50",
          )}
          title={
            activeUsageTotal > 0
              ? `Tokens used by ${PROVIDER_LABELS[resolved.provider]} this session: ${activeUsage.inputTokens.toLocaleString()} in / ${activeUsage.outputTokens.toLocaleString()} out (across all models — open dropdown for per-model breakdown)`
              : `No tokens used by ${PROVIDER_LABELS[resolved.provider]} yet this session`
          }
        >
          {formatTokens(activeUsage.inputTokens)}
          {" → "}
          {formatTokens(activeUsage.outputTokens)}
        </span>
        {activeContextMax > 0 && (
          <span className="ml-1 inline-flex items-center">
            <ContextProgressRing
              used={activeContextUsed}
              max={activeContextMax}
            />
          </span>
        )}
      </Button>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            style={{
              position: "fixed",
              top: anchor.top,
              right: anchor.right,
              zIndex: 100,
            }}
            className="w-96 rounded-lg border bg-popover text-popover-foreground shadow-lg"
          >
            <div className="px-3 py-2.5 border-b">
              <p className="text-xs font-semibold">
                {PANEL_LABELS[panel]}
                {stage ? ` · ${STAGE_LABELS[stage]}` : ""}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {resolved.locked
                  ? `Locked to ${PROVIDER_LABELS[resolved.provider]} — change priority in Settings to switch provider.`
                  : resolved.source === "stage"
                    ? "Using stage override."
                    : resolved.source === "panel"
                      ? "Using panel override."
                      : "Using default fallback order."}
              </p>
            </div>

            {/* Session usage — always visible. Sums every model the
                active provider has spent tokens on this session. When
                the user has set a daily token budget the bar fills
                against that ceiling; otherwise it just shows raw
                progress with no upper bound. */}
            <div className="px-3 py-2 border-b">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Session usage · {PROVIDER_LABELS[resolved.provider]}
                </p>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {formatTokens(activeUsage.inputTokens)}
                  {" → "}
                  {formatTokens(activeUsage.outputTokens)}
                </span>
              </div>
              {budgetPct != null ? (
                <>
                  <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        budgetPct >= 100
                          ? "bg-destructive"
                          : budgetPct >= 80
                            ? "bg-amber-500"
                            : "bg-primary/70",
                      )}
                      style={{ width: `${Math.max(2, budgetPct)}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {budgetPct.toFixed(0)}% of daily budget (
                    {formatTokens(dailyBudget!)} tokens)
                  </p>
                </>
              ) : sessionTotal > 0 ? (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  No daily budget set —{" "}
                  <span className="opacity-70">configure one in Settings → Notifications</span>
                </p>
              ) : (
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                  No tokens used yet this session.
                </p>
              )}
            </div>


            {stageScopable && (
              <div className="px-3 pt-2.5 pb-2 border-b">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
                  Apply selection to
                </p>
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    className={cn(
                      "rounded px-2 py-1.5 text-xs",
                      scope === "stage"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted hover:bg-muted/70",
                    )}
                    onClick={() => setScope("stage")}
                  >
                    This stage
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded px-2 py-1.5 text-xs",
                      scope === "panel"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted hover:bg-muted/70",
                    )}
                    onClick={() => setScope("panel")}
                  >
                    Whole panel
                  </button>
                </div>
              </div>
            )}

            {!resolved.locked && (
              <div className="px-3 pt-2.5 pb-2 border-b">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
                  Provider
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {PROVIDER_OPTIONS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={cn(
                        "rounded px-2 py-1.5 text-xs",
                        draftProvider === p
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted hover:bg-muted/70",
                      )}
                      onClick={() => setDraftProvider(p)}
                    >
                      {PROVIDER_LABELS[p]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="px-3 pt-2.5 pb-2.5">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
                Model
              </p>
              {loadingModels ? (
                <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                  Loading models…
                </div>
              ) : models.length === 0 ? (
                <p className="py-3 text-xs text-muted-foreground">
                  No models available for{" "}
                  {PROVIDER_LABELS[draftProvider]}. Configure it in Settings.
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto space-y-0.5">
                  {models.map(([id, label]) => {
                    const active =
                      resolved.provider === draftProvider &&
                      resolved.model === id;
                    const mk = modelKey(draftProvider, id);
                    const cum = modelCumulative[mk] ?? {
                      inputTokens: 0,
                      outputTokens: 0,
                    };
                    const live = modelCurrentCall[mk] ?? {
                      inputTokens: 0,
                      outputTokens: 0,
                    };
                    const inTok = cum.inputTokens + live.inputTokens;
                    const outTok = cum.outputTokens + live.outputTokens;
                    const totalTok = inTok + outTok;
                    return (
                      <button
                        key={id}
                        type="button"
                        className={cn(
                          "w-full rounded px-2 py-1.5 text-left text-xs flex items-center gap-2",
                          active
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-muted/70",
                        )}
                        onClick={() => void selectModel(id)}
                        title={
                          totalTok > 0
                            ? `${inTok.toLocaleString()} in · ${outTok.toLocaleString()} out`
                            : "No tokens used yet this session"
                        }
                      >
                        <span className="flex-1 min-w-0 truncate">{label}</span>
                        {totalTok > 0 && (
                          <span
                            className={cn(
                              "shrink-0 tabular-nums text-[10px]",
                              active
                                ? "text-primary-foreground/80"
                                : "text-muted-foreground",
                            )}
                          >
                            {formatTokens(inTok)}
                            {" → "}
                            {formatTokens(outTok)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {stageHasOverride && stage && (
              <button
                type="button"
                onClick={() => void clearStageOverride()}
                className="w-full px-3 py-2 border-t text-xs text-muted-foreground hover:bg-muted/60 flex items-center justify-center gap-1.5 rounded-b-lg"
              >
                <RotateCcw className="h-3 w-3" />
                Reset stage to panel default
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
