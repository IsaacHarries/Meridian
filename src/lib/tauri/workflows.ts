import { invoke } from "@tauri-apps/api/core";
import {
  invokeWithLlmCheck,
  isMockClaudeMode,
  reportPanelUsage,
  reportPanelChatContext,
} from "./core";
import type { ReviewReport } from "./pr-review";
import type { SkillType } from "./templates";

// ── Sidecar shared types ──────────────────────────────────────────────────────

export interface SidecarUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt-cache breakdown — subset of `inputTokens` that
   *  was billed at 1.25x because the request wrote them into the cache.
   *  Optional: workflows that don't opt into prompt caching (everything
   *  except the implementation pipeline orchestrator at time of writing)
   *  leave this undefined. Always undefined / 0 for non-Anthropic
   *  providers since they ignore the cache_control marker. */
  cacheCreationInputTokens?: number;
  /** Anthropic prompt-cache breakdown — subset of `inputTokens` that
   *  was billed at 0.1x because the request hit the cache. */
  cacheReadInputTokens?: number;
}

export interface WorkflowResult<T> {
  output: T;
  usage: SidecarUsage;
}

// ── Claude commands ───────────────────────────────────────────────────────────

export async function generateSprintRetrospective(
  sprintText: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_SPRINT_RETRO_MARKDOWN } =
      await import("../mockClaudeResponses");
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
    const { MOCK_WORKLOAD_MARKDOWN } = await import("../mockClaudeResponses");
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
    const { MOCK_PR_REVIEW_JSON } = await import("../mockClaudeResponses");
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
export async function runGroomingWorkflow(
  ticketText: string,
  fileContents: string,
  ticketType?: string,
): Promise<GroomingOutput> {
  if (isMockClaudeMode()) {
    const { MOCK_GROOMING_JSON } = await import("../mockClaudeResponses");
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
