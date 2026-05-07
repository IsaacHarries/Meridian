import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { streamLLMJson } from "./streaming.js";

// ── Input / output schemas ────────────────────────────────────────────────────

export const GroomingInputSchema = z.object({
  ticketText: z.string(),
  fileContents: z.string().optional().default(""),
  templates: z
    .object({
      // Rust serializes unset templates as JSON null (Option::None), so accept
      // both null and missing/undefined for either field.
      acceptance_criteria: z.string().nullish(),
      steps_to_reproduce: z.string().nullish(),
    })
    .nullish(),
  /** JIRA issue type, lower-cased ("bug", "story", "task", …). When the
   *  caller knows it, the system prompt gates the bug-specific rules
   *  block (~1k tokens) so non-bug runs don't carry them. Optional and
   *  defaulting to including the rules — keeps behaviour correct when
   *  an older caller forgets to pass it; a wasted-token bug is the
   *  worst-case rather than a missing-rules bug. */
  ticketType: z.string().nullish(),
});

export type GroomingInput = z.infer<typeof GroomingInputSchema>;

export const SuggestedEditSchema = z.object({
  id: z.string(),
  field: z.enum([
    "description",
    "acceptance_criteria",
    "steps_to_reproduce",
    "observed_behavior",
    "expected_behavior",
    "summary",
  ]),
  section: z.string(),
  current: z.string().nullable(),
  // Models occasionally return an array of strings here (one per bullet) even
  // when the prompt asks for a single string — coerce to a newline-joined
  // string. They also sometimes return null/undefined when they couldn't
  // propose anything; coerce to empty string rather than failing the whole
  // grooming response (an edit with empty suggested text is harmless and the
  // user will simply ignore it in the diff UI).
  suggested: z
    .union([z.string(), z.array(z.string()), z.null(), z.undefined()])
    .transform((v) => {
      if (v == null) return "";
      if (Array.isArray(v)) return v.join("\n");
      return v;
    }),
  reasoning: z.string(),
});

export const RelevantAreaSchema = z.object({
  area: z.string(),
  reason: z.string(),
  files_to_check: z.array(z.string()),
});

export const GroomingOutputSchema = z.object({
  ticket_summary: z.string(),
  // Mirrors Jira's standard work item types plus a couple of agile aliases
  // some teams use. "feature" and "chore" aren't Jira types but kept for
  // tickets imported from other trackers; "story" and "task" are the most
  // common Jira types and the only ones the grooming agent treats as
  // requiring acceptance criteria.
  ticket_type: z.enum([
    "story",
    "task",
    "bug",
    "spike",
    "epic",
    "subtask",
    "feature",
    "chore",
  ]),
  acceptance_criteria: z.array(z.string()),
  relevant_areas: z.array(RelevantAreaSchema),
  dependencies: z.array(z.string()),
  estimated_complexity: z.enum(["low", "medium", "high"]),
  grooming_notes: z.string(),
  suggested_edits: z.array(SuggestedEditSchema),
  // Open items the agent surfaces for the engineer to clarify in chat
  // before grooming finalises. Subsumes both "actual questions" and
  // "things in the ticket that read ambiguously" — they were previously
  // two separate fields that overlapped in practice. Older models that
  // still emit a top-level `ambiguities` array will have it silently
  // stripped by Zod's default unknown-key handling on z.object.
  clarifying_questions: z.array(z.string()),
});

export type GroomingOutput = z.infer<typeof GroomingOutputSchema>;

// ── System prompt ─────────────────────────────────────────────────────────────

