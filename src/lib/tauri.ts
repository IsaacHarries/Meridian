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
function panelKeyToAiPanelId(panel: PanelKey): AiPanelId | null {
  switch (panel) {
    case "implement_ticket":
    case "pr_review":
    case "ticket_quality":
    case "sprint_dashboard":
    case "retrospectives":
    case "meetings":
      return panel;
    case "address_pr":
      return "address_pr_comments";
    case "trends":
      return null;
  }
}

/** Resolve the model that workflows on `panel` are currently using.
 *  Returns undefined when the AI selection store hasn't hydrated or
 *  the panel isn't tracked, so callers can skip the per-model bucket
 *  without crashing. */
function currentModelKeyFor(panel: PanelKey): string | undefined {
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
function reportPanelUsage(
  panel: PanelKey,
  usage: { inputTokens?: number; outputTokens?: number } | null | undefined,
): void {
  if (!usage) return;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return;
  useTokenUsageStore
    .getState()
    .addUsage(
      panel,
      { inputTokens, outputTokens },
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
function reportPanelChatContext(
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
async function invokeWithLlmCheck<T>(
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

// ── Credential / config status ────────────────────────────────────────────────

export interface CredentialStatus {
  anthropicApiKey: boolean;
  geminiApiKey: boolean;
  copilotApiKey: boolean;
  localLlmUrl: boolean;
  jiraBaseUrl: boolean;
  jiraEmail: boolean;
  jiraApiToken: boolean;
  jiraBoardId: boolean;
  bitbucketWorkspace: boolean;
  bitbucketEmail: boolean;
  bitbucketAccessToken: boolean;
  bitbucketRepoSlug: boolean;
}

export function credentialStatusComplete(s: CredentialStatus) {
  return (
    s.jiraBaseUrl &&
    s.jiraEmail &&
    s.jiraApiToken &&
    s.jiraBoardId &&
    s.bitbucketWorkspace &&
    s.bitbucketEmail &&
    s.bitbucketAccessToken &&
    s.bitbucketRepoSlug
  );
}

export function anthropicComplete(s: CredentialStatus) {
  return s.anthropicApiKey;
}

/** True when at least one AI provider (Anthropic, Gemini, Copilot, or local LLM) is configured. */
export function aiProviderComplete(s: CredentialStatus) {
  return (
    s.anthropicApiKey || s.geminiApiKey || s.copilotApiKey || s.localLlmUrl
  );
}

/** All three auth credentials are present (board ID not required). */
export function jiraCredentialsSet(s: CredentialStatus) {
  return s.jiraBaseUrl && s.jiraEmail && s.jiraApiToken;
}

/** All three auth credentials are present (repo slug not required). */
export function bitbucketCredentialsSet(s: CredentialStatus) {
  return s.bitbucketWorkspace && s.bitbucketEmail && s.bitbucketAccessToken;
}

/** Fully ready: credentials + board ID configured. */
export function jiraComplete(s: CredentialStatus) {
  return s.jiraBaseUrl && s.jiraEmail && s.jiraApiToken && s.jiraBoardId;
}

/** Fully ready: credentials + repo slug configured. */
export function bitbucketComplete(s: CredentialStatus) {
  return (
    s.bitbucketWorkspace &&
    s.bitbucketEmail &&
    s.bitbucketAccessToken &&
    s.bitbucketRepoSlug
  );
}

// ── Credential commands ───────────────────────────────────────────────────────

export async function getCredentialStatus(): Promise<CredentialStatus> {
  const status = await invoke<CredentialStatus>("credential_status");
  let merged: CredentialStatus = { ...status };
  if (isMockMode()) {
    merged = {
      ...merged,
      jiraBaseUrl: true,
      jiraEmail: true,
      jiraApiToken: true,
      jiraBoardId: true,
      bitbucketWorkspace: true,
      bitbucketEmail: true,
      bitbucketAccessToken: true,
      bitbucketRepoSlug: true,
    };
  }
  if (isMockClaudeMode()) {
    merged = {
      ...merged,
      anthropicApiKey: true,
    };
  }
  return merged;
}

export async function saveCredential(
  key: string,
  value: string,
): Promise<void> {
  return invoke("save_credential", { key, value });
}

export async function deleteCredential(key: string): Promise<void> {
  return invoke("delete_credential", { key });
}

/** Returns non-secret stored config values (URLs, email, workspace slug) for UI display. */
export async function getNonSecretConfig(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_non_secret_config");
}

// ── Validation commands ───────────────────────────────────────────────────────

export async function validateAnthropic(apiKey: string): Promise<string> {
  return invoke<string>("validate_anthropic", { apiKey });
}

export async function validateJira(
  baseUrl: string,
  email: string,
  apiToken: string,
): Promise<string> {
  return invoke<string>("validate_jira", { baseUrl, email, apiToken });
}

export async function validateBitbucket(
  workspace: string,
  email: string,
  accessToken: string,
): Promise<string> {
  return invoke<string>("validate_bitbucket", {
    workspace,
    email,
    accessToken,
  });
}

/** Test the stored Anthropic key without passing it through the frontend. */
export async function testAnthropicStored(): Promise<string> {
  return invoke<string>("test_anthropic_stored");
}

/** Send a real "hello" message to Claude and verify a response comes back. */
export async function pingAnthropic(): Promise<string> {
  return invoke<string>("ping_anthropic");
}

/** Send a real "hello" message to Gemini and verify a response comes back. */
export async function pingGemini(): Promise<string> {
  return invoke<string>("ping_gemini");
}

/** Import the Claude Code CLI's OAuth token from the macOS Keychain. */
export async function importClaudeCodeToken(): Promise<string> {
  return invoke<string>("import_claude_code_token");
}

/**
 * Read the Claude Pro / Max OAuth token from the macOS keychain (where Claude Code
 * stores it after `claude /login`) and save it as the Anthropic credential.
 * Opens a browser to claude.ai, completes the OAuth PKCE flow, and stores the
 * resulting tokens. No Claude Code CLI required.
 */
export async function startClaudeOauth(): Promise<string> {
  return invoke<string>("start_claude_oauth");
}

/** Return the list of available Claude models as [id, display_label] pairs. */
export async function getClaudeModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_claude_models");
}

export async function startGeminiOauth(): Promise<string> {
  return invoke<string>("start_gemini_oauth");
}

/** Return the list of available Gemini models as [id, display_label] pairs. */
export async function getGeminiModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_gemini_models");
}

/** Return just the user-added custom Gemini model IDs. */
export async function getCustomGeminiModels(): Promise<string[]> {
  return invoke<string[]>("get_custom_gemini_models");
}

/** Persist a new custom Gemini model ID. Returns the updated custom list. */
export async function addCustomGeminiModel(modelId: string): Promise<string[]> {
  return invoke<string[]>("add_custom_gemini_model", { modelId });
}

/** Remove a user-added custom Gemini model. Returns the updated custom list. */
export async function removeCustomGeminiModel(
  modelId: string,
): Promise<string[]> {
  return invoke<string[]>("remove_custom_gemini_model", { modelId });
}

/**
 * Validate a Gemini API key by making a lightweight models-list request.
 * Saves the key on success; throws on failure.
 */
export async function validateGemini(apiKey: string): Promise<string> {
  return invoke<string>("validate_gemini", { apiKey });
}

/** Test the already-stored Gemini API key without re-saving it. */
export async function testGeminiStored(): Promise<string> {
  return invoke<string>("test_gemini_stored");
}

export async function startCopilotOauth(): Promise<string> {
  return invoke<string>("start_copilot_oauth");
}

export async function getCopilotModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_copilot_models");
}

export async function getCustomCopilotModels(): Promise<string[]> {
  return invoke<string[]>("get_custom_copilot_models");
}

export async function addCustomCopilotModel(
  modelId: string,
): Promise<string[]> {
  return invoke<string[]>("add_custom_copilot_model", { modelId });
}

export async function removeCustomCopilotModel(
  modelId: string,
): Promise<string[]> {
  return invoke<string[]>("remove_custom_copilot_model", { modelId });
}

export async function validateCopilot(apiKey: string): Promise<string> {
  return invoke<string>("validate_copilot", { apiKey });
}

export async function testCopilotStored(): Promise<string> {
  return invoke<string>("test_copilot_stored");
}

export async function pingCopilot(): Promise<string> {
  return invoke<string>("ping_copilot");
}

/**
 * Return the model list from the configured local LLM server.
 * Returns an empty array if no server URL is configured or the server is unreachable.
 */
export async function getLocalModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_local_models");
}

/**
 * Validate a local LLM server URL (and optional API key) by connecting to it.
 * Normalises the URL to end with /v1, saves on success; throws on failure.
 */
export async function validateLocalLlm(
  url: string,
  apiKey: string,
): Promise<string> {
  return invoke<string>("validate_local_llm", { url, apiKey });
}

/** Test the already-stored local LLM server connection without re-saving it. */
export async function testLocalLlmStored(): Promise<string> {
  return invoke<string>("test_local_llm_stored");
}

/** Test the stored JIRA credentials without passing secrets through the frontend. */
export async function testJiraStored(): Promise<string> {
  return invoke<string>("test_jira_stored");
}

/** Test the stored Bitbucket credentials without passing secrets through the frontend. */
export async function testBitbucketStored(): Promise<string> {
  return invoke<string>("test_bitbucket_stored");
}

/** Run a full diagnostic sweep of every JIRA endpoint, returning a plain-text report. */
export async function debugJiraEndpoints(): Promise<string> {
  return invoke<string>("debug_jira_endpoints");
}

// ── Claude commands ───────────────────────────────────────────────────────────

export async function generateSprintRetrospective(
  sprintText: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_SPRINT_RETRO_MARKDOWN } =
      await import("./mockClaudeResponses");
    return MOCK_SPRINT_RETRO_MARKDOWN;
  }
  // Routes through the TypeScript sidecar's `sprint_retrospective` workflow.
  // The sidecar emits a final result with `output: { markdown }`; the Rust
  // bridge wraps that in a WorkflowResult. We pull the markdown back out so
  // existing callers keep their string-returning contract.
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_sprint_retrospective_workflow", { sprintText });
  reportPanelUsage("retrospectives", result?.usage);
  return result?.output?.markdown ?? "";
}

