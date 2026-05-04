import {
  invokeWithLlmCheck,
  isMockClaudeMode,
  reportPanelUsage,
  reportPanelChatContext,
} from "./core";
import type { SidecarUsage } from "./workflows";

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
