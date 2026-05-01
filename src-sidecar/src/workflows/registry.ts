// Workflow registry — entrypoints for workflow.start / workflow.resume /
// workflow.cancel inbound messages.
//
// Each entry maps a workflow name to a runner that takes the validated input
// and the model selection, drives the StateGraph to completion, and emits
// progress + result events via the provided emitter.

import type {
  ModelSelection,
  OutboundEvent,
  WorkflowResume,
  WorkflowRewind,
  WorkflowStart,
} from "../protocol.js";
import { z } from "zod";
import { buildGroomingGraph, GroomingInputSchema, type GroomingInput } from "./grooming.js";
import {
  buildPrReviewGraph,
  PrReviewInputSchema,
} from "./pr-review.js";
import { buildPipelineGraph, PipelineInputSchema } from "./pipeline.js";
import {
  runSprintRetrospective,
  SprintRetroInputSchema,
} from "./sprint-retrospective.js";
import {
  runWorkloadSuggestions,
  WorkloadInputSchema,
} from "./workload-suggestions.js";
import {
  runMultiSprintTrends,
  TrendsInputSchema,
} from "./multi-sprint-trends.js";
import {
  runMeetingSummary,
  MeetingSummaryInputSchema,
} from "./meeting-summary.js";
import {
  runMeetingTitle,
  MeetingTitleInputSchema,
} from "./meeting-title.js";
import {
  runSprintDashboardChat,
  SprintDashboardChatInputSchema,
} from "./sprint-dashboard-chat.js";
import {
  runMeetingChat,
  MeetingChatInputSchema,
} from "./meeting-chat.js";
import {
  runAnalyzePrComments,
  AnalyzePrCommentsInputSchema,
} from "./analyze-pr-comments.js";
import { runStreamingChatWithTools } from "./chat-with-tools.js";
import {
  PrReviewChatInputSchema,
  PrReviewChatHistorySchema,
  buildPrReviewChatSystemPrompt,
} from "./pr-review-chat.js";
import {
  AddressPrChatInputSchema,
  AddressPrChatHistorySchema,
  buildAddressPrChatSystemPrompt,
} from "./address-pr-chat.js";
import {
  GroomingChatInputSchema,
  GroomingChatHistorySchema,
  buildGroomingChatSystemPrompt,
} from "./grooming-chat.js";
import {
  OrchestratorInputSchema,
  buildOrchestratorGraph,
  maybeCompressStageOnTransition,
  applyPlanEdits,
  ApplyPlanEditsInputSchema,
  type OrchestratorMessage,
} from "./orchestrator.js";
import {
  runGroomingFileProbe,
  GroomingFileProbeInputSchema,
} from "./grooming-file-probe.js";
import { makeRepoTools } from "../tools/repo-tools.js";

export type Emitter = (event: OutboundEvent) => void;

const activeRuns = new Map<string, AbortController>();

type WorkflowRunner = (args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}) => Promise<void>;

const workflows: Record<string, WorkflowRunner> = {
  grooming: runGrooming,
  pr_review: runPrReview,
  implementation_pipeline: runImplementationPipeline,
  sprint_retrospective: runSprintRetrospectiveWorkflow,
  workload_suggestions: runWorkloadSuggestionsWorkflow,
  multi_sprint_trends: runMultiSprintTrendsWorkflow,
  meeting_summary: runMeetingSummaryWorkflow,
  meeting_title: runMeetingTitleWorkflow,
  sprint_dashboard_chat: runSprintDashboardChatWorkflow,
  meeting_chat: runMeetingChatWorkflow,
  analyze_pr_comments: runAnalyzePrCommentsWorkflow,
  pr_review_chat: runPrReviewChatWorkflow,
  address_pr_chat: runAddressPrChatWorkflow,
  grooming_chat: runGroomingChatWorkflow,
  implement_ticket_orchestrator: runImplementTicketOrchestrator,
  apply_plan_edits: runApplyPlanEditsWorkflow,
  grooming_file_probe: runGroomingFileProbeWorkflow,
};