// Core system prompt — applies to every ticket type. Stays cache-stable
// across runs so the prompt-cache hit rate doesn't get fragmented by the
// optional bug-rules block below.
const BASE_SYSTEM_CORE = `You are a grooming agent helping a senior engineer understand and refine a JIRA ticket. \
You have been given the ticket details and relevant source code from the codebase. \
Your job is twofold:
1. Analyse the ticket and produce a structured grooming summary
2. Identify any gaps, inaccuracies, or missing sections in the ticket and suggest concrete improvements

For each suggested edit:
- Compare what the ticket currently says against what the code actually does
- Propose a specific, concrete replacement (not vague advice)
- For missing sections (e.g. no Acceptance Criteria on a Story, no Steps to Reproduce on a Bug), \
draft what should be there based on the code context — or raise a clarifying_question if you genuinely cannot determine it

Return ONLY valid JSON (no markdown fences) with this schema:
{
  "ticket_summary": "<2-3 sentence summary of what the ticket is asking for>",
  "ticket_type": "story|task|bug|spike|epic|subtask",
  "acceptance_criteria": ["<criterion>", ...],
  "relevant_areas": [
    {"area": "<module or layer>", "reason": "<why relevant>", "files_to_check": ["<path>"]}
  ],
  "dependencies": ["<other tickets or systems>", ...],
  "estimated_complexity": "low|medium|high",
  "grooming_notes": "<anything else worth flagging>",
  "suggested_edits": [
    {
      "id": "<short unique slug e.g. 'ac-1' or 'desc-clarity'>",
      "field": "<jira field: description|acceptance_criteria|steps_to_reproduce|observed_behavior|expected_behavior|summary>",
      "section": "<human label e.g. 'Acceptance Criteria' or 'Description'>",
      "current": "<exact existing text, or null if the section is missing entirely>",
      "suggested": "<your proposed replacement or addition>",
      "reasoning": "<1-2 sentences explaining why this change improves the ticket>"
    }
  ],
  "clarifying_questions": [
    "<question or unclear ticket detail the engineer needs to address before grooming finalises — phrased as a question>"
  ]
}

Important:
- Use clarifying_questions for BOTH genuine questions AND ambiguities in the ticket text. If something in the ticket reads unclear, phrase it as a question (e.g. \"Is X expected to do Y or Z?\") rather than emitting a separate \"ambiguity\" — the engineer answers it the same way either way.
- Only raise a clarifying_question when you genuinely cannot determine the answer from the code or ticket
- Prefer drafting a concrete suggestion (even if tentative) over asking a question
- If the ticket title (summary) is vague, too generic, or does not clearly convey the scope \
or intent of the work, suggest a concrete improved title using field \`summary\` — be specific \
and concise (under 80 characters). Only suggest a title change if it genuinely adds clarity; \
do not change titles that are already specific
- If the ticket is a Story/Task and has no Acceptance Criteria, always suggest them
- Keep each suggested text concise and actionable
- Only include ONE suggested_edit per field value — if you have multiple improvements for \
the same field (e.g. multiple acceptance criteria points), consolidate them into a single \
edit with all content merged. Never produce two suggested_edits with the same \`field\`.

=== CONTENT PRESERVATION (STRICT) ===
When you suggest a replacement for an existing field, you MUST preserve every \
non-prose artifact already present in that field's text. Your edits should \
ONLY change plain prose — never silently drop:
- URL links (raw \`https://…\` URLs, markdown \`[text](url)\` links, JIRA wiki \
\`[text|url]\` links, autolinks, attached-file links)
- Image embeds (markdown \`![alt](src)\` images, JIRA wiki \`!image.png|...!\` \
embeds, inline data URIs)
- @user mentions, JIRA ticket references (\`PROJ-123\`), commit / PR links
- Code blocks, inline code, and pre-formatted snippets
- Tables, numbered or bulleted lists' bullet markers, and existing structural \
formatting

If a URL or image is in the wrong section of a field (e.g. a screenshot link \
sitting in the description that belongs in steps_to_reproduce), MOVE it to the \
appropriate field's suggested_edit — never delete it. If you genuinely cannot \
tell where an artifact belongs, keep it in place rather than dropping it.

The goal is that anyone diffing your \`suggested\` against the original \`current\` \
should see only prose changes; every artifact must reappear in some \
suggested_edit, with its URL/path/anchor unchanged. Treat this as a hard \
constraint — losing a link is never acceptable, even if the surrounding prose \
is being rewritten.

When you cannot determine a field's content from the ticket text alone, draft \
a plausible value from the relevant source code provided below — only fall \
back to a clarifying_question if even the code does not give enough context.`;

// Optional block appended only when grooming a Bug. Carries the
// description/steps/observed/expected discipline the bug workflow
// needs but which is dead weight (~1k tokens) on Story/Task/Spike runs.
const BUG_RULES = `

=== BUG-SPECIFIC RULES (ticket_type == "bug") ===
When the ticket is a Bug, the following fields MUST all be populated. For \
every one that is missing OR empty, emit a suggested_edit:
- \`description\` — a concise summary of the bug (what is broken, where it shows up). \
NOT the reproduction steps and NOT the observed/expected behaviour — those \
belong in their own fields. Aim for 2–4 sentences.
- \`steps_to_reproduce\` — a numbered list of actions a reader can follow to \
reliably trigger the bug
- \`observed_behavior\` — what actually happens when those steps are followed
- \`expected_behavior\` — what the user/system should see instead
- \`acceptance_criteria\` — bugs need AC just like stories and tasks. Phrase \
each criterion as a verifiable post-fix condition (typically the inverse of \
the bug: the broken behaviour now works as expected, no regression in adjacent \
flows, etc.). If AC is missing or empty, ALWAYS emit a suggested_edit — never \
skip it on the assumption that "expected_behavior covers it".

If the existing \`description\` field contains content that belongs in another \
bug field, MOVE it rather than duplicate it:
- If the description has a "Steps to Reproduce" section (or a numbered list of \
reproduction steps), extract those steps into a suggested_edit for \
\`steps_to_reproduce\` and emit a suggested_edit for \`description\` whose \
\`suggested\` value is the description WITHOUT those steps (replaced by a \
summary of the bug).
- If the description contains "Observed Behavior" / "Actual Result" / similar \
content, extract it into \`observed_behavior\` and remove it from the description.
- If the description contains "Expected Behavior" / "Expected Result" / \
similar, extract it into \`expected_behavior\` and remove it from the description.

In short: after your suggested edits are applied, the description should read \
as a summary of the bug, and each of steps_to_reproduce / observed_behavior / \
expected_behavior should hold its own dedicated content.`;