export async function generateWorkloadSuggestions(
  workloadText: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_WORKLOAD_MARKDOWN } = await import("./mockClaudeResponses");
    return MOCK_WORKLOAD_MARKDOWN;
  }
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_workload_suggestions_workflow", {
    workloadText,
  });
  reportPanelUsage("sprint_dashboard", result?.usage);
  return result?.output?.markdown ?? "";
}

/** Multi-turn chat over the current sprint dashboard snapshot. Routes
 *  through the sidecar's `sprint_dashboard_chat` workflow. */
export async function chatSprintDashboard(
  contextText: string,
  historyJson: string,
): Promise<string> {
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_sprint_dashboard_chat_workflow", {
    contextText,
    historyJson,
  });
  reportPanelUsage("sprint_dashboard", result?.usage);
  reportPanelChatContext("sprint_dashboard", result?.usage);
  return result?.output?.markdown ?? "";
}

/**
 * PR Review workflow. Runs a chunk-aware LangGraph in the sidecar — one-pass
 * for small PRs, sequential per-chunk findings + synthesis for large ones.
 * The sidecar validates the final report against the ReviewReport schema and
 * returns it parsed.
 */
export async function runPrReviewWorkflow(
  reviewText: string,
): Promise<{ report: ReviewReport; usage: SidecarUsage }> {
  if (isMockClaudeMode()) {
    const { MOCK_PR_REVIEW_JSON } = await import("./mockClaudeResponses");
    return {
      report: JSON.parse(MOCK_PR_REVIEW_JSON) as ReviewReport,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  const result = await invokeWithLlmCheck<WorkflowResult<ReviewReport>>(
    "run_pr_review_workflow",
    { reviewText },
  );
  return { report: result.output, usage: result.usage };
}

/** Signal the backend to stop an in-progress PR review between chunks. */
export async function cancelReview(): Promise<void> {
  return invoke<void>("cancel_review");
}

// ── Implementation pipeline workflow ──────────────────────────────────────────
//
// The pipeline runs as a single LangGraph workflow in the sidecar with
// `interrupt()` between every agent stage. Frontend dispatches `start` once,
// then on each interrupt either approves (advances to next stage), aborts,
// or — for triage — replies with a chat message.

export interface PipelineInterrupt {
  threadId: string;
  /** Stage name from PIPELINE_STAGES (grooming, impact, triage, ...). */
  reason: string;
  /** The stage's structured output for the user to review. */
  payload: unknown;
}

export interface PipelineWorkflowResult {
  /** Set when the workflow completed normally; pipeline state shape. */
  output: unknown | null;
  /** Set when the workflow paused at a human checkpoint. */
  interrupt: PipelineInterrupt | null;
  usage: SidecarUsage;
}

export type PipelineResumeAction =
  | { action: "approve" }
  | { action: "abort"; reason?: string }
  | { action: "reply"; message: string }
  // Only valid at the `replan` checkpoint — loops back to the plan stage
  // with `planRevisionContext` populated from prior failures.
  | { action: "revise" };

export interface PipelineWorkflowArgs {
  ticketText: string;
  ticketKey: string;
  /** JIRA issue type ("Bug", "Story", "Task", …). Threaded through to
   *  the grooming node so the bug-specific rules block in the system
   *  prompt is omitted on non-bug tickets — saves ~1k tokens per run
   *  and keeps the cache-prefix tight for the common Story/Task case. */
  ticketType?: string;
  worktreePath: string;
  codebaseContext?: string;
  skills?: {
    grooming?: string | null;
    patterns?: string | null;
    implementation?: string | null;
    review?: string | null;
    testing?: string | null;
  };
  prTemplate?: { body: string; mode: "guide" | "strict" };
  /** Frontend-minted UUID for this run. The sidecar tags every event
   *  with this id so the store can drop stale events from a prior run
   *  the user has cancelled (via retry at an earlier stage). */
  runId?: string;
}

export async function runImplementationPipelineWorkflow(
  args: PipelineWorkflowArgs,
): Promise<PipelineWorkflowResult> {
  return invokeWithLlmCheck<PipelineWorkflowResult>(
    "run_implementation_pipeline_workflow",
    { args },
  );
}

export async function resumeImplementationPipelineWorkflow(
  threadId: string,
  resumeValue: PipelineResumeAction,
  runId?: string,
): Promise<PipelineWorkflowResult> {
  return invokeWithLlmCheck<PipelineWorkflowResult>(
    "resume_implementation_pipeline_workflow",
    { threadId, resumeValue, runId },
  );
}

/**
 * Rewind the workflow to the checkpoint just before `toNode` ran, then
 * resume forward. Used by the per-stage Retry button so the user can
 * re-run a single stage without restarting the whole pipeline.
 */
export async function rewindImplementationPipelineWorkflow(
  threadId: string,
  toNode: string,
  runId?: string,
): Promise<PipelineWorkflowResult> {
  return invokeWithLlmCheck<PipelineWorkflowResult>(
    "rewind_implementation_pipeline_workflow",
    { threadId, toNode, runId },
  );
}

/**
 * Cancel an in-flight implementation pipeline run. Used when the user
 * clicks Retry at an earlier stage — that explicitly invalidates the
 * prior run, so we tell the sidecar to stop emitting its events. The
 * model call may still finish in the background (LangChain providers
 * don't all honour AbortSignal) but the events no longer reach the UI.
 */
export async function cancelImplementationPipelineWorkflow(
  runId: string,
): Promise<void> {
  return invokeWithLlmCheck<void>(
    "cancel_implementation_pipeline_workflow",
    { runId },
  );
}

/** Tauri event payload streamed during pipeline runs. Each event carries
 *  a `runId` matching the originating workflow.start / workflow.resume /
 *  workflow.rewind call so the listener can drop events from runs the
 *  user has explicitly cancelled / superseded. */
export type PipelineEvent =
  | { kind: "progress"; runId: string; node: string; status: "started" | "completed"; data?: unknown }
  | { kind: "stream"; runId: string; node: string; delta: string }
  | { kind: "interrupt"; runId: string; threadId: string; reason: string; payload: unknown };

export const PIPELINE_EVENT_NAME = "implementation-pipeline-event";

// ── Implement-Ticket Orchestrator ─────────────────────────────────────────────
//
// Long-lived chat agent for the implement-ticket pipeline. Each call is one
// user turn; the sidecar persists thread/summaries/notes/proposal state by
// `threadId`. Reply tokens stream through `orchestrator-workflow-event`.

export const ORCHESTRATOR_EVENT_NAME = "orchestrator-workflow-event";

/** A persisted entry in the orchestrator's chat thread. Mirrors the sidecar
 *  `OrchestratorMessageSchema`. The discriminated `kind` lets the UI render
 *  user bubbles, assistant prose, system breadcrumbs, and tool-call rows
 *  distinctly. */
export type OrchestratorMessage =
  | { kind: "user"; content: string; ts: number; stage?: string }
  | { kind: "assistant"; content: string; ts: number; stage?: string }
  | {
      kind: "tool_call";
      name: string;
      args: unknown;
      resultSummary?: string;
      error?: string;
      ts: number;
      stage?: string;
    }
  | { kind: "system_note"; content: string; ts: number; stage?: string };

/** Atomic plan-mutation op the orchestrator can propose as part of an
 *  `edit_plan` proposal. Each is applied in order on accept; the whole
 *  batch fails if any op is invalid (e.g. removing a file not in the plan). */
export type PlanEditOp =
  | {
      op: "add_file";
      file: { path: string; action: "create" | "modify" | "delete"; description: string };
    }
  | { op: "remove_file"; path: string }
  | {
      op: "update_file";
      path: string;
      fields: { action?: "create" | "modify" | "delete"; description?: string };
    }
  | { op: "set_summary"; summary: string }
  | { op: "add_assumption"; text: string }
  | { op: "add_open_question"; text: string };

/** A live proposal the orchestrator has made via a `propose_*` tool that is
 *  awaiting the user's accept/reject decision. The frontend renders a
 *  confirm card; on accept it routes to the appropriate pipeline command or
 *  state-mutation workflow, on reject it just clears. */
export type OrchestratorPendingProposal =
  | {
      kind: "proceed";
      rationale: string;
      action: "approve" | "abort" | "revise";
      reason?: string;
    }
  | { kind: "rewind"; rationale: string; toStage: string }
  | { kind: "reply"; rationale: string; message: string }
  | { kind: "edit_plan"; rationale: string; edits: PlanEditOp[] }
  | {
      kind: "accept_grooming_edit";
      rationale: string;
      editId: string;
      newStatus: "approved" | "declined";
    };

/** Apply a batch of plan-edit ops to the pipeline thread's `state.plan`.
 *  Called from the frontend after the user accepts an `edit_plan` proposal.
 *  The sidecar re-validates each op and rejects the batch if any fails. */
export async function applyPlanEdits(args: {
  pipelineThreadId: string;
  edits: PlanEditOp[];
}): Promise<{ output?: { planFileCount: number } | null }> {
  return invokeWithLlmCheck<{ output?: { planFileCount: number } | null }>(
    "apply_plan_edits",
    {
      pipelineThreadId: args.pipelineThreadId,
      edits: args.edits,
    },
  );
}

/** Result of one orchestrator turn. The full updated state comes back so the
 *  store can replace its slice without a separate fetch. */
export interface OrchestratorTurnOutput {
  threadId: string;
  thread: OrchestratorMessage[];
  stageSummaries: Record<string, string>;
  userNotes: string[];
  currentStage?: string;
  pipelineThreadId?: string;
  pendingProposal?: OrchestratorPendingProposal;
}

export interface OrchestratorTurnResult {
  output: OrchestratorTurnOutput | null;
  interrupt: null;
  usage: SidecarUsage;
}

export interface OrchestratorTurnArgs {
  /** Persistent per-ticket thread id. The frontend should derive it once
   *  (e.g. `orchestrator:${ticketKey}`) and reuse it for every turn. */
  threadId: string;
  /** The sibling implementation-pipeline thread id, if known. Lets the
   *  orchestrator's `get_pipeline_state` tool read live pipeline state. */
  pipelineThreadId?: string;
  /** Text appended to the conversation. For user messages this is the
   *  user's typed input verbatim; for system-injected events (stage
   *  reviews, proposal-resolution notifications) the frontend synthesises
   *  it and tags `messageKind: "system_note"`. */
  message: string;
  messageKind?: "user" | "system_note";
  currentStage?: string;
  /** Optional stage-output rendering supplied by the frontend so the
   *  orchestrator doesn't have to fetch it via `get_pipeline_state`. */
  contextText?: string;
  /** Set after the user accepts/rejects an outstanding proposal so the
   *  next orchestrator turn doesn't see a stale pendingProposal in its
   *  system prompt. */
  clearPendingProposal?: boolean;
  /** Stage names whose compressed summaries are now stale — passed after
   *  a rewind so summaries from later stages don't leak forward. */
  dropSummariesForStages?: string[];
}

/** Send one user turn to the orchestrator. Reply tokens stream live on
 *  `ORCHESTRATOR_EVENT_NAME`; the resolved promise carries the updated
 *  thread + any new pending proposal. */
export async function chatWithOrchestrator(
  args: OrchestratorTurnArgs,
): Promise<OrchestratorTurnResult> {
  // Mock-mode short-circuit: useful for UI dev without a sidecar running.
  // Returns a deterministic single-turn response that echoes the user's
  // input so chat-panel rendering / state-machine flow can be exercised
  // without an LLM call.
  if (isMockClaudeMode()) {
    const ts = Date.now();
    return {
      output: {
        threadId: args.threadId,
        thread: [
          { kind: args.messageKind ?? "user", content: args.message, ts, stage: args.currentStage },
          {
            kind: "assistant",
            content: `(mock) acknowledged: ${args.message.slice(0, 200)}`,
            ts: ts + 1,
            stage: args.currentStage,
          },
        ],
        stageSummaries: {},
        userNotes: [],
        currentStage: args.currentStage,
        pipelineThreadId: args.pipelineThreadId,
      },
      interrupt: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  const result = await invokeWithLlmCheck<OrchestratorTurnResult>(
    "chat_with_orchestrator",
    {
      threadId: args.threadId,
      pipelineThreadId: args.pipelineThreadId,
      message: args.message,
      messageKind: args.messageKind ?? "user",
      currentStage: args.currentStage,
      contextText: args.contextText,
      clearPendingProposal: args.clearPendingProposal ?? false,
      dropSummariesForStages: args.dropSummariesForStages ?? [],
    },
  );
  reportPanelUsage("implement_ticket", result.usage);
  // The orchestrator replays the entire chat thread + stage summaries
  // on every turn, so this call's input-token count IS the panel's
  // current conversation context size.
  reportPanelChatContext("implement_ticket", result.usage);
  return result;
}

/** Conversational follow-up chat about a completed PR review. Streams reply
 *  tokens through the workflow event channel `pr-review-chat-workflow-event`
 *  — subscribers should filter for `kind === "stream"` and read `delta`. */
export async function chatPrReview(
  contextText: string,
  historyJson: string,
): Promise<string> {
  const result = await invokeWithLlmCheck<{
    output?: { reply?: string } | null;
    usage?: SidecarUsage;
  }>("run_pr_review_chat_workflow", {
    contextText,
    historyJson,
  });
  reportPanelUsage("pr_review", result?.usage);
  reportPanelChatContext("pr_review", result?.usage);
  return result?.output?.reply ?? "";
}

// ── PR review report types ────────────────────────────────────────────────────

export interface ReviewFinding {
  severity: "blocking" | "non_blocking" | "nitpick";
  title: string;
  description: string;
  file: string | null;
  line_range: string | null;
}

export interface ReviewLens {
  assessment: string;
  findings: ReviewFinding[];
}

export interface BugTestSteps {
  description: string;
  happy_path: string[];
  sad_path: string[];
}

export interface ReviewReport {
  overall: "approve" | "request_changes" | "needs_discussion";
  summary: string;
  bug_test_steps?: BugTestSteps | null;
  lenses: {
    acceptance_criteria: ReviewLens;
    security: ReviewLens;
    logic: ReviewLens;
    quality: ReviewLens;
    testing: ReviewLens;
  };
}

// ── JIRA types ────────────────────────────────────────────────────────────────

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null;
  goal: string | null;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string | null;
}

export interface DescriptionSection {
  heading: string | null;
  content: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  url: string;
  summary: string;
  description: string | null;
  descriptionSections: DescriptionSection[];
  status: string;
  statusCategory: string;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  issueType: string;
  priority: string | null;
  storyPoints: number | null;
  labels: string[];
  epicKey: string | null;
  epicSummary: string | null;
  created: string;
  updated: string;
  resolutionDate: string | null;
  completedInSprint: boolean | null;
  /** Auto-detected from custom field display name — no configuration required. */
  acceptanceCriteria: string | null;
  stepsToReproduce: string | null;
  observedBehavior: string | null;
  expectedBehavior: string | null;
  /**
   * All non-empty custom fields keyed by human-readable display name.
   * Only populated by get_issue (full detail fetch). Empty for list/sprint fetches.
   */
  namedFields: Record<string, string>;
  /**
   * Mapping of semantic field name → discovered JIRA field ID.
   * e.g. { "acceptance_criteria": "customfield_10034" }
   * Empty when fields were not auto-discovered. Only populated by get_issue.
   */
  discoveredFieldIds: Record<string, string>;
}

// ── JIRA commands ─────────────────────────────────────────────────────────────

export async function getActiveSprint(): Promise<JiraSprint | null> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT } = await import("./mockData");
    return ACTIVE_SPRINT;
  }
  return invoke<JiraSprint | null>("get_active_sprint");
}

