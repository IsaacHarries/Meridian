// Grooming runner — wraps the grooming StateGraph and emits its parsed
// structured output.

import type { ModelSelection } from "../../../protocol.js";
import { buildGroomingGraph, GroomingInputSchema } from "../../grooming.js";
import type { Emitter } from "../types.js";

export async function runGrooming(args: {
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
