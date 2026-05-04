// Plan-edit application for the Implement-Ticket Orchestrator.
//
// When the user accepts an `edit_plan` proposal, the frontend calls into a
// dedicated sidecar workflow (registered as `apply_plan_edits`) that
// rehydrates the pipeline graph for the given thread, applies the ops to
// `state.plan`, and writes the result back via `graph.updateState`. We do
// NOT mutate plan from the orchestrator workflow itself — keeping the
// sibling pipeline as the only writer of pipeline state simplifies
// reasoning and avoids cross-thread races.

import type { OutboundEvent } from "../../protocol.js";
import { makeRepoTools } from "../../tools/repo-tools.js";
import { buildPipelineGraph } from "../pipeline.js";
import type { ApplyPlanEditsInput, PlanEditOp, PlanShape } from "./types.js";

/** Apply one op to the plan, returning the new plan or throwing on a
 *  semantic violation (e.g. removing a file that isn't in the plan). */
export function applyPlanEditOp(plan: PlanShape, op: PlanEditOp): PlanShape {
  if (op.op === "set_summary") {
    return { ...plan, summary: op.summary };
  }
  if (op.op === "add_file") {
    if (plan.files.some((f) => f.path === op.file.path)) {
      throw new Error(`add_file refused: '${op.file.path}' is already in the plan`);
    }
    return { ...plan, files: [...plan.files, op.file] };
  }
  if (op.op === "remove_file") {
    if (!plan.files.some((f) => f.path === op.path)) {
      throw new Error(`remove_file refused: '${op.path}' is not in the plan`);
    }
    return { ...plan, files: plan.files.filter((f) => f.path !== op.path) };
  }
  if (op.op === "update_file") {
    const idx = plan.files.findIndex((f) => f.path === op.path);
    if (idx < 0) {
      throw new Error(`update_file refused: '${op.path}' is not in the plan`);
    }
    const next = [...plan.files];
    next[idx] = {
      ...next[idx],
      ...(op.fields.action !== undefined ? { action: op.fields.action } : {}),
      ...(op.fields.description !== undefined
        ? { description: op.fields.description }
        : {}),
    };
    return { ...plan, files: next };
  }
  if (op.op === "add_assumption") {
    return { ...plan, assumptions: [...plan.assumptions, op.text] };
  }
  if (op.op === "add_open_question") {
    return { ...plan, open_questions: [...plan.open_questions, op.text] };
  }
  // Should be unreachable thanks to the discriminated union.
  return plan;
}

/** Apply the proposed edits to the pipeline thread's plan. Reads current
 *  state via the checkpointer, threads each op through `applyPlanEditOp`,
 *  and writes the resulting plan back via `graph.updateState`. Throws if
 *  the thread has no plan yet (orchestrator should have called
 *  `get_pipeline_state` first to verify). */
export async function applyPlanEdits(args: {
  workflowId: string;
  emit: (e: OutboundEvent) => void;
  input: ApplyPlanEditsInput;
}): Promise<{ planFileCount: number }> {
  const { workflowId, emit, input } = args;

  const noopEmit = () => undefined;
  const tools = makeRepoTools({ workflowId: "apply-plan-readonly", emit: noopEmit });
  const graph = buildPipelineGraph({
    tools,
    workflowId: "apply-plan-readonly",
    emit: noopEmit,
  });
  const config = { configurable: { thread_id: input.pipelineThreadId } };

  const snapshot = await graph.getState(config);
  const values = snapshot?.values as { plan?: PlanShape } | undefined;
  if (!values?.plan) {
    throw new Error(
      "apply_plan_edits: pipeline thread has no plan in state — nothing to edit.",
    );
  }

  let plan: PlanShape = values.plan;
  for (const op of input.edits) {
    plan = applyPlanEditOp(plan, op);
  }

  await graph.updateState(config, { plan });

  emit({
    id: workflowId,
    type: "progress",
    node: "apply_plan_edits",
    status: "completed",
    data: { opCount: input.edits.length, planFileCount: plan.files.length },
  });

  return { planFileCount: plan.files.length };
}