export async function getAllActiveSprints(): Promise<JiraSprint[]> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT } = await import("./mockData");
    return ACTIVE_SPRINT ? [ACTIVE_SPRINT] : [];
  }
  return invoke<JiraSprint[]>("get_all_active_sprints");
}

export async function getAllActiveSprintIssues(): Promise<
  Array<[JiraSprint, JiraIssue[]]>
> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT, ACTIVE_SPRINT_2, SPRINT_ISSUES_BY_ID } = await import("./mockData");
    if (!ACTIVE_SPRINT) return [];
    return [
      [ACTIVE_SPRINT, SPRINT_ISSUES_BY_ID[23] ?? []],
      [ACTIVE_SPRINT_2, SPRINT_ISSUES_BY_ID[24] ?? []],
    ];
  }
  return invoke<Array<[JiraSprint, JiraIssue[]]>>(
    "get_all_active_sprint_issues",
  );
}

export async function getActiveSprintIssues(): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("./mockData");
    return SPRINT_ISSUES_BY_ID[23] ?? [];
  }
  return invoke<JiraIssue[]>("get_active_sprint_issues");
}

export async function getMySprintIssues(): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { MY_SPRINT_ISSUES } = await import("./mockData");
    return MY_SPRINT_ISSUES;
  }
  return invoke<JiraIssue[]>("get_my_sprint_issues");
}

export async function getSprintIssues(sprintId: number): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("./mockData");
    return SPRINT_ISSUES_BY_ID[sprintId] ?? [];
  }
  return invoke<JiraIssue[]>("get_sprint_issues", { sprintId });
}

export async function getSprintIssuesById(
  sprintId: number,
  completeDate?: string | null,
): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("./mockData");
    return SPRINT_ISSUES_BY_ID[sprintId] ?? [];
  }
  return invoke<JiraIssue[]>("get_sprint_issues_by_id", { sprintId, completeDate: completeDate ?? null });
}

export async function getIssue(issueKey: string): Promise<JiraIssue> {
  if (isMockMode()) {
    const { ALL_ISSUES_BY_KEY } = await import("./mockData");
    const issue = ALL_ISSUES_BY_KEY[issueKey];
    if (!issue) throw new Error(`Mock: issue ${issueKey} not found`);
    return issue;
  }
  return invoke<JiraIssue>("get_issue", { issueKey });
}

export async function getCompletedSprints(
  limit: number,
): Promise<JiraSprint[]> {
  if (isMockMode()) {
    const { COMPLETED_SPRINTS } = await import("./mockData");
    return COMPLETED_SPRINTS.slice(0, limit);
  }
  return invoke<JiraSprint[]>("get_completed_sprints", { limit });
}

// ── Sprint report disk cache ───────────────────────────────────────────────────

