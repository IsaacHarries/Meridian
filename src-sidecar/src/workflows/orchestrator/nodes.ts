// LangGraph chat node for the Implement-Ticket Orchestrator.

import { createHash } from "node:crypto";
import { buildOrchestratorSystem } from "./system-prompt.js";
import { describeProposal, type ProposalCollector } from "./proposal-collector.js";
import { makePipelineControlTools, runOrchestratorToolLoop } from "./tools.js";
import type {
  OrchestratorMessage,
  OrchestratorNodeContext,
  OrchestratorState,
  OrchestratorTools,
} from "./types.js";

export function makeChatNode(ctx: OrchestratorNodeContext) {
  return async function chatNode(
    state: OrchestratorState,
  ): Promise<Partial<OrchestratorState>> {
    const newMsg = state.pendingUserMessage;
    if (!newMsg) {
      // No-op invocation. Could happen if the runner is mistakenly invoked
      // without a message; bail without mutating state.
      return {};
    }

    // Build the combined tool set for THIS turn. Pipeline-control tools
    // close over a fresh proposal collector so we can read the orchestrator's
    // chosen action after the loop terminates without mutating reducer
    // channels mid-loop.
    const proposalCollector: ProposalCollector = { current: undefined };
    const pipelineTools = makePipelineControlTools({
      pipelineThreadId: state.pipelineThreadId,
      proposalCollector,
      hasOpenProposal: !!state.pendingProposal,
    });
    const combinedTools: OrchestratorTools = [
      ...(ctx.tools as unknown as OrchestratorTools),
      ...(pipelineTools as unknown as OrchestratorTools),
    ];

    // Dedup: if the incoming context blob is byte-for-byte the same as
    // the last one we rendered, skip embedding it again. The prior
    // thread already grounds the conversation; the agent can re-read
    // fresh state via `get_pipeline_state` if it needs to verify.
    const incomingHash = state.pendingContextText
      ? createHash("sha256").update(state.pendingContextText).digest("hex")
      : undefined;
    const skipContext =
      !!incomingHash && incomingHash === state.lastContextHash;
    const effectiveContextText = skipContext
      ? undefined
      : state.pendingContextText;

    const systemPrompt = buildOrchestratorSystem({
      currentStage: state.currentStage,
      stageSummaries: state.stageSummaries,
      userNotes: state.userNotes,
      pendingContextText: effectiveContextText,
      pendingProposal: state.pendingProposal,
    });

    const outcome = await runOrchestratorToolLoop({
      workflowId: ctx.workflowId,
      model: ctx.model,
      tools: combinedTools,
      systemPrompt,
      priorThread: state.thread,
      summarisedStages: new Set(Object.keys(state.stageSummaries ?? {})),
      newUserMessage: newMsg,
      emit: ctx.emit,
    });

    const ts = Date.now();
    const messageKind = state.pendingMessageKind ?? "user";
    const stage = state.currentStage; // tag every entry with the active stage
    // Build the new thread entries:
    //   1. The incoming message (user bubble OR system_note, depending on
    //      how the runner tagged it).
    //   2. Each tool call recorded during the loop.
    //   3. A breadcrumb if the model produced a fresh proposal — gives the
    //      UI an inline marker explaining what was just suggested.
    //   4. The final assistant reply.
    const newTurns: OrchestratorMessage[] = [];
    newTurns.push({ kind: messageKind, content: newMsg, ts, stage });
    newTurns.push(
      ...outcome.toolEvents.map((e) => ({ ...e, stage })),
    );
    if (proposalCollector.current) {
      newTurns.push({
        kind: "system_note",
        content: `Proposal: ${describeProposal(proposalCollector.current)}`,
        ts: Date.now(),
        stage,
      });
    }
    newTurns.push({
      kind: "assistant",
      content: outcome.reply,
      ts: Date.now(),
      stage,
    });

    return {
      thread: newTurns,
      pendingUserMessage: undefined,
      pendingContextText: undefined,
      pendingMessageKind: "user",
      // Replace pendingProposal with the new one if the orchestrator created
      // one this turn; otherwise leave whatever was there. (The runner
      // already cleared it pre-invocation if `clearPendingProposal` was set.)
      pendingProposal: proposalCollector.current ?? state.pendingProposal,
      usage: outcome.usage,
      // Remember the hash of the context we actually used so the next
      // turn can decide whether to send the context again.
      lastContextHash: skipContext ? state.lastContextHash : incomingHash,
    };
  };
}
