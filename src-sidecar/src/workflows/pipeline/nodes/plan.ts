import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildModel } from "../../../models/factory.js";
import {
  ImplementationPlanSchema,
  type PipelineStage,
} from "../../pipeline-schemas.js";
import { buildPlanSystem } from "../../pipeline-prompts.js";
import { buildContextText, streamAndParse } from "../helpers.js";
import type { PipelineGraphContext, PipelineState } from "../state.js";

export function makePlanNode(ctx: PipelineGraphContext) {
  return async function planNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const model = buildModel(state.model);
    const contextText = buildContextText(state);
    const system = buildPlanSystem(contextText);
    const conversation = JSON.stringify(state.triageHistory, null, 2);

    // When `planRevisionContext` is populated, this is a re-plan triggered by
    // `replan_check` after the prior plan failed verification or build. Prepend
    // a REVISE preamble so the model produces a *revised* plan rather than
    // regenerating from scratch with no awareness of what already failed.
    const revision = state.planRevisionContext;
    const revisionPreamble = revision
      ? `=== PLAN REVISION REQUIRED (revision #${state.planRevisions + 1}) ===\n` +
        `Reason: ${revision.reason}\n\n` +
        `Prior plan that failed:\n${JSON.stringify(revision.prior_plan, null, 2)}\n\n` +
        (revision.verification_failures.length
          ? `Per-file verification failures (these files did not end up in the expected state on disk):\n${JSON.stringify(revision.verification_failures, null, 2)}\n\n`
          : "") +
        (revision.build_attempts.length
          ? `Build attempt history (most recent last):\n${JSON.stringify(revision.build_attempts, null, 2)}\n\n`
          : "") +
        `Produce a REVISED plan that addresses the failure mode above. ` +
        `If a different file set or different approach is needed, say so. ` +
        `Note: any partially-written files from the prior plan are still on disk — call out files that should be reverted in the plan summary.\n\n`
      : "";

    const user = `${revisionPreamble}Triage conversation:\n${conversation}`;
    const { parsed, usage } = await streamAndParse({
      ctx,
      nodeName: "do_plan",
      model,
      messages: [new SystemMessage(system), new HumanMessage(user)],
      schema: ImplementationPlanSchema,
    });

    // Clear revision context + prior failure state so the next implementation
    // pass starts clean. `planRevisions` is incremented so the routing edges
    // can cap runaway loops.
    const updates: Partial<PipelineState> = {
      plan: parsed,
      currentStage: "implementation" as PipelineStage,
      usage,
    };
    if (revision) {
      updates.planRevisions = state.planRevisions + 1;
      updates.planRevisionContext = undefined;
      updates.verificationFailures = [];
      updates.buildVerification = undefined;
    }
    return updates;
  };
}