export async function runWorkflow(msg: WorkflowStart, emit: Emitter): Promise<void> {
  const runner = workflows[msg.workflow];
  if (!runner) {
    emit({
      id: msg.id,
      type: "error",
      message: `Unknown workflow: ${msg.workflow}`,
    });
    return;
  }

  const controller = new AbortController();
  activeRuns.set(msg.id, controller);

  try {
    await runner({
      workflowId: msg.id,
      input: msg.input,
      model: msg.model,
      emit,
      signal: controller.signal,
    });
  } catch (err) {
    emit({
      id: msg.id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    activeRuns.delete(msg.id);
  }
}

/**
 * Rewind a paused workflow to the checkpoint just before `toNode` ran, then
 * resume forward. Used by the per-stage Retry UX so the user can re-run a
 * single stage without restarting the whole pipeline.
 */
export async function rewindWorkflow(msg: WorkflowRewind, emit: Emitter): Promise<void> {
  const tools = makeRepoTools({ workflowId: msg.id, emit });
  const graph = buildPipelineGraph({ tools, workflowId: msg.id, emit });
  const currentConfig = { configurable: { thread_id: msg.threadId } };

  // Walk the checkpoint history newest → oldest looking for the most recent
  // state where `next` was about to enter `toNode`. That checkpoint's `config`
  // (which carries a checkpoint_id) is what we resume from — the workflow
  // re-runs `toNode` and everything downstream onto a new branch in the
  // same thread. We also capture the "prior node" (the node whose write
  // produced this checkpoint) so a subsequent updateState can disambiguate.
  let targetConfig:
    | { configurable: { thread_id: string; checkpoint_id?: string } }
    | null = null;
  let priorNode: string | undefined;
  try {
    for await (const state of graph.getStateHistory(currentConfig)) {
      const next = (state.next ?? []) as readonly string[];
      if (next.includes(msg.toNode)) {
        targetConfig = state.config as unknown as typeof targetConfig;
        const writes = (
          state.metadata as { writes?: Record<string, unknown> } | undefined
        )?.writes;
        if (writes) {
          priorNode = Object.keys(writes)[0];
        }
        break;
      }
    }
  } catch (err) {
    emit({
      id: msg.id,
      type: "error",
      message: `Failed to read checkpoint history: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  if (!targetConfig) {
    emit({
      id: msg.id,
      type: "error",
      message: `No checkpoint found before node "${msg.toNode}" — cannot rewind.`,
    });
    return;
  }

  // Best-effort: try to overwrite `state.model` in the persisted checkpoint
  // so all downstream nodes see the freshly-refreshed credentials. LangGraph
  // requires `asNode` to disambiguate (model has no reducer; default replace)
  // and the right node to attribute the write to depends on the checkpoint
  // shape. If updateState rejects, that's fine: the implementation node
  // performs its own per-file IPC refresh, and other tool-loop nodes that
  // outlive a token will be added to the same pattern.
  if (msg.model && priorNode) {
    try {
      await graph.updateState(targetConfig, { model: msg.model }, priorNode);
    } catch {
      /* per-node refresh is the authoritative path */
    }
  }

  try {
    // Stream from the historical checkpoint config — LangGraph forks the
    // thread at that checkpoint and runs forward. Same fall-back as resume:
    // streamEvents can choke on multi-call tool-loop nodes; plain invoke
    // always works.
    try {
      await streamThroughGraph(graph, null, targetConfig, msg.id, emit);
    } catch (innerErr) {
      const m = innerErr instanceof Error ? innerErr.message : String(innerErr);
      if (
        m.includes("Ambiguous") ||
        m.includes("asNode") ||
        m.includes("Streaming not yet implemented") ||
        m.includes("Streaming not")
      ) {
        console.error(
          `[pipeline-runner] streamEvents rewind failed (${m}); retrying with plain invoke`,
        );
        await graph.invoke(null, targetConfig);
      } else {
        throw innerErr;
      }
    }

    const latestConfig = { configurable: { thread_id: msg.threadId } };
    await emitFinalOrInterrupt(graph, latestConfig, msg.id, emit);
  } catch (err) {
    emit({
      id: msg.id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function resumeWorkflow(msg: WorkflowResume, emit: Emitter): Promise<void> {
  // The implementation pipeline is the only workflow that interrupts. Resume
  // by re-invoking the compiled graph with a Command({resume: ...}) and the
  // saved thread_id; the SQLite checkpointer rehydrates the prior state.
  // Tools are recreated each resume so they capture the current emit/id.
  const { Command } = await import("@langchain/langgraph");
  const tools = makeRepoTools({ workflowId: msg.id, emit });
  const graph = buildPipelineGraph({ tools, workflowId: msg.id, emit });
  const config = { configurable: { thread_id: msg.threadId } };

  // Best-effort: try to overwrite `state.model` in the persisted checkpoint
  // so all downstream nodes see the freshly-refreshed credentials. LangGraph
  // requires `asNode` to disambiguate (model has no reducer; default replace).
  // If updateState rejects, that's fine: the implementation node performs its
  // own per-file IPC refresh, and other tool-loop nodes can be added to the
  // same pattern.
  if (msg.model) {
    try {
      const snapshot = await graph.getState(config);
      const writes = (
        snapshot.metadata as { writes?: Record<string, unknown> } | undefined
      )?.writes;
      const priorNode = writes ? Object.keys(writes)[0] : undefined;
      if (priorNode) {
        await graph.updateState(config, { model: msg.model }, priorNode);
      }
    } catch {
      /* per-node refresh is the authoritative path */
    }
  }

  try {
    // Use streamEvents on the resume so the user sees per-token output of
    // the next stage. Wrap in a try/catch — if streamEvents complains about
    // ambiguity inside a tool-loop node (test_gen / implementation),
    // fall back to plain invoke. We lose live streaming on that fallback
    // path but the workflow still advances.
    try {
      await streamThroughGraph(
        graph,
        new Command({ resume: msg.resumeValue }),
        config,
        msg.id,
        emit,
      );
    } catch (innerErr) {
      const m = innerErr instanceof Error ? innerErr.message : String(innerErr);
      if (
        m.includes("Ambiguous") ||
        m.includes("asNode") ||
        m.includes("Streaming not yet implemented") ||
        m.includes("Streaming not")
      ) {
        console.error(
          `[pipeline-runner] streamEvents resume failed (${m}); retrying with plain invoke`,
        );
        await graph.invoke(new Command({ resume: msg.resumeValue }), config);
      } else {
        throw innerErr;
      }
    }
    await emitFinalOrInterrupt(graph, config, msg.id, emit);
  } catch (err) {
    emit({
      id: msg.id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function emitFinalOrInterrupt(
  graph: ReturnType<typeof buildPipelineGraph>,
  config: { configurable: { thread_id: string } },
  workflowId: string,
  emit: Emitter,
): Promise<void> {
  const snapshot = await graph.getState(config);
  const pendingInterrupts = snapshot.tasks.flatMap((t) => t.interrupts ?? []);
  console.error(
    `[pipeline-runner] state snapshot: tasks=${snapshot.tasks.length} pendingInterrupts=${pendingInterrupts.length} next=${JSON.stringify(snapshot.next)}`,
  );
  if (pendingInterrupts.length > 0) {
    const top = pendingInterrupts[0];
    const payload = (top.value ?? {}) as { stage?: string; payload?: unknown };
    emit({
      id: workflowId,
      type: "interrupt",
      threadId: config.configurable.thread_id,
      reason: payload.stage ?? "checkpoint",
      payload: payload.payload ?? top.value,
    });
    return;
  }
  // No surfaced interrupts via `tasks[].interrupts`. If the graph still has
  // a `next` node it's paused waiting at an interrupt that didn't get picked
  // up by the API we used; emit an interrupt manually with the prior agent's
  // output so the frontend can still render the checkpoint UI.
  if (snapshot.next && snapshot.next.length > 0) {
    const nextNode = snapshot.next[0];
    const stageHint = nextNode.replace(/^checkpoint_/, "");
    const payloadValue = pickStageOutput(snapshot.values, stageHint);
    console.error(
      `[pipeline-runner] no surfaced interrupts but next=${nextNode} — synthesising interrupt for stage=${stageHint}`,
    );
    emit({
      id: workflowId,
      type: "interrupt",
      threadId: config.configurable.thread_id,
      reason: stageHint,
      // Always emit a payload (even if null) so the Rust deserializer's
      // required field is satisfied.
      payload: payloadValue ?? null,
    });
    return;
  }
  // Pipeline finished — emit the final state as the result.
  emit({
    id: workflowId,
    type: "result",
    output: snapshot.values,
    usage: {
      inputTokens: snapshot.values.usage?.inputTokens ?? 0,
      outputTokens: snapshot.values.usage?.outputTokens ?? 0,
    },
  });
}

/** Pull the relevant per-stage output from the pipeline state. */
function pickStageOutput(values: Record<string, unknown>, stage: string): unknown {
  const map: Record<string, string> = {
    grooming: "groomingOutput",
    impact: "impactOutput",
    triage: "triageLastTurn",
    implementation: "implementationOutput",
    test_plan: "testPlan",
    test_gen: "testOutput",
    code_review: "reviewOutput",
    pr_description: "prDescription",
  };
  const key = map[stage];
  return key ? values[key] : undefined;
}

export function cancelWorkflow(id: string): void {
  const controller = activeRuns.get(id);
  if (controller) {
    controller.abort();
    activeRuns.delete(id);
  }
}

// ── Grooming runner ───────────────────────────────────────────────────────────

async function runGrooming(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = GroomingInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid grooming input: ${parsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "analyse", status: "started" });

  const graph = buildGroomingGraph({ emit, workflowId });
  const finalState = await graph.invoke({
    input: parsed.data,
    model,
  });

  emit({ id: workflowId, type: "progress", node: "analyse", status: "completed" });

  if (finalState.parseError) {
    emit({
      id: workflowId,
      type: "error",
      message: `Grooming response failed schema validation: ${finalState.parseError}`,
      cause: finalState.rawResponse,
    });
    return;
  }

  emit({
    id: workflowId,
    type: "result",
    output: finalState.parsedOutput,
    usage: {
      inputTokens: finalState.usage?.inputTokens ?? 0,
      outputTokens: finalState.usage?.outputTokens ?? 0,
    },
  });
}

// ── Single-shot markdown workflow helper ─────────────────────────────────────

/** Shared scaffold for one-shot LLM workflows that return plain markdown
 *  (sprint retrospective, workload suggestions, multi-sprint trends, meeting
 *  summarisation, …). Validates input, emits a started/completed progress
 *  pair around the call, and emits a final `result` event with `output:
 *  { markdown }` so frontends keep a stable shape. */
async function runMarkdownWorkflow<TInput>(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  workflowName: string;
  nodeName: string;
  schema: z.ZodType<TInput>;
  run: (a: {
    input: TInput;
    model: ModelSelection;
    emit?: Emitter;
    workflowId?: string;
    nodeName?: string;
  }) => Promise<{
    markdown: string;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}): Promise<void> {
  const { workflowId, input, model, emit, workflowName, nodeName, schema, run } =
    args;

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid ${workflowName} input: ${parsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: nodeName, status: "started" });

  let result: { markdown: string; usage: { inputTokens: number; outputTokens: number } };
  try {
    result = await run({ input: parsed.data, model, emit, workflowId, nodeName });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: nodeName, status: "completed" });

  emit({
    id: workflowId,
    type: "result",
    output: { markdown: result.markdown },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  });
}

// ── Sprint Retrospective runner ──────────────────────────────────────────────

async function runSprintRetrospectiveWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "sprint_retrospective",
    nodeName: "summarise",
    schema: SprintRetroInputSchema,
    run: runSprintRetrospective,
  });
}

// ── Workload Suggestions runner ──────────────────────────────────────────────

async function runWorkloadSuggestionsWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "workload_suggestions",
    nodeName: "analyse",
    schema: WorkloadInputSchema,
    run: runWorkloadSuggestions,
  });
}

// ── Multi-Sprint Trends runner ───────────────────────────────────────────────

async function runMultiSprintTrendsWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "multi_sprint_trends",
    nodeName: "analyse",
    schema: TrendsInputSchema,
    run: runMultiSprintTrends,
  });
}

// ── Meeting Summary runner ───────────────────────────────────────────────────

async function runMeetingSummaryWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "meeting_summary",
    nodeName: "summarise",
    schema: MeetingSummaryInputSchema,
    run: runMeetingSummary,
  });
}

async function runMeetingTitleWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "meeting_title",
    nodeName: "title",
    schema: MeetingTitleInputSchema,
    run: runMeetingTitle,
  });
}

// ── Sprint Dashboard Chat runner ─────────────────────────────────────────────

async function runSprintDashboardChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "sprint_dashboard_chat",
    nodeName: "reply",
    schema: SprintDashboardChatInputSchema,
    run: runSprintDashboardChat,
  });
}

// ── Meeting Chat runner ──────────────────────────────────────────────────────

async function runMeetingChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "meeting_chat",
    nodeName: "reply",
    schema: MeetingChatInputSchema,
    run: runMeetingChat,
  });
}

// ── Analyze PR Comments runner ───────────────────────────────────────────────

async function runAnalyzePrCommentsWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "analyze_pr_comments",
    nodeName: "analyse",
    schema: AnalyzePrCommentsInputSchema,
    run: runAnalyzePrComments,
  });
}

// ── PR Review Chat runner ────────────────────────────────────────────────────

async function runPrReviewChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = PrReviewChatInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid pr_review_chat input: ${parsed.error.message}`,
    });
    return;
  }
  const historyParsed = PrReviewChatHistorySchema.safeParse(
    JSON.parse(parsed.data.historyJson || "[]"),
  );
  if (!historyParsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid pr_review_chat history: ${historyParsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "started" });

  const tools = makeRepoTools({ workflowId, emit });
  let result: { reply: string; usage: { inputTokens: number; outputTokens: number } };
  try {
    result = await runStreamingChatWithTools({
      workflowId,
      model,
      tools,
      systemPrompt: buildPrReviewChatSystemPrompt(parsed.data),
      history: historyParsed.data,
      emit,
      nodeName: "reply",
    });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "completed" });

  emit({
    id: workflowId,
    type: "result",
    output: { reply: result.reply },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  });
}

// ── Grooming File Probe runner ───────────────────────────────────────────────

async function runGroomingFileProbeWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "grooming_file_probe",
    nodeName: "probe",
    schema: GroomingFileProbeInputSchema,
    run: runGroomingFileProbe,
  });
}

