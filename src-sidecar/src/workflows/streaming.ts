// Shared streaming helper for one-shot text-returning workflows.
//
// Wraps `model.stream()` so workflows that previously called `llm.invoke()`
// can produce the same final string while emitting each token chunk as a
// `StreamEvent` on the way through. Each text delta is forwarded over the
// IPC channel, so the frontend can render the response incrementally
// instead of waiting for the full reply.
//
// Workflows that previously did:
//   const response = await llm.invoke(messages);
//   const text = extractText(response.content);
//   const usage = response.usage_metadata;
// now do:
//   const { text, usage } = await streamLLMText({ llm, messages, emit, ... });
// and get the same final string + usage.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  AIMessageChunk,
  BaseMessage,
} from "@langchain/core/messages";
import { parsePartialJson } from "@langchain/core/output_parsers";
import type { OutboundEvent } from "../protocol.js";

const PARTIAL_FLUSH_MS = 80;

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

export interface StreamLLMTextResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Stream a chat model response, forwarding each text delta as a
 * `StreamEvent` while accumulating the full reply for the caller. When
 * `emit` / `workflowId` / `nodeName` are absent the helper still streams
 * (so we get the final usage metadata that LangChain only attaches to the
 * stream's terminal chunk) but does not forward deltas — useful for
 * tests.
 */
export async function streamLLMText(args: {
  llm: BaseChatModel;
  messages: BaseMessage[];
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
}): Promise<StreamLLMTextResult> {
  const { llm, messages, emit, workflowId, nodeName } = args;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = (await (llm as any).stream(
    messages,
  )) as AsyncIterable<AIMessageChunk>;

  let text = "";
  let accumulated: AIMessageChunk | undefined;

  for await (const chunk of stream) {
    accumulated = accumulated ? accumulated.concat(chunk) : chunk;
    const delta = extractText(chunk.content);
    if (!delta) continue;
    text += delta;
    if (emit && workflowId && nodeName) {
      emit({
        id: workflowId,
        type: "stream",
        node: nodeName,
        delta,
      });
    }
  }

  const meta = accumulated?.usage_metadata as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;

  return {
    text,
    usage: {
      inputTokens: meta?.input_tokens ?? 0,
      outputTokens: meta?.output_tokens ?? 0,
    },
  };
}

export interface StreamLLMJsonResult {
  /** Final concatenated raw text — caller is responsible for validating it
   *  against a schema (Zod) once streaming completes. */
  raw: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Stream a chat model response that produces a JSON document, emitting
 * incremental partial-parsed objects as `progress` events while the JSON
 * tokens arrive. The deepest valid partial parse is sent on each flush so
 * the frontend can render fields as they fill in.
 *
 * `cleanText` is run on the accumulated raw text before parsePartialJson —
 * use it to strip code fences or sanitise common model glitches.
 */
export async function streamLLMJson(args: {
  llm: BaseChatModel;
  messages: BaseMessage[];
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
  cleanText?: (raw: string) => string;
}): Promise<StreamLLMJsonResult> {
  const { llm, messages, emit, workflowId, nodeName, cleanText } = args;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = (await (llm as any).stream(
    messages,
  )) as AsyncIterable<AIMessageChunk>;

  let raw = "";
  let accumulated: AIMessageChunk | undefined;
  let lastFlushAt = 0;
  let lastEmittedSize = -1;

  const tryFlush = (force: boolean) => {
    if (!emit || !workflowId || !nodeName) return;
    const now = Date.now();
    if (!force && now - lastFlushAt < PARTIAL_FLUSH_MS) return;

    const cleaned = cleanText ? cleanText(raw) : raw;
    if (cleaned.length === lastEmittedSize) return;

    const partial = parsePartialJson(cleaned);
    if (partial == null) return;

    lastFlushAt = now;
    lastEmittedSize = cleaned.length;
    emit({
      id: workflowId,
      type: "progress",
      node: nodeName,
      status: "started",
      data: { partial },
    });
  };

  for await (const chunk of stream) {
    accumulated = accumulated ? accumulated.concat(chunk) : chunk;
    const delta = extractText(chunk.content);
    if (delta) {
      raw += delta;
      tryFlush(false);
    }
  }
  tryFlush(true);

  const meta = accumulated?.usage_metadata as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;

  return {
    raw,
    usage: {
      inputTokens: meta?.input_tokens ?? 0,
      outputTokens: meta?.output_tokens ?? 0,
    },
  };
}
