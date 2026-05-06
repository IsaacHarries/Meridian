import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type JiraIssue } from "@/lib/tauri/jira";
import { type OrchestratorMessage, type OrchestratorPendingProposal } from "@/lib/tauri/orchestrator";
import { type SkillType } from "@/lib/tauri/templates";
import { type GroomingOutput, type GuidanceOutput, type ImpactOutput, type ImplementationOutput, type ImplementationPlan, type PipelineResumeAction, type PlanReviewOutput, type PrDescriptionOutput, type RetrospectiveOutput, type SuggestedEdit, type TestOutput, type TestPlan, type TriageMessage, type TriageTurnOutput } from "@/lib/tauri/workflows";
import { type ReplanCheckpointPayload, type VerificationOutput, type WorktreeInfo } from "@/lib/tauri/worktree";

// ── Stage type — single source of truth used by every screen + store slice ───

export type Stage =
  | "select"
  | "grooming"
  | "impact"
  | "triage"
  | "plan"
  | "implementation"
  // Surfaced when implementation verification or build verification has
  // exhausted its in-stage budget — user chooses to revise the plan or
  // accept the partial work.
  | "replan"
  | "tests_plan"
  | "tests"
  | "review"
  | "pr"
  | "retro"
  | "complete";

// ── Grooming blocker type (was defined inline in ImplementTicketScreen) ──────

export interface GroomingBlocker {
  id: string;
  severity: "blocking" | "warning";
  message: string;
  detail: string;
}

// ── Per-ticket cached pipeline session ────────────────────────────────────────
// All pipeline fields that should survive navigation, keyed by issue key.

export type PipelineSession = Pick<
  ImplementTicketState,
  | "selectedIssue"
  | "currentStage"
  | "viewingStage"
  | "completedStages"
  | "pendingApproval"
  | "proceeding"
  | "pipelineThreadId"
  | "pipelineFinalState"
  | "grooming"
  | "impact"
  | "triageHistory"
  | "triageTurns"
  | "plan"
  | "guidance"
  | "implementation"
  | "implementationStreamText"
  | "verificationOutput"
  | "testPlan"
  | "tests"
  | "review"
  | "prDescription"
  | "retrospective"
  | "featureBranch"
  | "createdPr"
  | "prSubmitStatus"
  | "prSubmitError"
  | "groomingBlockers"
  | "groomingEdits"
  | "clarifyingQuestions"
  | "clarifyingQuestionsInitial"
  | "groomingHighlights"
  | "filesRead"
  | "groomingChat"
  | "groomingBaseline"
  | "jiraUpdateStatus"
  | "jiraUpdateError"
  | "groomingProgress"
  | "groomingStreamText"
  | "orchestratorThreadId"
  | "orchestratorThread"
  | "orchestratorStageSummaries"
  | "orchestratorUserNotes"
  | "orchestratorPendingProposal"
  | "orchestratorReviewedStages"
  | "errors"
  | "worktreeInfo"
  | "ticketText"
  | "skills"
  | "isSessionActive"
  | "activeSessionId"
>;

export interface ImplementTicketState {
  // ── Pipeline identity ──────────────────────────────────────────────────────
  selectedIssue: JiraIssue | null;
  currentStage: Stage;
  viewingStage: Exclude<Stage, "select">;
  completedStages: Set<Stage>;
  pendingApproval: Stage | null;
  proceeding: boolean;

  // ── LangGraph workflow tracking ────────────────────────────────────────────
  /** Checkpoint thread id of the running pipeline workflow; resume calls
   *  pass this back to the sidecar so it can rehydrate state. */
  pipelineThreadId: string | null;
  /** UUID for the current logical run (one start, one resume, or one
   *  rewind call). The sidecar tags every emitted event with this id;
   *  the pipeline event listener drops events whose runId doesn't match
   *  so a stale run we've cancelled (via retryStage at an earlier stage)
   *  can't jump the UI back to a later stage when its model call
   *  eventually finishes in the background. Reset to a fresh UUID on
   *  each start / proceed / retry. */
  currentRunId: string | null;
  /** Final structured pipeline state when the workflow completes. */
  pipelineFinalState: unknown | null;

