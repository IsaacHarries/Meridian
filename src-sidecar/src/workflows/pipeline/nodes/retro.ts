import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildModel } from "../../../models/factory.js";
import { RetrospectiveOutputSchema } from "../../pipeline-schemas.js";
import { RETROSPECTIVE_SYSTEM } from "../../pipeline-prompts.js";
import { streamAndParse } from "../helpers.js";
import type { PipelineGraphContext, PipelineState } from "../state.js";

export function makeRetrospectiveNode(ctx: PipelineGraphContext) {
  return async function retrospectiveNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const model = buildModel(state.model);
    const user = `Ticket:\n${state.input.ticketText}\n\nImplementation plan:\n${JSON.stringify(state.plan ?? {}, null, 2)}\n\nImplementation result:\n${JSON.stringify(state.implementationOutput ?? {}, null, 2)}\n\nReview:\n${JSON.stringify(state.reviewOutput ?? {}, null, 2)}`;
    const { parsed, usage } = await streamAndParse({
      ctx,
      nodeName: "do_retrospective",
      model,
      messages: [new SystemMessage(RETROSPECTIVE_SYSTEM), new HumanMessage(user)],
      schema: RetrospectiveOutputSchema,
    });
    return { retrospective: parsed, usage };
  };
}
