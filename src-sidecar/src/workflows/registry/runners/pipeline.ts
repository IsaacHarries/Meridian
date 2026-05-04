// Pipeline-style runners — the implementation pipeline (StateGraph with
// interrupts) and the PR review workflow (StateGraph with chunk-aware
// streaming). Both drive a compiled graph and surface mid-run progress
// to the frontend.

import type { ModelSelection } from "../../../protocol.js";
import { makeRepoTools } from "../../../tools/repo-tools.js";
import { buildPipelineGraph } from "../../pipeline.js";
import { PipelineInputSchema } from "../../pipeline/schemas.js";
import { buildPrReviewGraph, PrReviewInputSchema } from "../../pr-review.js";
import { emitFinalOrInterrupt, streamThroughGraph } from "../graph-stream.js";
import type { Emitter } from "../types.js";

// ── Implementation pipeline runner ────────────────────────────────────────────

export async function runImplementationPipeline(args: {
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

// ── PR Review runner ──────────────────────────────────────────────────────────

export async function runPrReview(args: {
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
