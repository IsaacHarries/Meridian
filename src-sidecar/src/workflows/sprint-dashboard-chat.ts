// Sprint Dashboard Chat workflow.
//
// Multi-turn Q&A over a sprint dashboard snapshot. The frontend doesn't
// subscribe to a stream channel for this workflow — it awaits the final
// reply — so a plain non-streaming invoke is sufficient.

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

export const SprintDashboardChatInputSchema = z.object({
  contextText: z.string(),
  historyJson: z.string(),
});

export type SprintDashboardChatInput = z.infer<
  typeof SprintDashboardChatInputSchema
>;

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

function buildSystemPrompt(contextText: string): string {
  return (
    `You are a scrum master's assistant, answering questions about the user's current sprint dashboard. You have a compact snapshot of the sprint state below: the sprint metadata, every issue with its status/assignee/points, every open and recently merged PR, and a per-developer workload breakdown.\n\n` +
    `${contextText}\n\n` +
    `Rules:\n` +
    `- Answer ONLY from the snapshot. If something isn't in the data, say so plainly.\n` +
    `- Be concrete: cite ticket keys, PR numbers, and developer names where relevant.\n` +
    `- When asked to rebalance, suggest specific moves (ticket → developer) with brief reasons.\n` +
    `- Keep replies tight — this is a conversation, not an essay. Use bullet points for lists.\n` +
    `- Reply in plain markdown. No JSON.`
  );
}

export interface ChatResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runSprintDashboardChat(args: {
  input: SprintDashboardChatInput;
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
      `Invalid sprint chat history: ${historyParsed.error.message}`,
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
