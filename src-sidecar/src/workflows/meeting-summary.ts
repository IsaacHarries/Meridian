// Meeting Summary workflow.
//
// Single-shot LLM call that returns a JSON-as-text response with summary,
// action items, decisions, per-person notes, suggested title, suggested tags.
// The frontend parses the JSON; the sidecar treats the response as opaque
// text and returns it via the same `{ markdown }` shape used by other
// single-shot workflows.

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

export const MeetingSummaryInputSchema = z.object({
  transcriptText: z.string(),
  currentTitle: z.string(),
  currentTagsJson: z.string(),
});

export type MeetingSummaryInput = z.infer<typeof MeetingSummaryInputSchema>;

const SYSTEM_PROMPT = `You are an assistant that reviews material from a meeting the user attended. The input is EITHER (a) a recorded conversation produced by automatic speech-to-text — possibly including speaker labels in the form "Name: …" or "SPEAKER_00: …" when diarization has run; attribute quotes to those labels when present — OR (b) freeform written notes the user typed during a meeting where audio could not be recorded. Treat both inputs the same way: write a precise analysis the user can consult later. Be concrete and faithful to what was said or written — do not invent facts, attendees, or decisions. If the notes are very brief, your summary should be brief too.

IMPORTANT: Never use the word "transcript" in any output field. Refer to the material as the meeting, the conversation, or the notes — whichever fits.

Return ONLY a JSON object, no markdown fences, matching this schema:
{
  "summary": "<2–4 sentence overview of what the meeting was about and what was concluded>",
  "actionItems": ["<one concrete action item per string: who/what/when where mentioned>", ...],
  "decisions": ["<one decision per string, stated plainly>", ...],
  "perPerson": [
    {
      "name": "<speaker's name or label as it appears in the input>",
      "summary": "<1–3 sentences covering what this person said: progress, plans, blockers, opinions>",
      "actionItems": ["<concrete action item owned by or assigned to this person>", ...]
    }, ...
  ],
  "suggestedTitle": "<a short descriptive title (≤ 8 words), or null to keep current>",
  "suggestedTags": ["standup"|"planning"|"retro"|"1:1"|"other", ...]
}
Leave an array empty if the input contains nothing of that kind. Prefer \`suggestedTags\` from the enum above; only add a new tag if absolutely necessary.

Rules for \`perPerson\`:
- REQUIRED when the current tags include "standup" — produce one entry per person who spoke or whose update is captured in the notes, in the order they spoke.
- For other tags it is optional: include it only when individual contributions can be clearly attributed (named speaker labels, or a notes section where each person's update is clearly delimited). Otherwise leave it as [].
- Use the speaker's real name when given ("Alice: …" → "Alice"). For unnamed diarization clusters ("SPEAKER_00: …"), use that label verbatim. Do not invent names.
- Each person's \`actionItems\` must also appear in the top-level \`actionItems\` array — \`perPerson\` is a per-attendee view of the same items, not a separate list.
- If a person spoke but had no action items, set their \`actionItems\` to [].`;

function buildUserPrompt(input: MeetingSummaryInput): string {
  return (
    `Current title: ${input.currentTitle}\n` +
    `Current tags: ${input.currentTagsJson}\n\n` +
    `=== MEETING CONTENT ===\n` +
    `${input.transcriptText}\n\n` +
    `Return the JSON object now.`
  );
}

export interface MeetingSummaryResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runMeetingSummary(args: {
  input: MeetingSummaryInput;
  model: ModelSelection;
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
}): Promise<MeetingSummaryResult> {
  const llm = buildModel(args.model);
  const { raw, usage } = await streamLLMJson({
    llm,
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(buildUserPrompt(args.input)),
    ],
    emit: args.emit,
    workflowId: args.workflowId,
    nodeName: args.nodeName,
    cleanText: stripJsonFences,
  });
  return { markdown: raw, usage };
}
