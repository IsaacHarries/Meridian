// Custom LangChain chat model for Google Gemini via the CodeAssist OAuth path.
//
// The CodeAssist endpoint (cloudcode-pa.googleapis.com) accepts personal OAuth
// tokens and free-tier project IDs that the public Generative Language API
// rejects. The Rust backend handles OAuth token refresh and project ID
// onboarding before invoking the sidecar; this adapter only consumes the
// resolved access token + project ID and issues the generateContent request.
//
// Reference implementation: src-tauri/src/llms/gemini.rs (complete_multi_gemini_codeassist).

import { createHash, randomUUID } from "node:crypto";
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

const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com/v1internal";

// CodeAssist rejects `*-latest` aliases — translate to concrete versions
// matching what the official gemini-cli ships.
const CODE_ASSIST_MODEL_ALIASES: Record<string, string> = {
  "gemini-flash-latest": "gemini-2.5-flash",
  "gemini-2.5-flash-latest": "gemini-2.5-flash",
  "gemini-pro-latest": "gemini-2.5-pro",
  "gemini-2.5-pro-latest": "gemini-2.5-pro",
  "gemini-flash-lite-latest": "gemini-2.5-flash-lite",
  "gemini-2.5-flash-lite-latest": "gemini-2.5-flash-lite",
};

export function resolveCodeAssistModel(model: string): string {
  return CODE_ASSIST_MODEL_ALIASES[model] ?? model;
}

function geminiCliUserAgent(model: string): string {
  const version = "0.2.0"; // sidecar version; surface-classification only
  const os = process.platform;
  const arch = process.arch;
  return `GeminiCLI/${version}/${model} (${os}; ${arch}; meridian)`;
}

