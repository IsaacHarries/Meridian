// Custom LangChain chat model for GitHub Copilot.
//
// Copilot's chat-completions endpoint is OpenAI-compatible but requires a
// specific set of editor-identification headers (Editor-Version, etc.) and
// the Copilot-Integration-Id, otherwise the request is rejected. The Rust
// backend handles OAuth token refresh (`refresh_copilot_token_if_needed`)
// before invoking the sidecar; this adapter only consumes the resolved
// access token and issues the chat completion request.
//
// Tool calls follow the OpenAI function-calling shape on the wire:
//   - Outbound `tools: [{ type: "function", function: { name, description,
//     parameters: <JSON Schema> } }]`
//   - Inbound assistant `tool_calls: [{ id, type: "function", function: {
//     name, arguments: "<JSON string>" } }]`
//   - ToolMessage replies become `{ role: "tool", tool_call_id, content }`
//
// Streaming uses the same endpoint with `stream: true` — Copilot returns a
// `text/event-stream` body of `data: {choices:[{delta:{content:"…"}}]}`
// frames terminated by `data: [DONE]`. Tool-call deltas arrive across
// multiple frames keyed by `index`; we forward them as `tool_call_chunks`
// so LangChain's `AIMessageChunk.concat` can merge them into a final
// `tool_calls` array on the accumulated chunk.
//
// Reference implementation: src-tauri/src/llms/copilot.rs (complete_multi_copilot).

import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { Runnable, RunnableConfig } from "@langchain/core/runnables";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

const COPILOT_API_BASE = "https://api.githubcopilot.com";
const COPILOT_INTEGRATION_ID = "vscode-chat";
const COPILOT_EDITOR_VERSION = "vscode/1.95.0";
const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.22.0";
const COPILOT_USER_AGENT = "GitHubCopilotChat/0.22.0";

// ── Wire types ────────────────────────────────────────────────────────────────

type WireToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

// ── Message conversion ────────────────────────────────────────────────────────

function aiMessageText(m: AIMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}

function aiMessageToolCalls(m: AIMessage): WireToolCall[] | undefined {
  const calls = m.tool_calls;
  if (!calls || calls.length === 0) return undefined;
  return calls.map((c, i) => ({
    id: c.id ?? `call_${i}`,
    type: "function",
    function: {
      name: c.name,
      arguments: JSON.stringify(c.args ?? {}),
    },
  }));
}

export function toCopilotMessages(messages: BaseMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  let systemBuffer = "";
  for (const m of messages) {
    if (m instanceof SystemMessage) {
      systemBuffer = systemBuffer ? `${systemBuffer}\n\n${m.text}` : m.text;
    } else if (m instanceof HumanMessage) {
      out.push({ role: "user", content: m.text });
    } else if (m instanceof AIMessage) {
      const toolCalls = aiMessageToolCalls(m);
      const wire: WireMessage = toolCalls
        ? { role: "assistant", content: aiMessageText(m), tool_calls: toolCalls }
        : { role: "assistant", content: aiMessageText(m) };
      out.push(wire);
    } else if (m instanceof ToolMessage) {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      out.push({
        role: "tool",
        tool_call_id: (m as ToolMessage).tool_call_id ?? "",
        content,
      });
    } else {
      out.push({ role: "user", content: m.text });
    }
  }
  if (systemBuffer) {
    out.unshift({ role: "system", content: systemBuffer });
  }
  return out;
}