// ── Grooming Chat runner ─────────────────────────────────────────────────────

async function runGroomingChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = GroomingChatInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid grooming_chat input: ${parsed.error.message}`,
    });
    return;
  }
  const historyParsed = GroomingChatHistorySchema.safeParse(
    JSON.parse(parsed.data.historyJson || "[]"),
  );
  if (!historyParsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid grooming_chat history: ${historyParsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "started" });

  const tools = makeRepoTools({ workflowId, emit });
  let result: { reply: string; usage: { inputTokens: number; outputTokens: number } };
  try {
    result = await runStreamingChatWithTools({
      workflowId,
      model,
      tools,
      systemPrompt: buildGroomingChatSystemPrompt(parsed.data),
      history: historyParsed.data,
      emit,
      nodeName: "reply",
    });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "completed" });

  emit({
    id: workflowId,
    type: "result",
    output: { reply: result.reply },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  });
}

// ── Address PR Chat runner ───────────────────────────────────────────────────

async function runAddressPrChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = AddressPrChatInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid address_pr_chat input: ${parsed.error.message}`,
    });
    return;
  }
  const historyParsed = AddressPrChatHistorySchema.safeParse(
    JSON.parse(parsed.data.historyJson || "[]"),
  );
  if (!historyParsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid address_pr_chat history: ${historyParsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "started" });

  const tools = makeRepoTools({ workflowId, emit });
  let result: { reply: string; usage: { inputTokens: number; outputTokens: number } };
  try {
    result = await runStreamingChatWithTools({
      workflowId,
      model,
      tools,
      systemPrompt: buildAddressPrChatSystemPrompt(parsed.data),
      history: historyParsed.data,
      emit,
      nodeName: "reply",
    });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "completed" });

  emit({
    id: workflowId,
    type: "result",
    output: { reply: result.reply },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  });
}