  // ── Agent outputs ──────────────────────────────────────────────────────────
  grooming: GroomingOutput | null;
  /** Live partial agent outputs streamed by the sidecar's `streamLLMJson`
   *  helper while the model is mid-response. Each clears when the
   *  corresponding final output lands (or on stage retry). The screen
   *  prefers the partial when the final isn't there yet so the structured
   *  panel renders incrementally — same pattern as PR Review's
   *  `partialReport`. */
  partialGrooming: Partial<GroomingOutput> | null;
  partialImpact: Partial<ImpactOutput> | null;
  partialTriageTurn: Partial<TriageTurnOutput> | null;
  partialPlan: Partial<ImplementationPlan> | null;
  partialGuidance: Partial<GuidanceOutput> | null;
  partialReview: Partial<PlanReviewOutput> | null;
  partialPrDescription: Partial<PrDescriptionOutput> | null;
  partialRetrospective: Partial<RetrospectiveOutput> | null;
  impact: ImpactOutput | null;
  triageHistory: TriageMessage[];
  /** Structured per-turn triage output, parallel to assistant turns in
   *  triageHistory. Used by the middle panel to render the current proposal
   *  + revisions while the chat keeps the conversational message+questions. */
  triageTurns: TriageTurnOutput[];
  plan: ImplementationPlan | null;
  guidance: GuidanceOutput | null;
  implementation: ImplementationOutput | null;
  implementationStreamText: string;
  /** Per-file progress emitted by the implementation node. Surfaces which
   *  file is currently being written so the loading UI can show
   *  "Writing src/cli.ts (3/8)…" instead of a static label. */
  implementationProgress: {
    file: string;
    fileIndex: number;
    totalFiles: number;
  } | null;
  /** Live "what is the agent doing right now" snapshot, derived from
   *  pipeline progress events. Drives the activity strip above the
   *  orchestrator chat input — so the user can spot a runaway loop or
   *  a wrong file path early and hit Stop instead of waiting for tokens
   *  to bleed away. Cleared when the workflow ends (result / error /
   *  interrupt). Sources:
   *    - pipeline node start/complete: sets `node` (e.g. "do_plan",
   *      "implementation", "code_review")
   *    - implementation `file_started` phase: sets `file`/`fileIndex`/
   *      `totalFiles`
   *    - tool callbacks (read/write/grep/glob): sets `tool`/`toolArg`,
   *      cleared again on tool completion. */
  pipelineActivity: {
    node: string;
    file?: string;
    fileIndex?: number;
    totalFiles?: number;
    tool?: string;
    toolArg?: string;
  } | null;
  /** Result of the post-implementation verification pass — typecheck/test/
   *  build summary surfaced alongside the implementation output in the
   *  Implementation panel. Null until verification has completed. */
  verificationOutput: VerificationOutput | null;
  /** Payload for the `replan` checkpoint, populated when the pipeline pauses
   *  at the plan-revision interrupt. Cleared on next interrupt. */
  replanCheckpoint: ReplanCheckpointPayload | null;
  /** Proposed test plan from the test_plan stage — user reviews/approves before tests are written. */
  testPlan: TestPlan | null;
  tests: TestOutput | null;
  review: PlanReviewOutput | null;
  prDescription: PrDescriptionOutput | null;
  retrospective: RetrospectiveOutput | null;

  // ── PR submission (Bitbucket) ──────────────────────────────────────────────
  /** Feature branch created off the base branch at Implementation start. */
  featureBranch: string | null;
  /** The Bitbucket PR once created — UI surfaces the URL from this. */
  createdPr: BitbucketPr | null;
  /** Progress of the PR submission flow (squash → push → create). */
  prSubmitStatus: "idle" | "squashing" | "pushing" | "creating" | "error";
  prSubmitError: string | null;

  // ── Grooming sub-state ─────────────────────────────────────────────────────
  groomingBlockers: GroomingBlocker[];
  groomingEdits: SuggestedEdit[];
  clarifyingQuestions: string[];
  /** Snapshot of clarifying questions at first grooming run. Used to render
   * resolved (answered) ones as strikethrough while keeping them visible. */
  clarifyingQuestionsInitial: string[];
  /** Tracks which items were just updated by the chat turn — drives the glow
   * animation until the user interacts or toggles highlights off. */
  groomingHighlights: {
    editIds: string[];
    questions: boolean;
  };
  /** User toggle to hide the update-glow highlights. Persisted. */
  showHighlights: boolean;
  filesRead: string[];
  groomingChat: TriageMessage[];
  groomingBaseline: GroomingOutput | null;
  jiraUpdateStatus: "idle" | "saving" | "saved" | "error";
  jiraUpdateError: string;

  // ── Live progress (written by backend event listeners) ─────────────────────
  groomingProgress: string;
  groomingStreamText: string;
  impactStreamText: string;
  triageStreamText: string;
  planStreamText: string;
  testsStreamText: string;
  reviewStreamText: string;
  prStreamText: string;
  retroStreamText: string;
  checkpointStreamText: string;