/** Decide whether to attach the bug-specific rules block. Returns true
 *  when the caller-supplied type identifies the ticket as a bug, OR
 *  when no type was provided (preserves correctness for callers that
 *  haven't been updated to pass `ticketType` yet — the worst case is a
 *  bit of wasted prompt rather than missing rules on a real bug). */
function shouldIncludeBugRules(ticketType: string | null | undefined): boolean {
  if (ticketType == null) return true;
  return ticketType.trim().toLowerCase() === "bug";
}

function templatesBlock(templates?: GroomingInput["templates"]): string {
  if (!templates) return "";
  const ac = templates.acceptance_criteria;
  const str = templates.steps_to_reproduce;
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

export function buildSystemPrompt(
  templates?: GroomingInput["templates"],
  ticketType?: string | null,
): string {
  const bugBlock = shouldIncludeBugRules(ticketType) ? BUG_RULES : "";
  return BASE_SYSTEM_CORE + bugBlock + templatesBlock(templates);
}

export function buildUserPrompt(input: GroomingInput): string {
  const fileBlock = input.fileContents
    ? `\n\n=== RELEVANT FILE CONTENTS (read from codebase) ===\n${input.fileContents}`
    : "";
  return `Groom this ticket:\n\n${input.ticketText}${fileBlock}`;
}

// ── State graph ───────────────────────────────────────────────────────────────

const GroomingStateAnnotation = Annotation.Root({
  input: Annotation<GroomingInput>(),
  model: Annotation<ModelSelection>(),
  rawResponse: Annotation<string | undefined>(),
  parsedOutput: Annotation<GroomingOutput | undefined>(),
  parseError: Annotation<string | undefined>(),
  usage: Annotation<{ inputTokens: number; outputTokens: number } | undefined>(),
});

type GroomingState = typeof GroomingStateAnnotation.State;

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  return trimmed;
}

/**
 * Models occasionally emit bad JSON escape sequences — usually a bare `\`
 * inside a string field (code snippets, regex patterns). JSON.parse then
 * fails with "Bad escaped character". Try to recover by escaping any `\`
 * that isn't followed by a valid JSON escape character.
 */
function tryParseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (firstErr) {
    const repaired = text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    if (repaired !== text) {
      try {
        return JSON.parse(repaired);
      } catch {
        // fall through to throw the original error so the user sees the
        // actual position the model produced (more useful for debugging)
      }
    }
    throw firstErr;
  }
}

function makeAnalyseNode(
  emit?: (event: OutboundEvent) => void,
  workflowId?: string,
) {
  return async function analyseNode(
    state: GroomingState,
  ): Promise<Partial<GroomingState>> {
    const model: BaseChatModel = buildModel(state.model);
    const system = buildSystemPrompt(
      state.input.templates,
      state.input.ticketType,
    );
    const user = buildUserPrompt(state.input);

    const { raw, usage } = await streamLLMJson({
      llm: model,
      messages: [new SystemMessage(system), new HumanMessage(user)],
      emit,
      workflowId,
      nodeName: "analyse",
      cleanText: stripJsonFences,
    });

    // Parse + validate against the schema. On failure we surface parseError so
    // the caller can decide how to handle it (retry, surface to user, etc.).
    const cleaned = stripJsonFences(raw);
    try {
      const parsed = tryParseJsonLenient(cleaned);
      const validated = GroomingOutputSchema.parse(parsed);
      return { rawResponse: raw, parsedOutput: validated, usage };
    } catch (err) {
      return {
        rawResponse: raw,
        parseError: err instanceof Error ? err.message : String(err),
        usage,
      };
    }
  };
}

export function buildGroomingGraph(opts?: {
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
}) {
  return new StateGraph(GroomingStateAnnotation)
    .addNode("analyse", makeAnalyseNode(opts?.emit, opts?.workflowId))
    .addEdge(START, "analyse")
    .addEdge("analyse", END)
    .compile();
}