// ── Implementation pipeline runner ────────────────────────────────────────────

async function runImplementationPipeline(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = PipelineInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid implementation_pipeline input: ${parsed.error.message}`,
    });
    return;
  }

  emit({
    id: workflowId,
    type: "progress",
    node: "grooming",
    status: "started",
  });

  const tools = makeRepoTools({ workflowId, emit });
  const graph = buildPipelineGraph({ tools, workflowId, emit });
  const config = { configurable: { thread_id: workflowId } };
  try {
    await streamThroughGraph(graph, { input: parsed.data, model }, config, workflowId, emit);
  } catch (innerErr) {
    const m = innerErr instanceof Error ? innerErr.message : String(innerErr);
    if (
        m.includes("Ambiguous") ||
        m.includes("asNode") ||
        m.includes("Streaming not yet implemented") ||
        m.includes("Streaming not")
      ) {
      console.error(
        `[pipeline-runner] streamEvents start failed (${m}); retrying with plain invoke`,
      );
      await graph.invoke({ input: parsed.data, model }, config);
    } else {
      throw innerErr;
    }
  }
  await emitFinalOrInterrupt(graph, config, workflowId, emit);
}

/**
 * Drive a graph via `streamEvents` so each chat-model token delta and tool
 * call gets emitted to the frontend as it happens. Without this the user
 * sees no progress until the whole stage's interrupt fires (which can be
 * 30+ seconds for tool-loop stages like implementation/test_gen).
 */
async function streamThroughGraph(
  graph: ReturnType<typeof buildPipelineGraph>,
  input: unknown,
  config: { configurable: { thread_id: string } },
  workflowId: string,
  emit: Emitter,
): Promise<void> {
  // The graph builder generates a richly typed input shape; the runner
  // genuinely can't know if it's the initial input, a Command for resume,
  // or null for a rewind. Cast through an explicit `any` rather than try
  // to thread the right union through every call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events = graph.streamEvents(input as any, {
    ...config,
    version: "v2",
  });
  for await (const ev of events) {
    const node =
      (ev.metadata as { langgraph_node?: string } | undefined)?.langgraph_node ?? "";
    if (ev.event === "on_chat_model_stream") {
      const chunk = (ev.data as { chunk?: { content?: unknown } } | undefined)
        ?.chunk;
      const content = chunk?.content;
      let delta = "";
      if (typeof content === "string") {
        delta = content;
      } else if (Array.isArray(content)) {
        delta = content
          .map((b) =>
            typeof b === "string"
              ? b
              : (b as { text?: string } | undefined)?.text ?? "",
          )
          .join("");
      }
      if (delta && node) {
        emit({ id: workflowId, type: "stream", node, delta });
      }
    } else if (ev.event === "on_tool_start") {
      // Surface tool calls as progress events so the UI can render
      // "reading X", "writing Y" lines mid-loop.
      const toolName =
        (ev.data as { input?: unknown } | undefined)?.input &&
        ((ev.data as { input?: { name?: string } }).input?.name ??
          (ev.name as string));
      emit({
        id: workflowId,
        type: "progress",
        node,
        status: "started",
        data: { tool: toolName, input: (ev.data as { input?: unknown })?.input },
      });
    }
  }
}

// ── PR Review runner ──────────────────────────────────────────────────────────

async function runPrReview(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = PrReviewInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid pr_review input: ${parsed.error.message}`,
    });
    return;
  }

  emit({
    id: workflowId,
    type: "progress",
    node: "review",
    status: "started",
  });

  // Stream node-level progress so the UI can show "reviewing chunk N/M" or
  // "synthesising" while the graph runs. The synthesis nodes also emit
  // `progress` events with `data.partialReport` as the JSON streams in, so
  // the UI populates the summary and per-lens cards live rather than
  // appearing all at once at the end.
  const graph = buildPrReviewGraph({ emit, workflowId });
  let finalState: Awaited<ReturnType<typeof graph.invoke>> | undefined;
  for await (const update of await graph.stream(
    { input: parsed.data, model },
    { streamMode: "values" },
  )) {
    finalState = update;
    if (update.mode === "multi_chunk" && update.chunks?.length) {
      const total = update.chunks.length;
      const done = Math.min(update.currentChunk ?? 0, total);
      emit({
        id: workflowId,
        type: "progress",
        node: "chunk_review",
        status: done >= total ? "completed" : "started",
        data: { done, total },
      });
    } else if (update.mode === "single_pass") {
      emit({
        id: workflowId,
        type: "progress",
        node: "single_pass",
        status: "started",
      });
    }
  }

  if (!finalState) {
    emit({
      id: workflowId,
      type: "error",
      message: "PR review workflow ended without producing a state",
    });
    return;
  }

  emit({
    id: workflowId,
    type: "progress",
    node: "synthesis",
    status: "completed",
  });

  if (finalState.parseError) {
    emit({
      id: workflowId,
      type: "error",
      message: `PR review synthesis failed schema validation: ${finalState.parseError}`,
      cause: finalState.rawReport,
    });
    return;
  }

  emit({
    id: workflowId,
    type: "result",
    output: finalState.parsedReport,
    usage: {
      inputTokens: finalState.usage?.inputTokens ?? 0,
      outputTokens: finalState.usage?.outputTokens ?? 0,
    },
  });
}

