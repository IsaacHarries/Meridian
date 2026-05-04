// Tool-loop machinery for the Implement-Ticket Orchestrator:
//   - `makePipelineControlTools` — the propose_* + get_pipeline_state tools
//     the chat node binds in addition to the standard repo-inspection set.
//   - `runOrchestratorToolLoop` — the streamed tool loop (mirrors
//     runStreamingChatWithTools but records each tool call so the UI can
//     render it as a row in the chat thread).

import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { buildModel } from "../../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../../protocol.js";
import { PlanEditOpSchema } from "./schemas.js";
import { readPipelineSnapshot } from "./pipeline-snapshot.js";
import type { ProposalCollector } from "./proposal-collector.js";
import type {
  OrchestratorMessage,
  OrchestratorTools,
  PlanEditOp,
  ToolLoopOutcome,
} from "./types.js";

// ── Pipeline-control tools ───────────────────────────────────────────────────

/** Build the pipeline-control tools the orchestrator gets in addition to
 *  the standard repo-inspection set. Closure captures:
 *   - `pipelineThreadId` for read-only state lookup
 *   - `proposalCollector` so the propose_* tools record the user's pending
 *     decision in a place the chat node can read after the loop completes
 *   - `hasOpenProposal` flag so the tools refuse to stack proposals */
