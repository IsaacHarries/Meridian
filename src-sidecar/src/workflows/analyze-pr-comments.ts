// Analyze PR Comments workflow.
//
// Single-shot LLM call: given the PR diff + reviewer comments + referenced
// file contents, returns a JSON array of structured fix proposals (one per
// comment) that the Address PR Comments UI then renders for the engineer to
// approve/edit. The response is JSON text — the frontend parses it.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { streamLLMJson } from "./streaming.js";

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  }
  return trimmed;
}

export const AnalyzePrCommentsInputSchema = z.object({
  reviewText: z.string(),
});

export type AnalyzePrCommentsInput = z.infer<
  typeof AnalyzePrCommentsInputSchema
>;

const SYSTEM_PROMPT = `You are an expert software engineer helping the PR author address code review comments left by their team. You will be given:
1. The full PR diff
2. All reviewer comments (inline comments annotated with file/line context)
3. The content of files referenced in inline comments

Your task is to produce a structured fix plan. Analyse every reviewer comment carefully. For each comment, decide:
- What is the reviewer asking for?
- What specific code change would address it?
- How confident are you in the fix? (High / Medium / Needs human judgment)

You MUST respond with ONLY a valid JSON array — no markdown fences, no explanation outside the JSON.
Schema for each element:
{
  "commentId": <number — the Bitbucket comment id>,
  "file": "<relative file path or null for general comments>",
  "fromLine": <number or null>,
  "toLine": <number or null>,
  "reviewerName": "<commenter display name>",
  "commentSummary": "<one sentence: what the reviewer wants>",
  "proposedFix": "<concrete description of the change to make>",
  "confidence": "High" | "Medium" | "Needs human judgment",
  "affectedFiles": ["<relative path>"],
  "newContent": "<the exact replacement file content if confidence is High or Medium, otherwise null>",
  "skippable": false
}
Set \`newContent\` only when you can produce the full replacement content for the affected file. For general architectural or design comments where the fix is open-ended, set confidence to 'Needs human judgment' and leave newContent null.
Do not invent problems. Only address comments that are actually present.`;

export interface AnalyzePrCommentsResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runAnalyzePrComments(args: {
  input: AnalyzePrCommentsInput;
  model: ModelSelection;
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
}): Promise<AnalyzePrCommentsResult> {
  const llm = buildModel(args.model);
  const { raw, usage } = await streamLLMJson({
    llm,
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(args.input.reviewText),
    ],
    emit: args.emit,
    workflowId: args.workflowId,
    nodeName: args.nodeName,
    cleanText: stripJsonFences,
  });
  return { markdown: raw, usage };
}
