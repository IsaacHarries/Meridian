// Grooming Chat workflow.
//
// Multi-turn chat at the grooming checkpoint. The agent refines suggested
// edits and asks/retracts clarifying questions as the engineer answers.
// Returns a JSON object the frontend parses to apply state updates
// (suggested edits + open questions). Streams reply tokens live to the
// workflow event channel.

import { z } from "zod";
import { ChatHistoryItemSchema } from "./chat-with-tools.js";

export const GroomingChatInputSchema = z.object({
  contextText: z.string(),
  historyJson: z.string(),
  /** Per-field grooming format templates configured by the user. Either may
   *  be `null` if the user hasn't configured one. The sidecar pulls these
   *  through into the system prompt so the agent's `suggested` text follows
   *  the user's expected structure. */
  templates: z
    .object({
      acceptance_criteria: z.string().nullish(),
      steps_to_reproduce: z.string().nullish(),
    })
    .nullish(),
});

export type GroomingChatInput = z.infer<typeof GroomingChatInputSchema>;

export const GroomingChatHistorySchema = z.array(ChatHistoryItemSchema);

function buildTemplatesBlock(
  templates: GroomingChatInput["templates"],
): string {
  const ac = templates?.acceptance_criteria;
  const str = templates?.steps_to_reproduce;
  if (!ac && !str) return "";
  let out =
    "\n\n=== FORMAT TEMPLATES ===\n" +
    "When you draft text for the `suggested` field of an edit, follow the " +
    "format shown below for the matching `field`. Match the structure, " +
    "bullet style, numbering, and line breaks exactly — the user relies on " +
    "a consistent format across tickets.\n";
  if (ac) {
    out += "\n--- Format for field `acceptance_criteria` ---\n" + ac.trimEnd() + "\n";
  }
  if (str) {
    out += "\n--- Format for field `steps_to_reproduce` ---\n" + str.trimEnd() + "\n";
  }
  return out;
}

export function buildGroomingChatSystemPrompt(input: GroomingChatInput): string {
  const templatesBlock = buildTemplatesBlock(input.templates);
  return (
    `You are a grooming agent leading a structured review of a JIRA ticket with a senior engineer. The ticket details, relevant code context, and current state of suggested edits are below.\n\n` +
    `${input.contextText}\n\n` +
    `Your role in this conversation:\n` +
    `- Respond naturally to the engineer's message\n` +
    `- Refine, add, or retract suggested edits based on new information\n` +
    `- Ask follow-up clarifying questions if you still need information\n` +
    `- When the engineer answers a question, incorporate it into your suggestions immediately\n` +
    `- Lead toward a complete, well-groomed ticket\n\n` +
    `IMPORTANT — you have NO ability to write to JIRA, Bitbucket, or any external system. You only return suggested edits as JSON; the engineer must approve them in the UI before anything is pushed anywhere.\n\n` +
    `CRITICAL: You MUST always respond with ONLY a valid JSON object — no markdown fences, no prose outside the JSON, no matter how conversational the engineer's message is. Every single response must be valid JSON.\n\n` +
    `Required schema:\n` +
    `{\n` +
    `  "message": "<your conversational reply to the engineer — plain prose, no JSON>",\n` +
    `  "updated_edits": [\n` +
    `    {\n` +
    `      "id": "<same id as existing edit to update it, or a new slug for new edits>",\n` +
    `      "field": "<description|acceptance_criteria|steps_to_reproduce|observed_behavior|expected_behavior|summary>",\n` +
    `      "section": "<human label>",\n` +
    `      "current": "<existing text or null>",\n` +
    `      "suggested": "<proposed text>",\n` +
    `      "reasoning": "<why>"\n` +
    `    }\n` +
    `  ],\n` +
    `  "updated_questions": ["<remaining open clarifying questions — drop ones the engineer has answered, add any new ones that have surfaced. Cover both genuine questions AND ambiguous ticket details (phrase ambiguities as questions). Return the FULL current list every turn — it replaces the previous list, it does not merge.>"]\n` +
    `}\n\n` +
    `Rules:\n` +
    `- updated_edits may be empty if no changes are needed this turn\n` +
    `- To remove a suggestion, omit its id from updated_edits (the frontend will not delete it — include it with a note in reasoning if it should be withdrawn)\n` +
    `- If you change the suggested text or current text of an existing edit, the engineer's previous approval is automatically reset and they must re-approve — your edit is a fresh proposal.\n` +
    `- Keep the message focused and concise\n` +
    `- Even if the engineer says only 'yes', 'ok', or 'thanks', you must still return the full JSON object\n` +
    `\n` +
    `=== TITLE CASE FOR SUMMARY ===\n` +
    `Whenever you propose or revise the \`summary\` field, the \`suggested\` value MUST be Title Cased: capitalise every word except articles (a, an, the), conjunctions (and, but, or, nor, for, so, yet), and short prepositions (in, on, at, to, of, by, with, from, as, into) — unless the small word is the first or last word of the title, in which case it's also capitalised. Acronyms and identifier-shaped tokens (e.g. \`GET /users/:id\`, \`JWT\`, \`HS256\`, \`N+1\`, \`gRPC\`, file paths, version numbers) keep their original casing. Do NOT emit a \`summary\` edit purely for casing fixes — the client normalises casing on save automatically. Only propose a \`summary\` revision when the title's *content* would genuinely improve.\n` +
    `\n` +
    `=== CONTENT PRESERVATION (STRICT) ===\n` +
    `When you propose a replacement for an existing field, you MUST preserve every non-prose artifact already present in that field's text. Your edits should ONLY change plain prose — never silently drop:\n` +
    `- URL links (raw https://… URLs, markdown [text](url) links, JIRA wiki [text|url] links, autolinks, attached-file links)\n` +
    `- Image embeds (markdown ![alt](src), JIRA wiki !image.png|...! embeds, inline data URIs)\n` +
    `- @user mentions, JIRA ticket references (PROJ-123), commit / PR links\n` +
    `- Code blocks, inline code, and pre-formatted snippets\n` +
    `- Tables, list bullet markers, and existing structural formatting\n` +
    `\n` +
    `If an artifact belongs in a different field, MOVE it (emit a suggested_edit for the destination field) rather than dropping it. If you cannot tell where it belongs, keep it in place. Anyone diffing your suggested against the original current must see only prose changes; every URL/image/mention must reappear with its target unchanged. This is a hard constraint — losing a link is never acceptable, even when rewriting the surrounding prose.` +
    templatesBlock
  );
}
