// Custom LangChain chat model for GitHub Copilot.
//
// Copilot's chat-completions endpoint is OpenAI-compatible but requires a
// specific set of editor-identification headers (Editor-Version, etc.) and
// the Copilot-Integration-Id, otherwise the request is rejected. The Rust
// backend handles OAuth token refresh (`refresh_copilot_token_if_needed`)
// before invoking the sidecar; this adapter only consumes the resolved
// access token and issues the chat completion request.
//
// Streaming uses the same endpoint with `stream: true` — Copilot returns a
// `text/event-stream` body of `data: {choices:[{delta:{content:"…"}}]}`
// frames terminated by `data: [DONE]`. The SSE parser is split into pure
// helpers so it can be unit-tested without mocking fetch.
//
// Reference implementation: src-tauri/src/llms/copilot.rs (complete_multi_copilot).

import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";

const COPILOT_API_BASE = "https://api.githubcopilot.com";
const COPILOT_INTEGRATION_ID = "vscode-chat";
const COPILOT_EDITOR_VERSION = "vscode/1.95.0";
const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.22.0";
const COPILOT_USER_AGENT = "GitHubCopilotChat/0.22.0";

type WireMessage = { role: "system" | "user" | "assistant"; content: string };

export function toCopilotMessages(messages: BaseMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  let systemBuffer = "";
  for (const m of messages) {
    if (m instanceof SystemMessage) {
      systemBuffer = systemBuffer ? `${systemBuffer}\n\n${m.text}` : m.text;
    } else if (m instanceof HumanMessage) {
      out.push({ role: "user", content: m.text });
    } else if (m instanceof AIMessage) {
      out.push({ role: "assistant", content: m.text });
    } else {
      out.push({ role: "user", content: m.text });
    }
  }
  if (systemBuffer) {
    out.unshift({ role: "system", content: systemBuffer });
  }
  return out;
}

// ── SSE parsing (pure helpers, exported for tests) ────────────────────────────

/**
 * Split an incrementally-built SSE buffer into complete events plus any
 * trailing partial frame. Each event is the concatenation of its `data:`
 * lines (per the SSE spec — multi-line data is joined with "\n"). Comment
 * lines (`:keep-alive`) and unrelated fields (`event:`, `id:`, `retry:`)
 * are ignored.
 */
export function parseSseFrames(buffer: string): {
  events: string[];
  remainder: string;
} {
  // Normalise CRLF → LF so the boundary check ("\n\n") works regardless of
  // how the server formatted line endings.
  const normalised = buffer.replace(/\r\n/g, "\n");
  const events: string[] = [];
  let cursor = 0;

  while (cursor < normalised.length) {
    const boundary = normalised.indexOf("\n\n", cursor);
    if (boundary === -1) break;

    const frame = normalised.slice(cursor, boundary);
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      let payload = line.slice(5);
      if (payload.startsWith(" ")) payload = payload.slice(1);
      dataLines.push(payload);
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join("\n"));
    }
    cursor = boundary + 2;
  }

  return { events, remainder: normalised.slice(cursor) };
}

export type CompletionDelta = {
  /** Content tokens to surface to the caller. May be empty for the final
   *  usage-only frame OpenAI-style endpoints emit when stream_options
   *  asks for usage. */
  content: string;
  /** Token counts, present on the final frame when the server includes them. */
  usage?: { promptTokens: number; completionTokens: number };
  /** True if the payload was the literal `[DONE]` sentinel — the loop must stop. */
  done: boolean;
};

/**
 * Parse one SSE event payload (the JSON body of a `data:` line) into the
 * fields we care about. Returns null if the payload is malformed JSON we
 * should skip rather than fail the whole stream.
 */
