// Tool-calling loop machinery used by tool-using nodes (implementation,
// build-fix, test-plan, test-gen). Owns the per-iteration streaming, usage
// accumulation, optional `usagePartial` progress emission, and the loop's
// hard iteration cap.

import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { AIMessageChunk } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { OutboundEvent } from "../../protocol.js";
import type { RepoTools } from "../../tools/repo-tools.js";
import { tokenUsage } from "./helpers.js";

export const MAX_TOOL_LOOP_ITERATIONS = 15;

export interface ToolLoopResult {
  finalMessage: AIMessage;
  usage: { inputTokens: number; outputTokens: number };
  /** Paths the model successfully wrote during this loop. Used by the
   *  implementation node to recover from final-message parse failures: if the
   *  file was written, we can synthesise a success summary instead of
   *  declaring the file skipped. */
  writtenPaths: string[];
  /** The full conversation including the final response. Returned so callers
   *  (e.g. the implementation node's verify-after-write re-prompt) can append
   *  follow-up messages and continue the same conversation rather than
   *  starting a fresh tool loop with no context. */
  messages: BaseMessage[];
}

/** Run a tool-calling loop continuing an existing conversation. The caller
 *  owns the message list — they can pre-populate it with system + user, or
 *  pass back a list returned from a prior `runToolLoopFrom` call to extend
 *  the same conversation (used by the implementation node's verification
 *  re-prompt path).
 *
 *  When `emitCtx` is supplied, the loop forwards a `usagePartial` progress
 *  event to the workflow channel after each LLM iteration. That keeps the
 *  TokenUsageBadge climbing live during a long implementation run instead
 *  of staying at zero until the workflow's final result event fires
 *  minutes later. The implementation node (and any other tool-loop caller)
 *  is the only path where this matters; streamLLMText / streamLLMJson
 *  already emit usagePartial natively. */
export async function runToolLoopFrom(
  model: BaseChatModel,
  tools: RepoTools,
  messages: BaseMessage[],
  emitCtx?: {
    emit: (event: OutboundEvent) => void;
    workflowId: string;
    nodeName: string;
  },
  maxIterations: number = MAX_TOOL_LOOP_ITERATIONS,
): Promise<ToolLoopResult> {
  // Standard adapters (ChatAnthropic, ChatGoogleGenerativeAI, ChatOllama)
  // implement bindTools natively; the custom Claude OAuth adapter inherits
  // it from ChatAnthropic. Custom adapters that don't support bindTools
  // (Gemini CodeAssist, Copilot) will throw a clear error here — that's
  // expected for now; they're not used for tool-loop workflows.
  if (typeof model.bindTools !== "function") {
    throw new Error(
      `Model ${model._llmType()} does not support tool calls. Implementation pipeline requires a provider with native bindTools support (Anthropic API key, Anthropic OAuth via Claude.ai subscription, Google API key, or Ollama).`,
    );
  }

  const modelWithTools = model.bindTools(tools);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const writtenPaths: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    // Stream the model's reply so each text chunk surfaces to the
    // frontend live (graph.streamEvents picks up on_chat_model_stream
    // events and the runner forwards them as `stream` deltas) and so
    // adapters that only attach usage_metadata via the streaming
    // path (Gemini CodeAssist, Copilot) report tokens correctly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (await (modelWithTools as any).stream(
      messages,
    )) as AsyncIterable<AIMessageChunk>;
    let accumulated: AIMessageChunk | undefined;
    for await (const chunk of stream) {
      accumulated = accumulated ? accumulated.concat(chunk) : chunk;
    }
    if (!accumulated) {
      throw new Error("Tool loop received an empty stream from the model");
    }
    const response = new AIMessage({
      content: accumulated.content,
      tool_calls: accumulated.tool_calls,
      additional_kwargs: accumulated.additional_kwargs,
    });
    messages.push(response);
    const u = tokenUsage(accumulated.usage_metadata);
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;

    if (emitCtx && (u.inputTokens > 0 || u.outputTokens > 0)) {
      emitCtx.emit({
        id: emitCtx.workflowId,
        type: "progress",
        node: emitCtx.nodeName,
        status: "started",
        data: {
          usagePartial: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          },
        },
      });
    }

    const calls = response.tool_calls;
    if (!calls || calls.length === 0) {
      return { finalMessage: response, usage, writtenPaths, messages };
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
        if (call.name === "write_repo_file") {
          const path = (call.args as { path?: string } | undefined)?.path;
          if (path) writtenPaths.push(path);
        }
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content: typeof result === "string" ? result : JSON.stringify(result),
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
    `Tool loop exceeded ${maxIterations} iterations without producing a final response.`,
  );
}

export async function runToolLoop(
  model: BaseChatModel,
  tools: RepoTools,
  system: string,
  user: string,
  emitCtx?: {
    emit: (event: OutboundEvent) => void;
    workflowId: string;
    nodeName: string;
  },
  maxIterations: number = MAX_TOOL_LOOP_ITERATIONS,
): Promise<ToolLoopResult> {
  return runToolLoopFrom(
    model,
    tools,
    [new SystemMessage(system), new HumanMessage(user)],
    emitCtx,
    maxIterations,
  );
}
