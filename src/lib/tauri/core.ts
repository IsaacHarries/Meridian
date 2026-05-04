import { invoke } from "@tauri-apps/api/core";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  useTokenUsageStore,
  modelKey,
  type PanelKey,
} from "@/stores/tokenUsageStore";
import {
  useAiSelectionStore,
  type PanelId as AiPanelId,
} from "@/stores/aiSelectionStore";

/** Map a usage-store panel key to the AI-selection-store panel id.
 *  The two enums largely overlap; bridge the few diverging keys here
 *  so attribution to a model is consistent. Returns null for panels
 *  the AI selection store doesn't manage (e.g. `trends`) — those
 *  reports won't be bucketed by model. */
const PANEL_TO_AI: Record<PanelKey, AiPanelId | null> = {
  implement_ticket: "implement_ticket",
  pr_review: "pr_review",
  ticket_quality: "ticket_quality",
  sprint_dashboard: "sprint_dashboard",
  retrospectives: "retrospectives",
  meetings: "meetings",
  address_pr: "address_pr_comments",
  trends: null,
};

function panelKeyToAiPanelId(panel: PanelKey): AiPanelId | null {
  return PANEL_TO_AI[panel];
}

/** Resolve the model that workflows on `panel` are currently using.
 *  Returns undefined when the AI selection store hasn't hydrated or
 *  the panel isn't tracked, so callers can skip the per-model bucket
 *  without crashing. Exported so streaming-event subscribers can pass
 *  the same per-model key when forwarding `usagePartial` events into
 *  tokenUsageStore.setCurrentCallUsage. */
export function currentModelKeyFor(panel: PanelKey): string | undefined {
  try {
    const aiPanel = panelKeyToAiPanelId(panel);
    if (!aiPanel) return undefined;
    const r = useAiSelectionStore.getState().resolve(aiPanel);
    if (!r.model) return undefined;
    return modelKey(r.provider, r.model);
  } catch {
    return undefined;
  }
}

/**
 * Side-effect: report a workflow's token usage into the cross-app
 * accumulator so the panel's TokenUsageBadge stays current. Each
 * workflow wrapper that knows its panel context calls this with the
 * raw `usage` block from the Tauri result. Zero-token results are
 * skipped so panels that haven't seen real spend don't render a 0/0
 * badge. Buckets the same usage into the per-model total so the
 * HeaderModelPicker dropdown can display per-model spend.
 */
export function reportPanelUsage(
  panel: PanelKey,
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      }
    | null
    | undefined,
): void {
  if (!usage) return;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return;
  const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;
  useTokenUsageStore
    .getState()
    .addUsage(
      panel,
      {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
      },
      currentModelKeyFor(panel),
    );
}

/**
 * Side-effect: record this call's input-token count as the panel's
 * "current conversation size". Use ONLY for chat-style workflows
 * whose prompt replays accumulated history (orchestrator, triage,
 * grooming chat, dashboard chat, meeting chat, PR-review chat,
 * address-PR chat). The HeaderModelPicker's context ring on a panel
 * with a chat thread reads this so the user can see the running
 * thread's size and decide whether to compress.
 */
export function reportPanelChatContext(
  panel: PanelKey,
  usage: { inputTokens?: number } | null | undefined,
): void {
  if (!usage) return;
  const inputTokens = usage.inputTokens ?? 0;
  if (inputTokens <= 0) return;
  useTokenUsageStore.getState().setPanelChatLastInput(panel, inputTokens);
}

// ── Local LLM error detection ─────────────────────────────────────────────────

/**
 * Returns true when an error string looks like the local LLM server is not
 * reachable (i.e. Ollama is not running).
 */
function isLocalLlmConnectionError(err: string): boolean {
  const e = err.toLowerCase();
  return (
    e.includes("could not connect to local llm") ||
    e.includes("make sure ollama") ||
    e.includes("make sure lm studio") ||
    (e.includes("local llm") &&
      (e.includes("connect") || e.includes("reach") || e.includes("refused")))
  );
}

/**
 * Detect which local LLM URL is configured so we can include it in the toast.
 * We read it from the credential store key that `local_llm_url` was saved under.
 * Falls back to "localhost:11434" if unknown.
 */
let _cachedLocalLlmUrl: string | null = null;
export function setLocalLlmUrlCache(url: string) {
  _cachedLocalLlmUrl = url;
}

/**
 * Show a persistent toast explaining that the Ollama server is not running,
 * including the command needed to start it.
 */
function showLocalLlmDownToast(_err: string) {
  const urlHint = _cachedLocalLlmUrl ?? "http://localhost:11434";
  // Determine whether this looks like an Ollama URL vs LM Studio etc.
  const isOllama =
    urlHint.includes("11434") ||
    urlHint.includes("ollama") ||
    !urlHint.includes("1234");

  const startCmd = isOllama
    ? "ollama serve"
    : "Start LM Studio and enable the local server";
  const description = isOllama
    ? `Could not connect to ${urlHint}. Start the server with: ${startCmd}`
    : `Could not connect to ${urlHint}. ${startCmd}.`;

  toast.error("Local LLM server is not running", {
    description,
    duration: 12_000,
    id: "local-llm-down", // deduplicate — only show once at a time
  });
}

/**
 * Wrapper around invoke that automatically detects local-LLM-server-down errors
 * and shows a helpful toast. Re-throws the error so callers still see it.
 */
export async function invokeWithLlmCheck<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = String(e);
    if (isLocalLlmConnectionError(err)) {
      showLocalLlmDownToast(err);
    }
    throw e;
  }
}

/**
 * Open a URL in the user's default system browser.
 * Must be used instead of window.open() — Tauri's webview does not handle
 * window.open or <a target="_blank"> the way a browser does.
 */
export function openUrl(url: string): void {
  tauriOpenUrl(url).catch((e) => console.error("Failed to open URL:", url, e));
}

// ── Mock mode ─────────────────────────────────────────────────────────────────
// When enabled, all JIRA and Bitbucket commands return local mock data.
// Claude / agent calls still hit the API unless Mock AI responses is enabled.

const MOCK_KEY = "meridian_mock_mode";
const MOCK_CLAUDE_KEY = "meridian_mock_claude_mode";

export function isMockMode(): boolean {
  return localStorage.getItem(MOCK_KEY) === "true";
}

export function setMockMode(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(MOCK_KEY, "true");
  } else {
    localStorage.removeItem(MOCK_KEY);
  }
}

/** When true, agent and briefing commands return canned text/JSON (no Anthropic call). */
export function isMockClaudeMode(): boolean {
  return localStorage.getItem(MOCK_CLAUDE_KEY) === "true";
}

export function setMockClaudeMode(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(MOCK_CLAUDE_KEY, "true");
  } else {
    localStorage.removeItem(MOCK_CLAUDE_KEY);
  }
}
