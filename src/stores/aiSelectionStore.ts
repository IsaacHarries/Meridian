/**
 * Per-panel and per-stage AI provider/model selection.
 *
 * Overrides are stored per-priority-mode so switching between Auto / Claude /
 * Gemini / Copilot / Local preserves each mode's configuration independently.
 *
 * Pref keys (both hold a JSON object keyed by AiPriority):
 *   panel_ai_overrides  → { auto: { pr_review: {provider,model}, … }, claude: {…}, … }
 *   stage_ai_overrides  → same shape, keyed by StageId inside each mode
 */

import { create } from "zustand";
import { getPreferences, setPreference } from "@/lib/preferences";
import {
  getClaudeModels,
  getGeminiModels,
  getCopilotModels,
  getLocalModels,
} from "@/lib/tauri";

export type AiProvider = "claude" | "gemini" | "copilot" | "local";

export type AiPriority = "auto" | AiProvider;

export type PanelId =
  | "implement_ticket"
  | "pr_review"
  | "ticket_quality"
  | "address_pr_comments"
  | "sprint_dashboard"
  | "retrospectives"
  | "meetings";

export type StageId =
  | "grooming"
  | "impact"
  | "triage"
  | "plan"
  | "implementation"
  | "tests"
  | "review"
  | "pr"
  | "retro";

export interface AiOverride {
  provider: AiProvider;
  model: string;
}

export const PANEL_LABELS: Record<PanelId, string> = {
  implement_ticket: "Implement a Ticket",
  pr_review: "PR Review",
  ticket_quality: "Ticket Quality",
  address_pr_comments: "Address PR Comments",
  sprint_dashboard: "Sprint Dashboard",
  retrospectives: "Retrospectives",
  meetings: "Meetings",
};

export const STAGE_LABELS: Record<StageId, string> = {
  grooming: "Grooming",
  impact: "Impact Analysis",
  triage: "Triage",
  plan: "Implementation Plan",
  implementation: "Implementation",
  tests: "Test Generation",
  review: "Code Review",
  pr: "PR Description",
  retro: "Retrospective",
};

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  claude: "Claude",
  gemini: "Gemini",
  copilot: "Copilot",
  local: "Local LLM",
};

const DEFAULT_ORDER: AiProvider[] = ["claude", "gemini", "copilot", "local"];
const PRIORITY_VALUES = new Set<string>(["auto", "claude", "gemini", "copilot", "local"]);

type OverrideMap<K extends string> = Partial<Record<K, AiOverride>>;
type OverridesByMode<K extends string> = Partial<Record<AiPriority, OverrideMap<K>>>;

interface State {
  hydrated: boolean;
  priority: AiPriority;
  /** Provider fallback order when priority is "auto". */
  order: AiProvider[];
  /** All saved overrides keyed by priority mode — persisted to disk. */
  panelOverridesByMode: OverridesByMode<PanelId>;
  stageOverridesByMode: OverridesByMode<StageId>;
  /** Active slice for the current priority — derived from the above two. */
  panelOverrides: OverrideMap<PanelId>;
  stageOverrides: OverrideMap<StageId>;
  /** Provider-default model preferences (set at the global Settings level). */
  providerDefaultModel: Partial<Record<AiProvider, string>>;
  /** Model lists per provider, lazy-loaded on first picker open. */
  modelsByProvider: Partial<Record<AiProvider, [string, string][]>>;
  modelsLoading: Partial<Record<AiProvider, boolean>>;
}

interface Actions {
  hydrate: () => Promise<void>;
  refreshFromPrefs: () => Promise<void>;
  loadModels: (provider: AiProvider) => Promise<void>;
  /** Drop the cached model list for a provider so the next picker open
   *  re-fetches it. Settings calls this after adding/removing custom models
   *  so header dropdowns pick up the change without a reload. */
  invalidateModels: (provider: AiProvider) => void;
  /** Set or clear a panel-level override for the current priority mode. */
  setPanelOverride: (panel: PanelId, value: AiOverride | null) => Promise<void>;
  /** Set or clear a stage-level override for the current priority mode. */
  setStageOverride: (stage: StageId, value: AiOverride | null) => Promise<void>;
  /** Resolve the active provider+model for a (panel, stage?) pair. */
  resolve: (
    panel: PanelId,
    stage?: StageId | null,
  ) => {
    provider: AiProvider;
    model: string;
    source: "stage" | "panel" | "global";
    locked: boolean;
  };
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parseOverrideMap<K extends string>(obj: unknown): OverrideMap<K> {
  if (!obj || typeof obj !== "object") return {};
  const out: Record<string, AiOverride> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (
      v &&
      typeof v === "object" &&
      typeof (v as Record<string, unknown>).provider === "string" &&
      typeof (v as Record<string, unknown>).model === "string"
    ) {
      out[k] = {
        provider: (v as Record<string, unknown>).provider as AiProvider,
        model: (v as Record<string, unknown>).model as string,
      };
    }
  }
  return out as OverrideMap<K>;
}

