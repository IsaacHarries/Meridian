import { buildModel } from "../../../models/factory.js";
import type { RepoTools } from "../../../tools/repo-tools.js";
import { TestPlanSchema } from "../../pipeline-schemas.js";
import { TEST_PLAN_SYSTEM } from "../../pipeline-prompts.js";
import {
  appendSkill,
  extractText,
  parseStructuredResponse,
} from "../helpers.js";
import { runToolLoop } from "../tool-loop.js";
import type { PipelineState } from "../state.js";

export function makeTestPlanNode(tools: RepoTools) {
  return async function testPlanNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    if (!state.plan) throw new Error("TestPlan node ran before plan was finalised");
    if (!state.implementationOutput) {
      throw new Error("TestPlan node ran before implementation completed");
    }

    const model = buildModel(state.model);
    const system = appendSkill(
      TEST_PLAN_SYSTEM,
      state.input.skills?.testing ?? state.input.skills?.implementation,
      "TESTING CONVENTIONS",
    );
    const userPrompt =
      `Ticket:\n${state.input.ticketText}\n\n` +
      `Implementation plan:\n${JSON.stringify(state.plan, null, 2)}\n\n` +
      `What was implemented:\n${JSON.stringify(state.implementationOutput, null, 2)}\n\n` +
      `Propose a test plan for the new/changed code. Read implementation files and existing test conventions if needed. Do NOT write any test files yet — return the plan as JSON.`;

    const { finalMessage, usage } = await runToolLoop(model, tools, system, userPrompt);
    const raw = extractText(finalMessage.content) || finalMessage.text;
    const parsed = TestPlanSchema.parse(parseStructuredResponse(raw));

    return { testPlan: parsed, usage };
  };
}