  // ── Orchestrator chat (long-lived, spans every stage) ──────────────────────
  /** Persistent thread id for the orchestrator workflow. Derived from the
   *  selected ticket's key (e.g. "orchestrator:PROJ-123") so the same chat
   *  history is rehydrated across sessions / app restarts. Null when no
   *  ticket is active. */
  orchestratorThreadId: string | null;
  /** The full lossless chat thread the orchestrator persists in its
   *  checkpointer. Mirrored here so the UI can render without a round-trip;
   *  every successful turn replaces this with the latest from the workflow
   *  result. */
  orchestratorThread: OrchestratorMessage[];
  /** Compressed per-stage summaries (UI doesn't render these directly —
   *  they're only used by the model — but the store mirrors them so we can
   *  show a small "compressing…" indicator and for debug visibility). */
  orchestratorStageSummaries: Record<string, string>;
  /** Persistent "user told me X" notes the orchestrator decides are worth
   *  keeping across stages. */
  orchestratorUserNotes: string[];
  /** Outstanding proposal awaiting the user's accept/reject. The chat panel
   *  renders a confirm card while this is non-null. */
  orchestratorPendingProposal: OrchestratorPendingProposal | null;
  /** Live token stream for the in-flight turn — accumulates while the
   *  sidecar emits `stream` events; cleared when the turn completes and the
   *  final assistant message lands in `orchestratorThread`. */
  orchestratorStreamText: string;
  /** True while a turn is in flight. Drives the send button + spinner. */
  orchestratorSending: boolean;
  /** Stages we've already auto-fired a review turn for, so a single
   *  pipeline advance doesn't trigger duplicate reviews. */
  orchestratorReviewedStages: Stage[];

  // ── Error state ────────────────────────────────────────────────────────────
  errors: Partial<Record<Stage, string>>;

  // ── Misc ───────────────────────────────────────────────────────────────────
  worktreeInfo: WorktreeInfo | null;

  // ── Internals (not derived from UI, survive navigation) ────────────────────
  /** Compiled ticket text — kept here so async actions always read the latest version */
  ticketText: string;
  /** Agent skills loaded at pipeline start */
  skills: Partial<Record<SkillType, string>>;

  // ── Computed ───────────────────────────────────────────────────────────────
  /** True when a pipeline session is active (ticket selected and pipeline started) */
  isSessionActive: boolean;

  /** UUID that changes on every fresh pipeline start — event listeners use this to discard stale backend events */
  activeSessionId: string;

  // ── Session cache — one entry per ticket key ───────────────────────────────
  /** Cached pipeline sessions keyed by JIRA issue key */
  sessions: Map<string, PipelineSession>;

  // ── Actions ────────────────────────────────────────────────────────────────
  /** Directly write state — used by event listeners outside React tree */
  _set: (partial: Partial<ImplementTicketState>) => void;
  /** Reload `skills` from disk — called before each stage so live edits apply. */
  _reloadSkills: () => Promise<void>;

  resetSession: () => void;
  startPipeline: (issue: JiraIssue) => Promise<void>;
  sendTriageMessage: (input: string) => Promise<void>;
  finalizePlan: () => Promise<void>;
  /** Squash feature branch commits, push, and create a PR on Bitbucket (no reviewers). */
  submitDraftPr: () => Promise<void>;
  proceedFromStage: (stage: Stage, action?: PipelineResumeAction) => Promise<void>;
  /** Send a user-typed turn through the orchestrator (replaces the per-stage
   *  `sendCheckpointMessage`). The orchestrator decides whether to answer
   *  conversationally, propose a pipeline action, or both. */
  sendOrchestratorMessage: (input: string) => Promise<void>;
  /** Resolve an outstanding orchestrator proposal. `accepted` fires the
   *  appropriate pipeline command (resume / rewind / triage-reply) and then
   *  notifies the orchestrator via a system_note; `rejected` only notifies. */
  resolveOrchestratorProposal: (decision: "accepted" | "rejected") => Promise<void>;
  /** Auto-fire a stage-review turn against the orchestrator with the freshly
   *  arrived stage output as a system_note. Idempotent — guarded by
   *  `orchestratorReviewedStages`. */
  triggerOrchestratorReview: (stage: Stage, contextText: string) => Promise<void>;
  sendGroomingChatMessage: (input: string) => Promise<void>;
  handleApproveEdit: (id: string) => void;
  handleDeclineEdit: (id: string) => void;
  handleEditSuggested: (id: string, newSuggested: string) => void;
  /** Clear the glow highlights on a specific edit (when the user interacts with it). */
  clearEditHighlight: (id: string) => void;
  /** Clear all grooming highlights at once. */
  clearAllGroomingHighlights: () => void;
  /** Flip the showHighlights toggle. */
  toggleHighlights: () => void;
  pushGroomingToJira: () => Promise<void>;
  markComplete: (stage: Stage) => void;
  setError: (stage: Stage, err: string) => void;
  /** User-initiated abort of the in-flight implementation pipeline run.
   *  Hits Rust → sidecar to drop the LangGraph invocation, clears the
   *  in-flight flags + activity strip locally, and the listener's
   *  stale-event guard then drops any events from the cancelled run. */
  stopActivePipeline: () => Promise<void>;
  clearError: (stage: Stage) => void;
  retryStage: (stage: Stage) => Promise<void>;
  /** Routes a chat message to the correct agent based on the active pipeline stage. */
  sendPipelineMessage: (input: string) => Promise<void>;
}

// Re-export the SkillType so consumers that did
// `import type { SkillType } from "@/stores/implementTicketStore"` keep
// working through the barrel.
export type { SkillType };
