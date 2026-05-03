// IPC protocol between the Rust backend and the TypeScript sidecar.
//
// All messages are newline-delimited JSON over the sidecar process's
// stdin/stdout. Each inbound message has a string `id` that the sidecar
// echoes back on every related outbound event so Rust can correlate
// concurrent workflow runs.

// ── Provider identity (passed per-request; sidecar never caches) ──────────────

export type Provider = "anthropic" | "google" | "copilot" | "ollama";

export type ProviderCredentials =
  | { provider: "anthropic"; mode: "api_key"; apiKey: string }
  | { provider: "anthropic"; mode: "oauth"; accessToken: string }
  | { provider: "google"; mode: "api_key"; apiKey: string }
  | { provider: "google"; mode: "oauth"; accessToken: string; project?: string }
  | { provider: "copilot"; mode: "oauth"; accessToken: string }
  | { provider: "ollama"; baseUrl: string };

export type ModelSelection = {
  provider: Provider;
  model: string;
  credentials: ProviderCredentials;
};

// ── Inbound messages (Rust → sidecar) ─────────────────────────────────────────

export type WorkflowStart = {
  id: string;
  type: "workflow.start";
  workflow: string; // e.g. "grooming", "pr_review", "implementation_pipeline"
  input: unknown;   // workflow-specific payload, validated by the workflow's Zod schema
  model: ModelSelection;
  worktreePath?: string;
  /** When true, the sidecar attaches an AI-traffic callback to every
   *  model built during this run and emits an `ai_traffic` event for
   *  each round-trip. Off by default — capture is opt-in via a
   *  developer toggle in Settings so prompt JSON doesn't ride the IPC
   *  channel for runs nobody is debugging. */
  debug?: boolean;
};

export type WorkflowResume = {
  id: string;
  type: "workflow.resume";
  threadId: string;       // checkpointer thread id from the prior interrupt
  resumeValue: unknown;   // user response that satisfies the interrupt
  /** When present, the sidecar overwrites `state.model` with this before
   *  invoking the graph. Used to keep OAuth tokens fresh on long runs. */
  model?: ModelSelection;
  /** Same semantics as WorkflowStart.debug — re-supplied on every
   *  resume because each invocation establishes a fresh capture scope. */
  debug?: boolean;
};

export type WorkflowCancel = {
  id: string;
  type: "workflow.cancel";
};

/** Rewind a paused workflow to the checkpoint just before `toNode` ran, then
 *  resume forward. Used by the per-stage Retry UX. */
export type WorkflowRewind = {
  id: string;
  type: "workflow.rewind";
  threadId: string;
  /** Internal node name to rewind to (e.g. "grooming", "impact", "do_plan"). */
  toNode: string;
  /** When present, the sidecar overwrites `state.model` with this before
   *  resuming forward from the checkpoint. */
  model?: ModelSelection;
  /** Mirrors WorkflowStart.debug. */
  debug?: boolean;
};

export type ToolCallbackResponse = {
  id: string;
  type: "tool.callback.response";
  callbackId: string;
  result?: unknown;
  error?: string;
};

export type InboundMessage =
  | WorkflowStart
  | WorkflowResume
  | WorkflowRewind
  | WorkflowCancel
  | ToolCallbackResponse;

// ── Outbound events (sidecar → Rust) ──────────────────────────────────────────

export type ProgressEvent = {
  id: string;
  type: "progress";
  node: string;
  status: "started" | "completed";
  data?: unknown;
};

export type StreamEvent = {
  id: string;
  type: "stream";
  node: string;
  delta: string;
};

export type InterruptEvent = {
  id: string;
  type: "interrupt";
  threadId: string;
  reason: string;
  payload: unknown;
};

export type ToolCallbackRequest = {
  id: string;
  type: "tool.callback.request";
  callbackId: string;
  tool: string;
  input: unknown;
};

export type ResultEvent = {
  id: string;
  type: "result";
  output: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
};

export type ErrorEvent = {
  id: string;
  type: "error";
  message: string;
  cause?: string;
};

/** Snapshot of a single LLM round-trip — request prompt, response text,
 *  per-call usage, latency. Emitted only when AI debug capture is on
 *  (a developer toggle in Settings) so production runs don't pay the
 *  cost of serialising prompts they'll never look at. Forwarded to the
 *  frontend's debug panel for inspection. */
export type AiTrafficEvent = {
  id: string;
  type: "ai_traffic";
  /** Wall-clock milliseconds when the request started. */
  startedAt: number;
  /** Total round-trip latency in ms. */
  latencyMs: number;
  /** Provider + model the request actually hit. Carries the same
   *  shape the workflow received so a debug viewer can show which
   *  model produced each turn. Credentials are scrubbed before this
   *  event leaves the sidecar. */
  provider: string;
  model: string;
  /** Workflow / node identifier — surface in the panel so the user
   *  can see which agent issued the call. */
  workflow: string;
  node?: string;
  /** Serialised messages array sent to the model. Each entry is
   *  `{ role, content }` where content may be string or array of
   *  content blocks. The handler stringifies content blocks so the
   *  frontend doesn't need provider-specific knowledge to render. */
  messages: Array<{ role: string; content: string }>;
  /** Final reply text. May be empty for tool-only turns. */
  response: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Optional error message if the call failed. */
  error?: string;
};

export type OutboundEvent =
  | ProgressEvent
  | StreamEvent
  | InterruptEvent
  | ToolCallbackRequest
  | ResultEvent
  | ErrorEvent
  | AiTrafficEvent;