export interface SprintReportCache {
  issues: JiraIssue[];
  prs: BitbucketPr[];
  cachedAt: string;
}

export async function saveSprintReport(
  sprintId: number,
  data: SprintReportCache,
): Promise<void> {
  if (isMockMode()) return;
  return invoke<void>("save_sprint_report", {
    sprintId,
    dataJson: JSON.stringify(data),
  });
}

export async function loadSprintReport(
  sprintId: number,
): Promise<SprintReportCache | null> {
  if (isMockMode()) return null;
  const raw = await invoke<string | null>("load_sprint_report", { sprintId });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SprintReportCache;
  } catch {
    return null;
  }
}

export async function listCachedSprintIds(): Promise<number[]> {
  if (isMockMode()) return [];
  return invoke<number[]>("list_cached_sprint_ids");
}

export async function getSprintReportsDir(): Promise<string> {
  return invoke<string>("get_sprint_reports_dir");
}

// ── Trend analyses (multi-sprint AI) ──────────────────────────────────────────

/** One sprint summary that the trend analysis covered — enough to rehydrate labels in the UI. */
export interface TrendAnalysisSprintRef {
  id: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

export interface AssigneePoints {
  name: string;
  points: number;
}

/** Per-sprint hard stats computed server-side; drives both the AI prompt and the UI charts. */
export interface SprintStats {
  name: string;
  committedPoints: number;
  completedPoints: number;
  velocityPct: number;
  totalIssues: number;
  completedIssues: number;
  completionRatePct: number;
  carryoverCount: number;
  carryoverPct: number;
  bugCount: number;
  storyCount: number;
  taskCount: number;
  otherIssueCount: number;
  blockerCount: number;
  bugStoryRatio: number | null;
  prsTotal: number;
  prsMerged: number;
  avgCycleHours: number | null;
  avgCommentsPerPr: number | null;
  uniquePrAuthors: number;
  assigneeAssignedPoints: AssigneePoints[];
  assigneeCompletedPoints: AssigneePoints[];
}

export interface TrendAnalysisResult {
  markdown: string;
  stats: SprintStats[];
}

export interface TrendAnalysisRecord {
  id: string;
  createdAt: string;
  sprints: TrendAnalysisSprintRef[];
  markdown: string;
  /** Present on records saved after the Rust side started returning stats. */
  stats?: SprintStats[];
}

/** Trimmed-down shape sent to the Rust trend agent (one entry per sprint). */
export interface TrendSprintInput {
  name: string;
  startDate: string | null;
  endDate: string | null;
  goal: string | null;
  issues: TrendIssueInput[];
  /** PRs already filtered to this sprint's window by the caller. */
  prs: TrendPrInput[];
}

export interface TrendIssueInput {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  issueType: string;
  priority: string | null;
  storyPoints: number | null;
  assignee: string | null;
  completedInSprint: boolean | null;
  labels: string[];
}

export interface TrendPrInput {
  id: number;
  title: string;
  state: string;
  author: string | null;
  createdOn: string;
  updatedOn: string;
  /** Hours between createdOn and updatedOn, pre-computed client-side. */
  cycleHours: number | null;
  commentCount: number;
}

export async function generateMultiSprintTrends(
  sprints: TrendSprintInput[],
): Promise<TrendAnalysisResult> {
  if (isMockClaudeMode()) {
    const { MOCK_SPRINT_RETRO_MARKDOWN } = await import("./mockClaudeResponses");
    return { markdown: MOCK_SPRINT_RETRO_MARKDOWN, stats: [] };
  }
  return invokeWithLlmCheck<TrendAnalysisResult>("generate_multi_sprint_trends", {
    sprints,
  });
}

// Trend analyses are one-shot AI outputs (no re-fetch source), so unlike sprint
// reports the storage helpers persist in both mock and real modes. The disk
// is still the real data dir — users can delete unwanted entries via the UI.
export async function saveTrendAnalysis(
  record: TrendAnalysisRecord,
): Promise<void> {
  return invoke<void>("save_trend_analysis", {
    id: record.id,
    dataJson: JSON.stringify(record),
  });
}

export async function loadTrendAnalysis(
  id: string,
): Promise<TrendAnalysisRecord | null> {
  const raw = await invoke<string | null>("load_trend_analysis", { id });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TrendAnalysisRecord;
  } catch {
    return null;
  }
}

export async function listTrendAnalyses(): Promise<string[]> {
  return invoke<string[]>("list_trend_analyses");
}

export async function deleteTrendAnalysis(id: string): Promise<void> {
  return invoke<void>("delete_trend_analysis", { id });
}

export async function getDataDir(): Promise<string> {
  return invoke<string>("get_data_dir");
}

export async function dataDirectoryHasContent(path: string): Promise<boolean> {
  return invoke<boolean>("data_directory_has_content", { path });
}

export async function moveDataDirectory(from: string, to: string): Promise<void> {
  return invoke<void>("move_data_directory", { from, to });
}

export async function relaunchApp(): Promise<void> {
  return invoke<void>("relaunch_app");
}

export async function getAiDebugLogPath(): Promise<string> {
  return invoke<string>("get_ai_debug_log_path_cmd");
}

export async function clearAiDebugLogFile(): Promise<void> {
  return invoke<void>("clear_ai_debug_log_cmd");
}

export async function getFutureSprints(limit: number): Promise<JiraSprint[]> {
  if (isMockMode()) return [];
  return invoke<JiraSprint[]>("get_future_sprints", { limit });
}

export async function searchJiraIssues(
  jql: string,
  maxResults: number,
): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("./mockData");
    const all = SPRINT_ISSUES_BY_ID[23] ?? [];
    const q = jql.toLowerCase();
    const filtered = all.filter(
      (i) =>
        i.summary.toLowerCase().includes(q) ||
        i.key.toLowerCase().includes(q) ||
        i.status.toLowerCase().includes(q),
    );
    return filtered.slice(0, maxResults);
  }
  return invoke<JiraIssue[]>("search_jira_issues", { jql, maxResults });
}

/** Diagnostic: fetch ALL fields for one issue with human-readable names.
 *  Uses ?expand=names so field IDs are mapped to display names without admin access.
 *  Returns custom fields sorted by name, standard fields first. */
export interface RawIssueField {
  id: string;
  name: string;
  value: string;
}

export async function getRawIssueFields(
  issueKey: string,
): Promise<RawIssueField[]> {
  return invoke<RawIssueField[]>("get_raw_issue_fields", { issueKey });
}

export interface JiraFieldMeta {
  id: string;
  name: string;
  fieldType: string | null;
}

/** Fetch all field definitions from the JIRA workspace (id + name + type). */
export async function getJiraFields(): Promise<JiraFieldMeta[]> {
  return invoke<JiraFieldMeta[]>("get_jira_fields");
}

// ── Bitbucket types ───────────────────────────────────────────────────────────

export interface BitbucketUser {
  displayName: string;
  nickname: string;
  accountId: string | null;
}

export interface BitbucketReviewer {
  user: BitbucketUser;
  approved: boolean;
  state: string;
}

export interface BitbucketPr {
  id: number;
  title: string;
  description: string | null;
  state: string;
  author: BitbucketUser;
  reviewers: BitbucketReviewer[];
  sourceBranch: string;
  destinationBranch: string;
  createdOn: string;
  updatedOn: string;
  commentCount: number;
  taskCount: number;
  url: string;
  jiraIssueKey: string | null;
  changesRequested: boolean;
  draft: boolean;
}

export interface BitbucketTask {
  id: number;
  content: string;
  resolved: boolean;
  commentId: number | null;
}

export interface BitbucketInlineContext {
  path: string;
  fromLine: number | null;
  toLine: number | null;
}

export interface BitbucketComment {
  id: number;
  content: string;
  author: BitbucketUser;
  createdOn: string;
  updatedOn: string;
  inline: BitbucketInlineContext | null;
  parentId: number | null;
}

// ── Bitbucket commands ────────────────────────────────────────────────────────

export async function getOpenPrs(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("./mockData");
    return OPEN_PRS;
  }
  return invoke<BitbucketPr[]>("get_open_prs");
}

/** Open PRs authored by the configured Bitbucket user (for the Address PR Comments workflow). */
export async function getMyOpenPrs(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("./mockData");
    return OPEN_PRS;
  }
  return invoke<BitbucketPr[]>("get_my_open_prs");
}

export async function getMergedPrs(sinceIso?: string): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { MERGED_PRS } = await import("./mockData");
    if (sinceIso) {
      const since = new Date(sinceIso).getTime();
      return MERGED_PRS.filter(
        (pr) => new Date(pr.updatedOn).getTime() >= since,
      );
    }
    return MERGED_PRS;
  }
  return invoke<BitbucketPr[]>("get_merged_prs", {
    sinceIso: sinceIso ?? null,
  });
}

export async function getPrsForReview(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("./mockData");
    // PRs where the current user (user-1) is a reviewer and hasn't approved yet
    return OPEN_PRS.filter((pr) =>
      pr.reviewers.some((r) => r.user.nickname === "isaac.chen" && !r.approved),
    );
  }
  return invoke<BitbucketPr[]>("get_prs_for_review");
}

export async function getPr(prId: number): Promise<BitbucketPr> {
  if (isMockMode()) {
    const { OPEN_PRS, MERGED_PRS } = await import("./mockData");
    const pr = [...OPEN_PRS, ...MERGED_PRS].find((p) => p.id === prId);
    if (!pr) throw new Error(`Mock: PR #${prId} not found`);
    return pr;
  }
  return invoke<BitbucketPr>("get_pr", { prId });
}

