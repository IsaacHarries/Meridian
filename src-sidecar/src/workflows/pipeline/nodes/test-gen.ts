import { buildModel } from "../../../models/factory.js";
import type { RepoTools } from "../../../tools/repo-tools.js";
import { TestOutputSchema } from "../../pipeline-schemas.js";
import { TEST_GEN_SYSTEM } from "../../pipeline-prompts.js";
import {
  appendSkill,
  extractText,
  parseStructuredResponse,
} from "../helpers.js";
import { runToolLoop } from "../tool-loop.js";
import type { PipelineState } from "../state.js";

export function makeTestGenNode(tools: RepoTools) {
  return async function testGenNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    if (!state.plan) throw new Error("TestGen node ran before plan was finalised");
    if (!state.implementationOutput) {
      throw new Error("TestGen node ran before implementation completed");
    }
    if (!state.testPlan) {
      throw new Error("TestGen node ran before testPlan was approved");
    }

    const model = buildModel(state.model);
    const system = appendSkill(
      TEST_GEN_SYSTEM,
      state.input.skills?.testing ?? state.input.skills?.implementation,
      "TESTING CONVENTIONS",
    );
    const userPrompt =
      `Ticket:\n${state.input.ticketText}\n\n` +
      `Implementation plan:\n${JSON.stringify(state.plan, null, 2)}\n\n` +
      `What was implemented:\n${JSON.stringify(state.implementationOutput, null, 2)}\n\n` +
      `=== APPROVED TEST PLAN (write these files) ===\n${JSON.stringify(state.testPlan, null, 2)}\n\n` +
      `Write each approved test file using write_repo_file with the COMPLETE content. Stick to the approved plan — don't silently drop or invent files.`;

    const { finalMessage, usage } = await runToolLoop(model, tools, system, userPrompt);
    const raw = extractText(finalMessage.content) || finalMessage.text;
    const parsed = TestOutputSchema.parse(parseStructuredResponse(raw));

    return { testOutput: parsed, usage };
  };
}
