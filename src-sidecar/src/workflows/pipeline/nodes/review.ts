import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildModel } from "../../../models/factory.js";
import { PlanReviewOutputSchema } from "../../pipeline-schemas.js";
import { CODE_REVIEW_SYSTEM } from "../../pipeline-prompts.js";
import { appendSkill, streamAndParse } from "../helpers.js";
import type { PipelineGraphContext, PipelineState } from "../state.js";

export function makeCodeReviewNode(ctx: PipelineGraphContext) {
  const tools = ctx.tools;
  return async function codeReviewNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const model = buildModel(state.model);
    const system = appendSkill(
      CODE_REVIEW_SYSTEM,
      state.input.skills?.review,
      "REVIEW STANDARDS",
    );
    // Pull the actual unified diff via the tool callback bridge so the
    // reviewer sees real changes, not just summaries.
    const diffTool = tools.find((t) => t.name === "get_repo_diff") as
      | { invoke: (input: unknown) => Promise<unknown> }
      | undefined;
    let diff = "(diff unavailable — get_repo_diff tool not registered)";
    if (diffTool) {
      try {
        const result = await diffTool.invoke({});
        diff = typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        diff = `(diff unavailable — ${err instanceof Error ? err.message : String(err)})`;
      }
    }

    const planJson = JSON.stringify(state.plan ?? {}, null, 2);
    const implJson = JSON.stringify(state.implementationOutput ?? {}, null, 2);
    const testJson = JSON.stringify(state.testOutput ?? {}, null, 2);
    const user = `Ticket:\n${state.input.ticketText}\n\nImplementation plan:\n${planJson}\n\nImplementation result:\n${implJson}\n\nTest plan:\n${testJson}\n\nCode diff:\n${diff}`;

    const { parsed, usage } = await streamAndParse({
      ctx,
      nodeName: "code_review",
      model,
      messages: [new SystemMessage(system), new HumanMessage(user)],
      schema: PlanReviewOutputSchema,
    });
    return { reviewOutput: parsed, usage };
  };
}
