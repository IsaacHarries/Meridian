import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelSelection } from "../protocol.js";
import { ClaudeOAuthChatModel } from "./anthropic-oauth.js";
import { GeminiCodeAssistChatModel } from "./gemini-codeassist.js";
import { CopilotChatModel } from "./copilot.js";
import { AiTrafficHandler, getAiCaptureCtx } from "../ai-capture.js";

export function buildModel(selection: ModelSelection): BaseChatModel {
  const { model, credentials } = selection;
  const built = buildModelInner(selection);

  // Attach the AI-traffic capture handler when the active workflow run
  // requested debug capture. AsyncLocalStorage propagates the scope
  // across all the async machinery between here and the model call,
  // so this single hook covers every workflow without each runner
  // having to wire it manually.
  const ctx = getAiCaptureCtx();
  if (ctx?.captureEnabled) {
    const existing = built.callbacks ?? [];
    const handlers = Array.isArray(existing) ? existing : [];
    built.callbacks = [...handlers, new AiTrafficHandler(ctx, credentials.provider, model)];
  }

  return built;
}

function buildModelInner(selection: ModelSelection): BaseChatModel {
  const { model, credentials, maxTokens } = selection;

  switch (credentials.provider) {
    case "anthropic": {
      if (credentials.mode === "oauth") {
        return new ClaudeOAuthChatModel({
          accessToken: credentials.accessToken,
          model,
          maxTokens,
        });
      }
      // ChatAnthropic's own default is conservative (~4K) and caused
      // truncation on long Plan / Code Review stages. When the user
      // hasn't set an explicit preference yet, pass nothing and let
      // the SDK pick its default; once they have, use their number.
      return new ChatAnthropic({
        apiKey: credentials.apiKey,
        model,
        ...(maxTokens != null ? { maxTokens } : {}),
      });
    }
    case "google": {
      if (credentials.mode === "oauth") {
        if (!credentials.project) {
          throw new Error(
            "Google CodeAssist OAuth requires a project ID. The Rust backend must call ensure_gemini_codeassist_project before dispatching the workflow.",
          );
        }
        return new GeminiCodeAssistChatModel({
          accessToken: credentials.accessToken,
          projectId: credentials.project,
          model,
          maxTokens,
        });
      }
      return new ChatGoogleGenerativeAI({
        apiKey: credentials.apiKey,
        model,
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
      });
    }
    case "ollama": {
      // Ollama caps at the loaded model's native context window. We
      // intentionally don't forward maxTokens here — the local server
      // is the source of truth, and overriding it produces confusing
      // mid-response truncation when a user picks a model with less
      // headroom than the global pref.
      return new ChatOllama({
        baseUrl: credentials.baseUrl,
        model,
      });
    }
    case "copilot": {
      return new CopilotChatModel({
        accessToken: credentials.accessToken,
        model,
        maxTokens,
      });
    }
    default: {
      const _exhaustive: never = credentials;
      throw new Error(`Unknown provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