export async function getPrDiff(prId: number): Promise<string> {
  if (isMockMode()) {
    const { PR_87_DIFF } = await import("./mockData");
    // Return a realistic diff for PR 87; stub for others
    if (prId === 87) return PR_87_DIFF;
    return `diff --git a/src/example.rs b/src/example.rs\nindex 0000000..1234567\n--- a/src/example.rs\n+++ b/src/example.rs\n@@ -1,3 +1,5 @@\n fn main() {\n-    println!("hello");\n+    println!("hello, world");\n+    // PR ${prId} mock diff\n }\n`;
  }
  return invoke<string>("get_pr_diff", { prId });
}

/**
 * Full contents of a file at the PR's source commit — used by the diff viewer
 * to lazy-load surrounding context around the changed hunks.
 */
export async function getPrFileContent(prId: number, path: string): Promise<string> {
  if (isMockMode()) {
    // Return a simple stub so the UI can exercise expansion in mock mode.
    const lines: string[] = [];
    for (let i = 1; i <= 120; i++) lines.push(`// ${path} line ${i} (mock, PR ${prId})`);
    return lines.join("\n");
  }
  return invoke<string>("get_pr_file_content", { prId, path });
}

export async function getPrComments(prId: number): Promise<BitbucketComment[]> {
  if (isMockMode()) {
    const { PR_87_COMMENTS } = await import("./mockData");
    return prId === 87 ? PR_87_COMMENTS : [];
  }
  return invoke<BitbucketComment[]>("get_pr_comments", { prId });
}

export async function getPrTasks(prId: number): Promise<BitbucketTask[]> {
  if (isMockMode()) {
    const { PR_TASKS_BY_ID } = await import("./mockData");
    return PR_TASKS_BY_ID[prId] ?? [];
  }
  return invoke<BitbucketTask[]>("get_pr_tasks", { prId });
}

/** Approve a PR as the authenticated user. Requires pullrequest:write scope. */
export async function approvePr(prId: number): Promise<void> {
  return invoke<void>("approve_pr", { prId });
}

/** Remove your approval from a PR. */
export async function unapprovePr(prId: number): Promise<void> {
  return invoke<void>("unapprove_pr", { prId });
}

/** Mark a PR as 'Needs work' (request changes). */
export async function requestChangesPr(prId: number): Promise<void> {
  return invoke<void>("request_changes_pr", { prId });
}

/** Remove your 'Needs work' status from a PR. */
export async function unrequestChangesPr(prId: number): Promise<void> {
  return invoke<void>("unrequest_changes_pr", { prId });
}

/**
 * Post a comment on a PR.
 * - General comment: omit `inlinePath` / `inlineToLine`.
 * - Inline comment: provide `inlinePath` (file path in the diff) and `inlineToLine` (new-side line number).
 * - Reply: provide `parentId` (the comment id to reply to).
 */
export async function postPrComment(
  prId: number,
  content: string,
  inlinePath?: string,
  inlineToLine?: number,
  parentId?: number,
): Promise<BitbucketComment> {
  return invoke<BitbucketComment>("post_pr_comment", {
    prId,
    content,
    inlinePath: inlinePath ?? null,
    inlineToLine: inlineToLine ?? null,
    parentId: parentId ?? null,
  });
}

/** Create a task linked to a specific comment on a PR. */
export async function createPrTask(
  prId: number,
  commentId: number,
  content: string,
): Promise<BitbucketTask> {
  return invoke<BitbucketTask>("create_pr_task", { prId, commentId, content });
}

export async function resolvePrTask(
  prId: number,
  taskId: number,
  resolved: boolean,
): Promise<BitbucketTask> {
  return invoke<BitbucketTask>("resolve_pr_task", { prId, taskId, resolved });
}

/** Update the text of a task on a PR. */
export async function updatePrTask(
  prId: number,
  taskId: number,
  content: string,
): Promise<BitbucketTask> {
  return invoke<BitbucketTask>("update_pr_task", { prId, taskId, content });
}

export async function deletePrComment(
  prId: number,
  commentId: number,
): Promise<void> {
  return invoke<void>("delete_pr_comment", { prId, commentId });
}

export async function updatePrComment(
  prId: number,
  commentId: number,
  content: string,
): Promise<BitbucketComment> {
  return invoke<BitbucketComment>("update_pr_comment", {
    prId,
    commentId,
    newContent: content,
  });
}

// ── Agent pipeline types ──────────────────────────────────────────────────────

export interface GroomingOutput {
  ticket_summary: string;
  ticket_type: string;
  acceptance_criteria: string[];
  relevant_areas: { area: string; reason: string; files_to_check: string[] }[];
  dependencies: string[];
  estimated_complexity: "low" | "medium" | "high";
  grooming_notes: string;
  suggested_edits: SuggestedEdit[];
  /** Open items the agent surfaces for the engineer to address before
   *  grooming finalises. Covers both literal questions and ambiguous
   *  ticket details (phrased as questions) — they were previously two
   *  separate fields that overlapped in practice. */
  clarifying_questions: string[];
}

export type SuggestedEditField =
  | "description"
  | "acceptance_criteria"
  | "steps_to_reproduce"
  | "observed_behavior"
  | "expected_behavior"
  | "summary";

export type SuggestedEditStatus = "pending" | "approved" | "declined";

export interface SuggestedEdit {
  /** Stable ID used to correlate edits across chat turns */
  id: string;
  field: SuggestedEditField;
  section: string;
  /** The current text in the ticket, or null if this section is missing entirely */
  current: string | null;
  suggested: string;
  reasoning: string;
  /** Client-side status — not returned by the agent */
  status: SuggestedEditStatus;
}

export interface GroomingChatResponse {
  message: string;
  updated_edits: Omit<SuggestedEdit, "status">[];
  updated_questions: string[];
}

/**
 * One assistant turn from the triage agent. Stored alongside `triageHistory`
 * so the middle panel can render `proposal` separately from the chat reply.
 */
export interface TriageTurnOutput {
  /** Short conversational reply for the chat (1–3 sentences). */
  message: string;
  /** Current proposed approach (markdown) — the middle panel headline. */
  proposal: string;
  /** Questions the agent needs the engineer to answer; rendered enumerated in chat. */
  questions: string[];
}

export interface ImpactOutput {
  risk_level: "low" | "medium" | "high";
  risk_justification: string;
  affected_areas: string[];
  potential_regressions: string[];
  cross_cutting_concerns: string[];
  files_needing_consistent_updates: string[];
  recommendations: string;
}

export interface PlanFile {
  path: string;
  action: "create" | "modify" | "delete";
  description: string;
}

export interface ImplementationPlan {
  summary: string;
  files: PlanFile[];
  order_of_operations: string[];
  edge_cases: string[];
  do_not_change: string[];
  assumptions: string[];
  open_questions: string[];
}

export interface GuidanceStep {
  step: number;
  title: string;
  file: string;
  action: string;
  details: string;
  code_hints: string;
}

export interface GuidanceOutput {
  steps: GuidanceStep[];
  patterns_to_follow: string[];
  common_pitfalls: string[];
  definition_of_done: string[];
}

export interface TestFileWritten {
  path: string;
  description: string;
}

export interface TestOutput {
  summary: string;
  files_written: TestFileWritten[];
  edge_cases_covered: string[];
  coverage_notes: string;
}

export interface TestPlanFile {
  path: string;
  framework?: string;
  description: string;
  cases: string[];
}

export interface TestPlan {
  summary: string;
  files: TestPlanFile[];
  edge_cases_covered: string[];
  coverage_notes: string;
}

export interface ImplementationFileResult {
  path: string;
  action: "created" | "modified" | "deleted";
  summary: string;
}

export interface ImplementationOutput {
  summary: string;
  files_changed: ImplementationFileResult[];
  deviations: string[];
  skipped: string[];
}

export interface PlanReviewFinding {
  severity: "blocking" | "non_blocking" | "suggestion";
  area: string;
  feedback: string;
}

export interface PlanReviewOutput {
  confidence: "ready" | "needs_attention" | "requires_rework";
  summary: string;
  findings: PlanReviewFinding[];
  things_to_address: string[];
  things_to_watch: string[];
}

export interface PrDescriptionOutput {
  title: string;
  description: string;
}

export interface RetroSkillSuggestion {
  skill: SkillType;
  suggestion: string;
}

export interface RetrospectiveOutput {
  what_went_well: string[];
  what_could_improve: string[];
  patterns_identified: string[];
  agent_skill_suggestions: RetroSkillSuggestion[];
  summary: string;
}

export interface TriageMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Agent pipeline commands ───────────────────────────────────────────────────

/**
 * Grooming workflow. Runs a LangGraph StateGraph in the sidecar, which
 * validates the model response against the GroomingOutput Zod schema and
 * returns the parsed object directly.
 */
export interface SidecarUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface WorkflowResult<T> {
  output: T;
  usage: SidecarUsage;
}

export async function runGroomingWorkflow(
  ticketText: string,
  fileContents: string,
  ticketType?: string,
): Promise<GroomingOutput> {
  if (isMockClaudeMode()) {
    const { MOCK_GROOMING_JSON } = await import("./mockClaudeResponses");
    return JSON.parse(MOCK_GROOMING_JSON) as GroomingOutput;
  }
  const result = await invokeWithLlmCheck<WorkflowResult<GroomingOutput>>(
    "run_grooming_workflow",
    { ticketText, fileContents, ticketType },
  );
  reportPanelUsage("ticket_quality", result.usage);
  return result.output;
}

/** Phase-1 probe: ask the agent which files to read before full grooming.
 *  Routes through the sidecar's `grooming_file_probe` workflow; the response
 *  is the raw JSON text the model produced, which existing callers parse via
 *  `parseAgentJson`. */
