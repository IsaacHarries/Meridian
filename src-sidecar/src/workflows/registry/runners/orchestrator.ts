// Implement-Ticket orchestrator runner + the apply-plan-edits one-shot.
//
// The orchestrator drives one user chat turn against a persistent graph
// (state lives in the SQLite checkpointer keyed by threadId). It also
// detects pipeline-stage transitions and compresses the prior stage's
// chat turns into a summary BEFORE the new turn runs to bound prompt
// growth.

import type { ModelSelection } from "../../../protocol.js";
import { makeRepoTools } from "../../../tools/repo-tools.js";
import { buildOrchestratorGraph } from "../../orchestrator/graph.js";
import { applyPlanEdits } from "../../orchestrator/plan-edits.js";
import {
    ApplyPlanEditsInputSchema,
    OrchestratorInputSchema,
} from "../../orchestrator/schemas.js";
import { maybeCompressStageOnTransition } from "../../orchestrator/summarisation.js";
import type { OrchestratorMessage } from "../../orchestrator/types.js";
import { attachRateLimitForwarding } from "../../streaming.js";
import type { Emitter } from "../types.js";

// ── Implement-Ticket Orchestrator runner ─────────────────────────────────────
//
// Each call corresponds to ONE user chat turn. The orchestrator's persistent
// state (thread, stage summaries, user notes) lives in the SQLite checkpointer
// keyed by `input.threadId`. We invoke the compiled graph with the new
// pendingUserMessage; the chat node consumes it, runs the tool loop, and
// appends both turns to `thread`. Streaming deltas flow live to the frontend
// during the tool loop; the result event fires once the model returns
// without further tool calls.