export function makePipelineControlTools(args: {
  pipelineThreadId: string | undefined;
  proposalCollector: ProposalCollector;
  hasOpenProposal: boolean;
}) {
  const { pipelineThreadId, proposalCollector, hasOpenProposal } = args;

  const refuseIfOpen = (): string | undefined => {
    if (hasOpenProposal || proposalCollector.current) {
      return (
        `Refused: there is already an outstanding proposal awaiting the user's decision. ` +
        `Wait for it to resolve before proposing another action.`
      );
    }
    return undefined;
  };

  const getPipelineState = tool(
    async () => {
      if (!pipelineThreadId) {
        return JSON.stringify({
          error:
            "No pipeline thread is associated with this orchestrator session yet — the pipeline may not have started.",
        });
      }
      try {
        const snap = await readPipelineSnapshot(pipelineThreadId);
        if (!snap) {
          return JSON.stringify({
            error: "Pipeline thread exists but has no checkpointed state yet.",
          });
        }
        return JSON.stringify(snap);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to read pipeline state: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    {
      name: "get_pipeline_state",
      description:
        "Read the current implementation pipeline's state: which stage it's on, whether a plan exists, " +
        "implementation/build/verification status, and the plan-revision counter. Use this to ground " +
        "review and proposal decisions in actual pipeline state rather than guessing from chat history.",
      schema: z.object({}),
    },
  );

  const proposeProceedPipeline = tool(
    async ({ rationale, action, reason }: { rationale: string; action: "approve" | "abort" | "revise"; reason?: string }) => {
      const refused = refuseIfOpen();
      if (refused) return refused;
      proposalCollector.current = {
        kind: "proceed",
        rationale,
        action,
        reason,
      };
      return (
        `Proposal recorded (action: ${action}). The developer will see a confirm card; ` +
        `pause and wait for their decision before any further pipeline actions.`
      );
    },
    {
      name: "propose_proceed_pipeline",
      description:
        "Suggest the developer advance the pipeline at the current checkpoint. " +
        "Does NOT execute — surfaces a confirm card that the developer accepts or rejects. " +
        "Use `action: 'approve'` to move forward, `action: 'abort'` to stop the pipeline, " +
        "`action: 'revise'` only at the replan checkpoint to enter plan revision.",
      schema: z.object({
        rationale: z
          .string()
          .describe(
            "One-sentence justification the developer will see on the confirm card.",
          ),
        action: z.enum(["approve", "abort", "revise"]),
        reason: z
          .string()
          .optional()
          .describe(
            "For action='abort': free-form reason recorded in the audit trail.",
          ),
      }),
    },
  );

  const proposeRewindPipeline = tool(
    async ({ rationale, toStage }: { rationale: string; toStage: string }) => {
      const refused = refuseIfOpen();
      if (refused) return refused;
      proposalCollector.current = {
        kind: "rewind",
        rationale,
        toStage,
      };
      return (
        `Rewind proposal recorded (target: ${toStage}). The developer will confirm before the rewind fires.`
      );
    },
    {
      name: "propose_rewind_pipeline",
      description:
        "Suggest rewinding the pipeline to a prior stage so it can re-run with new context. " +
        "Use when the current stage's output reveals an upstream stage missed something important. " +
        "Examples of valid `toStage` values: grooming, impact, triage, plan, implementation, tests_plan, " +
        "tests, review, pr.",
      schema: z.object({
        rationale: z.string(),
        toStage: z.string(),
      }),
    },
  );

  const proposeReplyTriage = tool(
    async ({ rationale, message }: { rationale: string; message: string }) => {
      const refused = refuseIfOpen();
      if (refused) return refused;
      proposalCollector.current = {
        kind: "reply",
        rationale,
        message,
      };
      return (
        `Triage-reply proposal recorded. The developer can accept (sends as-is), edit, or reject before it goes to the triage agent.`
      );
    },
    {
      name: "propose_reply_triage",
      description:
        "Only valid at the triage checkpoint. Drafts a reply message to send to the triage agent on " +
        "the developer's behalf — they accept/edit/reject before it's actually sent. Use when the " +
        "developer has expressed an opinion in chat that should now be communicated to the triage agent.",
      schema: z.object({
        rationale: z.string(),
        message: z
          .string()
          .describe("The proposed message body that will be sent to the triage agent on accept."),
      }),
    },
  );

  const proposePlanEdit = tool(
    async ({ rationale, edits }: { rationale: string; edits: PlanEditOp[] }) => {
      const refused = refuseIfOpen();
      if (refused) return refused;
      // Re-validate via Zod even though LangChain runs the schema — the
      // model can sometimes coerce a plain object that bypasses the
      // discriminated-union check. Belt and braces.
      const parsed = z.array(PlanEditOpSchema).min(1).safeParse(edits);
      if (!parsed.success) {
        return `Refused: edits failed validation — ${parsed.error.message}`;
      }
      proposalCollector.current = {
        kind: "edit_plan",
        rationale,
        edits: parsed.data,
      };
      return (
        `Plan-edit proposal recorded (${parsed.data.length} op(s)). ` +
        `The developer will see a confirm card with each op listed; the plan is NOT yet changed.`
      );
    },
    {
      name: "propose_plan_edit",
      description:
        "Suggest atomic edits to the implementation plan currently in pipeline state. " +
        "Use after `get_pipeline_state` to ensure the plan exists. Each `edit` is one " +
        "atomic op: add_file (full PlanFile), remove_file (path), update_file (path + " +
        "fields to change), set_summary (replace top-level summary), add_assumption " +
        "(append text), add_open_question (append text). Batched: the developer accepts " +
        "or rejects all ops together. Use sparingly — re-running the plan node via " +
        "propose_rewind_pipeline is preferred for substantive replans.",
      schema: z.object({
        rationale: z
          .string()
          .describe(
            "One- or two-sentence justification the developer will see on the confirm card.",
          ),
        edits: z.array(PlanEditOpSchema).min(1),
      }),
    },
  );

  const proposeGroomingEdit = tool(
    async ({
      rationale,
      editId,
      newStatus,
    }: {
      rationale: string;
      editId: string;
      newStatus: "approved" | "declined";
    }) => {
      const refused = refuseIfOpen();
      if (refused) return refused;
      proposalCollector.current = {
        kind: "accept_grooming_edit",
        rationale,
        editId,
        newStatus,
      };
      return `Grooming-edit proposal recorded (id ${editId} → ${newStatus}).`;
    },
    {
      name: "propose_grooming_edit",
      description:
        "Suggest accepting or declining a grooming-suggested AC edit. Use when the " +
        "developer has expressed an opinion in chat about a specific suggested edit " +
        "that hasn't been resolved yet. Surfaces a confirm card; the local grooming " +
        "edit only changes status on accept.",
      schema: z.object({
        rationale: z.string(),
        editId: z.string().describe("The grooming edit's id field."),
        newStatus: z.enum(["approved", "declined"]),
      }),
    },
  );

  return [
    getPipelineState,
    proposeProceedPipeline,
    proposeRewindPipeline,
    proposeReplyTriage,
    proposePlanEdit,
    proposeGroomingEdit,
  ];
}

// ── Tool loop ─────────────────────────────────────────────────────────────────

export const MAX_TOOL_LOOP_ITERATIONS = 12;

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}

export function summariseToolResult(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text.length <= 240) return text;
  return `${text.slice(0, 200)}… (${text.length} chars)`;
}

/** Streamed tool loop tailored for the orchestrator. Mirrors
 *  runStreamingChatWithTools but records each tool call so the UI can render
 *  it as a row in the chat thread (rather than only seeing the final reply). */