export function extractCompletionDelta(payload: string): CompletionDelta | null {
  if (payload === "[DONE]") return { content: "", done: true };

  let parsed: {
    choices?: Array<{ delta?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  const content = parsed.choices?.[0]?.delta?.content ?? "";
  const usage = parsed.usage
    ? {
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
      }
    : undefined;

  return { content, usage, done: false };
}

// ── Chat model ────────────────────────────────────────────────────────────────

export interface CopilotChatModelInput extends BaseChatModelParams {
  accessToken: string;
  model: string;
  maxTokens?: number;
}

export class CopilotChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private accessToken: string;
  private model: string;
  private maxTokens: number;

  constructor(input: CopilotChatModelInput) {
    super(input);
    this.accessToken = input.accessToken;
    this.model = input.model;
    this.maxTokens = input.maxTokens ?? 8192;
  }

  _llmType(): string {
    return "copilot";
  }

  private commonHeaders(accept: string): Record<string, string> {
    return {
      authorization: `Bearer ${this.accessToken}`,
      "content-type": "application/json",
      accept,
      "copilot-integration-id": COPILOT_INTEGRATION_ID,
      "editor-version": COPILOT_EDITOR_VERSION,
      "editor-plugin-version": COPILOT_EDITOR_PLUGIN_VERSION,
      "user-agent": COPILOT_USER_AGENT,
    };
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const wire = toCopilotMessages(messages);
    const body = {
      model: this.model,
      messages: wire,
      max_tokens: this.maxTokens,
      stream: false,
    };

    const res = await fetch(`${COPILOT_API_BASE}/chat/completions`, {
      method: "POST",
      headers: this.commonHeaders("application/json"),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Copilot ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) {
      throw new Error(
        `Unexpected Copilot response shape: ${JSON.stringify(data)}`,
      );
    }

    runManager?.handleLLMNewToken(text).catch(() => {});

    return {
      generations: [
        {
          text,
          message: new AIMessage({ content: text }),
        },
      ],
      llmOutput: {
        tokenUsage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          totalTokens:
            (data.usage?.prompt_tokens ?? 0) +
            (data.usage?.completion_tokens ?? 0),
        },
      },
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const wire = toCopilotMessages(messages);
    const body = {
      model: this.model,
      messages: wire,
      max_tokens: this.maxTokens,
      stream: true,
      // Ask the server to include token counts on the final frame. Servers
      // that don't recognise the option ignore it, so this stays compatible
      // with older Copilot deployments.
      stream_options: { include_usage: true },
    };

    const res = await fetch(`${COPILOT_API_BASE}/chat/completions`, {
      method: "POST",
      headers: this.commonHeaders("text/event-stream"),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Copilot ${res.status}: ${text}`);
    }
    if (!res.body) {
      throw new Error("Copilot streaming response had no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalUsage: CompletionDelta["usage"];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any final bytes the decoder is holding.
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        const { events, remainder } = parseSseFrames(buffer);
        buffer = remainder;

        for (const payload of events) {
          const delta = extractCompletionDelta(payload);
          if (!delta) continue;
          if (delta.done) {
            // OpenAI sends [DONE] after the usage frame — stop iteration but
            // keep any usage we already captured for the final emit below.
            return yield* emitFinal(finalUsage);
          }
          if (delta.usage) finalUsage = delta.usage;
          if (delta.content) {
            runManager?.handleLLMNewToken(delta.content).catch(() => {});
            yield new ChatGenerationChunk({
              text: delta.content,
              message: new AIMessageChunk({ content: delta.content }),
            });
          }
        }
      }

      // Some servers close the stream without an explicit [DONE]. Drain the
      // last partial buffer (if any), then fall through to the final emit.
      if (buffer.trim().length > 0) {
        const { events } = parseSseFrames(buffer + "\n\n");
        for (const payload of events) {
          const delta = extractCompletionDelta(payload);
          if (!delta || delta.done) continue;
          if (delta.usage) finalUsage = delta.usage;
          if (delta.content) {
            runManager?.handleLLMNewToken(delta.content).catch(() => {});
            yield new ChatGenerationChunk({
              text: delta.content,
              message: new AIMessageChunk({ content: delta.content }),
            });
          }
        }
      }

      yield* emitFinal(finalUsage);
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Emit one trailing empty chunk carrying `usage_metadata` (if known). The
 * downstream `AIMessageChunk.concat` accumulator sums usage across chunks,
 * so usage must be attached to exactly one chunk to avoid double-counting.
 */
async function* emitFinal(
  usage: CompletionDelta["usage"],
): AsyncGenerator<ChatGenerationChunk> {
  if (!usage) return;
  yield new ChatGenerationChunk({
    text: "",
    message: new AIMessageChunk({
      content: "",
      usage_metadata: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
      },
    }),
  });
}
