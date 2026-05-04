import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildModel } from "../../../models/factory.js";
import { ImpactOutputSchema, type PipelineStage } from "../../pipeline-schemas.js";
import { IMPACT_SYSTEM } from "../../pipeline-prompts.js";
import { streamAndParse } from "../helpers.js";
import type { PipelineGraphContext, PipelineState } from "../state.js";

export function makeImpactNode(ctx: PipelineGraphContext) {
  return async function impactNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    if (!state.groomingOutput) throw new Error("Impact node ran before grooming completed");
    const model = buildModel(state.model);
    const user = `Ticket:\n${state.input.ticketText}\n\nGrooming analysis:\n${JSON.stringify(state.groomingOutput, null, 2)}`;
    const { parsed, usage } = await streamAndParse({
      ctx,
      nodeName: "impact",
      model,
      messages: [new SystemMessage(IMPACT_SYSTEM), new HumanMessage(user)],
      schema: ImpactOutputSchema,
    });
    return { impactOutput: parsed, currentStage: "triage" as PipelineStage, usage };
  };
}
