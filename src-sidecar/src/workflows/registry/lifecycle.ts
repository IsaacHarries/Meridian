// Workflow lifecycle entrypoints — runWorkflow / resumeWorkflow /
// rewindWorkflow / cancelWorkflow. These are the four functions
// `src-sidecar/src/index.ts` calls in response to inbound IPC messages.

import { withAiCaptureCtx } from "../../ai-capture.js";
import type {
    WorkflowResume,
    WorkflowRewind,
    WorkflowStart,
} from "../../protocol.js";
import { makeRepoTools } from "../../tools/repo-tools.js";
import { buildPipelineGraph } from "../pipeline.js";
import { emitFinalOrInterrupt, streamThroughGraph } from "./graph-stream.js";
import { workflows } from "./runners/index.js";
import { activeRuns } from "./state.js";
import type { Emitter } from "./types.js";

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
    await withAiCaptureCtx(
      {
        workflowId: msg.id,
        workflowName: msg.workflow,
        emit,
        captureEnabled: !!msg.debug,
      },
      () =>
        runner({
          workflowId: msg.id,
          input: msg.input,
          model: msg.model,
          emit,
          signal: controller.signal,
        }),
    );
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
  return withAiCaptureCtx(
    {
      workflowId: msg.id,
      workflowName: "implementation_pipeline",
      emit,
      captureEnabled: !!msg.debug,
    },
    () => rewindWorkflowInner(msg, emit),
  );
}

async function rewindWorkflowInner(msg: WorkflowRewind, emit: Emitter): Promise<void> {
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
  return withAiCaptureCtx(
    {
      workflowId: msg.id,
      workflowName: "implementation_pipeline",
      emit,
      captureEnabled: !!msg.debug,
    },
    () => resumeWorkflowInner(msg, emit),
  );
}

async function resumeWorkflowInner(msg: WorkflowResume, emit: Emitter): Promise<void> {
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

export function cancelWorkflow(id: string): void {
  const controller = activeRuns.get(id);
  if (controller) {
    controller.abort();
    activeRuns.delete(id);
  }
}
