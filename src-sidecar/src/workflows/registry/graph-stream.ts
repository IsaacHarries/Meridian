// Helpers shared between the implementation pipeline runner and the
// rewind/resume lifecycle entrypoints. Both need to drive a compiled
// pipeline graph via `streamEvents` (so the frontend sees per-token
// deltas mid-stage) and then translate the resulting checkpoint state
// into either a final `result` event or a synthesised `interrupt`.
import { buildPipelineGraph } from "../pipeline.js";
import type { Emitter } from "./types.js";

/** Pull the relevant per-stage output from the pipeline state. */
export function pickStageOutput(
  values: Record<string, unknown>,
  stage: string,
): unknown {
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

export async function emitFinalOrInterrupt(
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

/**
 * Drive a graph via `streamEvents` so each chat-model token delta and tool
 * call gets emitted to the frontend as it happens. Without this the user
 * sees no progress until the whole stage's interrupt fires (which can be
 * 30+ seconds for tool-loop stages like implementation/test_gen).
 */
export async function streamThroughGraph(
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
