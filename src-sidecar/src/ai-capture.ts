/**
 * AI traffic capture — opt-in developer tooling.
 *
 * When the frontend toggles the "Log AI traffic" debug switch, every
 * `workflow.start` / `workflow.resume` / `workflow.rewind` message
 * arrives with `debug: true`. The registry wraps each run inside an
 * AsyncLocalStorage scope holding the workflow id, emit channel, and
 * the live "captureEnabled" flag.
 *
 * `buildModel` checks the active scope and attaches an `AiTrafficHandler`
 * to the constructed model's default callbacks list, so every chat
 * round-trip — invoke or stream, tool-calling or plain — emits an
 * `ai_traffic` outbound event the Rust backend forwards to the
 * frontend's debug panel.
 *
 * The handler keeps a small per-run-id map of in-flight starts and
 * matches them to their `handleLLMEnd` (or `handleLLMError`) so the
 * emitted event carries both the request prompt and the response.
 *
 * Capture is scope-local — a single workflow run starts and ends the
 * scope, there is no global on/off switch the frontend has to reconcile
 * across runs. If `debug` is false on a given run, the scope is still
 * established but `captureEnabled` is false and `buildModel` skips
 * attaching the handler — keeping the steady-state hot path zero-cost.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { OutboundEvent } from "./protocol.js";

export interface AiCaptureCtx {
  workflowId: string;
  workflowName: string;
  emit: (e: OutboundEvent) => void;
  /** True when the inbound message asked for capture. False on
   *  ordinary runs — the scope still exists so callsites can read
   *  workflowName etc. but capture is a no-op. */
  captureEnabled: boolean;
}

const storage = new AsyncLocalStorage<AiCaptureCtx>();

export function getAiCaptureCtx(): AiCaptureCtx | undefined {
  return storage.getStore();
}

export function withAiCaptureCtx<T>(
  ctx: AiCaptureCtx,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

/** Convert a LangChain BaseMessage to a plain `{ role, content }` object
 *  the frontend can render without provider-specific knowledge. Content
 *  blocks are JSON-stringified so the panel can show raw structure if
 *  the user expands a turn. */
function serializeMessage(m: BaseMessage): { role: string; content: string } {
  const role = (() => {
    const t = m._getType();
    if (t === "human") return "user";
    if (t === "ai") return "assistant";
    if (t === "system") return "system";
    if (t === "tool") return "tool";
    return t;
  })();
  const content =
    typeof m.content === "string"
      ? m.content
      : JSON.stringify(m.content, null, 2);
  return { role, content };
}

interface PendingStart {
  startedAt: number;
  messages: Array<{ role: string; content: string }>;
  provider: string;
  model: string;
  node?: string;
}

/** LangChain callback handler that records request/response pairs and
 *  emits them to the workflow's outbound channel. Attached only when
 *  the scope's `captureEnabled` is true; idle otherwise. */
export class AiTrafficHandler extends BaseCallbackHandler {
  name = "ai_traffic";
  awaitHandlers = false;
  private pending = new Map<string, PendingStart>();

  constructor(
    private ctx: AiCaptureCtx,
    private provider: string,
    private model: string,
  ) {
    super();
  }

  async handleChatModelStart(
    _llm: unknown,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // LangChain passes `messages` as BaseMessage[][] (double-array) to
    // support batch invocations; we only ever submit one batch so flatten.
    const flat = messages[0] ?? [];
    const node =
      typeof metadata?.langgraph_node === "string"
        ? (metadata.langgraph_node as string)
        : undefined;
    this.pending.set(runId, {
      startedAt: Date.now(),
      messages: flat.map(serializeMessage),
      provider: this.provider,
      model: this.model,
      node,
    });
  }

  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const start = this.pending.get(runId);
    if (!start) return;
    this.pending.delete(runId);

    const generations = output.generations[0] ?? [];
    const responseText = generations
      .map((g) => g.text ?? "")
      .filter(Boolean)
      .join("\n\n");

    // Usage shape varies across providers — try a few common spots.
    const llmOutput = (output.llmOutput ?? {}) as {
      tokenUsage?: { promptTokens?: number; completionTokens?: number };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const usageA = llmOutput.tokenUsage;
    const usageB = llmOutput.usage;
    const usage = {
      inputTokens: usageA?.promptTokens ?? usageB?.input_tokens ?? 0,
      outputTokens: usageA?.completionTokens ?? usageB?.output_tokens ?? 0,
    };

    this.ctx.emit({
      id: this.ctx.workflowId,
      type: "ai_traffic",
      startedAt: start.startedAt,
      latencyMs: Date.now() - start.startedAt,
      provider: start.provider,
      model: start.model,
      workflow: this.ctx.workflowName,
      node: start.node,
      messages: start.messages,
      response: responseText,
      usage,
    });
  }

  async handleLLMError(err: Error, runId: string): Promise<void> {
    const start = this.pending.get(runId);
    if (!start) return;
    this.pending.delete(runId);

    this.ctx.emit({
      id: this.ctx.workflowId,
      type: "ai_traffic",
      startedAt: start.startedAt,
      latencyMs: Date.now() - start.startedAt,
      provider: start.provider,
      model: start.model,
      workflow: this.ctx.workflowName,
      node: start.node,
      messages: start.messages,
      response: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      error: err.message,
    });
  }
}
