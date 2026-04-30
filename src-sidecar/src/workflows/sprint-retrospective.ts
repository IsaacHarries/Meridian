// Sprint Retrospective workflow.
//
// Single-shot LLM call: takes a pre-compiled sprint context block and returns
// markdown the scrum master can use to open the retrospective meeting. No
// tools, no checkpoints, no structured-output validation — the frontend
// renders the result as markdown directly.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { streamLLMText } from "./streaming.js";

export const SprintRetroInputSchema = z.object({
  sprintText: z.string(),
});

export type SprintRetroInput = z.infer<typeof SprintRetroInputSchema>;

const SYSTEM_PROMPT = `You are an experienced agile coach helping a scrum master run sprint retrospectives. \
Write concise, honest, and actionable retrospective summaries based on sprint metrics. \
Be specific — reference story points, completion rates, and PR data where relevant. \
Avoid generic filler. Each section should be 2-4 bullet points.

The input may include a \`=== MEETINGS ===\` block listing meetings (standups, plannings, retros, 1:1s, etc.) captured during the sprint, with their summaries, decisions, action items, or — for written-notes meetings — the user's freeform notes verbatim. When this block is present, weave its content into your observations: highlight blockers raised in standup, decisions made in planning, follow-ups from 1:1s, and any tension between what was said in meetings and what the metrics show. Cite a specific meeting when you do ("In the planning meeting on 2025-01-15…"). When the block says "none," do not invent meeting content — proceed with metrics only.`;

function buildUserPrompt(sprintText: string): string {
  return (
    `Generate a sprint retrospective summary from the following sprint data:\n\n${sprintText}\n\n` +
    `Format your response in markdown with these four sections:\n` +
    `## What Went Well\n` +
    `## What Could Be Improved\n` +
    `## Patterns & Observations\n` +
    `## Suggested Discussion Points\n\n` +
    `End with a one-paragraph **Summary** the scrum master can use to open the meeting.`
  );
}

export interface SprintRetroResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runSprintRetrospective(args: {
  input: SprintRetroInput;
  model: ModelSelection;
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
}): Promise<SprintRetroResult> {
  const llm = buildModel(args.model);
  const { text, usage } = await streamLLMText({
    llm,
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(buildUserPrompt(args.input.sprintText)),
    ],
    emit: args.emit,
    workflowId: args.workflowId,
    nodeName: args.nodeName,
  });
  return { markdown: text, usage };
}