function parseOverridesByMode<K extends string>(raw: string | undefined): OverridesByMode<K> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<AiPriority, OverrideMap<K>>> = {};
    for (const [mode, overrides] of Object.entries(parsed)) {
      if (PRIORITY_VALUES.has(mode)) {
        out[mode as AiPriority] = parseOverrideMap<K>(overrides);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function parseOrder(raw: string | undefined): AiProvider[] {
  if (!raw?.trim()) return [...DEFAULT_ORDER];
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean) as AiProvider[];
  const valid = parts.filter((p) => (DEFAULT_ORDER as string[]).includes(p));
  for (const p of DEFAULT_ORDER) {
    if (!valid.includes(p)) valid.push(p);
  }
  return valid;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAiSelectionStore = create<State & Actions>((set, get) => ({
  hydrated: false,
  priority: "auto",
  order: [...DEFAULT_ORDER],
  panelOverridesByMode: {},
  stageOverridesByMode: {},
  panelOverrides: {},
  stageOverrides: {},
  providerDefaultModel: {},
  modelsByProvider: {},
  modelsLoading: {},

  hydrate: async () => {
    if (get().hydrated) return;
    await get().refreshFromPrefs();
    set({ hydrated: true });
  },

  refreshFromPrefs: async () => {
    try {
      const prefs = await getPreferences();
      const priority = (prefs.ai_provider || "auto") as AiPriority;
      const panelOverridesByMode = parseOverridesByMode<PanelId>(prefs.panel_ai_overrides);
      const stageOverridesByMode = parseOverridesByMode<StageId>(prefs.stage_ai_overrides);
      set({
        priority,
        order: parseOrder(prefs.ai_provider_order),
        panelOverridesByMode,
        stageOverridesByMode,
        panelOverrides: panelOverridesByMode[priority] ?? {},
        stageOverrides: stageOverridesByMode[priority] ?? {},
        providerDefaultModel: {
          claude: prefs.claude_model,
          gemini: prefs.gemini_model,
          copilot: prefs.copilot_model,
          local: prefs.local_llm_model,
        },
      });
    } catch {
      /* leave defaults */
    }
  },

  loadModels: async (provider) => {
    const { modelsByProvider, modelsLoading } = get();
    if (modelsByProvider[provider] || modelsLoading[provider]) return;
    set({ modelsLoading: { ...modelsLoading, [provider]: true } });
    try {
      let list: [string, string][] = [];
      if (provider === "claude") list = await getClaudeModels();
      else if (provider === "gemini") list = await getGeminiModels();
      else if (provider === "copilot") list = await getCopilotModels();
      else if (provider === "local") list = await getLocalModels();
      set((s) => ({
        modelsByProvider: { ...s.modelsByProvider, [provider]: list },
        modelsLoading: { ...s.modelsLoading, [provider]: false },
      }));
    } catch {
      set((s) => ({
        modelsLoading: { ...s.modelsLoading, [provider]: false },
      }));
    }
  },

  invalidateModels: (provider) => {
    set((s) => {
      const next = { ...s.modelsByProvider };
      delete next[provider];
      return { modelsByProvider: next };
    });
  },

  setPanelOverride: async (panel, value) => {
    const { priority, panelOverridesByMode } = get();
    const modeMap = { ...(panelOverridesByMode[priority] ?? {}) };
    if (value === null) delete modeMap[panel];
    else modeMap[panel] = value;
    const nextByMode = { ...panelOverridesByMode, [priority]: modeMap };
    set({ panelOverridesByMode: nextByMode, panelOverrides: modeMap });
    await setPreference("panel_ai_overrides", JSON.stringify(nextByMode));
  },

  setStageOverride: async (stage, value) => {
    const { priority, stageOverridesByMode } = get();
    const modeMap = { ...(stageOverridesByMode[priority] ?? {}) };
    if (value === null) delete modeMap[stage];
    else modeMap[stage] = value;
    const nextByMode = { ...stageOverridesByMode, [priority]: modeMap };
    set({ stageOverridesByMode: nextByMode, stageOverrides: modeMap });
    await setPreference("stage_ai_overrides", JSON.stringify(nextByMode));
  },

  resolve: (panel, stage) => {
    const s = get();
    const stageOv = stage ? s.stageOverrides[stage] : undefined;
    const panelOv = s.panelOverrides[panel];

    if (s.priority !== "auto") {
      const locked = s.priority;
      let model = s.providerDefaultModel[locked] ?? "";
      let source: "stage" | "panel" | "global" = "global";
      if (stageOv && stageOv.provider === locked) {
        model = stageOv.model;
        source = "stage";
      } else if (panelOv && panelOv.provider === locked) {
        model = panelOv.model;
        source = "panel";
      }
      return { provider: locked, model, source, locked: true };
    }

    if (stageOv) {
      return { provider: stageOv.provider, model: stageOv.model, source: "stage", locked: false };
    }
    if (panelOv) {
      return { provider: panelOv.provider, model: panelOv.model, source: "panel", locked: false };
    }
    const fallback = s.order[0] ?? "claude";
    return {
      provider: fallback,
      model: s.providerDefaultModel[fallback] ?? "",
      source: "global",
      locked: false,
    };
  },
}));
