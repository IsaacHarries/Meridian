// Custom LangChain chat model for GitHub Copilot.
//
// Copilot's chat-completions endpoint is OpenAI-compatible but requires a
// specific set of editor-identification headers (Editor-Version, etc.) and
// the Copilot-Integration-Id, otherwise the request is rejected. The Rust
// backend handles OAuth token refresh (`refresh_copilot_token_if_needed`)
// before invoking the sidecar; this adapter only consumes the resolved
// access token and issues the chat completion request.
//
// Reference implementation: src-tauri/src/llms/copilot.rs (complete_multi_copilot).

import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
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
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "copilot-integration-id": COPILOT_INTEGRATION_ID,
        "editor-version": COPILOT_EDITOR_VERSION,
        "editor-plugin-version": COPILOT_EDITOR_PLUGIN_VERSION,
        "user-agent": COPILOT_USER_AGENT,
      },
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

  async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    throw new Error("Streaming not yet implemented for CopilotChatModel");
  }
}
