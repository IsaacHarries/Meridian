import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildModel } from "../../../models/factory.js";
import {
  buildSystemPrompt as buildGroomingSystem,
  buildUserPrompt as buildGroomingUser,
  GroomingOutputSchema,
} from "../../grooming.js";
import type { PipelineStage } from "../../pipeline-schemas.js";
import { appendSkill, streamAndParse } from "../helpers.js";
import type { PipelineGraphContext, PipelineState } from "../state.js";

export function makeGroomingNode(ctx: PipelineGraphContext) {
  return async function groomingNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const model = buildModel(state.model);
    const system = appendSkill(
      buildGroomingSystem(
        state.input.groomingTemplates ?? undefined,
        state.input.ticketType,
      ),
      state.input.skills?.grooming,
      "GROOMING CONVENTIONS",
    );
    const user = buildGroomingUser({
      ticketText: state.input.ticketText,
      fileContents: state.input.codebaseContext,
      templates: state.input.groomingTemplates ?? undefined,
      ticketType: state.input.ticketType,
    });

    const { parsed, usage } = await streamAndParse({
      ctx,
      nodeName: "grooming",
      model,
      messages: [new SystemMessage(system), new HumanMessage(user)],
      schema: GroomingOutputSchema,
    });
    return { groomingOutput: parsed, currentStage: "impact" as PipelineStage, usage };
  };
}
