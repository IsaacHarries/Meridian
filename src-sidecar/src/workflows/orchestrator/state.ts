// LangGraph state annotation + reducers for the Implement-Ticket
// Orchestrator workflow.

import { Annotation } from "@langchain/langgraph";
import type { OrchestratorMessage, PendingProposal } from "./types.js";

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

export const OrchestratorStateAnnotation = Annotation.Root({
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
  usage: Annotation<{
    inputTokens: number;
    outputTokens: number;
    /** Anthropic-only: tokens billed at 1.25x because they wrote the
     *  prompt cache on this turn (stable preamble + stage context).
     *  Reported separately so the badge can show whether the write
     *  premium amortised against subsequent reads. Always 0 for other
     *  providers. */
    cacheCreationInputTokens: number;
    /** Anthropic-only: tokens billed at 0.1x because they came from a
     *  prior cache write within the 5-min TTL. */
    cacheReadInputTokens: number;
  }>({
    reducer: (current, update) => ({
      inputTokens: (current?.inputTokens ?? 0) + update.inputTokens,
      outputTokens: (current?.outputTokens ?? 0) + update.outputTokens,
      cacheCreationInputTokens:
        (current?.cacheCreationInputTokens ?? 0) +
        (update.cacheCreationInputTokens ?? 0),
      cacheReadInputTokens:
        (current?.cacheReadInputTokens ?? 0) +
        (update.cacheReadInputTokens ?? 0),
    }),
    default: () => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }),
  }),
});
