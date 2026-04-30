// Workload Suggestions workflow.
//
// Single-shot LLM call: takes a pre-compiled per-developer workload block and
// returns markdown rebalancing suggestions for the sprint. No tools, no
// checkpoints — same shape as Sprint Retrospective.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { streamLLMText } from "./streaming.js";

export const WorkloadInputSchema = z.object({
  workloadText: z.string(),
});

export type WorkloadInput = z.infer<typeof WorkloadInputSchema>;

const SYSTEM_PROMPT = `You are a scrum master assistant helping balance work across a development team. \
Analyse the workload data and suggest specific, actionable ticket reassignments. \
Be concrete: name the ticket key, the current assignee, and the suggested new assignee. \
Consider both story point load and PR review load when assessing capacity. \
Keep suggestions brief and practical.`;

function buildUserPrompt(workloadText: string): string {
  return (
    `Analyse this sprint workload and suggest rebalancing moves:\n\n${workloadText}\n\n` +
    `Format your response as:\n` +
    `**Summary** — one sentence describing the overall balance.\n\n` +
    `**Recommended moves** (if any):\n` +
    `- Move [TICKET-KEY] "summary" from [Person A] → [Person B]. Reason: ...\n\n` +
    `**Developers at risk** (if any): who may not complete their load.\n\n` +
    `**Developers with capacity**: who could take on more.\n\n` +
    `If the workload is already well balanced, say so clearly. Do not invent problems.`
  );
}

export interface WorkloadResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runWorkloadSuggestions(args: {
  input: WorkloadInput;
  model: ModelSelection;
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
}): Promise<WorkloadResult> {
  const llm = buildModel(args.model);
  const { text, usage } = await streamLLMText({
    llm,
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(buildUserPrompt(args.input.workloadText)),
    ],
    emit: args.emit,
    workflowId: args.workflowId,
    nodeName: args.nodeName,
  });
  return { markdown: text, usage };
}
