// Cross-Meetings Chat workflow.
//
// Q&A across the user's full meeting history. The frontend runs the
// Rust-side hybrid retrieval (FTS5 + cosine semantic) first and passes
// the top-K segment hits in as `contextHits`. This workflow's only
// job is to format those hits into a prompt and ask the model to
// answer with citations back to the source meetings.
//
// Why retrieval lives outside the workflow:
//   - The index is in Rust SQLite; running it from the sidecar would
//     mean either duplicating the schema in Node or shoving it across
//     the IPC boundary as an extra round-trip per turn.
//   - The frontend already shows search results separately; passing
//     the same hits into chat keeps the user's mental model consistent
//     ("here's what I found, now ask about it").
//   - Lets the user manually narrow the corpus by selecting specific
//     meetings before asking — future enhancement that needs the hit
//     list to be a first-class input.
//
// The system prompt forces citations like `[MEETING-TITLE @ HH:MM:SS]`
// so the user can click through to the source segment. We trust the
// model less than the retriever — the prompt explicitly tells it to
// say "the transcripts don't cover this" rather than guess.

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { streamLLMText } from "./streaming.js";

/** One retrieved hit passed in by the frontend. Mirrors the shape
 *  Rust returns from `search_meetings` so the frontend doesn't have
 *  to translate. */
const RetrievedHitSchema = z.object({
  segmentId: z.number(),
  meetingId: z.string(),
  meetingTitle: z.string(),
  meetingStartedAt: z.string(),
  speaker: z.string().nullish(),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
});

export type RetrievedHit = z.infer<typeof RetrievedHitSchema>;

export const CrossMeetingsChatInputSchema = z.object({
  /** Top-K hits the Rust hybrid retrieval already pulled. The
   *  workflow doesn't run retrieval itself — see file-header note. */
  contextHits: z.array(RetrievedHitSchema),
  /** Same shape every other chat workflow uses: serialised
   *  [{role,content}] turns the user has already exchanged. */
  historyJson: z.string(),
  /** Whether the index was complete at the time of the query. The UI
   *  might already warn the user, but we mention it in the system
   *  prompt too so the model doesn't promise exhaustive coverage when
   *  semantic embeddings are still backfilling. Optional — caller
   *  may omit when not surfaced to the user; treated as `true`. */
  semanticAvailable: z.boolean().nullish(),
});

export type CrossMeetingsChatInput = z.infer<typeof CrossMeetingsChatInputSchema>;

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

/** Format milliseconds as HH:MM:SS. Used for citations so the user
 *  can scrub straight to the relevant moment in the meeting. */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function buildContextBlock(hits: RetrievedHit[]): string {
  if (hits.length === 0) {
    return "(no relevant excerpts retrieved — the index returned no hits for this query)";
  }
  const lines: string[] = [];
  for (const hit of hits) {
    const ts = formatMs(hit.startMs);
    const speaker = hit.speaker ? `${hit.speaker}: ` : "";
    const date = hit.meetingStartedAt.slice(0, 10);
    lines.push(
      `[${hit.meetingTitle} @ ${ts}] (${date}, segment ${hit.segmentId})\n${speaker}${hit.text.trim()}`,
    );
  }
  return lines.join("\n\n");
}

export function buildSystemPrompt(input: CrossMeetingsChatInput): string {
  const contextBlock = buildContextBlock(input.contextHits);
  const semanticAvailable = input.semanticAvailable !== false; // default true
  const semanticNote = semanticAvailable
    ? ""
    : `\n\nNOTE: semantic search was unavailable for this query — only keyword matches are included below. If you suspect the answer might be phrased differently in the transcripts, recommend the user re-run the query later or try alternative wording.`;
  return (
    `You are answering a question for the user about meetings they attended. ` +
    `You have been given excerpts from those meetings, retrieved from a search index. ` +
    `The transcripts come from automatic speech-to-text — expect transcription errors on proper nouns and technical terms.\n\n` +
    `=== RETRIEVED EXCERPTS ===\n${contextBlock}${semanticNote}\n\n` +
    `Rules:\n` +
    `- Answer ONLY from the retrieved excerpts above. Don't invent context that isn't present.\n` +
    `- Cite every claim using the bracketed labels you see — e.g. [Sprint Planning @ 00:14:32]. Multiple citations OK.\n` +
    `- If the excerpts don't actually cover the question, say so plainly: "The retrieved excerpts don't cover this — try rephrasing the search or include more meetings." Don't speculate.\n` +
    `- Speaker labels like "Name: …" identify who spoke. Use them when answering "who said X" questions; if a line has no speaker prefix, the speaker is unknown for that portion.\n` +
    `- Be concise. This is a conversation, not an essay.\n` +
    `- Reply in plain prose. No JSON.`
  );
}

export interface ChatResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runCrossMeetingsChat(args: {
  input: CrossMeetingsChatInput;
  model: ModelSelection;
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
}): Promise<ChatResult> {
  const llm = buildModel(args.model);

  const historyParsed = z
    .array(ChatMessageSchema)
    .safeParse(JSON.parse(args.input.historyJson || "[]"));
  if (!historyParsed.success) {
    throw new Error(
      `Invalid cross-meetings chat history: ${historyParsed.error.message}`,
    );
  }

  const messages: BaseMessage[] = [
    new SystemMessage(buildSystemPrompt(args.input)),
    ...historyParsed.data.map((m) =>
      m.role === "user"
        ? new HumanMessage(m.content)
        : new AIMessage(m.content),
    ),
  ];

  const { text, usage } = await streamLLMText({
    llm,
    messages,
    emit: args.emit,
    workflowId: args.workflowId,
    nodeName: args.nodeName,
  });
  return { markdown: text, usage };
}
