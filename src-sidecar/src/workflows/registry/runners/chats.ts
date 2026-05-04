// Streaming-chat-with-tools runners (PR review chat, grooming chat, address
// PR chat). All three follow the same shape: validate input + history,
// drive runStreamingChatWithTools with the workflow-specific system prompt,
// emit progress + result events.

import type { ModelSelection } from "../../../protocol.js";
import { makeRepoTools } from "../../../tools/repo-tools.js";
import { runStreamingChatWithTools } from "../../chat-with-tools.js";
import {
  PrReviewChatInputSchema,
  PrReviewChatHistorySchema,
  buildPrReviewChatSystemPrompt,
} from "../../pr-review-chat.js";
import {
  AddressPrChatInputSchema,
  AddressPrChatHistorySchema,
  buildAddressPrChatSystemPrompt,
} from "../../address-pr-chat.js";
import {
  GroomingChatInputSchema,
  GroomingChatHistorySchema,
  buildGroomingChatSystemPrompt,
} from "../../grooming-chat.js";
import type { Emitter } from "../types.js";

// ── PR Review Chat runner ────────────────────────────────────────────────────

export async function runPrReviewChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = PrReviewChatInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid pr_review_chat input: ${parsed.error.message}`,
    });
    return;
  }
  const historyParsed = PrReviewChatHistorySchema.safeParse(
    JSON.parse(parsed.data.historyJson || "[]"),
  );
  if (!historyParsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid pr_review_chat history: ${historyParsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "started" });

  const tools = makeRepoTools({ workflowId, emit });
  let result: { reply: string; usage: { inputTokens: number; outputTokens: number } };
  try {
    result = await runStreamingChatWithTools({
      workflowId,
      model,
      tools,
      systemPrompt: buildPrReviewChatSystemPrompt(parsed.data),
      history: historyParsed.data,
      emit,
      nodeName: "reply",
    });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "completed" });

  emit({
    id: workflowId,
    type: "result",
    output: { reply: result.reply },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  });
}

// ── Grooming Chat runner ─────────────────────────────────────────────────────

export async function runGroomingChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = GroomingChatInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid grooming_chat input: ${parsed.error.message}`,
    });
    return;
  }
  const historyParsed = GroomingChatHistorySchema.safeParse(
    JSON.parse(parsed.data.historyJson || "[]"),
  );
  if (!historyParsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid grooming_chat history: ${historyParsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "started" });

  const tools = makeRepoTools({ workflowId, emit });
  let result: { reply: string; usage: { inputTokens: number; outputTokens: number } };
  try {
    result = await runStreamingChatWithTools({
      workflowId,
      model,
      tools,
      systemPrompt: buildGroomingChatSystemPrompt(parsed.data),
      history: historyParsed.data,
      emit,
      nodeName: "reply",
    });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "completed" });

  emit({
    id: workflowId,
    type: "result",
    output: { reply: result.reply },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  });
}

// ── Address PR Chat runner ───────────────────────────────────────────────────

export async function runAddressPrChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  const { workflowId, input, model, emit } = args;

  const parsed = AddressPrChatInputSchema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid address_pr_chat input: ${parsed.error.message}`,
    });
    return;
  }
  const historyParsed = AddressPrChatHistorySchema.safeParse(
    JSON.parse(parsed.data.historyJson || "[]"),
  );
  if (!historyParsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid address_pr_chat history: ${historyParsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "started" });

  const tools = makeRepoTools({ workflowId, emit });
  let result: { reply: string; usage: { inputTokens: number; outputTokens: number } };
  try {
    result = await runStreamingChatWithTools({
      workflowId,
      model,
      tools,
      systemPrompt: buildAddressPrChatSystemPrompt(parsed.data),
      history: historyParsed.data,
      emit,
      nodeName: "reply",
    });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: "reply", status: "completed" });

  emit({
    id: workflowId,
    type: "result",
    output: { reply: result.reply },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  });
}
