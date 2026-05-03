// Implement-Ticket Orchestrator workflow.
//
// A long-lived chat agent that survives across the entire ticket lifecycle.
// Unlike the per-stage `checkpoint_chat` workflow this replaces, the
// orchestrator carries its own message thread + summarised stage history +
// persistent user notes via a LangGraph SQLite checkpointer.
//
// Architecture:
//   - One persistent thread per ticket (orchestratorThreadId, distinct from
//     the sibling implementation_pipeline thread that drives stages).
//   - Single chat node + tool loop. Each user message is one graph invocation
//     with `pendingUserMessage` set; the node consumes it, runs the model,
//     appends both turns to `thread`, then ends.
//   - Subsequent invocations on the same thread_id rehydrate the prior state
//     from the checkpointer; the `thread` reducer appends new turns.
//
// Step-2 capabilities (this file):
//   - Repo-inspection tools (glob/grep/read/diff) — same set sub-agents use.
//   - `get_pipeline_state` — reads the sibling pipeline workflow's checkpoint
//     so the orchestrator can ground review without the frontend supplying
//     contextText every turn.
//   - `propose_*` pipeline-control tools — they DO NOT execute the pipeline
//     action; they write a `pendingProposal` to orchestrator state. The
//     frontend renders a confirm card; the user accepts or rejects; the
//     pipeline is then resumed via the existing Tauri command. This honours
//     the "all mutations require user confirmation" guardrail.
//   - Reviewer-style turns: when the runner is invoked with
//     `messageKind: "system_note"`, the synthesised message is rendered in
//     the chat thread as an inline marker (e.g. "Pipeline reached impact —
//     reviewing…") rather than a user bubble.

import { createHash } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
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
import { buildModel } from "../models/factory.js";
import { getCheckpointer } from "../checkpointer.js";
import { makeRepoTools, type RepoTools } from "../tools/repo-tools.js";
import { buildPipelineGraph } from "./pipeline.js";
import { PlanFileSchema } from "./pipeline-schemas.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";

// ── Input schema ──────────────────────────────────────────────────────────────

export const OrchestratorInputSchema = z.object({
  /** The orchestrator's persistent thread id. Generated on first turn by the
   *  caller (typically derived from the ticket key) and reused for every
   *  subsequent message so SQLite can rehydrate state. */
  threadId: z.string().min(1),
  /** The sibling implementation-pipeline thread id. Stored in state on the
   *  first turn; pipeline-control tools use it via `get_pipeline_state` and
   *  the propose_* tools. Optional because some early turns may happen
   *  before the pipeline has started. */
  pipelineThreadId: z.string().optional(),
  /** Text the runner appends to the conversation. For user-typed messages
   *  this is verbatim user input; for stage reviews and proposal-resolution
   *  notifications the frontend (or Rust) synthesises a prompt and tags it
   *  via `messageKind: "system_note"` so the UI renders it as an inline
   *  marker rather than a user bubble. */
  message: z.string(),
  /** Render hint. `"user"` (default) is a normal user message; `"system_note"`
   *  is a synthetic review-trigger or proposal-outcome ping that the UI
   *  shows as a divider. The model sees it as a HumanMessage either way —
   *  the kind only affects UI rendering and thread persistence. */
  messageKind: z.enum(["user", "system_note"]).optional().default("user"),
  /** Current pipeline stage at the time of the message — frontend tells us
   *  what the user is looking at so the orchestrator's system prompt can
   *  tailor advice. The orchestrator can also discover this via the
   *  `get_pipeline_state` tool. */
  currentStage: z.string().optional(),
  /** Free-form context summary the frontend can supply per turn (e.g. the
   *  current stage's structured output rendered as text). Cheap to include
   *  even when the orchestrator could fetch it via tools — saves a round
   *  trip on the first turn at every checkpoint. */
  contextText: z.string().optional(),
  /** When true, the runner clears `state.pendingProposal` before processing
   *  this turn. Set by the frontend after the user accepts/rejects an
   *  outstanding proposal so the next orchestrator turn doesn't see a
   *  stale "outstanding proposal" entry in its system prompt. The frontend
   *  should also send a system_note message describing the resolution. */
  clearPendingProposal: z.boolean().optional().default(false),
  /** Stage names whose compressed summaries are now stale and should be
   *  dropped from `state.stageSummaries`. Set by the frontend after a
   *  rewind so summaries from stages that came AFTER the rewind target
   *  don't leak forward into the new run. Names match `currentStage`
   *  values (e.g. "implementation", "test_plan"). */
  dropSummariesForStages: z.array(z.string()).optional().default([]),
});