// ── Implement-Ticket Orchestrator runner ─────────────────────────────────────
//
// Each call corresponds to ONE user chat turn. The orchestrator's persistent
// state (thread, stage summaries, user notes) lives in the SQLite checkpointer
// keyed by `input.threadId`. We invoke the compiled graph with the new
// pendingUserMessage; the chat node consumes it, runs the tool loop, and
// appends both turns to `thread`. Streaming deltas flow live to the frontend
// during the tool loop; the result event fires once the model returns
// without further tool calls.

async function runImplementTicketOrchestrator(args: {
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
      incomingStage: parsed.data.currentStage,
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
  const turnInput = {
    pendingUserMessage: parsed.data.message,
    pendingMessageKind: parsed.data.messageKind ?? "user",
    pendingContextText: parsed.data.contextText,
    currentStage: parsed.data.currentStage,
    pipelineThreadId: parsed.data.pipelineThreadId,
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
      },
    });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Apply Plan Edits runner ──────────────────────────────────────────────────
//
// One-shot mutation workflow. The frontend invokes this when the user
// accepts an orchestrator-proposed plan-edit batch. We apply the ops to the
// pipeline thread's plan via graph.updateState (in orchestrator.ts) and
// emit a single result event with the new plan file count for telemetry.

async function runApplyPlanEditsWorkflow(args: {
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

