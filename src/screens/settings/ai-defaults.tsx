import { useEffect, useMemo } from "react";
import { AlertCircle, Gauge } from "lucide-react";
import { APP_PREFERENCE_DEFAULTS } from "@/lib/appPreferences";
import {
  useAiSelectionStore,
  PANEL_LABELS,
  STAGE_LABELS,
  PROVIDER_LABELS,
  ALL_PROVIDERS,
} from "@/stores/aiSelectionStore";
import type {
  PanelId as AiPanelId,
  StageId as AiStageId,
  AiProvider,
} from "@/stores/aiSelectionStore";
import {
  useCredentialStatusStore,
  authenticatedProviders,
} from "@/stores/credentialStatusStore";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NumberPreferenceField, useAppPreferencesEditor } from "./_shared";

const PROVIDER_META: Record<
  string,
  { label: string; color: string; dot: string }
> = {
  claude: {
    label: "Claude",
    color: "border-orange-400/40 bg-orange-400/10 text-orange-400",
    dot: "bg-orange-400",
  },
  gemini: {
    label: "Gemini",
    color: "border-blue-400/40  bg-blue-400/10  text-blue-400",
    dot: "bg-blue-400",
  },
  copilot: {
    label: "Copilot",
    color: "border-emerald-400/40 bg-emerald-400/10 text-emerald-400",
    dot: "bg-emerald-400",
  },
  local: {
    label: "Local LLM",
    color: "border-purple-400/40 bg-purple-400/10 text-purple-400",
    dot: "bg-purple-400",
  },
};

/**
 * Picks the global default provider+model used by any panel that doesn't
 * have its own override. The first authenticated provider is suggested
 * during onboarding (see OnboardingScreen) so this card usually starts
 * pre-populated; users come here later to switch defaults.
 *
 * Replaces the older "AI Provider Priority" card which used a per-mode
 * fallback chain — the app no longer falls back silently between
 * providers. If a panel's selected provider is unauthenticated, the
 * header model picker badges it instead.
 */
