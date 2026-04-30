// Meeting Chat workflow.
//
// Multi-turn Q&A over a completed meeting's transcript. The frontend doesn't
// subscribe to a stream channel — it awaits the final reply — so a plain
// non-streaming invoke is sufficient.

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

export const MeetingChatInputSchema = z.object({
  contextText: z.string(),
  historyJson: z.string(),
});

export type MeetingChatInput = z.infer<typeof MeetingChatInputSchema>;

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

function buildSystemPrompt(contextText: string): string {
  return (
    `You are helping the user recall details from a meeting they attended. You have the full transcript (produced by automatic speech-to-text, so expect transcription errors on proper nouns and technical terms).\n\n` +
    `${contextText}\n\n` +
    `Rules:\n` +
    `- Answer ONLY from the transcript. Quote the relevant portion when useful.\n` +
    `- If the answer is not in the transcript, say so plainly — do not speculate.\n` +
    `- Be concise. This is a conversation, not an essay.\n` +
    `- Speaker attribution: lines may be prefixed with a speaker label such as "Name: …" (a named person) or "SPEAKER_00: …" (an unnamed cluster from diarization). When asked who said something, use those labels directly. If a line has no prefix, the speaker is unknown for that portion.\n` +
    `- Reply in plain prose. No JSON.`
  );
}

export interface ChatResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runMeetingChat(args: {
  input: MeetingChatInput;
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
      `Invalid meeting chat history: ${historyParsed.error.message}`,
    );
  }

  const messages: BaseMessage[] = [
    new SystemMessage(buildSystemPrompt(args.input.contextText)),
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