// Stable per-process session ID — the CodeAssist server uses this to recognise
// follow-up requests as part of the same conversation.
const SIDECAR_SESSION_ID: string = (() => {
  const seed = `meridian-sidecar-${Date.now()}-${process.pid}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
})();

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: unknown } };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiTool = {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
};

export function toGeminiContents(messages: BaseMessage[]): {
  system: string;
  contents: GeminiContent[];
} {
  let system = "";
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m instanceof SystemMessage) {
      system = system ? `${system}\n\n${m.text}` : m.text;
    } else if (m instanceof HumanMessage) {
      contents.push({ role: "user", parts: [{ text: m.text }] });
    } else if (m instanceof AIMessage) {
      const parts: GeminiPart[] = [];
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((b) =>
                  typeof b === "string" ? b : (b as { text?: string }).text ?? "",
                )
                .join("")
            : "";
      if (text) parts.push({ text });
      const toolCalls = (m as AIMessage).tool_calls;
      if (toolCalls?.length) {
        for (const tc of toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.args ?? {} } });
        }
      }
      if (parts.length === 0) parts.push({ text: "" });
      contents.push({ role: "model", parts });
    } else if (m instanceof ToolMessage) {
      // Function response. ToolMessage has the tool's name in `name` field
      // (set by the caller when constructing the message). Try to JSON-parse
      // the content; fall back to wrapping a string.
      const name = (m as ToolMessage).name ?? "unknown_tool";
      const raw = typeof m.content === "string" ? m.content : "";
      let response: unknown;
      try {
        response = JSON.parse(raw);
        if (typeof response !== "object" || response === null) {
          response = { result: raw };
        }
      } catch {
        response = { result: raw };
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response } }],
      });
    } else {
      contents.push({ role: "user", parts: [{ text: m.text }] });
    }
  }
  return { system, contents };
}

/**
 * Strip JSON Schema fields the Gemini CodeAssist endpoint rejects with
 * `Invalid JSON payload received. Unknown name "$schema" ...`. Gemini wants
 * a minimal subset (type/properties/required/items/enum/description) — not
 * the full Draft-07 metadata that zod-to-json-schema emits.
 */
const GEMINI_REJECTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
  "default",
  "examples",
  "title",
]);

function cleanSchemaForGemini(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchemaForGemini);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (GEMINI_REJECTED_SCHEMA_KEYS.has(key)) continue;
      out[key] = cleanSchemaForGemini(v);
    }
    return out;
  }
  return value;
}

function toGeminiTools(tools: BindToolsInput[]): GeminiTool {
  const functionDeclarations = tools.map((t) => {
    const openai = convertToOpenAITool(t) as {
      function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
      };
    };
    return {
      name: openai.function.name,
      description: openai.function.description,
      parameters: openai.function.parameters
        ? (cleanSchemaForGemini(openai.function.parameters) as Record<string, unknown>)
        : undefined,
    };
  });
  return { functionDeclarations };
}

export interface GeminiCodeAssistChatModelInput extends BaseChatModelParams {
  accessToken: string;
  projectId: string;
  model: string;
  maxTokens?: number;
}

export interface GeminiCodeAssistCallOptions extends BaseChatModelCallOptions {
  /** `functionDeclarations`-shaped tools, set by `bindTools`. */
  geminiTools?: GeminiTool;
}

export class GeminiCodeAssistChatModel extends BaseChatModel<GeminiCodeAssistCallOptions> {
  private accessToken: string;
  private projectId: string;
  private model: string;
  private maxTokens: number;

  constructor(input: GeminiCodeAssistChatModelInput) {
    super(input);
    this.accessToken = input.accessToken;
    this.projectId = input.projectId;
    this.model = input.model;
    // Gemini 2.5 supports much larger output budgets than the historical
    // 8192-token cap. Grooming + implementation responses are often long
    // structured JSON, and truncated output corrupts the JSON parse — bump
    // the default so we don't silently lose the back half of the response.
    this.maxTokens = input.maxTokens ?? 32768;
  }

  _llmType(): string {
    return "gemini-codeassist";
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<GeminiCodeAssistCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, GeminiCodeAssistCallOptions> {
    const geminiTools = toGeminiTools(tools);
    return this.withConfig({
      ...((kwargs ?? {}) as RunnableConfig),
      geminiTools,
    } as Partial<GeminiCodeAssistCallOptions>) as unknown as Runnable<
      BaseLanguageModelInput,
      AIMessageChunk,
      GeminiCodeAssistCallOptions
    >;
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const resolvedModel = resolveCodeAssistModel(this.model);
    const { system, contents } = toGeminiContents(messages);

    const request: Record<string, unknown> = {
      contents,
      session_id: SIDECAR_SESSION_ID,
      generationConfig: { maxOutputTokens: this.maxTokens },
    };
    if (system.trim()) {
      request.systemInstruction = { parts: [{ text: system }] };
    }
    const geminiTools = (options as GeminiCodeAssistCallOptions).geminiTools;
    if (geminiTools && geminiTools.functionDeclarations.length > 0) {
      request.tools = [geminiTools];
    }

    const body = {
      model: resolvedModel,
      project: this.projectId,
      user_prompt_id: randomUUID(),
      request,
    };

    const res = await fetch(`${CODE_ASSIST_BASE}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.accessToken}`,
        "user-agent": geminiCliUserAgent(resolvedModel),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Gemini CodeAssist ${res.status} (model=${resolvedModel}, project=${this.projectId}): ${text}`,
      );
    }

    const data = (await res.json()) as {
      response?: {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              functionCall?: { name: string; args: Record<string, unknown> };
            }>;
          };
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
      };
    };

    const parts = data.response?.candidates?.[0]?.content?.parts ?? [];
    let text = "";
    const toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      type: "tool_call";
    }> = [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text) {
        text += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: randomUUID(),
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
          type: "tool_call",
        });
      }
    }
    if (!text && toolCalls.length === 0) {
      throw new Error(
        `Unexpected CodeAssist response shape: ${JSON.stringify(data)}`,
      );
    }

    if (text) {
      runManager?.handleLLMNewToken(text).catch(() => {});
    }

    const usage = data.response?.usageMetadata;
    const message = new AIMessage({
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    return {
      generations: [{ text, message }],
      llmOutput: {
        tokenUsage: {
          promptTokens: usage?.promptTokenCount ?? 0,
          completionTokens: usage?.candidatesTokenCount ?? 0,
          totalTokens:
            (usage?.promptTokenCount ?? 0) +
            (usage?.candidatesTokenCount ?? 0),
        },
      },
    };
  }

  /**
   * Stream from CodeAssist's `:streamGenerateContent?alt=sse` endpoint so
   * each text delta lands as a separate chunk and usage metadata can be
   * attached to a final empty chunk. Without this LangChain's stream path
   * sees a single full-response chunk (no live UI typing) and never sees
   * `usage_metadata` on the chunks (so the streaming helpers can't emit
   * `usagePartial` events to the frontend).
   *
   * Wire format: `data: {response: <PartialGenerateResponse>}` SSE frames
   * separated by blank lines. The terminal frame carries `usageMetadata`.
   * Tool calls arrive as `functionCall` parts (whole at once — Gemini does
   * not stream tool-call argument deltas like OpenAI does).
   */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const resolvedModel = resolveCodeAssistModel(this.model);
    const { system, contents } = toGeminiContents(messages);

    const request: Record<string, unknown> = {
      contents,
      session_id: SIDECAR_SESSION_ID,
      generationConfig: { maxOutputTokens: this.maxTokens },
    };
    if (system.trim()) {
      request.systemInstruction = { parts: [{ text: system }] };
    }
    const geminiTools = (options as GeminiCodeAssistCallOptions).geminiTools;
    if (geminiTools && geminiTools.functionDeclarations.length > 0) {
      request.tools = [geminiTools];
    }

    const body = {
      model: resolvedModel,
      project: this.projectId,
      user_prompt_id: randomUUID(),
      request,
    };

    const res = await fetch(
      `${CODE_ASSIST_BASE}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.accessToken}`,
          accept: "text/event-stream",
          "user-agent": geminiCliUserAgent(resolvedModel),
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Gemini CodeAssist stream ${res.status} (model=${resolvedModel}, project=${this.projectId}): ${text}`,
      );
    }
    if (!res.body) {
      throw new Error("Gemini CodeAssist streaming response had no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastUsage:
      | { promptTokenCount?: number; candidatesTokenCount?: number }
      | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        const { events, remainder } = parseGeminiSseFrames(buffer);
        buffer = remainder;
        for (const payload of events) {
          for (const chunk of handleGeminiFrame(payload, runManager, (u) => {
            lastUsage = u;
          })) {
            yield chunk;
          }
        }
      }
      if (buffer.trim().length > 0) {
        const { events } = parseGeminiSseFrames(buffer + "\n\n");
        for (const payload of events) {
          for (const chunk of handleGeminiFrame(payload, runManager, (u) => {
            lastUsage = u;
          })) {
            yield chunk;
          }
        }
      }

      if (lastUsage) {
        const inputTokens = lastUsage.promptTokenCount ?? 0;
        const outputTokens = lastUsage.candidatesTokenCount ?? 0;
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: "",
            usage_metadata: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            },
          }),
        });
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ── SSE parsing helpers (pure, exported for tests) ───────────────────────────

/**
 * Split an incrementally-built SSE buffer into complete events plus any
 * trailing partial frame. Each event is the concatenation of its `data:`
 * lines (per the SSE spec). Comment lines and unrelated fields are ignored.
 */
export function parseGeminiSseFrames(buffer: string): {
  events: string[];
  remainder: string;
} {
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
    if (dataLines.length > 0) events.push(dataLines.join("\n"));
    cursor = boundary + 2;
  }
  return { events, remainder: normalised.slice(cursor) };
}

type GeminiStreamFrame = {
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: { name: string; args: Record<string, unknown> };
        }>;
      };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };
};

function* handleGeminiFrame(
  payload: string,
  runManager: CallbackManagerForLLMRun | undefined,
  recordUsage: (u: NonNullable<GeminiStreamFrame["response"]>["usageMetadata"]) => void,
): Generator<ChatGenerationChunk> {
  let parsed: GeminiStreamFrame;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  const response = parsed.response;
  if (!response) return;
  if (response.usageMetadata) recordUsage(response.usageMetadata);

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  let text = "";
  const toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    type: "tool_call";
  }> = [];
  for (const part of parts) {
    if (typeof part.text === "string" && part.text) text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: randomUUID(),
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
        type: "tool_call",
      });
    }
  }
  if (!text && toolCalls.length === 0) return;
  if (text) {
    runManager?.handleLLMNewToken(text).catch(() => {});
  }
  yield new ChatGenerationChunk({
    text,
    message: new AIMessageChunk({
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    }),
  });
}
