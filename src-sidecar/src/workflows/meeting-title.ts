// Meeting Title workflow.
//
// Lightweight single-shot LLM call that returns just a short, descriptive
// title for a meeting given its current content (notes or transcript) plus
// any tags. Kept separate from `meeting_summary` so the user can regenerate
// a title without paying for a full summary pass.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { streamLLMText } from "./streaming.js";

export const MeetingTitleInputSchema = z.object({
  contentText: z.string(),
  currentTagsJson: z.string(),
});

export type MeetingTitleInput = z.infer<typeof MeetingTitleInputSchema>;

const SYSTEM_PROMPT = `You generate a single short, descriptive title for a meeting based on its content. The content is EITHER an automated speech-to-text transcript (possibly with speaker labels like "Alice: …" or "SPEAKER_00: …") OR freeform written notes. Treat both the same way.

Return ONLY the title text — no quotes, no markdown, no leading "Title:", no trailing punctuation, no explanation. The title must:
- Be at most 8 words and under 70 characters
- Capture the actual subject of the meeting (what was discussed or decided), not generic words like "Meeting" or "Discussion"
- Be specific enough to disambiguate from other meetings ("Q3 roadmap planning" beats "Planning")
- If the content is too short or empty to determine a subject, return the single word: Untitled

Use the supplied tags only as a soft hint about meeting kind (standup, retro, planning, 1:1) — do not put the tag itself in the title unless it adds meaning.`;

function buildUserPrompt(input: MeetingTitleInput): string {
  return (
    `Current tags: ${input.currentTagsJson}\n\n` +
    `=== MEETING CONTENT ===\n` +
    `${input.contentText}\n\n` +
    `Return the title text now.`
  );
}

function sanitiseTitle(raw: string): string {
  // Strip JSON fences, surrounding quotes, and trailing punctuation. Models
  // occasionally ignore the "no quotes" rule despite the explicit instruction.
  let t = raw.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  }
  // Remove a leading "Title:" or "Suggested title:" prefix if present.
  t = t.replace(/^(suggested\s+)?title\s*:\s*/i, "").trim();
  // Strip wrapping single/double/smart quotes.
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    const isQuote = (c: string) =>
      c === '"' || c === "'" || c === "“" || c === "”" || c === "‘" || c === "’";
    if (isQuote(first) && isQuote(last)) {
      t = t.slice(1, -1).trim();
    }
  }
  // Collapse to a single line — titles must never wrap.
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

export interface MeetingTitleResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runMeetingTitle(args: {
  input: MeetingTitleInput;
  model: ModelSelection;
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
}): Promise<MeetingTitleResult> {
  const llm = buildModel(args.model);
  // Titles are short — we still stream so we get usage metadata, but don't
  // forward deltas (a half-formed title isn't useful UX).
  const { text, usage } = await streamLLMText({
    llm,
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(buildUserPrompt(args.input)),
    ],
  });
  return { markdown: sanitiseTitle(text), usage };
}