export type OrchestratorInput = z.infer<typeof OrchestratorInputSchema>;

// ── Pending-proposal shape ────────────────────────────────────────────────────

/** Atomic plan mutation. The orchestrator proposes a sequence of these via
 *  `propose_plan_edit`; the user accepts the whole batch or rejects. Each op
 *  applies to `state.plan` on the pipeline workflow's checkpointed state. */
export const PlanEditOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_file"),
    file: PlanFileSchema,
  }),
  z.object({
    op: z.literal("remove_file"),
    path: z.string(),
  }),
  z.object({
    op: z.literal("update_file"),
    path: z.string(),
    /** Fields to replace on the matching plan file. Only the fields present
     *  are applied; omitted fields are kept as-is. */
    fields: z
      .object({
        action: z.enum(["create", "modify", "delete"]).optional(),
        description: z.string().optional(),
      })
      .refine((f) => Object.keys(f).length > 0, {
        message: "update_file must change at least one field",
      }),
  }),
  z.object({
    op: z.literal("set_summary"),
    summary: z.string().min(1),
  }),
  z.object({
    op: z.literal("add_assumption"),
    text: z.string().min(1),
  }),
  z.object({
    op: z.literal("add_open_question"),
    text: z.string().min(1),
  }),
]);

export type PlanEditOp = z.infer<typeof PlanEditOpSchema>;

/** A proposal the orchestrator made via a `propose_*` tool. The frontend
 *  reads this from the workflow result and renders a confirm card; the
 *  underlying mutation (pipeline resume / rewind / state edit) only fires on
 *  explicit user accept. */
export const PendingProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("proceed"),
    rationale: z.string(),
    /** Resume action to apply on accept. */
    action: z.enum(["approve", "abort", "revise"]),
    /** For `abort`: the reason text shown in the audit trail. */
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("rewind"),
    rationale: z.string(),
    toStage: z.string(),
  }),
  z.object({
    kind: z.literal("reply"),
    rationale: z.string(),
    /** Triage `reply` action: text the orchestrator drafted that the user
     *  can accept (sends as-is), edit, or reject. */
    message: z.string(),
  }),
  z.object({
    kind: z.literal("edit_plan"),
    rationale: z.string(),
    /** Atomic ops to apply to `state.plan` in order. Validated by Zod at
     *  proposal time so the orchestrator can't stage malformed mutations. */
    edits: z.array(PlanEditOpSchema).min(1),
  }),
  z.object({
    kind: z.literal("accept_grooming_edit"),
    rationale: z.string(),
    /** The grooming edit's id (matches `groomingEdits[i].id` in the store). */
    editId: z.string(),
    /** New status to apply on accept — typically "approved" or "declined". */
    newStatus: z.enum(["approved", "declined"]),
  }),
]);

export type PendingProposal = z.infer<typeof PendingProposalSchema>;

// ── Persisted message shape ───────────────────────────────────────────────────

/** Lightweight per-turn record stored in the orchestrator's checkpointed
 *  state. We don't persist BaseMessage instances directly because their tool-
 *  call/structured-content shapes don't round-trip cleanly through the
 *  SQLite checkpointer's JSON serialiser. The `kind` discriminator lets the
 *  UI render assistant prose, user prose, and tool-call rows distinctly
 *  without inferring from content. */
export const OrchestratorMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    content: z.string(),
    ts: z.number(),
    /** Pipeline stage this turn occurred during. Used by the compression
     *  hook to find/summarise prior-stage turns and to filter them out of
     *  prompt context once a summary exists. Optional because early turns
     *  before the pipeline starts have no stage. */
    stage: z.string().optional(),
  }),
  z.object({
    kind: z.literal("assistant"),
    content: z.string(),
    ts: z.number(),
    stage: z.string().optional(),
  }),
  z.object({
    kind: z.literal("tool_call"),
    name: z.string(),
    args: z.unknown(),
    /** A short summary of the result for the UI (full result lives in the
     *  model's working context only). */
    resultSummary: z.string().optional(),
    error: z.string().optional(),
    ts: z.number(),
    stage: z.string().optional(),
  }),
  /** Inline system breadcrumb (e.g. "Moved to Impact Analysis", "Proposed:
   *  advance to triage", "User accepted — pipeline advanced") that appears
   *  in the chat thread. Distinct from `assistant` so the UI can render it
   *  as a divider rather than a chat bubble. Live proposals (still awaiting
   *  user decision) are tracked separately on the `pendingProposal`
   *  channel — that's the source of truth for which confirm card to show. */
  z.object({
    kind: z.literal("system_note"),
    content: z.string(),
    ts: z.number(),
    stage: z.string().optional(),
  }),
]);

