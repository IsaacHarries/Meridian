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
};

export type WorkflowResume = {
  id: string;
  type: "workflow.resume";
  threadId: string;       // checkpointer thread id from the prior interrupt
  resumeValue: unknown;   // user response that satisfies the interrupt
  /** When present, the sidecar overwrites `state.model` with this before
   *  invoking the graph. Used to keep OAuth tokens fresh on long runs. */
  model?: ModelSelection;
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

export type OutboundEvent =
  | ProgressEvent
  | StreamEvent
  | InterruptEvent
  | ToolCallbackRequest
  | ResultEvent
  | ErrorEvent;
