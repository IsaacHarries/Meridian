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

export const SYSTEM_PROMPT = `You are an expert software engineer helping the PR author address code review comments left by their team. You will be given:
1. The full PR diff
2. All reviewer comments (inline comments annotated with file/line context)
3. The content of files referenced in inline comments

Your task is to produce a structured fix plan. Analyse every reviewer comment carefully. For each comment, decide:
- What is the reviewer asking for?
- What specific code change would address it?
- How confident are you in the fix? (see calibration below)

=== CONFIDENCE CALIBRATION ===
- "High" — single localised edit, fully visible in the supplied file content, no semantics outside the comment's scope. You can produce the complete replacement \`newContent\` with confidence.
- "Medium" — the edit is local but spans behaviour you can only partially verify from the supplied content. Produce \`newContent\` but expect the engineer to review carefully.
- "Needs human judgment" — open-ended / architectural / requires context not in the input. Set \`newContent\` to null.

=== EVIDENCE REQUIREMENTS ===
- Before producing \`newContent\`, confirm the affected file's content was supplied in the input. If it was NOT supplied, downgrade to "Needs human judgment" and set \`newContent\` to null — do not fabricate file content.
- \`commentId\`, \`file\`, \`fromLine\`, and \`toLine\` MUST match the values from the input. Do not invent comment ids or shift line numbers.
- \`affectedFiles\` should list exactly the files you would write — usually one, sometimes more for cross-file fixes.

You MUST respond with ONLY a valid JSON array — no markdown fences, no explanation outside the JSON.
Schema for each element:
{
  "commentId": <number — the Bitbucket comment id from the input>,
  "file": "<relative file path or null for general comments>",
  "fromLine": <number or null>,
  "toLine": <number or null>,
  "reviewerName": "<commenter display name>",
  "commentSummary": "<one sentence: what the reviewer wants>",
  "proposedFix": "<concrete description of the change to make>",
  "confidence": "High" | "Medium" | "Needs human judgment",
  "affectedFiles": ["<relative path>"],
  "newContent": "<the exact replacement file content if confidence is High or Medium AND the file was supplied; otherwise null>",
  "skippable": false
}

=== SELF-CHECK (apply before outputting) ===
1. Does every commentId in my output appear in the input comments?
2. For every High/Medium confidence: was the affected file's content actually supplied in the input?
3. Did I avoid inventing file content for any comment whose file was not supplied?
4. Are file paths and line numbers copied verbatim from the input (not estimated)?
If any answer is NO — fix or downgrade the affected entry before emitting JSON.

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