export async function runGroomingFileProbe(
  ticketText: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    return JSON.stringify({ files: [], grep_patterns: [] });
  }
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
  }>("run_grooming_file_probe_workflow", { ticketText });
  return result?.output?.markdown ?? "";
}

/**
 * Grooming conversation turn — returns structured JSON:
 * { message, updated_edits, updated_questions }
 */
export async function runGroomingChatTurn(
  contextText: string,
  historyJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    return JSON.stringify({
      message:
        "I've updated my understanding. The suggested edits reflect the agreed wording. Feel free to ask any more questions or approve the grooming to proceed.",
      updated_edits: [],
      updated_questions: [],
    });
  }
  // Routes through the sidecar's `grooming_chat` workflow, which streams reply
  // tokens to `grooming-chat-workflow-event` and returns the final raw JSON
  // text via `output.reply`. Existing callers parse the JSON with
  // `parseAgentJson` so we keep the string-returning shape.
  const result = await invokeWithLlmCheck<{
    output?: { reply?: string } | null;
    usage?: SidecarUsage;
  }>("run_grooming_chat_workflow", {
    contextText,
    historyJson,
  });
  reportPanelUsage("ticket_quality", result?.usage);
  reportPanelChatContext("ticket_quality", result?.usage);
  return result?.output?.reply ?? "";
}

export async function writeRepoFile(
  path: string,
  content: string,
): Promise<void> {
  return invoke("write_repo_file", { path, content });
}

export interface BuildAttempt {
  attempt: number;
  exit_code: number;
  output: string;
  fixed: boolean;
  files_written: string[];
}

export interface BuildCheckResult {
  build_command: string;
  build_passed: boolean;
  attempts: BuildAttempt[];
}

export type FileVerificationOutcome =
  | "ok"
  | "missing"
  | "empty"
  | "unchanged"
  | "still_present"
  | "read_error";

export interface FileVerification {
  path: string;
  expected_action: "create" | "modify" | "delete";
  outcome: FileVerificationOutcome;
  detail?: string;
}

/** Payload of the `replan` checkpoint interrupt. Surfaces the prior plan and
 *  whatever failure context (verification, build) drove us back here. */
export interface ReplanCheckpointPayload {
  reason: "verification_failed" | "build_failed" | "user_requested";
  verification_failures: FileVerification[];
  build_attempts: BuildAttempt[];
  prior_plan: ImplementationPlan | null;
  previously_written_files: string[];
  revisions_used: number;
  revisions_remaining: number;
}

export async function execInWorktree(
  command: string,
  timeoutSecs?: number,
): Promise<[number, string]> {
  return invoke<[number, string]>("exec_in_worktree", {
    command,
    timeoutSecs,
  });
}

export async function updateJiraIssue(
  issueKey: string,
  summary: string | null,
  description: string,
): Promise<void> {
  return invoke("update_jira_issue", { issueKey, summary, description });
}

/**
 * Update multiple fields on a JIRA issue in a single PUT request.
 * `fieldsJson` is a JSON string mapping JIRA field IDs to plain-text values.
 * e.g. { "summary": "...", "customfield_10034": "..." }
 */
export async function updateJiraFields(
  issueKey: string,
  fieldsJson: string,
): Promise<void> {
  return invoke("update_jira_fields", { issueKey, fieldsJson });
}

// ── Repo / worktree types & commands ─────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch: string;
  headCommit: string;
  headMessage: string;
}

/** Validate the configured worktree path is a valid git repository. */
export async function validateWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_worktree");
}

/**
 * Fetch from origin and hard-reset the worktree to the configured base branch.
 * Returns the new HEAD info.
 */
export async function syncWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("sync_worktree");
}

/** Find files matching a glob pattern (relative to the worktree root). */
export async function globRepoFiles(pattern: string): Promise<string[]> {
  return invoke<string[]>("glob_repo_files", { pattern });
}

/**
 * Search file contents with an extended regex.
 * @param path Optional subdirectory to restrict the search to.
 */
export async function grepRepoFiles(
  pattern: string,
  path?: string,
): Promise<string[]> {
  return invoke<string[]>("grep_repo_files", { pattern, path: path ?? null });
}

/** Read a single file from the worktree (path relative to root). */
export async function readRepoFile(path: string): Promise<string> {
  return invoke<string>("read_repo_file", { path });
}

/** Validate the grooming worktree (falls back to main worktree). */
export async function validateGroomingWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_grooming_worktree");
}

/** Pull latest from origin/<base_branch> in the grooming worktree. */
export async function syncGroomingWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("sync_grooming_worktree");
}

/** Glob files in the grooming worktree (falls back to main worktree). */
export async function globGroomingFiles(pattern: string): Promise<string[]> {
  return invoke<string[]>("glob_grooming_files", { pattern });
}

/** Grep files in the grooming worktree (falls back to main worktree). */
export async function grepGroomingFiles(
  pattern: string,
  path?: string,
): Promise<string[]> {
  return invoke<string[]>("grep_grooming_files", { pattern, path: path ?? null });
}

/** Read a file from the grooming worktree (falls back to main worktree). */
export async function readGroomingFile(path: string): Promise<string> {
  return invoke<string>("read_grooming_file", { path });
}

/** Get the git diff of the worktree against the configured base branch. */
export async function getRepoDiff(): Promise<string> {
  return invoke<string>("get_repo_diff");
}

/** Read a file's content at the merge-base with origin/<base>. Empty string for new files. */
export async function getFileAtBase(path: string): Promise<string> {
  return invoke<string>("get_file_at_base", { path });
}

/** Get recent commits in the worktree. */
export async function getRepoLog(maxCommits: number): Promise<string> {
  return invoke<string>("get_repo_log", { maxCommits });
}

/** Get the git log for a specific file (to understand history). */
export async function getFileHistory(
  path: string,
  maxCommits: number,
): Promise<string> {
  return invoke<string>("get_file_history", { path, maxCommits });
}

/**
 * Check out a branch in the configured worktree (fetch + checkout/reset).
 * Used by the PR Review Assistant before analysis.
 */
export async function checkoutWorktreeBranch(
  branch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("checkout_worktree_branch", { branch });
}

/**
 * Validate the PR review worktree path (falls back to the main worktree if no
 * dedicated PR review path is configured).
 */
export async function validatePrReviewWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_pr_review_worktree");
}

/**
 * Check out a branch in the PR review worktree (fetch + checkout/reset).
 * Uses `pr_review_worktree_path` if set, otherwise falls back to `repo_worktree_path`.
 */
export async function checkoutPrReviewBranch(
  branch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("checkout_pr_review_branch", { branch });
}

/**
 * Open a new macOS Terminal window in the PR review worktree directory and
 * run the supplied shell command. The window stays open so the user can
 * interact with the running process.
 */
export async function runInTerminal(command: string): Promise<void> {
  return invoke<void>("run_in_terminal", { command });
}

// ── PR Address worktree commands ──────────────────────────────────────────────

/**
 * Validate the PR address worktree path.
 * Falls back to pr_review_worktree_path → repo_worktree_path.
 */
export async function validatePrAddressWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_pr_address_worktree");
}

/**
 * Check out a branch in the PR address worktree (fetch + checkout/reset).
 */
export async function checkoutPrAddressBranch(
  branch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("checkout_pr_address_branch", { branch });
}

/** Read a file from the PR address worktree (relative path). */
export async function readPrAddressFile(path: string): Promise<string> {
  return invoke<string>("read_pr_address_file", { path });
}

/**
 * Write a file in the PR address worktree (relative path).
 * Sandboxed to the worktree root.
 */
export async function writePrAddressFile(
  path: string,
  content: string,
): Promise<void> {
  return invoke<void>("write_pr_address_file", { path, content });
}

/** Get the current diff of the PR address worktree (staged + unstaged vs HEAD). */
export async function getPrAddressDiff(): Promise<string> {
  return invoke<string>("get_pr_address_diff");
}

/** Stage all changes and commit in the PR address worktree. Returns the new short SHA. */
export async function commitPrAddressChanges(message: string): Promise<string> {
  return invoke<string>("commit_pr_address_changes", { message });
}

/** Push the current branch of the PR address worktree to origin. */
export async function pushPrAddressBranch(): Promise<void> {
  return invoke<void>("push_pr_address_branch");
}

// ── Implementation pipeline — branch / commit / push / squash ─────────────────

/**
 * Create a feature branch in the implementation worktree for a JIRA ticket.
 * Name: `feature/<issueKey>-<slug-of-summary>`. Branch is checked out off
 * `origin/<base_branch>`. If the branch already exists it is checked out.
 */
export async function createFeatureBranch(
  issueKey: string,
  summary: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("create_feature_branch", { issueKey, summary });
}

/**
 * Stage and commit all current changes in the implementation worktree.
 * Returns the new HEAD short sha, or `null` if there was nothing to commit.
 */
export async function commitWorktreeChanges(
  message: string,
): Promise<string | null> {
  return invoke<string | null>("commit_worktree_changes", { message });
}

/**
 * Squash all commits on the current feature branch since the merge-base with
 * the base branch into a single commit with the given message.
 */
export async function squashWorktreeCommits(message: string): Promise<string> {
  return invoke<string>("squash_worktree_commits", { message });
}

/**
 * Push the current feature branch of the implementation worktree to origin
 * with `--set-upstream`. Returns the branch name that was pushed.
 */
export async function pushWorktreeBranch(): Promise<string> {
  return invoke<string>("push_worktree_branch");
}

