import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildModel } from "../../../models/factory.js";
import { PrDescriptionOutputSchema } from "../../pipeline-schemas.js";
import { buildPrDescriptionSystem } from "../../pipeline-prompts.js";
import { streamAndParse } from "../helpers.js";
import type { PipelineGraphContext, PipelineState } from "../state.js";

export function makePrDescriptionNode(ctx: PipelineGraphContext) {
  return async function prDescriptionNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const model = buildModel(state.model);
    const tmpl = state.input.prTemplate;
    const system = buildPrDescriptionSystem(tmpl?.body, tmpl?.mode ?? "guide");
    const user = `Ticket:\n${state.input.ticketText}\n\nImplementation plan:\n${JSON.stringify(state.plan ?? {}, null, 2)}\n\nImplementation result:\n${JSON.stringify(state.implementationOutput ?? {}, null, 2)}\n\nReview notes:\n${JSON.stringify(state.reviewOutput ?? {}, null, 2)}`;
    const { parsed, usage } = await streamAndParse({
      ctx,
      nodeName: "pr_description",
      model,
      messages: [new SystemMessage(system), new HumanMessage(user)],
      schema: PrDescriptionOutputSchema,
    });
    return { prDescription: parsed, usage };
  };
}