export function toOpenAITools(tools: BindToolsInput[]): OpenAITool[] {
  return tools.map((t) => convertToOpenAITool(t) as OpenAITool);
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

export type ParsedToolCallChunk = {
  index: number;
  id?: string;
  name?: string;
  args?: string;
};

export type CompletionDelta = {
  /** Content tokens to surface to the caller. May be empty when the frame
   *  carries only tool-call deltas or only usage metadata. */
  content: string;
  /** Tool-call deltas in this frame. OpenAI streams tool calls as a stream
   *  of partial entries keyed by `index`; we forward them so concat can
   *  merge them into a final `tool_calls` array. */
  toolCallChunks?: ParsedToolCallChunk[];
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
    choices?: Array<{
      delta?: {
        content?: string;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  const delta = parsed.choices?.[0]?.delta;
  const content = delta?.content ?? "";
  const usage = parsed.usage
    ? {
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
      }
    : undefined;

  let toolCallChunks: ParsedToolCallChunk[] | undefined;
  if (delta?.tool_calls && delta.tool_calls.length > 0) {
    toolCallChunks = delta.tool_calls.map((tc, i) => ({
      index: tc.index ?? i,
      id: tc.id,
      name: tc.function?.name,
      args: tc.function?.arguments,
    }));
  }

  return { content, toolCallChunks, usage, done: false };
}

// ── Chat model ────────────────────────────────────────────────────────────────

export interface CopilotChatModelInput extends BaseChatModelParams {
  accessToken: string;
  model: string;
  maxTokens?: number;
}

export interface CopilotCallOptions extends BaseChatModelCallOptions {
  /** OpenAI-shaped `tools` array, set by `bindTools`. */
  openaiTools?: OpenAITool[];
}

export class CopilotChatModel extends BaseChatModel<CopilotCallOptions> {
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

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<CopilotCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CopilotCallOptions> {
    const openaiTools = toOpenAITools(tools);
    return this.withConfig({
      ...((kwargs ?? {}) as RunnableConfig),
      openaiTools,
    } as Partial<CopilotCallOptions>) as unknown as Runnable<
      BaseLanguageModelInput,
      AIMessageChunk,
      CopilotCallOptions
    >;
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

  private buildBody(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    stream: boolean,
  ): Record<string, unknown> {
    const wire = toCopilotMessages(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: wire,
      max_tokens: this.maxTokens,
      stream,
    };
    const tools = (options as CopilotCallOptions).openaiTools;
    if (tools && tools.length > 0) {
      body.tools = tools;
    }
    if (stream) {
      // Ask the server to include token counts on the final frame. Servers
      // that don't recognise the option ignore it, so this stays compatible
      // with older Copilot deployments.
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const body = this.buildBody(messages, options, false);

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
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const message = data.choices?.[0]?.message ?? {};
    const text = message.content ?? "";
    const rawCalls = message.tool_calls ?? [];

    if (!text && rawCalls.length === 0) {
      throw new Error(
        `Unexpected Copilot response shape: ${JSON.stringify(data)}`,
      );
    }

    const toolCalls = rawCalls
      .filter((c) => c.function?.name)
      .map((c, i) => {
        let args: Record<string, unknown> = {};
        const raw = c.function?.arguments ?? "";
        if (raw) {
          try {
            args = JSON.parse(raw);
          } catch {
            // Leave args as {} when the model emitted malformed JSON; the
            // tool layer will report the problem more cleanly than we can
            // here.
          }
        }
        return {
          id: c.id ?? `call_${i}`,
          name: c.function?.name as string,
          args,
          type: "tool_call" as const,
        };
      });

    if (text) {
      runManager?.handleLLMNewToken(text).catch(() => {});
    }

    return {
      generations: [
        {
          text,
          message: new AIMessage({
            content: text,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          }),
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
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const body = this.buildBody(messages, options, true);

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

    const handleDelta = (delta: CompletionDelta): ChatGenerationChunk | null => {
      const hasContent = !!delta.content;
      const hasToolCallChunks = !!(delta.toolCallChunks && delta.toolCallChunks.length > 0);
      if (!hasContent && !hasToolCallChunks) return null;

      if (hasContent) {
        runManager?.handleLLMNewToken(delta.content).catch(() => {});
      }

      const toolCallChunks = delta.toolCallChunks?.map((c) => ({
        index: c.index,
        id: c.id,
        name: c.name,
        args: c.args,
        type: "tool_call_chunk" as const,
      }));

      return new ChatGenerationChunk({
        text: delta.content,
        message: new AIMessageChunk({
          content: delta.content,
          tool_call_chunks: toolCallChunks,
        }),
      });
    };

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
          const chunk = handleDelta(delta);
          if (chunk) yield chunk;
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
          const chunk = handleDelta(delta);
          if (chunk) yield chunk;
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
