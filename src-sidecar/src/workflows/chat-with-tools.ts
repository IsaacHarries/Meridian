// Shared scaffold for chat workflows that stream tokens AND can call tools.
//
// Used by both `pr_review_chat` and `address_pr_chat` — these are interactive
// chat sessions where the model can call repo-inspection tools (glob / grep /
// read / get_repo_diff) between turns. Token output is streamed back to the
// frontend live (one `stream` event per chunk) so the user sees the reply
// being typed in real time.
//
// This is the non-graph equivalent of `runToolLoop` in `pipeline.ts` — same
// tool-call protocol, but uses `model.stream()` so deltas can be emitted as
// they arrive rather than waiting for the whole response.

import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import type { RepoTools } from "../tools/repo-tools.js";

export const ChatHistoryItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export type ChatHistoryItem = z.infer<typeof ChatHistoryItemSchema>;

const MAX_ITERATIONS = 12;

type Emitter = (event: OutboundEvent) => void;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string" ? b : (b as { text?: string }).text ?? "",
      )
      .join("");
  }
  return "";
}

export async function runStreamingChatWithTools(args: {
  workflowId: string;
  model: ModelSelection;
  tools: RepoTools;
  systemPrompt: string;
  history: ChatHistoryItem[];
  emit: Emitter;
  nodeName: string;
}): Promise<{
  reply: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const { workflowId, model, tools, systemPrompt, history, emit, nodeName } =
    args;

  const llm = buildModel(model);
  if (typeof llm.bindTools !== "function") {
    throw new Error(
      `Model ${llm._llmType()} does not support tool calls. The chat workflow requires a provider with native bindTools support.`,
    );
  }
  const llmWithTools = llm.bindTools(tools);

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    ...history.map((m) =>
      m.role === "user"
        ? new HumanMessage(m.content)
        : new AIMessage(m.content),
    ),
  ];

  let reply = "";
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let accumulated: AIMessageChunk | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (await (llmWithTools as any).stream(
      messages,
    )) as AsyncIterable<AIMessageChunk>;
    for await (const chunk of stream) {
      const deltaText = extractText(chunk.content);
      if (deltaText) {
        emit({ id: workflowId, type: "stream", node: nodeName, delta: deltaText });
      }
      accumulated = accumulated ? accumulated.concat(chunk) : chunk;
    }
    if (!accumulated) {
      throw new Error("Chat tool loop received an empty stream from the model");
    }

    const u = accumulated.usage_metadata as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    usage.inputTokens += u?.input_tokens ?? 0;
    usage.outputTokens += u?.output_tokens ?? 0;

    const turnText = extractText(accumulated.content);
    if (turnText) reply += turnText;

    const aiMessage = new AIMessage({
      content: accumulated.content,
      tool_calls: accumulated.tool_calls,
      additional_kwargs: accumulated.additional_kwargs,
    });
    messages.push(aiMessage);

    const calls = accumulated.tool_calls;
    if (!calls || calls.length === 0) {
      return { reply, usage };
    }

    for (const call of calls) {
      const found = tools.find((t) => t.name === call.name) as
        | { invoke: (input: unknown) => Promise<unknown> }
        | undefined;
      if (!found) {
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            content: `Error: unknown tool '${call.name}'`,
          }),
        );
        continue;
      }
      try {
        const result = await found.invoke(call.args);
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content:
              typeof result === "string" ? result : JSON.stringify(result),
          }),
        );
      } catch (err) {
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      }
    }
  }

  throw new Error(
    `Chat tool loop exceeded ${MAX_ITERATIONS} iterations without a final reply`,
  );
}
