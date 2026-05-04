// Zod schemas for the Implement-Ticket Orchestrator workflow.
//
// Split out of orchestrator.ts so each file stays under the ~1000-line
// budget. Re-exported from `../orchestrator.ts` for backwards compat.

import { z } from "zod";
import { PlanFileSchema } from "../pipeline-schemas.js";

// ── Input schema ──────────────────────────────────────────────────────────────

export const OrchestratorInputSchema = z.object({
  /** The orchestrator's persistent thread id. Generated on first turn by the
   *  caller (typically derived from the ticket key) and reused for every
   *  subsequent message so SQLite can rehydrate state. */
  threadId: z.string().min(1),
  /** The sibling implementation-pipeline thread id. Stored in state on the
   *  first turn; pipeline-control tools use it via `get_pipeline_state` and
   *  the propose_* tools. Optional because some early turns may happen
   *  before the pipeline has started.
   *
   *  `nullish()` rather than `optional()` — Rust's `serde_json::json!`
   *  serialises `Option::None` as JSON `null` (not omitted), so callers
   *  that don't supply this field arrive here with an explicit null.
   *  `optional()` would reject that. */
  pipelineThreadId: z.string().nullish(),
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
  messageKind: z.enum(["user", "system_note"]).nullish().default("user"),
  /** Current pipeline stage at the time of the message — frontend tells us
   *  what the user is looking at so the orchestrator's system prompt can
   *  tailor advice. The orchestrator can also discover this via the
   *  `get_pipeline_state` tool. */
  currentStage: z.string().nullish(),
  /** Free-form context summary the frontend can supply per turn (e.g. the
   *  current stage's structured output rendered as text). Cheap to include
   *  even when the orchestrator could fetch it via tools — saves a round
   *  trip on the first turn at every checkpoint. */
  contextText: z.string().nullish(),
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

// ── Plan-edit op ──────────────────────────────────────────────────────────────

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

// ── Pending proposal ──────────────────────────────────────────────────────────

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

// ── Apply-plan-edits input ────────────────────────────────────────────────────

export const ApplyPlanEditsInputSchema = z.object({
  /** The implementation pipeline's checkpointer thread id. */
  pipelineThreadId: z.string().min(1),
  /** Atomic ops to apply, in order. Same shape the orchestrator proposed —
   *  re-validated here at the trust boundary. */
  edits: z.array(PlanEditOpSchema).min(1),
});