export async function runImplementTicketOrchestrator(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = OrchestratorInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid implement_ticket_orchestrator input: ${parsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "orchestrator", status: "started" });

  // Bridge Anthropic rate-limit header snapshots → frontend for the
  // duration of this orchestrator run. The orchestrator drives
  // `llmWithTools.stream(messages)` directly (rather than going through
  // streamLLMText / streamLLMJson), so without this the rate-limit
  // bars in the HeaderModelPicker stay empty whenever the user is only
  // chatting through the orchestrator. Detached in the finally below.
  const detachRateLimits = attachRateLimitForwarding(
    emit,
    workflowId,
    "orchestrator",
  );

  const tools = makeRepoTools({ workflowId, emit });
  const graph = buildOrchestratorGraph({ workflowId, model, tools, emit });
  const config = { configurable: { thread_id: parsed.data.threadId } };

  // Detect pipeline-stage transitions and compress the prior stage's chat
  // turns into a summary BEFORE the new turn runs. This bounds prompt
  // growth as the conversation spans many stages: raw turns from a
  // summarised stage are filtered out of the model's context (the chat
  // node reads `stageSummaries` and the tool-loop builder skips matching
  // entries). The persisted `thread` stays lossless — UI still renders
  // every original message.
  let prior:
    | {
        currentStage?: string;
        thread?: OrchestratorMessage[];
        stageSummaries?: Record<string, string>;
      }
    | undefined;
  try {
    const snapshot = await graph.getState(config);
    if (snapshot?.values && Object.keys(snapshot.values).length > 0) {
      prior = snapshot.values as typeof prior;
    }
  } catch {
    // No prior state — first turn on this thread. Nothing to compress.
  }

  if (prior) {
    const compressionUpdate = await maybeCompressStageOnTransition({
      model,
      priorStage: prior.currentStage,
      incomingStage: parsed.data.currentStage ?? undefined,
      thread: prior.thread ?? [],
      existingSummaries: prior.stageSummaries ?? {},
    });
    if (compressionUpdate) {
      emit({
        id: workflowId,
        type: "progress",
        node: "orchestrator",
        status: "started",
        data: {
          phase: "stage_summary",
          stage: prior.currentStage,
        },
      });
      try {
        await graph.updateState(config, compressionUpdate);
      } catch (err) {
        console.error(
          `[orchestrator] failed to write stage summary: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // If the frontend resolved an outstanding proposal (user accepted or
  // rejected the confirm card), clear it BEFORE invoking the graph so the
  // chat node's system prompt doesn't show a stale "outstanding proposal"
  // entry. We do this via updateState because pendingProposal isn't in the
  // turn input shape and its reducer wouldn't accept undefined as a "clear"
  // signal.
  if (parsed.data.clearPendingProposal) {
    try {
      await graph.updateState(config, { pendingProposal: undefined });
    } catch {
      // updateState can fail on a brand-new thread that has no prior state;
      // safe to ignore — the channel default is already undefined.
    }
  }

  // Drop stage summaries the frontend has flagged as stale (typically
  // after a rewind). Writes `undefined` for each key — the orchestrator's
  // stageSummaries reducer treats undefined as a delete signal so the
  // entries are actually removed rather than left behind.
  if (parsed.data.dropSummariesForStages.length > 0) {
    const drop: Record<string, string | undefined> = {};
    for (const stage of parsed.data.dropSummariesForStages) {
      drop[stage] = undefined;
    }
    try {
      await graph.updateState(config, { stageSummaries: drop });
    } catch {
      // Tolerate missing prior state — nothing to drop on a brand-new thread.
    }
  }

  // Per-turn channel updates. Reducers handle the merge:
  //   - thread: append new turns (the chat node returns the new entries)
  //   - pendingUserMessage / pendingContextText / pendingMessageKind: replace
  //   - currentStage / pipelineThreadId: replace if provided
  // Schema is `nullish()` to absorb the JSON-null Rust emits for
  // unset Option<String> fields; coerce null → undefined here so
  // downstream channels (typed string | undefined) don't see nulls.
  const turnInput = {
    pendingUserMessage: parsed.data.message,
    pendingMessageKind: parsed.data.messageKind ?? "user",
    pendingContextText: parsed.data.contextText ?? undefined,
    currentStage: parsed.data.currentStage ?? undefined,
    pipelineThreadId: parsed.data.pipelineThreadId ?? undefined,
  };

  try {
    const finalState = await graph.invoke(turnInput, config);
    emit({
      id: workflowId,
      type: "progress",
      node: "orchestrator",
      status: "completed",
    });
    emit({
      id: workflowId,
      type: "result",
      output: {
        threadId: parsed.data.threadId,
        thread: finalState.thread,
        stageSummaries: finalState.stageSummaries,
        userNotes: finalState.userNotes,
        currentStage: finalState.currentStage,
        pipelineThreadId: finalState.pipelineThreadId,
        pendingProposal: finalState.pendingProposal,
      },
      usage: {
        inputTokens: finalState.usage?.inputTokens ?? 0,
        outputTokens: finalState.usage?.outputTokens ?? 0,
        cacheCreationInputTokens:
          finalState.usage?.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: finalState.usage?.cacheReadInputTokens ?? 0,
      },
    });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    detachRateLimits();
  }
}

// ── Apply Plan Edits runner ──────────────────────────────────────────────────
//
// One-shot mutation workflow. The frontend invokes this when the user
// accepts an orchestrator-proposed plan-edit batch. We apply the ops to the
// pipeline thread's plan via graph.updateState (in orchestrator.ts) and
// emit a single result event with the new plan file count for telemetry.

export async function runApplyPlanEditsWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, emit } = args;

  const parsed = ApplyPlanEditsInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid apply_plan_edits input: ${parsed.error.message}`,
    });
    return;
  }

  emit({
    id: workflowId,
    type: "progress",
    node: "apply_plan_edits",
    status: "started",
  });

  try {
    const out = await applyPlanEdits({
      workflowId,
      emit,
      input: parsed.data,
    });
    emit({
      id: workflowId,
      type: "result",
      output: { planFileCount: out.planFileCount },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