export function DefaultModelCard() {
  const hydrated = useAiSelectionStore((s) => s.hydrated);
  const hydrate = useAiSelectionStore((s) => s.hydrate);
  const defaultProvider = useAiSelectionStore((s) => s.defaultProvider);
  const defaultModel = useAiSelectionStore((s) => s.defaultModel);
  const providerDefaultModel = useAiSelectionStore(
    (s) => s.providerDefaultModel,
  );
  const modelsByProvider = useAiSelectionStore((s) => s.modelsByProvider);
  const loadModels = useAiSelectionStore((s) => s.loadModels);
  const setDefaultStored = useAiSelectionStore((s) => s.setDefault);
  const credStatus = useCredentialStatusStore((s) => s.status);
  const authed = useMemo(() => authenticatedProviders(credStatus), [credStatus]);

  useEffect(() => {
    if (!hydrated) void hydrate();
    for (const p of ALL_PROVIDERS) void loadModels(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const activeProvider: AiProvider = defaultProvider ?? "claude";
  const models = modelsByProvider[activeProvider] ?? [];
  const activeModel =
    defaultModel || providerDefaultModel[activeProvider] || "";

  // Always include the currently saved value in the dropdown even if it
  // hasn't appeared in the fetched list yet (custom model id, slow API).
  const modelOptions: [string, string][] = activeModel
    && !models.some(([id]) => id === activeModel)
    ? [[activeModel, activeModel], ...models]
    : models;

  function changeProvider(next: AiProvider) {
    if (next === defaultProvider) return;
    const fallbackModel =
      providerDefaultModel[next] ||
      modelsByProvider[next]?.[0]?.[0] ||
      "";
    void setDefaultStored({ provider: next, model: fallbackModel });
  }

  function changeModel(next: string) {
    void setDefaultStored({ provider: activeProvider, model: next });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Default model</CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Used by any panel that doesn't have its own override below. Per-panel
          and per-stage selections still take precedence.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {ALL_PROVIDERS.map((p) => {
            const meta = PROVIDER_META[p];
            const isAuthed = authed.has(p);
            const isActive = activeProvider === p;
            return (
              <button
                key={p}
                onClick={() => changeProvider(p)}
                className={`relative rounded-full border px-3 py-1 text-xs transition-colors ${
                  isActive
                    ? "bg-primary/20 border-primary/40 text-primary font-medium"
                    : "bg-muted/40 border-border text-muted-foreground hover:bg-muted/60"
                }`}
                title={isAuthed ? undefined : `${meta.label} is not authenticated`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                  {meta.label}
                  {!isAuthed && (
                    <AlertCircle className="h-3 w-3 text-amber-500" />
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Model</span>
          <select
            className="text-xs border rounded px-2 py-1 bg-background min-w-[220px]"
            value={activeModel}
            onChange={(e) => changeModel(e.target.value)}
          >
            {modelOptions.length === 0 ? (
              <option value="" disabled>
                Loading…
              </option>
            ) : (
              modelOptions.map(([id, lbl]) => (
                <option key={id} value={id}>
                  {lbl}
                </option>
              ))
            )}
          </select>
        </div>

        {!authed.has(activeProvider) && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {PROVIDER_LABELS[activeProvider]} isn't authenticated yet — set up
            credentials below before running a workflow on this provider.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Per-panel AI section ───────────────────────────────────────────────────────

export function PerPanelAiSection() {
  type PanelId = AiPanelId;
  type StageId = AiStageId;

  const hydrated = useAiSelectionStore((s) => s.hydrated);
  const hydrate = useAiSelectionStore((s) => s.hydrate);
  const refresh = useAiSelectionStore((s) => s.refreshFromPrefs);
  const loadModels = useAiSelectionStore((s) => s.loadModels);
  const defaultProvider = useAiSelectionStore((s) => s.defaultProvider);
  const panelOverrides = useAiSelectionStore((s) => s.panelOverrides);
  const stageOverrides = useAiSelectionStore((s) => s.stageOverrides);
  const modelsByProvider = useAiSelectionStore((s) => s.modelsByProvider);
  const providerDefaultModel = useAiSelectionStore(
    (s) => s.providerDefaultModel,
  );
  const setPanelOverride = useAiSelectionStore((s) => s.setPanelOverride);
  const setStageOverride = useAiSelectionStore((s) => s.setStageOverride);
  const credStatus = useCredentialStatusStore((s) => s.status);
  const authed = useMemo(() => authenticatedProviders(credStatus), [credStatus]);

  const PANELS: PanelId[] = [
    "implement_ticket",
    "pr_review",
    "ticket_quality",
    "address_pr_comments",
    "sprint_dashboard",
    "retrospectives",
    "meetings",
  ];
  const IMPL_STAGES: StageId[] = [
    "grooming",
    "impact",
    "triage",
    "plan",
    "implementation",
    "tests",
    "review",
    "pr",
    "retro",
  ];

  useEffect(() => {
    if (!hydrated) void hydrate();
    else void refresh();
    for (const p of ALL_PROVIDERS) void loadModels(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  function getModels(provider: AiProvider): [string, string][] {
    return modelsByProvider[provider] ?? [];
  }

  // Build a model list that always includes the currently stored value even if
  // it hasn't yet appeared in the fetched list (e.g. a custom model ID).
  function modelsWithCurrent(
    provider: AiProvider,
    currentModel: string,
  ): [string, string][] {
    const list = getModels(provider);
    if (!currentModel || list.some(([id]) => id === currentModel)) return list;
    return [[currentModel, currentModel], ...list];
  }

  function savePanel(panel: PanelId, prov: AiProvider, model: string) {
    const m =
      model || getModels(prov)[0]?.[0] || providerDefaultModel[prov] || "";
    void setPanelOverride(panel, { provider: prov, model: m });
  }
  function clearPanel(panel: PanelId) {
    void setPanelOverride(panel, null);
  }

  function saveStage(stage: StageId, prov: AiProvider, model: string) {
    const m =
      model || getModels(prov)[0]?.[0] || providerDefaultModel[prov] || "";
    void setStageOverride(stage, { provider: prov, model: m });
  }
  function clearStage(stage: StageId) {
    void setStageOverride(stage, null);
  }

  function providerOptionLabel(p: AiProvider): string {
    return authed.has(p) ? PROVIDER_LABELS[p] : `${PROVIDER_LABELS[p]} (needs auth)`;
  }

  // Unified row renderer used for both panels and stages.
  function OverrideRow({
    label,
    indent,
    hint,
    overrideProvider,
    overrideModel,
    onSet,
    onClear,
  }: {
    label: string;
    indent?: boolean;
    hint?: string | null;
    overrideProvider: AiProvider | "";
    overrideModel: string;
    onSet: (provider: AiProvider, model: string) => void;
    onClear: () => void;
  }) {
    const rowClass = indent
      ? "flex items-center gap-2 py-1 pl-6 border-l-2 border-muted ml-2"
      : "flex items-center gap-2 py-1.5";
    const labelClass = indent
      ? "flex-1 text-xs text-muted-foreground"
      : "flex-1 text-sm";

    const models = overrideProvider
      ? modelsWithCurrent(overrideProvider as AiProvider, overrideModel)
      : [];
    const showAuthWarning =
      overrideProvider && !authed.has(overrideProvider as AiProvider);
    return (
      <div className={rowClass}>
        <div className={labelClass}>
          {label}
          {hint && (
            <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-60">
              {hint}
            </span>
          )}
        </div>
        <select
          className={`text-xs border rounded px-2 py-1 bg-background ${
            overrideProvider === "" ? "text-muted-foreground" : ""
          }`}
          value={overrideProvider}
          onChange={(e) => {
            const v = e.target.value as AiProvider | "";
            if (v === "") onClear();
            else onSet(v, "");
          }}
        >
          <option value="">
            — Use default
            {defaultProvider ? ` (${PROVIDER_LABELS[defaultProvider]})` : ""} —
          </option>
          {ALL_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {providerOptionLabel(p)}
            </option>
          ))}
        </select>
        {overrideProvider && (
          <select
            className="text-xs border rounded px-2 py-1 bg-background min-w-[180px]"
            value={overrideModel}
            onChange={(e) =>
              onSet(overrideProvider as AiProvider, e.target.value)
            }
          >
            {models.length === 0 ? (
              <option value="">Loading…</option>
            ) : (
              models.map(([id, lbl]) => (
                <option key={id} value={id}>
                  {lbl}
                </option>
              ))
            )}
          </select>
        )}
        {showAuthWarning && (
          <AlertCircle
            className="h-3.5 w-3.5 text-amber-500"
            aria-label="Provider not authenticated"
          />
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Per-panel AI</CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Override the AI provider and model for any panel. Stage overrides
          under <strong>Implement a Ticket</strong> win over the panel setting.
          Panels with no override use the default model above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {PANELS.map((p) => {
          const panelOv = panelOverrides[p];
          return (
            <div key={p}>
              <OverrideRow
                label={PANEL_LABELS[p]}
                overrideProvider={panelOv?.provider ?? ""}
                overrideModel={panelOv?.model ?? ""}
                onSet={(prov, model) => savePanel(p, prov, model)}
                onClear={() => clearPanel(p)}
              />
              {p === "implement_ticket" && (
                <div className="mt-1">
                  {IMPL_STAGES.map((s) => {
                    const stageOv = stageOverrides[s];
                    const hint = !stageOv
                      ? panelOv
                        ? "(panel)"
                        : "(default)"
                      : null;
                    return (
                      <OverrideRow
                        key={s}
                        label={STAGE_LABELS[s]}
                        indent
                        hint={hint}
                        overrideProvider={stageOv?.provider ?? ""}
                        overrideModel={stageOv?.model ?? ""}
                        onSet={(prov, model) => saveStage(s, prov, model)}
                        onClear={() => clearStage(s)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function MaxOutputTokensSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          Max output tokens
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Per-provider response-token ceiling. <span className="font-mono">max_tokens</span> is a cap, not an
          allocation — typical responses are 1–4K, but Plan / Test Plan /
          Code Review can blow past 8K and silently truncate at the
          adapter's historical default. A larger cap costs nothing on
          normal calls but prevents truncation when the model genuinely
          needs the headroom.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <NumberPreferenceField
              label="Anthropic (Claude)"
              helper="Applies to both API key and Claude.ai subscription (OAuth) modes. Sonnet 4.6 / Haiku 4.5 support up to 64K output tokens; Opus 4.x caps at 32K."
              value={prefs.anthropicMaxOutputTokens}
              defaultValue={APP_PREFERENCE_DEFAULTS.anthropicMaxOutputTokens}
              min={1024}
              max={65536}
              step={1024}
              unit="tokens"
              onChange={(n) => void update("anthropicMaxOutputTokens", n)}
            />
            <NumberPreferenceField
              label="Google (Gemini)"
              helper="Applies to both API key and CodeAssist (OAuth) modes. Gemini 2.x models commonly support up to 64K output."
              value={prefs.geminiMaxOutputTokens}
              defaultValue={APP_PREFERENCE_DEFAULTS.geminiMaxOutputTokens}
              min={1024}
              max={65536}
              step={1024}
              unit="tokens"
              onChange={(n) => void update("geminiMaxOutputTokens", n)}
            />
            <NumberPreferenceField
              label="GitHub Copilot"
              helper="The GPT-4-class models Copilot fronts tend to genuinely cap around 8K — bumping higher can cause server-side rejection rather than longer responses."
              value={prefs.copilotMaxOutputTokens}
              defaultValue={APP_PREFERENCE_DEFAULTS.copilotMaxOutputTokens}
              min={1024}
              max={16384}
              step={1024}
              unit="tokens"
              onChange={(n) => void update("copilotMaxOutputTokens", n)}
            />
            <p className="text-[11px] text-muted-foreground">
              Ollama is omitted on purpose — its server enforces the loaded model's native context window, and overriding it produces confusing mid-response truncation when models with different limits get loaded.
            </p>
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
