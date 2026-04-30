// Multi-Sprint Trends workflow.
//
// The Rust caller pre-computes per-sprint statistics (velocity, completion
// rate, carry-over, etc.) and a formatted raw-data block, then asks the LLM
// to identify trends and produce a retrospective. Sidecar receives both as
// strings and emits markdown back.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { streamLLMText } from "./streaming.js";

export const TrendsInputSchema = z.object({
  statsTable: z.string(),
  rawBlock: z.string(),
});

export type TrendsInput = z.infer<typeof TrendsInputSchema>;

const SYSTEM_PROMPT = `You are an experienced agile coach analysing multiple sprints for a scrum master. Your goal is to help them gauge what the team did well, what needs improvement, and what concrete changes they should try next sprint to succeed.

You receive BOTH pre-computed statistics (verified, computed server-side) AND raw issue/PR data. Use the pre-computed statistics as the authoritative source for numbers. Use the raw data to identify specific patterns: which ticket types recur in carry-over, which assignees are consistently overloaded, which PR authors have long cycle times, which issue keys keep re-appearing, etc.

Be specific and data-driven. Cite ticket keys, sprint names, and numbers from the pre-computed table. Avoid generic agile platitudes. Every recommendation must be grounded in something you observed in the data.`;

function buildUserPrompt(input: TrendsInput): string {
  return (
    `Analyse trends across these sprints and produce a retrospective for the scrum master.\n\n` +
    `# Pre-Computed Statistics (authoritative — use these numbers)\n\n` +
    `${input.statsTable}\n\n` +
    `## Metric definitions\n` +
    `- **Velocity**: completed story points / committed story points\n` +
    `- **Completion %**: completed issues / total issues committed\n` +
    `- **Carry-over**: issues not done by end of sprint (count and % of committed)\n` +
    `- **Bug:Story**: bug count / story count (a rough quality vs. feature-work ratio)\n` +
    `- **Blockers**: issues with priority Blocker, Highest, or Critical\n` +
    `- **PRs**: pull requests updated within the sprint's date window\n` +
    `- **Avg Cycle**: mean hours between createdOn → updatedOn for MERGED PRs only\n` +
    `- **Avg Comments**: mean commentCount across all PRs in the window\n\n` +
    `# Raw Issue & PR Data (use for pattern identification)\n\n` +
    `${input.rawBlock}\n\n` +
    `# Output Format\n\n` +
    `Respond in markdown with these sections in this order:\n\n` +
    `## Overview\n` +
    `One paragraph: period covered, overall trajectory (improving, declining, stable, volatile).\n\n` +
    `## Trends in the Statistics\n` +
    `Walk through the stats table and call out which metrics are trending up, down, or flat. Quote specific numbers.\n\n` +
    `## What's Going Well\n` +
    `3–5 specific strengths, each backed by numbers from the table or examples from the raw data.\n\n` +
    `## What Needs Improvement\n` +
    `3–5 specific issues, each backed by numbers or recurring patterns. Call out patterns explicitly (e.g. "3 of 4 sprints had at least one blocker-priority ticket carry over").\n\n` +
    `## Notable Patterns & Observations\n` +
    `Things the stats table doesn't show on its own — correlations between metrics, specific assignees or authors consistently at the extremes, tickets that re-surfaced across sprints, etc.\n\n` +
    `## Recommendations for Next Sprint\n` +
    `3–5 concrete, testable actions. Each must say *what to try* and *what outcome to look for* to know it worked. No generic advice.\n\n` +
    `## Opening Notes for the Retro Meeting\n` +
    `2–3 sentences the scrum master can read verbatim to open the retrospective.`
  );
}

export interface TrendsResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runMultiSprintTrends(args: {
  input: TrendsInput;
  model: ModelSelection;
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
}): Promise<TrendsResult> {
  const llm = buildModel(args.model);
  const { text, usage } = await streamLLMText({
    llm,
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(buildUserPrompt(args.input)),
    ],
    emit: args.emit,
    workflowId: args.workflowId,
    nodeName: args.nodeName,
  });
  return { markdown: text, usage };
}