export type OrchestratorMessage = z.infer<typeof OrchestratorMessageSchema>;

// ── State reducers (exported for unit tests) ─────────────────────────────────

/** Append-only reducer for the orchestrator chat thread. */
export function threadReducer(
  current: OrchestratorMessage[],
  update: OrchestratorMessage[],
): OrchestratorMessage[] {
  return [...current, ...update];
}

/** Merge-with-delete reducer for compressed per-stage summaries. Keys whose
 *  update value is `undefined` are removed; everything else is set. The
 *  undefined-as-delete behaviour is what the rewind invalidation path
 *  relies on (`dropSummariesForStages` writes `{[stage]: undefined}`). */
export function stageSummariesReducer(
  current: Record<string, string>,
  update: Record<string, string | undefined>,
): Record<string, string> {
  const next: Record<string, string> = { ...current };
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined) {
      delete next[k];
    } else {
      next[k] = v;
    }
  }
  return next;
}

// ── State annotation ──────────────────────────────────────────────────────────

const OrchestratorStateAnnotation = Annotation.Root({
  /** Sibling pipeline thread the orchestrator drives via control tools. */
  pipelineThreadId: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
  /** Lossless conversation log. Reducer appends every turn. UI renders this
   *  in full; the model's prompt context uses a compressed form (see
   *  `stageSummaries`) once stages start advancing. */
  thread: Annotation<OrchestratorMessage[]>({
    reducer: threadReducer,
    default: () => [],
  }),
  /** Compressed per-stage notes. Populated by the compression hook on stage
   *  transitions. Update semantics: keys with string values are added or
   *  overwritten; keys with `undefined` values are deleted. The undefined
   *  semantics let `dropSummariesForStages` (used after a rewind) remove
   *  stale summaries without rewriting the whole map. */
  stageSummaries: Annotation<Record<string, string>>({
    reducer: stageSummariesReducer,
    default: () => ({}),
  }),
  /** Long-lived "user told me X" facts the orchestrator decides are worth
   *  remembering across stages. Reducer appends. The model can choose to
   *  write here via a future `add_user_note` tool. */
  userNotes: Annotation<string[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  /** Last-known pipeline stage. Updated each turn from input; future
   *  stage-transition detection compares this to detect advances. */
  currentStage: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
  /** Per-turn input. The runner sets this on each invocation; the chat node
   *  consumes it and writes back `undefined`. Reducer is "replace" so the
   *  next invocation can overwrite cleanly. */
  pendingUserMessage: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /** Render hint for the current pending message ("user" vs "system_note"). */
  pendingMessageKind: Annotation<"user" | "system_note">({
    reducer: (_current, update) => update,
    default: () => "user" as const,
  }),
  /** Per-turn context blob from the frontend (rendered stage output, etc.).
   *  Replaced each turn — never stored across invocations. */
  pendingContextText: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /** SHA-256 of the most recent `pendingContextText` actually rendered
   *  into a system prompt. The chat node compares the incoming context
   *  hash against this and skips the (often multi-k) context block on
   *  turns where the stage state hasn't changed — the prior thread
   *  already carries it, and the agent can pull fresh state via the
   *  `get_pipeline_state` tool when it actually needs to. Persisted
   *  with the rest of the orchestrator state so the dedup survives
   *  process restarts. */
  lastContextHash: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /** Current outstanding proposal (if any). Set when a `propose_*` tool
   *  runs; cleared by the runner once a turn carrying a proposal-outcome
   *  system_note has been processed. The UI uses this to know which chat
   *  thread entry's accept/reject buttons are still live. */
  pendingProposal: Annotation<PendingProposal | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  usage: Annotation<{ inputTokens: number; outputTokens: number }>({
    reducer: (current, update) => ({
      inputTokens: (current?.inputTokens ?? 0) + update.inputTokens,
      outputTokens: (current?.outputTokens ?? 0) + update.outputTokens,
    }),
    default: () => ({ inputTokens: 0, outputTokens: 0 }),
  }),
});

export type OrchestratorState = typeof OrchestratorStateAnnotation.State;

// ── System prompt ─────────────────────────────────────────────────────────────

/** Build the orchestrator's system prompt. Includes any compressed stage
 *  summaries and persistent user notes so the agent has continuity even
 *  after the raw turns for prior stages get dropped from prompt context. */
export function buildOrchestratorSystem(state: {
  currentStage: string | undefined;
  stageSummaries: Record<string, string>;
  userNotes: string[];
  pendingContextText: string | undefined;
  pendingProposal: PendingProposal | undefined;
}): string {
  const sections: string[] = [];

  sections.push(
    `You are the orchestrator agent for a senior engineer working through a JIRA ticket via a multi-stage AI pipeline.\n\n` +
      `Your role: be a hands-on collaborator across the entire ticket lifecycle. You carry continuity that no individual sub-agent has — ` +
      `the full conversation across grooming, impact, triage, plan, implementation, tests, review, and PR.\n\n` +
      `=== YOUR THREE MODES ===\n\n` +
      `1. CONVERSATIONAL — answering the developer's questions. Use repo tools (read/glob/grep/diff) and \`get_pipeline_state\` to ground answers.\n\n` +
      `2. REVIEWER — when the system surfaces a stage's output (you'll see a "system_note" in your turn saying the {stage} agent just produced X), ` +
      `run a brief review pass. Your job is the cross-stage continuity check: does this output align with what the developer told you earlier? ` +
      `Did the sub-agent miss something we discussed? Is anything inconsistent or worth flagging? Be concise — usually 1-3 sentences. ` +
      `If everything looks good, say so plainly so the developer can confidently move on.\n\n` +
      `3. PIPELINE DRIVER — when the developer indicates they're ready to advance (or you've reviewed and everything looks fine), ` +
      `you may PROPOSE a pipeline action via a propose_* tool. **You never execute pipeline actions directly** — proposals create a confirm ` +
      `card the developer accepts or rejects. Examples: "Looks good — want me to advance to triage?" then call propose_proceed_pipeline. ` +
      `If rewinding is warranted (e.g. grooming missed an AC the developer just mentioned), call propose_rewind_pipeline.\n\n` +
      `=== HARD RULES ===\n` +
      `- Speak like a peer engineer. Concise, technical, opinionated when warranted.\n` +
      `- Use repo tools to verify claims about code rather than guessing.\n` +
      `- Don't dump structured stage output back at the developer — they can already see it. Discuss it.\n` +
      `- Only ONE proposal at a time. After calling a propose_* tool, end your turn and wait for the user's decision.\n` +
      `- If you have an outstanding proposal (you'll see it noted below), do not call another propose_* tool until it resolves.`,
  );

  if (state.currentStage) {
    sections.push(`CURRENT PIPELINE STAGE: ${state.currentStage}`);
  }

  if (state.userNotes.length > 0) {
    sections.push(
      `PERSISTENT USER NOTES (things the developer has told you across stages):\n` +
        state.userNotes.map((n, i) => `${i + 1}. ${n}`).join("\n"),
    );
  }

  const summaryEntries = Object.entries(state.stageSummaries).filter(
    ([, v]) => v && v.trim().length > 0,
  );
  if (summaryEntries.length > 0) {
    sections.push(
      `PRIOR-STAGE CONVERSATION SUMMARIES (compressed; raw turns dropped from this prompt to save context):\n` +
        summaryEntries.map(([stage, summary]) => `- ${stage}: ${summary}`).join("\n"),
    );
  }

  if (state.pendingProposal) {
    sections.push(
      `OUTSTANDING PROPOSAL (awaiting developer's accept/reject — do not call another propose_* tool until this resolves):\n` +
        JSON.stringify(state.pendingProposal, null, 2),
    );
  }

  if (state.pendingContextText && state.pendingContextText.trim().length > 0) {
    sections.push(
      `=== STAGE CONTEXT (current snapshot from the frontend) ===\n${state.pendingContextText}`,
    );
  }

  return sections.join("\n\n");
}

// ── Pipeline-control tools ───────────────────────────────────────────────────

/** Slim representation of the pipeline checkpoint state — what the
 *  orchestrator needs to ground decisions without forcing the model to
 *  parse the full LangGraph state blob. */
interface PipelineSnapshot {
  currentStage: string | undefined;
  pendingNode: string | undefined;
  hasPlan: boolean;
  planFileCount: number;
  implementationFileCount: number | undefined;
  verificationFailures: number;
  buildPassed: boolean | undefined;
  buildAttempts: number;
  planRevisions: number;
}

/** Read the pipeline workflow's checkpointed state for a given thread.
 *  Returns undefined if no state exists yet (pipeline hasn't run). The
 *  pipeline graph is rebuilt with no-op tool callbacks because we're only
 *  reading state, not executing nodes. */
async function readPipelineSnapshot(
  pipelineThreadId: string,
): Promise<PipelineSnapshot | undefined> {
  // Stub tools/emit because getState() does not invoke nodes.
  const noopEmit = () => undefined;
  const tools = makeRepoTools({ workflowId: "orchestrator-readonly", emit: noopEmit });
  const graph = buildPipelineGraph({
    tools,
    workflowId: "orchestrator-readonly",
    emit: noopEmit,
  });
  const snapshot = await graph.getState({
    configurable: { thread_id: pipelineThreadId },
  });
  if (!snapshot.values || Object.keys(snapshot.values).length === 0) {
    return undefined;
  }
  // Cast: the pipeline state shape is internal to pipeline.ts. We only
  // touch fields that have been stable for a while.
  const v = snapshot.values as {
    currentStage?: string;
    plan?: { files: unknown[] } | undefined;
    implementationOutput?: { files_changed?: unknown[] } | undefined;
    verificationFailures?: unknown[];
    buildVerification?: { build_passed?: boolean; attempts?: unknown[] } | undefined;
    planRevisions?: number;
  };
  const next = (snapshot.next ?? []) as readonly string[];
  return {
    currentStage: v.currentStage,
    pendingNode: next[0],
    hasPlan: !!v.plan,
    planFileCount: v.plan?.files?.length ?? 0,
    implementationFileCount: v.implementationOutput?.files_changed?.length,
    verificationFailures: v.verificationFailures?.length ?? 0,
    buildPassed: v.buildVerification?.build_passed,
    buildAttempts: v.buildVerification?.attempts?.length ?? 0,
    planRevisions: v.planRevisions ?? 0,
  };
}

interface ProposalCollector {
  current: PendingProposal | undefined;
}

/** Build the pipeline-control tools the orchestrator gets in addition to
 *  the standard repo-inspection set. Closure captures:
 *   - `pipelineThreadId` for read-only state lookup
 *   - `proposalCollector` so the propose_* tools record the user's pending
 *     decision in a place the chat node can read after the loop completes
 *   - `hasOpenProposal` flag so the tools refuse to stack proposals */
function makePipelineControlTools(args: {
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

const MAX_TOOL_LOOP_ITERATIONS = 12;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}

function summariseToolResult(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text.length <= 240) return text;
  return `${text.slice(0, 200)}… (${text.length} chars)`;
}

interface ToolLoopOutcome {
  reply: string;
  toolEvents: Extract<OrchestratorMessage, { kind: "tool_call" }>[];
  usage: { inputTokens: number; outputTokens: number };
}

// LangChain tools have a stable shape — we widen `RepoTools` so the
// orchestrator can pass its combined repo + pipeline-control set without
// fighting the type system.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = { name: string; invoke: (input: unknown) => Promise<unknown> } & any;
type OrchestratorTools = AnyTool[];

/** Streamed tool loop tailored for the orchestrator. Mirrors
 *  runStreamingChatWithTools but records each tool call so the UI can render
 *  it as a row in the chat thread (rather than only seeing the final reply). */
async function runOrchestratorToolLoop(args: {
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
  const usage = { inputTokens: 0, outputTokens: 0 };

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

    const u = accumulated.usage_metadata as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    usage.inputTokens += u?.input_tokens ?? 0;
    usage.outputTokens += u?.output_tokens ?? 0;

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

// ── Chat node ─────────────────────────────────────────────────────────────────

interface OrchestratorNodeContext {
  workflowId: string;
  model: ModelSelection;
  tools: RepoTools;
  emit: (e: OutboundEvent) => void;
}

function makeChatNode(ctx: OrchestratorNodeContext) {
  return async function chatNode(
    state: OrchestratorState,
  ): Promise<Partial<OrchestratorState>> {
    const newMsg = state.pendingUserMessage;
    if (!newMsg) {
      // No-op invocation. Could happen if the runner is mistakenly invoked
      // without a message; bail without mutating state.
      return {};
    }

    // Build the combined tool set for THIS turn. Pipeline-control tools
    // close over a fresh proposal collector so we can read the orchestrator's
    // chosen action after the loop terminates without mutating reducer
    // channels mid-loop.
    const proposalCollector: ProposalCollector = { current: undefined };
    const pipelineTools = makePipelineControlTools({
      pipelineThreadId: state.pipelineThreadId,
      proposalCollector,
      hasOpenProposal: !!state.pendingProposal,
    });
    const combinedTools: OrchestratorTools = [
      ...(ctx.tools as unknown as OrchestratorTools),
      ...(pipelineTools as unknown as OrchestratorTools),
    ];

    // Dedup: if the incoming context blob is byte-for-byte the same as
    // the last one we rendered, skip embedding it again. The prior
    // thread already grounds the conversation; the agent can re-read
    // fresh state via `get_pipeline_state` if it needs to verify.
    const incomingHash = state.pendingContextText
      ? createHash("sha256").update(state.pendingContextText).digest("hex")
      : undefined;
    const skipContext =
      !!incomingHash && incomingHash === state.lastContextHash;
    const effectiveContextText = skipContext
      ? undefined
      : state.pendingContextText;

    const systemPrompt = buildOrchestratorSystem({
      currentStage: state.currentStage,
      stageSummaries: state.stageSummaries,
      userNotes: state.userNotes,
      pendingContextText: effectiveContextText,
      pendingProposal: state.pendingProposal,
    });

    const outcome = await runOrchestratorToolLoop({
      workflowId: ctx.workflowId,
      model: ctx.model,
      tools: combinedTools,
      systemPrompt,
      priorThread: state.thread,
      summarisedStages: new Set(Object.keys(state.stageSummaries ?? {})),
      newUserMessage: newMsg,
      emit: ctx.emit,
    });

    const ts = Date.now();
    const messageKind = state.pendingMessageKind ?? "user";
    const stage = state.currentStage; // tag every entry with the active stage
    // Build the new thread entries:
    //   1. The incoming message (user bubble OR system_note, depending on
    //      how the runner tagged it).
    //   2. Each tool call recorded during the loop.
    //   3. A breadcrumb if the model produced a fresh proposal — gives the
    //      UI an inline marker explaining what was just suggested.
    //   4. The final assistant reply.
    const newTurns: OrchestratorMessage[] = [];
    newTurns.push({ kind: messageKind, content: newMsg, ts, stage });
    newTurns.push(
      ...outcome.toolEvents.map((e) => ({ ...e, stage })),
    );
    if (proposalCollector.current) {
      newTurns.push({
        kind: "system_note",
        content: `Proposal: ${describeProposal(proposalCollector.current)}`,
        ts: Date.now(),
        stage,
      });
    }
    newTurns.push({
      kind: "assistant",
      content: outcome.reply,
      ts: Date.now(),
      stage,
    });

    return {
      thread: newTurns,
      pendingUserMessage: undefined,
      pendingContextText: undefined,
      pendingMessageKind: "user",
      // Replace pendingProposal with the new one if the orchestrator created
      // one this turn; otherwise leave whatever was there. (The runner
      // already cleared it pre-invocation if `clearPendingProposal` was set.)
      pendingProposal: proposalCollector.current ?? state.pendingProposal,
      usage: outcome.usage,
      // Remember the hash of the context we actually used so the next
      // turn can decide whether to send the context again.
      lastContextHash: skipContext ? state.lastContextHash : incomingHash,
    };
  };
}

/** Short human-readable summary of a proposal for thread breadcrumbs. */
function describeProposal(p: PendingProposal): string {
  if (p.kind === "proceed") return `pipeline ${p.action}${p.reason ? ` (${p.reason})` : ""}`;
  if (p.kind === "rewind") return `rewind to ${p.toStage}`;
  if (p.kind === "reply") {
    const trim = p.message.length > 80 ? `${p.message.slice(0, 80)}…` : p.message;
    return `triage reply — "${trim}"`;
  }
  if (p.kind === "edit_plan") {
    return `edit plan (${p.edits.length} op${p.edits.length === 1 ? "" : "s"})`;
  }
  if (p.kind === "accept_grooming_edit") {
    return `${p.newStatus} grooming edit ${p.editId}`;
  }
  return "unknown";
}

// ── Graph builder ─────────────────────────────────────────────────────────────

export function buildOrchestratorGraph(ctx: OrchestratorNodeContext) {
  return new StateGraph(OrchestratorStateAnnotation)
    .addNode("chat", makeChatNode(ctx))
    .addEdge(START, "chat")
    .addEdge("chat", END)
    .compile({ checkpointer: getCheckpointer() });
}

// ── Snapshot helper ───────────────────────────────────────────────────────────

/** Return the persisted state for a given orchestrator thread. Used by the
 *  Tauri layer when the frontend wants to render existing thread history
 *  (e.g. on app reopen) without sending a new user message. */
export async function getOrchestratorSnapshot(
  threadId: string,
  ctx: OrchestratorNodeContext,
): Promise<OrchestratorState | undefined> {
  const graph = buildOrchestratorGraph(ctx);
  const snapshot = await graph.getState({
    configurable: { thread_id: threadId },
  });
  if (!snapshot.values || Object.keys(snapshot.values).length === 0) {
    return undefined;
  }
  return snapshot.values as OrchestratorState;
}

// ── Plan-edit application ────────────────────────────────────────────────────
//
// When the user accepts an `edit_plan` proposal, the frontend calls into a
// dedicated sidecar workflow (registered as `apply_plan_edits`) that
// rehydrates the pipeline graph for the given thread, applies the ops to
// `state.plan`, and writes the result back via `graph.updateState`. We do
// NOT mutate plan from the orchestrator workflow itself — keeping the
// sibling pipeline as the only writer of pipeline state simplifies
// reasoning and avoids cross-thread races.

export const ApplyPlanEditsInputSchema = z.object({
  /** The implementation pipeline's checkpointer thread id. */
  pipelineThreadId: z.string().min(1),
  /** Atomic ops to apply, in order. Same shape the orchestrator proposed —
   *  re-validated here at the trust boundary. */
  edits: z.array(PlanEditOpSchema).min(1),
});

export type ApplyPlanEditsInput = z.infer<typeof ApplyPlanEditsInputSchema>;

export interface PlanShape {
  summary: string;
  files: Array<{
    path: string;
    action: "create" | "modify" | "delete";
    description: string;
  }>;
  order_of_operations: string[];
  edge_cases: string[];
  do_not_change: string[];
  assumptions: string[];
  open_questions: string[];
}

/** Apply one op to the plan, returning the new plan or throwing on a
 *  semantic violation (e.g. removing a file that isn't in the plan). */
export function applyPlanEditOp(plan: PlanShape, op: PlanEditOp): PlanShape {
  if (op.op === "set_summary") {
    return { ...plan, summary: op.summary };
  }
  if (op.op === "add_file") {
    if (plan.files.some((f) => f.path === op.file.path)) {
      throw new Error(`add_file refused: '${op.file.path}' is already in the plan`);
    }
    return { ...plan, files: [...plan.files, op.file] };
  }
  if (op.op === "remove_file") {
    if (!plan.files.some((f) => f.path === op.path)) {
      throw new Error(`remove_file refused: '${op.path}' is not in the plan`);
    }
    return { ...plan, files: plan.files.filter((f) => f.path !== op.path) };
  }
  if (op.op === "update_file") {
    const idx = plan.files.findIndex((f) => f.path === op.path);
    if (idx < 0) {
      throw new Error(`update_file refused: '${op.path}' is not in the plan`);
    }
    const next = [...plan.files];
    next[idx] = {
      ...next[idx],
      ...(op.fields.action !== undefined ? { action: op.fields.action } : {}),
      ...(op.fields.description !== undefined
        ? { description: op.fields.description }
        : {}),
    };
    return { ...plan, files: next };
  }
  if (op.op === "add_assumption") {
    return { ...plan, assumptions: [...plan.assumptions, op.text] };
  }
  if (op.op === "add_open_question") {
    return { ...plan, open_questions: [...plan.open_questions, op.text] };
  }
  // Should be unreachable thanks to the discriminated union.
  return plan;
}

/** Apply the proposed edits to the pipeline thread's plan. Reads current
 *  state via the checkpointer, threads each op through `applyPlanEditOp`,
 *  and writes the resulting plan back via `graph.updateState`. Throws if
 *  the thread has no plan yet (orchestrator should have called
 *  `get_pipeline_state` first to verify). */
export async function applyPlanEdits(args: {
  workflowId: string;
  emit: (e: OutboundEvent) => void;
  input: ApplyPlanEditsInput;
}): Promise<{ planFileCount: number }> {
  const { workflowId, emit, input } = args;

  const noopEmit = () => undefined;
  const tools = makeRepoTools({ workflowId: "apply-plan-readonly", emit: noopEmit });
  const graph = buildPipelineGraph({
    tools,
    workflowId: "apply-plan-readonly",
    emit: noopEmit,
  });
  const config = { configurable: { thread_id: input.pipelineThreadId } };

  const snapshot = await graph.getState(config);
  const values = snapshot?.values as { plan?: PlanShape } | undefined;
  if (!values?.plan) {
    throw new Error(
      "apply_plan_edits: pipeline thread has no plan in state — nothing to edit.",
    );
  }

  let plan: PlanShape = values.plan;
  for (const op of input.edits) {
    plan = applyPlanEditOp(plan, op);
  }

  await graph.updateState(config, { plan });

  emit({
    id: workflowId,
    type: "progress",
    node: "apply_plan_edits",
    status: "completed",
    data: { opCount: input.edits.length, planFileCount: plan.files.length },
  });

  return { planFileCount: plan.files.length };
}

// ── Stage compression ────────────────────────────────────────────────────────
//
// When the pipeline advances from stage A to stage B, the runner calls
// `summariseStageTurns` over the orchestrator's chat entries that were
// tagged with stage A and writes the result to `stageSummaries[A]`. The
// next chat turn's prompt then drops those raw entries and shows the
// compressed version instead — bounded prompt size with no information loss
// in the persisted thread (UI still renders the originals).

/** Render orchestrator messages as plain text for the summariser model. */
function renderTurnsForSummary(turns: OrchestratorMessage[]): string {
  const lines: string[] = [];
  for (const m of turns) {
    if (m.kind === "user") lines.push(`USER: ${m.content}`);
    else if (m.kind === "assistant") lines.push(`ORCHESTRATOR: ${m.content}`);
    else if (m.kind === "system_note") lines.push(`[note] ${m.content}`);
    else if (m.kind === "tool_call") {
      const args =
        typeof m.args === "string" ? m.args : JSON.stringify(m.args);
      lines.push(
        `[tool: ${m.name}(${args.length > 120 ? args.slice(0, 120) + "…" : args})${
          m.error ? ` ERROR: ${m.error}` : ""
        }]`,
      );
    }
  }
  return lines.join("\n");
}

const STAGE_SUMMARY_SYSTEM = `You are summarising a chat exchange between a senior engineer and an AI orchestrator that took place during one stage of a multi-stage implementation pipeline.

Produce a SHORT summary (under 80 words) for the orchestrator's own future reference. Capture:
- the developer's intent and any concerns they flagged
- decisions made or directions given
- anything that should carry forward into later stages (e.g. "user is worried about backward-compat in the auth middleware")

Do NOT recap stage outputs verbatim — those are stored separately. Focus on what only emerged in conversation.

Write in third person past tense ("the developer asked…", "we agreed to…"). Output the summary as plain text — no preamble, no bullet points, no markdown.`;

/** Summarise the orchestrator's exchanges from a given stage into a short
 *  natural-language note. Uses a non-streaming model invocation since the
 *  output is internal state, not user-facing. */
export async function summariseStageTurns(args: {
  model: ModelSelection;
  stage: string;
  turns: OrchestratorMessage[];
}): Promise<string | undefined> {
  if (args.turns.length === 0) return undefined;
  const llm = buildModel(args.model);
  const rendered = renderTurnsForSummary(args.turns);
  const userMsg = `STAGE: ${args.stage}\n\nEXCHANGES:\n${rendered}`;
  try {
    const response = await llm.invoke([
      new SystemMessage(STAGE_SUMMARY_SYSTEM),
      new HumanMessage(userMsg),
    ]);
    const text = extractText(response.content).trim();
    return text.length > 0 ? text : undefined;
  } catch (err) {
    console.error(
      `[orchestrator] stage-summary call failed for ${args.stage}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/** Compare prior vs incoming stage and, on transition, summarise the prior
 *  stage's chat turns. Returns the partial state update to apply (the
 *  caller is responsible for `graph.updateState`-ing it in). Returns
 *  `undefined` when no transition is detected or there's nothing to
 *  summarise. */
export async function maybeCompressStageOnTransition(args: {
  model: ModelSelection;
  priorStage: string | undefined;
  incomingStage: string | undefined;
  thread: OrchestratorMessage[];
  existingSummaries: Record<string, string>;
}): Promise<{ stageSummaries: Record<string, string> } | undefined> {
  const { priorStage, incomingStage } = args;
  if (!priorStage) return undefined;            // no prior stage to summarise
  if (!incomingStage) return undefined;          // nothing to compare
  if (priorStage === incomingStage) return undefined; // same stage, no-op
  if (args.existingSummaries[priorStage]) return undefined; // already summarised
  const turns = args.thread.filter((m) => m.stage === priorStage);
  if (turns.length === 0) return undefined;
  const summary = await summariseStageTurns({
    model: args.model,
    stage: priorStage,
    turns,
  });
  if (!summary) return undefined;
  return { stageSummaries: { [priorStage]: summary } };
}