export async function runOrchestratorToolLoop(args: {
  workflowId: string;
  model: ModelSelection;
  tools: OrchestratorTools;
  systemPrompt: string;
  priorThread: OrchestratorMessage[];
  /** Stage names that already have a compressed summary in the system
   *  prompt. Raw turns from those stages are filtered out of the model's
   *  context to keep the prompt bounded as the conversation grows. */
  summarisedStages: Set<string>;
  newUserMessage: string;
  emit: (e: OutboundEvent) => void;
}): Promise<ToolLoopOutcome> {
  const {
    workflowId,
    model,
    tools,
    systemPrompt,
    priorThread,
    summarisedStages,
    newUserMessage,
    emit,
  } = args;

  const llm = buildModel(model);
  if (typeof llm.bindTools !== "function") {
    throw new Error(
      `Model ${llm._llmType()} does not support tool calls. The orchestrator requires a provider with native bindTools support.`,
    );
  }
  const llmWithTools = llm.bindTools(tools);

  // Build the message list from the prior thread (raw turns + compressed
  // tool-call breadcrumbs reconstructed as ToolMessages would distort the
  // model's view of its own past, so we render past tool calls as inline
  // assistant text rather than re-injecting them as ToolMessages).
  // Skip entries whose stage already has a summary in the system prompt —
  // their content is captured in the summary.
  //
  // For Anthropic providers, the system prompt is marked
  // `cache_control: ephemeral` so the orchestrator's stable preamble +
  // current-stage context block (~3-5k tokens, replayed verbatim every
  // turn) hits the prompt cache and bills at ~10% of normal input. The
  // OAuth subscription path preserves this marker through its
  // system → first-user-message rewrite. Other providers ignore the
  // unrecognised field, so this is safe to set unconditionally.
  const messages: BaseMessage[] = [
    new SystemMessage({
      content: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
    }),
  ];
  for (const m of priorThread) {
    if (m.stage && summarisedStages.has(m.stage)) continue;
    if (m.kind === "user") messages.push(new HumanMessage(m.content));
    else if (m.kind === "assistant") messages.push(new AIMessage(m.content));
    else if (m.kind === "system_note") {
      messages.push(new AIMessage(`[note] ${m.content}`));
    }
    // tool_call entries are skipped here — they're a UI artifact, not a
    // re-playable model turn. The model would need the original tool_call_id
    // pairing to reconcile, which we don't persist.
  }
  messages.push(new HumanMessage(newUserMessage));

  let reply = "";
  const toolEvents: Extract<OrchestratorMessage, { kind: "tool_call" }>[] = [];
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
    let accumulated: AIMessageChunk | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (await (llmWithTools as any).stream(
      messages,
    )) as AsyncIterable<AIMessageChunk>;
    for await (const chunk of stream) {
      const deltaText = extractText(chunk.content);
      if (deltaText) {
        emit({ id: workflowId, type: "stream", node: "orchestrator", delta: deltaText });
      }
      accumulated = accumulated ? accumulated.concat(chunk) : chunk;
    }
    if (!accumulated) {
      throw new Error("Orchestrator received an empty stream from the model");
    }

    // LangChain normalises Anthropic's per-call cache token counters
    // under `input_token_details.cache_creation` / `cache_read`. We
    // accumulate them separately from `input_tokens` so the badge can
    // show how much of this turn's input billed at the 1.25x write
    // rate vs the 0.1x read rate. (Anthropic also DOUBLE-COUNTS — the
    // SDK reports cache_creation + cache_read INSIDE input_tokens —
    // so for cost math the cached portion has already been factored
    // into `input_tokens`. We surface the breakdown for display only.)
    const u = accumulated.usage_metadata as
      | {
          input_tokens?: number;
          output_tokens?: number;
          input_token_details?: {
            cache_creation?: number;
            cache_read?: number;
          };
        }
      | undefined;
    usage.inputTokens += u?.input_tokens ?? 0;
    usage.outputTokens += u?.output_tokens ?? 0;
    usage.cacheCreationInputTokens += u?.input_token_details?.cache_creation ?? 0;
    usage.cacheReadInputTokens += u?.input_token_details?.cache_read ?? 0;

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
      return { reply, toolEvents, usage };
    }

    for (const call of calls) {
      const found = tools.find((t) => t.name === call.name) as
        | { invoke: (input: unknown) => Promise<unknown> }
        | undefined;
      if (!found) {
        const err = `unknown tool '${call.name}'`;
        toolEvents.push({
          kind: "tool_call",
          name: call.name,
          args: call.args,
          error: err,
          ts: Date.now(),
        });
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            content: `Error: ${err}`,
          }),
        );
        continue;
      }
      try {
        const result = await found.invoke(call.args);
        toolEvents.push({
          kind: "tool_call",
          name: call.name,
          args: call.args,
          resultSummary: summariseToolResult(result),
          ts: Date.now(),
        });
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content:
              typeof result === "string" ? result : JSON.stringify(result),
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolEvents.push({
          kind: "tool_call",
          name: call.name,
          args: call.args,
          error: msg,
          ts: Date.now(),
        });
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content: `Error: ${msg}`,
          }),
        );
      }
    }
  }

  throw new Error(
    `Orchestrator tool loop exceeded ${MAX_TOOL_LOOP_ITERATIONS} iterations without a final reply`,
  );
}