/**
 * Create a pull request on Bitbucket. Bitbucket Cloud has no draft API, so
 * Meridian mimics it by creating the PR with no reviewers — nobody gets
 * notified until reviewers are added from the Bitbucket UI.
 */
export async function createPullRequest(
  title: string,
  description: string,
  sourceBranch: string,
  destinationBranch: string,
): Promise<BitbucketPr> {
  return invoke<BitbucketPr>("create_pull_request", {
    title,
    description,
    sourceBranch,
    destinationBranch,
  });
}

// ── Address PR Comments — Claude commands ─────────────────────────────────────

/**
 * Analyse reviewer comments on a PR and produce a structured fix plan.
 * Streams reasoning to the `address-pr-stream` event.
 * Returns a JSON array of fix proposals.
 */
export async function analyzePrComments(reviewText: string): Promise<string> {
  const result = await invoke<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_analyze_pr_comments_workflow", { reviewText });
  reportPanelUsage("address_pr", result?.usage);
  return result?.output?.markdown ?? "";
}

/**
 * Multi-turn chat for the Address PR Comments workflow. Streams reply tokens
 * through the workflow event channel `address-pr-chat-workflow-event` —
 * subscribers should filter for `kind === "stream"` and read `delta`.
 */
export async function chatAddressPr(
  contextText: string,
  historyJson: string,
): Promise<string> {
  const result = await invoke<{
    output?: { reply?: string } | null;
    usage?: SidecarUsage;
  }>("run_address_pr_chat_workflow", { contextText, historyJson });
  reportPanelUsage("address_pr", result?.usage);
  reportPanelChatContext("address_pr", result?.usage);
  return result?.output?.reply ?? "";
}

export type SkillType = "grooming" | "patterns" | "implementation" | "review";

export async function loadAgentSkills(): Promise<Record<SkillType, string>> {
  return invoke<Record<SkillType, string>>("load_agent_skills");
}

export async function saveAgentSkill(
  skillType: SkillType,
  content: string,
): Promise<void> {
  return invoke("save_agent_skill", { skillType, content });
}

export async function deleteAgentSkill(skillType: SkillType): Promise<void> {
  return invoke("delete_agent_skill", { skillType });
}

// ── PR description template ───────────────────────────────────────────────────

/** Mode controlling how strictly the PR Description agent follows the template. */
export type PrTemplateMode = "guide" | "strict";

/** Read the PR description template markdown. Returns "" if not yet set. */
export async function loadPrTemplate(): Promise<string> {
  return invoke<string>("load_pr_template");
}

/** Save the PR description template markdown. Empty content clears it. */
export async function savePrTemplate(content: string): Promise<void> {
  return invoke<void>("save_pr_template", { content });
}

/** Absolute path to the template file on disk (for display in Settings). */
export async function getPrTemplatePath(): Promise<string> {
  return invoke<string>("get_pr_template_path");
}

/** Open the containing folder in the OS file manager. */
export async function revealPrTemplateDir(): Promise<void> {
  return invoke<void>("reveal_pr_template_dir");
}

// ── Grooming format templates ────────────────────────────────────────────────

/** Named grooming format templates. Stored as Markdown files alongside the PR template. */
export type GroomingTemplateKind = "acceptance_criteria" | "steps_to_reproduce";

/** Read a grooming format template. Returns "" if not yet set. */
export async function loadGroomingTemplate(
  kind: GroomingTemplateKind,
): Promise<string> {
  return invoke<string>("load_grooming_template", { kind });
}

/** Save a grooming format template. Empty content clears it. */
export async function saveGroomingTemplate(
  kind: GroomingTemplateKind,
  content: string,
): Promise<void> {
  return invoke<void>("save_grooming_template", { kind, content });
}

/** Absolute path to a grooming template file on disk (for display in Settings). */
export async function getGroomingTemplatePath(
  kind: GroomingTemplateKind,
): Promise<string> {
  return invoke<string>("get_grooming_template_path", { kind });
}

/** Open the templates folder in the OS file manager. */
export async function revealGroomingTemplatesDir(): Promise<void> {
  return invoke<void>("reveal_grooming_templates_dir");
}

export function parseAgentJson<T>(raw: string): T | null {
  // 1. Direct parse
  try { return JSON.parse(raw.trim()) as T; } catch { /* fall through */ }

  // 2. Strip a single ```json ... ``` fence
  try {
    const fenced = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    return JSON.parse(fenced) as T;
  } catch { /* fall through */ }

  // 3. Extract the outermost {...} or [...] block from prose-wrapped responses
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");
  const start =
    firstBrace === -1 ? firstBracket
    : firstBracket === -1 ? firstBrace
    : Math.min(firstBrace, firstBracket);
  if (start !== -1) {
    const opener = raw[start];
    const closer = opener === "{" ? "}" : "]";
    const end = raw.lastIndexOf(closer);
    if (end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)) as T; } catch { /* fall through */ }
    }
  }

  return null;
}

// ── Store cache (file-backed persistence) ─────────────────────────────────────

/**
 * Write a store's serialised JSON to a file in the app data directory.
 * Replaces localStorage — no size limit.
 */
export async function saveStoreCache(key: string, json: string): Promise<void> {
  return invoke("save_store_cache", { key, json });
}

/**
 * Read a previously saved store cache. Returns null if the file doesn't exist yet.
 */
export async function loadStoreCache(key: string): Promise<string | null> {
  return invoke<string | null>("load_store_cache", { key });
}

/**
 * Delete a single store cache file.
 */
export async function deleteStoreCache(key: string): Promise<void> {
  return invoke("delete_store_cache", { key });
}

/**
 * Return the size in bytes of each cache file, keyed by cache key name.
 * Used to display cache usage in Settings.
 */
export async function getStoreCacheInfo(): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("get_store_cache_info");
}

/**
 * Delete all store cache files. This is the "Clear Cache" action.
 */
export async function clearAllStoreCaches(): Promise<void> {
  return invoke("clear_all_store_caches");
}

// ── URL fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch the text content of a URL from the Tauri backend.
 * HTML pages are stripped to plain text. Content is capped at ~100 KB.
 * Throws a string error message on failure.
 */
export async function fetchUrlContent(url: string): Promise<string> {
  return invoke<string>("fetch_url_content", { url });
}

// ── Meetings types ────────────────────────────────────────────────────────────

export interface MicrophoneInfo {
  name: string;
  is_default: boolean;
  sampleRate: number;
  channels: number;
}

export interface WhisperModelStatus {
  id: string;
  downloaded: boolean;
  sizeBytes: number;
}

export interface MeetingSegment {
  startSec: number;
  endSec: number;
  text: string;
  // Populated by the diarization pass. Absent on legacy segments and on
  // meetings that have not been diarized yet.
  speakerId?: string | null;
}

export interface MeetingChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SpeakerCandidate {
  name: string;
  similarity: number;
}

export interface MeetingSpeaker {
  id: string;
  embedding: number[];
  displayName?: string | null;
  candidates?: SpeakerCandidate[];
}

export type MeetingKind = "transcript" | "notes";

export interface PersonSummary {
  name: string;
  summary: string;
  actionItems: string[];
}

export interface MeetingRecord {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  micDeviceName: string;
  model: string;
  tags: string[];
  segments: MeetingSegment[];
  summary: string | null;
  actionItems: string[];
  decisions: string[];
  perPerson: PersonSummary[];
  suggestedTitle: string | null;
  suggestedTags: string[];
  chatHistory: MeetingChatMessage[];
  speakers?: MeetingSpeaker[];
  // `transcript` for live-recorded meetings, `notes` for freeform note-taking.
  // Older on-disk records default to `transcript`.
  kind?: MeetingKind;
  // Freeform notes body for notes-mode meetings. Null/undefined for transcript
  // meetings.
  notes?: string | null;
}

export interface StartMeetingRequest {
  title: string;
  tags: string[];
  micName: string | null;
  modelId: string;
}

export interface StartMeetingResult {
  id: string;
  startedAt: string;
  micDeviceName: string;
  sampleRate: number;
  channels: number;
}

export interface MeetingSummaryJson {
  summary: string;
  actionItems: string[];
  decisions: string[];
  perPerson: PersonSummary[];
  suggestedTitle: string | null;
  suggestedTags: string[];
}

// ── Meetings commands ─────────────────────────────────────────────────────────

export async function listMicrophones(): Promise<MicrophoneInfo[]> {
  return invoke<MicrophoneInfo[]>("list_microphones");
}

export async function listWhisperModels(): Promise<WhisperModelStatus[]> {
  return invoke<WhisperModelStatus[]>("list_whisper_models");
}

export async function downloadWhisperModel(modelId: string): Promise<string> {
  return invoke<string>("download_whisper_model", { modelId });
}

export async function startMeetingRecording(
  req: StartMeetingRequest,
): Promise<StartMeetingResult> {
  return invoke<StartMeetingResult>("start_meeting_recording", { req });
}

export async function pauseMeetingRecording(): Promise<void> {
  return invoke<void>("pause_meeting_recording");
}

export async function resumeMeetingRecording(): Promise<void> {
  return invoke<void>("resume_meeting_recording");
}

export async function stopMeetingRecording(): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("stop_meeting_recording");
}

export async function diarizeMeeting(meetingId: string): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("diarize_meeting", { meetingId });
}

export async function renameMeetingSpeaker(
  meetingId: string,
  speakerId: string,
  displayName: string | null,
): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("rename_meeting_speaker", {
    meetingId,
    speakerId,
    displayName,
  });
}

export async function activeMeetingId(): Promise<string | null> {
  return invoke<string | null>("active_meeting_id");
}

export async function saveMeeting(record: MeetingRecord): Promise<void> {
  return invoke<void>("save_meeting", { record });
}

export async function createNotesMeeting(
  title: string,
  tags: string[],
): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("create_notes_meeting", { title, tags });
}

export async function updateMeetingNotes(
  meetingId: string,
  notes: string,
): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("update_meeting_notes", { meetingId, notes });
}

export async function loadMeeting(id: string): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("load_meeting", { id });
}

export async function listMeetings(): Promise<MeetingRecord[]> {
  return invoke<MeetingRecord[]>("list_meetings");
}

export async function deleteMeeting(id: string): Promise<void> {
  return invoke<void>("delete_meeting", { id });
}

export async function getMeetingsDir(): Promise<string> {
  return invoke<string>("get_meetings_dir");
}

export async function summarizeMeeting(
  transcriptText: string,
  currentTitle: string,
  currentTags: string[],
): Promise<string> {
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_meeting_summary_workflow", {
    transcriptText,
    currentTitle,
    currentTagsJson: JSON.stringify(currentTags),
  });
  reportPanelUsage("meetings", result?.usage);
  return result?.output?.markdown ?? "";
}

export async function generateMeetingTitle(
  contentText: string,
  currentTags: string[],
): Promise<string> {
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_meeting_title_workflow", {
    contentText,
    currentTagsJson: JSON.stringify(currentTags),
  });
  reportPanelUsage("meetings", result?.usage);
  return (result?.output?.markdown ?? "").trim();
}

export async function chatMeeting(
  contextText: string,
  historyJson: string,
): Promise<string> {
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_meeting_chat_workflow", {
    contextText,
    historyJson,
  });
  reportPanelUsage("meetings", result?.usage);
  reportPanelChatContext("meetings", result?.usage);
  return result?.output?.markdown ?? "";
}

// ── Cross-meetings RAG search + chat ─────────────────────────────────────────

/** One hit returned by `searchMeetings`. Mirrors the Rust SegmentHit. */
export interface MeetingSearchHit {
  segmentId: number;
  meetingId: string;
  meetingTitle: string;
  meetingStartedAt: string;
  segmentIdx: number;
  speaker: string | null;
  startMs: number;
  endMs: number;
  text: string;
  matchedKeyword: boolean;
  matchedSemantic: boolean;
  score: number;
}

export interface MeetingSearchResponse {
  hits: MeetingSearchHit[];
  semanticUnavailable: boolean;
  semanticMessage: string | null;
  embeddingModel: string;
}

/** Hybrid keyword + semantic search across every indexed meeting. */
export async function searchMeetings(
  query: string,
  opts?: {
    limit?: number;
    semantic?: boolean;
    /** Minimum fused score (0–1) a hit must clear to be returned.
     *  Filters out the long tail of weakly-similar chunks that
     *  embedding search would otherwise surface as "citations".
     *  Defaults to a sensible value on the Rust side. */
    minScore?: number;
    /** Restrict the search to segments belonging to these meeting ids.
     *  Used by the `#tag` query syntax: the caller resolves tags →
     *  meeting ids client-side, then passes them through so the FTS5 +
     *  cosine queries only consider the right slice of the index. An
     *  empty array yields no results (used to express "this tag has
     *  no meetings"); omit the option entirely to search everything. */
    meetingIds?: string[];
  },
): Promise<MeetingSearchResponse> {
  const raw = await invoke<{
    hits: Array<{
      segment_id: number;
      meeting_id: string;
      meeting_title: string;
      meeting_started_at: string;
      segment_idx: number;
      speaker: string | null;
      start_ms: number;
      end_ms: number;
      text: string;
      matched_keyword: boolean;
      matched_semantic: boolean;
      score: number;
    }>;
    semantic_unavailable: boolean;
    semantic_message: string | null;
    embedding_model: string;
  }>("search_meetings", {
    query,
    limit: opts?.limit,
    semantic: opts?.semantic,
    minScore: opts?.minScore,
    meetingIds: opts?.meetingIds,
  });
  return {
    hits: raw.hits.map((h) => ({
      segmentId: h.segment_id,
      meetingId: h.meeting_id,
      meetingTitle: h.meeting_title,
      meetingStartedAt: h.meeting_started_at,
      segmentIdx: h.segment_idx,
      speaker: h.speaker,
      startMs: h.start_ms,
      endMs: h.end_ms,
      text: h.text,
      matchedKeyword: h.matched_keyword,
      matchedSemantic: h.matched_semantic,
      score: h.score,
    })),
    semanticUnavailable: raw.semantic_unavailable,
    semanticMessage: raw.semantic_message,
    embeddingModel: raw.embedding_model,
  };
}

/** Cross-meetings RAG chat. Pre-pass retrieval lives in Rust; this
 *  wrapper just relays the hits + history to the sidecar workflow. */
export async function chatCrossMeetings(
  hits: MeetingSearchHit[],
  historyJson: string,
  semanticAvailable: boolean,
): Promise<string> {
  // Convert to the snake_case shape the Rust command expects (and
  // which forwards verbatim to the sidecar's Zod schema).
  const contextHits = hits.map((h) => ({
    segmentId: h.segmentId,
    meetingId: h.meetingId,
    meetingTitle: h.meetingTitle,
    meetingStartedAt: h.meetingStartedAt,
    speaker: h.speaker,
    startMs: h.startMs,
    endMs: h.endMs,
    text: h.text,
  }));
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_cross_meetings_chat_workflow", {
    contextHits,
    historyJson,
    semanticAvailable,
  });
  reportPanelUsage("meetings", result?.usage);
  reportPanelChatContext("meetings", result?.usage);
  return result?.output?.markdown ?? "";
}

export interface MeetingsIndexStatus {
  totalSegments: number;
  embeddedSegments: number;
  meetingsIndexed: number;
}

export async function getMeetingsIndexStatus(): Promise<MeetingsIndexStatus> {
  const raw = await invoke<{
    total_segments: number;
    embedded_segments: number;
    meetings_indexed: number;
  }>("meetings_index_status");
  return {
    totalSegments: raw.total_segments,
    embeddedSegments: raw.embedded_segments,
    meetingsIndexed: raw.meetings_indexed,
  };
}

export async function reindexAllMeetings(): Promise<number> {
  return invoke<number>("reindex_all_meetings");
}

export async function clearMeetingsEmbeddings(): Promise<void> {
  return invoke<void>("clear_meetings_embeddings");
}

export type OllamaProbeStatus =
  | "available"
  | "unreachable"
  | "model_missing"
  | "not_configured";

export interface OllamaProbe {
  status: OllamaProbeStatus;
  model: string;
  dimensions: number | null;
  message: string | null;
}

export async function probeOllama(model?: string): Promise<OllamaProbe> {
  return invoke<OllamaProbe>("probe_ollama_cmd", { model });
}

// ── Manual tasks ──────────────────────────────────────────────────────────────

export interface TaskRecord {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  completedAt?: string;
  /** Optional grouping label. Absent / empty = uncategorised. */
  category?: string;
}

export async function listTasks(): Promise<TaskRecord[]> {
  return invoke<TaskRecord[]>("list_tasks");
}

// ── Bitbucket image proxy ─────────────────────────────────────────────────────
//
// Bitbucket-hosted images (PR description / comment attachments, user-content
// URLs) require Basic auth. The Tauri webview can't supply per-request auth
// headers for `<img src>`, so the backend fetches the bytes for us and we
// turn them into a `data:` URI on the frontend.

export interface ProxiedImage {
  contentType: string;
  dataBase64: string;
}

export async function fetchBitbucketImage(url: string): Promise<ProxiedImage> {
  return invoke<ProxiedImage>("fetch_bitbucket_image", { url });
}

/**
 * Same idea for JIRA-hosted attachment URLs (typically
 * `{base_url}/rest/api/3/attachment/content/{id}`). The Tauri backend
 * checks the URL prefix against the configured JIRA base URL and refuses
 * anything outside it.
 */
export async function fetchJiraImage(url: string): Promise<ProxiedImage> {
  return invoke<ProxiedImage>("fetch_jira_image", { url });
}

/**
 * Upload an image as a PR-level attachment via Bitbucket's undocumented
 * `/pullrequests/{id}/attachments` endpoint and return the resulting URL.
 * `dataBase64` is the raw image bytes base64-encoded — the data:URI prefix,
 * if any, must be stripped before calling.
 *
 * Caller is expected to surface failures clearly: this endpoint is
 * undocumented and may reject the request entirely (App Password may lack
 * the right scope, the endpoint shape may have shifted, etc.). Users can
 * flip the "Upload images as Bitbucket attachments" toggle off in Settings
 * to fall back to the data-URI embedding flow.
 */
export async function uploadPrAttachment(
  prId: number,
  filename: string,
  dataBase64: string,
  contentType?: string,
): Promise<string> {
  return invoke<string>("upload_pr_attachment", {
    prId,
    filename,
    dataBase64,
    contentType: contentType ?? null,
  });
}

export async function createTask(
  text: string,
  category?: string | null,
): Promise<TaskRecord> {
  return invoke<TaskRecord>("create_task", {
    text,
    // Tauri unwraps `Option<String>` from `null`/missing equivalently; we
    // always send `null` for "uncategorised" so the wire format stays explicit.
    category: category && category.trim() !== "" ? category.trim() : null,
  });
}

export async function updateTask(record: TaskRecord): Promise<TaskRecord> {
  return invoke<TaskRecord>("update_task", { record });
}

export async function deleteTask(id: string): Promise<void> {
  return invoke<void>("delete_task", { id });
}
