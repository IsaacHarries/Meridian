/**
 * Zustand store for the Implement a Ticket pipeline.
 *
 * All pipeline state lives here so that navigating away and back preserves
 * progress. In-flight Tauri async calls write to this store via get() and set(),
 * so the component being unmounted has no effect on them.
 */

import { create } from "zustand";
import {
  type JiraIssue,
  type GroomingOutput,
  type ImpactOutput,
  type ImplementationPlan,
  type GuidanceOutput,
  type ImplementationOutput,
  type TestPlan,
  type TestOutput,
  type PlanReviewOutput,
  type PrDescriptionOutput,
  type RetrospectiveOutput,
  type TriageMessage,
  type TriageTurnOutput,
  type SuggestedEdit,
  type SuggestedEditStatus,
  type WorktreeInfo,
  type SkillType,
  type BitbucketPr,
  isMockMode,
  createFeatureBranch,
  commitWorktreeChanges,
  squashWorktreeCommits,
  pushWorktreeBranch,
  createPullRequest,
  getIssue,
  loadAgentSkills,
  syncWorktree,
  syncGroomingWorktree,
  getNonSecretConfig,
  runGroomingFileProbe,
  runCheckpointAction,
  type CheckpointActionResult,
  runGroomingChatTurn,
  type BuildCheckResult,
  updateJiraIssue,
  parseAgentJson,
  readGroomingFile,
  grepGroomingFiles,
  runImplementationPipelineWorkflow,
  resumeImplementationPipelineWorkflow,
  PIPELINE_EVENT_NAME,
  type PipelineEvent,
  type PipelineWorkflowArgs,
  type PipelineWorkflowResult,
  rewindImplementationPipelineWorkflow,
} from "@/lib/tauri";
import { listen } from "@tauri-apps/api/event";

export type { SkillType };

// ── Pipeline workflow event wiring ────────────────────────────────────────────
//
// The implementation pipeline runs as a single LangGraph workflow in the
// sidecar. We dispatch one `runImplementationPipelineWorkflow` to start the
// run, then subscribe to PIPELINE_EVENT_NAME events to learn about progress
// and interrupts. On each interrupt the relevant store slice is updated and
// `pendingApproval` is set so the UI can render the checkpoint.

let pipelineUnlisten: (() => void) | null = null;

// Vite HMR replaces this module on save — drop the old listener so the
// fresh module's `ensurePipelineListener` re-subscribes against the
// (potentially recreated) store instance. Without this, the old listener
// keeps writing to a stale store and the UI sees no updates until reload.
if (typeof import.meta !== "undefined" && (import.meta as { hot?: { dispose?: (cb: () => void) => void } }).hot) {
  (import.meta as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    if (pipelineUnlisten) {
      pipelineUnlisten();
      pipelineUnlisten = null;
    }
  });
}

/** Linear order of user-facing stages — used to mark all prior stages
 *  complete whenever a downstream interrupt fires (some stages like
 *  `plan` run silently inside the workflow without an interrupt). */
const STAGE_ORDER: Stage[] = [
  "grooming",
  "impact",
  "triage",
  "plan",
  "implementation",
  "tests_plan",
  "tests",
  "review",
  "pr",
  "retro",
];

/** Map a sidecar pipeline node name to the user-facing Stage in this store. */
const NODE_TO_STAGE: Record<string, Stage> = {
  grooming: "grooming",
  impact: "impact",
  triage: "triage",
  do_plan: "plan",
  do_guidance: "implementation",
  implementation: "implementation",
  test_plan: "tests_plan",
  test_gen: "tests",
  code_review: "review",
  pr_description: "pr",
  do_retrospective: "retro",
};

/** Map a user-facing Stage to the sidecar node we need to rewind to in
 *  order to re-run just that stage. */
const STAGE_TO_REWIND_NODE: Partial<Record<Stage, string>> = {
  grooming: "grooming",
  impact: "impact",
  triage: "triage",
  plan: "do_plan",
  implementation: "implementation",
  tests_plan: "test_plan",
  tests: "test_gen",
  review: "code_review",
  pr: "pr_description",
  retro: "do_retrospective",
};

/** Apply a workflow interrupt's payload to the matching store slice. */
function applyInterruptToState(
  set: (updater: (s: ImplementTicketState) => Partial<ImplementTicketState>) => void,
  reason: string,
  payload: unknown,
): void {
  const stage = NODE_TO_STAGE[reason] ?? null;
  set((s) => {
    const updates: Partial<ImplementTicketState> = {
      pendingApproval: stage ?? s.pendingApproval,
      currentStage: stage ?? s.currentStage,
      // Always sync viewingStage so the UI follows the workflow forward.
      // (The user can still navigate back to a prior stage to inspect it
      // — they'd reset viewingStage themselves via the stage list.)
      viewingStage:
        stage && stage !== "select"
          ? (stage as Exclude<Stage, "select">)
          : s.viewingStage,
      proceeding: false,
      // Mark the stage complete AND every prior stage — some stages run
      // silently inside the workflow (e.g. `plan` runs between `triage`
      // and `implementation` without an interrupt of its own), so the
      // only signal the frontend has that they finished is the next
      // downstream interrupt.
      completedStages: stage
        ? (() => {
            const idx = STAGE_ORDER.indexOf(stage);
            if (idx < 0) return new Set([...s.completedStages, stage]);
            return new Set<Stage>([
              ...s.completedStages,
              ...STAGE_ORDER.slice(0, idx + 1),
            ]);
          })()
        : s.completedStages,
    };
    switch (reason) {
      case "grooming": {
        const data = payload as GroomingOutput;
        updates.grooming = data;
        // Mirror the post-grooming UI setup the old per-stage path did:
        // build editable suggestions, surface clarifying questions as a
        // welcome chat message, snapshot the initial Q/A state for the
        // diff-style highlight rendering, and detect blockers.
        const edits: SuggestedEdit[] = (data.suggested_edits ?? []).map((e) => ({
          ...e,
          status: "pending" as SuggestedEditStatus,
        }));
        const questions = data.clarifying_questions ?? [];
        const ambiguities = data.ambiguities ?? [];
        const openItems = [
          ...questions.map((q) => ({ label: "Question", text: q })),
          ...ambiguities.map((a) => ({ label: "Ambiguity", text: a })),
        ];
        const initialChat: TriageMessage[] =
          openItems.length > 0
            ? [
                {
                  role: "assistant",
                  content:
                    openItems.length === 1
                      ? `I have one item to clarify before we finalise the grooming:\n\n**${openItems[0].label}:** ${openItems[0].text}`
                      : `I have a few items to clarify before we finalise the grooming:\n\n${openItems
                          .map(
                            (item, i) =>
                              `${i + 1}. **${item.label}:** ${item.text}`,
                          )
                          .join("\n\n")}`,
                },
              ]
            : [];
        updates.groomingEdits = edits;
        updates.clarifyingQuestions = questions;
        updates.clarifyingQuestionsInitial = questions;
        updates.ambiguitiesInitial = ambiguities;
        updates.groomingHighlights = {
          editIds: [],
          questions: false,
          ambiguities: false,
        };
        updates.groomingChat = initialChat;
        updates.groomingBlockers = s.selectedIssue
          ? detectGroomingBlockers(s.selectedIssue, data)
          : [];
        updates.completedStages = new Set([...s.completedStages, "grooming"]);
        updates.viewingStage = "grooming";
        break;
      }
      case "impact":
        updates.impact = payload as ImpactOutput;
        break;
      case "triage": {
        const turn = payload as TriageTurnOutput;
        if (turn) {
          // Append the assistant turn to history if it isn't already there.
          const last = s.triageHistory[s.triageHistory.length - 1];
          const formatted = formatTriageChatContent(turn);
          if (!last || last.role !== "assistant" || last.content !== formatted) {
            updates.triageHistory = [
              ...s.triageHistory,
              { role: "assistant", content: formatted },
            ];
            updates.triageTurns = [...s.triageTurns, turn];
          }
        }
        // Triage's interrupt is NOT an approval gate — the screen treats
        // triage as the "active chat" stage (`isTriageActive` = currentStage
        // is triage AND pendingApproval is null). Setting pendingApproval
        // to anything other than null hides both the chat input and the
        // Finalise Plan button.
        updates.pendingApproval = null;
        break;
      }
      case "implementation":
        updates.implementation = payload as ImplementationOutput;
        break;
      case "test_plan":
        updates.testPlan = payload as TestPlan;
        break;
      case "test_gen":
        updates.tests = payload as TestOutput;
        break;
      case "code_review":
        updates.review = payload as PlanReviewOutput;
        break;
      case "pr_description":
        updates.prDescription = payload as PrDescriptionOutput;
        break;
    }
    return updates;
  });
}

/** Map a workflow result (interrupt or final) onto the store; called after
 *  every workflow.start / workflow.resume call. */
function applyWorkflowResult(
  set: (updater: (s: ImplementTicketState) => Partial<ImplementTicketState>) => void,
  result: PipelineWorkflowResult,
): void {
  if (result.interrupt) {
    applyInterruptToState(set, result.interrupt.reason, result.interrupt.payload);
    set(() => ({ pipelineThreadId: result.interrupt!.threadId }));
  } else if (result.output) {
    set(() => ({
      pipelineFinalState: result.output,
      currentStage: "complete" as Stage,
      pendingApproval: null,
      proceeding: false,
    }));
  }
}

/** Per-node stream text field — populated as the agent streams its output
 *  so the user sees live progress instead of waiting for the interrupt. */
const NODE_TO_STREAM_FIELD: Record<string, keyof ImplementTicketState> = {
  grooming: "groomingStreamText",
  impact: "impactStreamText",
  triage: "triageStreamText",
  do_plan: "planStreamText",
  do_guidance: "planStreamText",
  implementation: "implementationStreamText",
  test_plan: "testsStreamText",
  test_gen: "testsStreamText",
  code_review: "reviewStreamText",
  pr_description: "prStreamText",
  do_retrospective: "retroStreamText",
};

async function ensurePipelineListener(): Promise<void> {
  if (pipelineUnlisten) return;
  pipelineUnlisten = await listen<PipelineEvent>(PIPELINE_EVENT_NAME, (event) => {
    const e = event.payload;
    // Always go through the live store API rather than a captured set —
    // Vite HMR can replace the create() closure during development and
    // leave us writing to a stale store instance.
    const setState = useImplementTicketStore.setState;
    const updaterAdapter = (
      updater: (s: ImplementTicketState) => Partial<ImplementTicketState>,
    ) => {
      setState((s) => updater(s));
    };

    if (e.kind === "progress" && e.status === "started") {
      // Per-file implementation progress: update the implementationProgress
      // field so the loading UI can show "Writing src/cli.ts (3/8)…".
      const data = e.data as
        | {
            phase?: string;
            file?: string;
            fileIndex?: number;
            totalFiles?: number;
          }
        | undefined;
      if (
        e.node === "implementation" &&
        data?.phase === "file_started" &&
        typeof data.file === "string" &&
        typeof data.fileIndex === "number" &&
        typeof data.totalFiles === "number"
      ) {
        setState({
          implementationProgress: {
            file: data.file,
            fileIndex: data.fileIndex,
            totalFiles: data.totalFiles,
          },
        });
        return;
      }

      const stage = NODE_TO_STAGE[e.node];
      if (stage && stage !== "select") {
        setState((s) => {
          const updates: Partial<ImplementTicketState> = {
            currentStage: stage,
            viewingStage: stage as Exclude<Stage, "select">,
          };
          const streamField = NODE_TO_STREAM_FIELD[e.node];
          if (streamField) {
            (updates as Record<string, unknown>)[streamField] = "";
          }
          void s;
          return updates;
        });
      }
    } else if (e.kind === "stream") {
      const streamField = NODE_TO_STREAM_FIELD[e.node];
      if (streamField) {
        setState((s) => {
          const current = (s[streamField] as string | undefined) ?? "";
          return {
            [streamField]: current + e.delta,
          } as Partial<ImplementTicketState>;
        });
      }
    } else if (e.kind === "interrupt") {
      console.log(
        `[Meridian] pipeline interrupt: reason=${e.reason} payload=`,
        e.payload,
      );
      applyInterruptToState(updaterAdapter, e.reason, e.payload);
      setState({ pipelineThreadId: e.threadId });
    }
  });
}

// ── Re-export Stage type so the screen and store share one definition ──────────

export type Stage =
  | "select"
  | "grooming"
  | "impact"
  | "triage"
  | "plan"
  | "implementation"
  | "tests_plan"
  | "tests"
  | "review"
  | "pr"
  | "retro"
  | "complete";

// ── Grooming blocker type (was defined inline in ImplementTicketScreen) ────────

export interface GroomingBlocker {
  id: string;
  severity: "blocking" | "warning";
  message: string;
  detail: string;
}

// ── Helpers (pure functions shared with the screen) ────────────────────────────

export function compileTicketText(issue: JiraIssue): string {
  const lines: (string | null)[] = [
    `Ticket: ${issue.key}`,
    `Title: ${issue.summary}`,
    `Type: ${issue.issueType}`,
    issue.storyPoints != null ? `Story points: ${issue.storyPoints}` : null,
    issue.priority ? `Priority: ${issue.priority}` : null,
    `Status: ${issue.status}`,
    issue.epicSummary
      ? `Epic: ${issue.epicSummary}${issue.epicKey ? ` (${issue.epicKey})` : ""}`
      : null,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : null,
    issue.assignee ? `Assignee: ${issue.assignee.displayName}` : null,
    "",
  ];

  if (issue.descriptionSections && issue.descriptionSections.length > 0) {
    for (const section of issue.descriptionSections) {
      if (section.heading) lines.push(`## ${section.heading}`);
      lines.push(section.content);
      lines.push("");
    }
  } else if (issue.description) {
    lines.push(`Description:\n${issue.description}`, "");
  } else {
    lines.push("Description: (none)", "");
  }

  if (issue.acceptanceCriteria) {
    lines.push(`## Acceptance Criteria\n${issue.acceptanceCriteria}`, "");
  }
  if (issue.stepsToReproduce) {
    lines.push(`## Steps to Reproduce\n${issue.stepsToReproduce}`, "");
  }
  if (issue.observedBehavior) {
    lines.push(`## Observed Behavior\n${issue.observedBehavior}`, "");
  }
  if (issue.expectedBehavior) {
    lines.push(`## Expected Behavior\n${issue.expectedBehavior}`, "");
  }

  const knownNames = new Set([
    "acceptance criteria",
    "acceptance criterion",
    "steps to reproduce",
    "reproduction steps",
    "observed behavior",
    "observed behaviour",
    "actual result",
    "actual behavior",
    "expected behavior",
    "expected behaviour",
    "expected result",
    "expected outcome",
  ]);
  const extras = Object.entries(issue.namedFields ?? {}).filter(
    ([name]) => !knownNames.has(name.toLowerCase()),
  );
  if (extras.length > 0) {
    lines.push("## Additional Fields");
    for (const [name, value] of extras) lines.push(`${name}: ${value}`);
  }

  return lines.filter((l) => l !== null).join("\n");
}

export function compilePipelineContext(
  ticketText: string,
  grooming: GroomingOutput | null,
  impact: ImpactOutput | null,
  skills: Partial<Record<SkillType, string>> = {},
  groomingChat: TriageMessage[] = [],
): string {
  const parts: string[] = [];
  if (skills.grooming)
    parts.push(
      `=== GROOMING CONVENTIONS (follow these) ===\n${skills.grooming}`,
    );
  if (skills.patterns)
    parts.push(`=== CODEBASE PATTERNS (follow these) ===\n${skills.patterns}`);
  if (skills.implementation)
    parts.push(
      `=== IMPLEMENTATION STANDARDS (follow these) ===\n${skills.implementation}`,
    );
  parts.push(`=== TICKET ===\n${ticketText}`);
  if (grooming)
    parts.push(
      `=== GROOMING ANALYSIS ===\n${JSON.stringify(grooming, null, 2)}`,
    );
  if (groomingChat.length > 0)
    parts.push(
      `=== GROOMING Q&A (questions asked and answered during grooming — treat these answers as resolved) ===\n` +
        groomingChat
          .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content}`)
          .join("\n\n"),
    );
  if (impact)
    parts.push(`=== IMPACT ANALYSIS ===\n${JSON.stringify(impact, null, 2)}`);
  return parts.join("\n\n");
}


/**
 * Build the chat-bubble text for a triage turn: the conversational `message`
 * followed by the agent's questions, enumerated when there are multiple so
 * the engineer can answer each by number.
 */
function formatTriageChatContent(turn: TriageTurnOutput): string {
  const parts: string[] = [];
  const msg = turn.message?.trim();
  if (msg) parts.push(msg);
  const qs = (turn.questions ?? []).filter((q) => q && q.trim());
  if (qs.length === 1) {
    parts.push(qs[0]);
  } else if (qs.length > 1) {
    parts.push(qs.map((q, i) => `${i + 1}. ${q}`).join("\n"));
  }
  return parts.join("\n\n") || "(no message)";
}

export function detectGroomingBlockers(
  issue: JiraIssue,
  grooming: GroomingOutput,
): GroomingBlocker[] {
  const blockers: GroomingBlocker[] = [];
  const type = issue.issueType.toLowerCase();
  const isTaskOrStory = type === "story" || type === "task";

  if (!issue.description || issue.description.trim().length < 10) {
    blockers.push({
      id: "no-description",
      severity: "blocking",
      message: "Missing description",
      detail:
        "This ticket has no description. Implementation intent cannot be determined — update JIRA before proceeding.",
    });
  }

  if (isTaskOrStory && grooming.acceptance_criteria.length === 0) {
    blockers.push({
      id: "no-ac",
      severity: "blocking",
      message: "No acceptance criteria",
      detail: `${issue.issueType} tickets must have acceptance criteria before implementation begins. There is no definition of done.`,
    });
  }

  if (isTaskOrStory && issue.storyPoints == null) {
    blockers.push({
      id: "no-points",
      severity: "warning",
      message: "No story point estimate",
      detail: `This ${issue.issueType} has no story point estimate. Consider updating JIRA before starting implementation.`,
    });
  }

  return blockers;
}

// ── Store state shape ──────────────────────────────────────────────────────────

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
  | "ambiguitiesInitial"
  | "groomingHighlights"
  | "filesRead"
  | "groomingChat"
  | "groomingBaseline"
  | "jiraUpdateStatus"
  | "jiraUpdateError"
  | "groomingProgress"
  | "groomingStreamText"
  | "checkpointChats"
  | "errors"
  | "worktreeInfo"
  | "ticketText"
  | "skills"
  | "isSessionActive"
  | "activeSessionId"
>;

interface ImplementTicketState {
  // ── Pipeline identity ────────────────────────────────────────────────────────
  selectedIssue: JiraIssue | null;
  currentStage: Stage;
  viewingStage: Exclude<Stage, "select">;
  completedStages: Set<Stage>;
  pendingApproval: Stage | null;
  proceeding: boolean;

  // ── LangGraph workflow tracking ──────────────────────────────────────────────
  /** Checkpoint thread id of the running pipeline workflow; resume calls
   *  pass this back to the sidecar so it can rehydrate state. */
  pipelineThreadId: string | null;
  /** Final structured pipeline state when the workflow completes. */
  pipelineFinalState: unknown | null;

  // ── Agent outputs ────────────────────────────────────────────────────────────
  grooming: GroomingOutput | null;
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
  buildVerification: BuildCheckResult | null;
  buildCheckStreamText: string;
  /** Proposed test plan from the test_plan stage — user reviews/approves before tests are written. */
  testPlan: TestPlan | null;
  tests: TestOutput | null;
  review: PlanReviewOutput | null;
  prDescription: PrDescriptionOutput | null;
  retrospective: RetrospectiveOutput | null;

  // ── PR submission (Bitbucket) ────────────────────────────────────────────────
  /** Feature branch created off the base branch at Implementation start. */
  featureBranch: string | null;
  /** The Bitbucket PR once created — UI surfaces the URL from this. */
  createdPr: BitbucketPr | null;
  /** Progress of the PR submission flow (squash → push → create). */
  prSubmitStatus: "idle" | "squashing" | "pushing" | "creating" | "error";
  prSubmitError: string | null;

  // ── Grooming sub-state ───────────────────────────────────────────────────────
  groomingBlockers: GroomingBlocker[];
  groomingEdits: SuggestedEdit[];
  clarifyingQuestions: string[];
  /** Snapshot of clarifying questions at first grooming run. Used to render
   * resolved (answered) ones as strikethrough while keeping them visible. */
  clarifyingQuestionsInitial: string[];
  /** Snapshot of ambiguities at first grooming run. Same purpose as above. */
  ambiguitiesInitial: string[];
  /** Tracks which items were just updated by the chat turn — drives the glow
   * animation until the user interacts or toggles highlights off. */
  groomingHighlights: {
    editIds: string[];
    questions: boolean;
    ambiguities: boolean;
  };
  /** User toggle to hide the update-glow highlights. Persisted. */
  showHighlights: boolean;
  filesRead: string[];
  groomingChat: TriageMessage[];
  groomingBaseline: GroomingOutput | null;
  jiraUpdateStatus: "idle" | "saving" | "saved" | "error";
  jiraUpdateError: string;

  // ── Live progress (written by backend event listeners) ───────────────────────
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

  // ── Checkpoint chats (per stage follow-up conversations) ─────────────────────
  checkpointChats: Partial<Record<Stage, TriageMessage[]>>;

  // ── Error state ──────────────────────────────────────────────────────────────
  errors: Partial<Record<Stage, string>>;

  // ── Misc ─────────────────────────────────────────────────────────────────────
  worktreeInfo: WorktreeInfo | null;

  // ── Internals (not derived from UI, survive navigation) ──────────────────────
  /** Compiled ticket text — kept here so async actions always read the latest version */
  ticketText: string;
  /** Agent skills loaded at pipeline start */
  skills: Partial<Record<SkillType, string>>;

  // ── Computed ─────────────────────────────────────────────────────────────────
  /** True when a pipeline session is active (ticket selected and pipeline started) */
  isSessionActive: boolean;

  /** UUID that changes on every fresh pipeline start — event listeners use this to discard stale backend events */
  activeSessionId: string;

  // ── Session cache — one entry per ticket key ──────────────────────────────────
  /** Cached pipeline sessions keyed by JIRA issue key */
  sessions: Map<string, PipelineSession>;

  // ── Actions ──────────────────────────────────────────────────────────────────
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
  proceedFromStage: (stage: Stage) => Promise<void>;
  sendCheckpointMessage: (stage: Stage, input: string) => Promise<void>;
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
  clearError: (stage: Stage) => void;
  retryStage: (stage: Stage) => Promise<void>;
  /** Routes a chat message to the correct agent based on the active pipeline stage. */
  sendPipelineMessage: (input: string) => Promise<void>;
}

// ── Initial state (no session) ─────────────────────────────────────────────────

export const INITIAL: Omit<
  ImplementTicketState,
  | "_set"
  | "_reloadSkills"
  | "resetSession"
  | "startPipeline"
  | "sendTriageMessage"
  | "finalizePlan"
  | "submitDraftPr"
  | "proceedFromStage"
  | "sendCheckpointMessage"
  | "sendGroomingChatMessage"
  | "handleApproveEdit"
  | "handleDeclineEdit"
  | "handleEditSuggested"
  | "clearEditHighlight"
  | "clearAllGroomingHighlights"
  | "toggleHighlights"
  | "pushGroomingToJira"
  | "markComplete"
  | "setError"
  | "clearError"
  | "retryStage"
  | "sendPipelineMessage"
> = {
  selectedIssue: null,
  currentStage: "select",
  viewingStage: "grooming",
  completedStages: new Set(),
  pendingApproval: null,
  proceeding: false,
  grooming: null,
  impact: null,
  triageHistory: [],
  triageTurns: [],
  plan: null,
  guidance: null,
  implementation: null,
  implementationStreamText: "",
  implementationProgress: null,
  buildVerification: null,
  buildCheckStreamText: "",
  testPlan: null,
  tests: null,
  review: null,
  prDescription: null,
  retrospective: null,
  featureBranch: null,
  createdPr: null,
  prSubmitStatus: "idle",
  prSubmitError: null,
  groomingBlockers: [],
  groomingEdits: [],
  clarifyingQuestions: [],
  clarifyingQuestionsInitial: [],
  ambiguitiesInitial: [],
  groomingHighlights: { editIds: [], questions: false, ambiguities: false },
  showHighlights: true,
  filesRead: [],
  groomingChat: [],
  groomingBaseline: null,
  jiraUpdateStatus: "idle",
  jiraUpdateError: "",
  groomingProgress: "",
  groomingStreamText: "",
  impactStreamText: "",
  triageStreamText: "",
  planStreamText: "",
  testsStreamText: "",
  reviewStreamText: "",
  prStreamText: "",
  retroStreamText: "",
  checkpointStreamText: "",
  checkpointChats: {},
  errors: {},
  worktreeInfo: null,
  ticketText: "",
  skills: {},
  isSessionActive: false,
  activeSessionId: "",
  pipelineThreadId: null,
  pipelineFinalState: null,
  sessions: new Map(),
};

// ── Persistence key ────────────────────────────────────────────────────────────

export const IMPLEMENT_STORE_KEY = "meridian-implement-store";

// ── Session snapshot helper ────────────────────────────────────────────────────

export function snapshotSession(s: ImplementTicketState): PipelineSession {
  return {
    selectedIssue: s.selectedIssue,
    currentStage: s.currentStage,
    viewingStage: s.viewingStage,
    completedStages: s.completedStages,
    pendingApproval: s.pendingApproval,
    proceeding: s.proceeding,
    pipelineThreadId: s.pipelineThreadId,
    pipelineFinalState: s.pipelineFinalState,
    grooming: s.grooming,
    impact: s.impact,
    triageHistory: s.triageHistory,
    triageTurns: s.triageTurns,
    plan: s.plan,
    guidance: s.guidance,
    implementation: s.implementation,
    implementationStreamText: s.implementationStreamText,
    testPlan: s.testPlan,
    tests: s.tests,
    review: s.review,
    prDescription: s.prDescription,
    featureBranch: s.featureBranch,
    createdPr: s.createdPr,
    prSubmitStatus: s.prSubmitStatus,
    prSubmitError: s.prSubmitError,
    retrospective: s.retrospective,
    groomingBlockers: s.groomingBlockers,
    groomingEdits: s.groomingEdits,
    clarifyingQuestions: s.clarifyingQuestions,
    clarifyingQuestionsInitial: s.clarifyingQuestionsInitial,
    ambiguitiesInitial: s.ambiguitiesInitial,
    groomingHighlights: s.groomingHighlights,
    filesRead: s.filesRead,
    groomingChat: s.groomingChat,
    groomingBaseline: s.groomingBaseline,
    jiraUpdateStatus: s.jiraUpdateStatus,
    jiraUpdateError: s.jiraUpdateError,
    groomingProgress: s.groomingProgress,
    groomingStreamText: s.groomingStreamText,
    checkpointChats: s.checkpointChats,
    errors: s.errors,
    worktreeInfo: s.worktreeInfo,
    ticketText: s.ticketText,
    skills: s.skills,
    isSessionActive: s.isSessionActive,
    activeSessionId: s.activeSessionId,
  };
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useImplementTicketStore = create<ImplementTicketState>()(
  (set, get) => ({
    ...INITIAL,

    _set: (partial) => set(partial as Partial<ImplementTicketState>),

    resetSession: () => set((s) => ({ ...INITIAL, sessions: s.sessions })),

    /**
     * Reload agent skills from disk and write to state. Called at the start of
     * every stage so edits made in Agent Skills while a pipeline is paused
     * take effect on the next agent run. Disk cost is negligible (one small
     * JSON file read per stage) and failures are non-fatal — if the skills
     * file can't be read, we keep whatever was loaded previously.
     */
    _reloadSkills: async () => {
      try {
        const skills = await loadAgentSkills();
        set({ skills });
      } catch {
        /* keep existing skills */
      }
    },

    markComplete: (stage) =>
      set((s) => ({ completedStages: new Set([...s.completedStages, stage]) })),

    setError: (stage, err) =>
      set((s) => ({ errors: { ...s.errors, [stage]: err } })),

    clearError: (stage) =>
      set((s) => {
        const errors = { ...s.errors };
        delete errors[stage];
        return { errors };
      }),

    retryStage: async (stage) => {
      const s = get();
      const errors = { ...s.errors };
      delete errors[stage];
      const completedStages = new Set(
        [...s.completedStages].filter((st) => st !== stage),
      );
      const pendingApproval =
        s.pendingApproval === stage ? null : s.pendingApproval;

      const outputResets: Partial<ImplementTicketState> = {};
      switch (stage) {
        case "grooming":
          // Keep `groomingChat` so the user's prior Q&A with the grooming
          // agent survives a retry — otherwise a single bad agent response
          // throws away context the user had already typed out. Everything
          // else is tied to a single analysis run and must reset.
          Object.assign(outputResets, {
            grooming: null,
            groomingEdits: [],
            clarifyingQuestions: [],
            clarifyingQuestionsInitial: [],
            ambiguitiesInitial: [],
            groomingHighlights: {
              editIds: [],
              questions: false,
              ambiguities: false,
            },
            groomingBlockers: [],
            groomingProgress: "",
            groomingStreamText: "",
            filesRead: [],
          });
          break;
        case "impact":
          Object.assign(outputResets, { impact: null, impactStreamText: "" });
          break;
        case "triage":
          Object.assign(outputResets, {
            triageHistory: [],
            triageTurns: [],
            triageStreamText: "",
          });
          break;
        case "plan":
          Object.assign(outputResets, {
            plan: null,
            guidance: null,
            planStreamText: "",
          });
          break;
        case "implementation":
          Object.assign(outputResets, {
            implementation: null,
            implementationStreamText: "",
            implementationProgress: null,
            buildVerification: null,
            buildCheckStreamText: "",
            guidance: null,
          });
          break;
        case "tests_plan":
          // Re-running the proposal also invalidates whatever tests were
          // written from the prior plan.
          Object.assign(outputResets, {
            testPlan: null,
            tests: null,
            testsStreamText: "",
          });
          break;
        case "tests":
          Object.assign(outputResets, { tests: null, testsStreamText: "" });
          break;
        case "review":
          Object.assign(outputResets, { review: null, reviewStreamText: "" });
          break;
        case "pr":
          Object.assign(outputResets, {
            prDescription: null,
            prStreamText: "",
          });
          break;
        case "retro":
          Object.assign(outputResets, {
            retrospective: null,
            retroStreamText: "",
          });
          break;
      }

      set({
        errors,
        completedStages,
        pendingApproval,
        ...outputResets,
      });

      // Per-stage retry uses LangGraph's checkpoint history: rewind to the
      // checkpoint just before the target stage's node ran, then resume.
      // The workflow re-runs that stage and everything downstream onto a
      // new branch in the same thread.
      const threadId = get().pipelineThreadId;
      const rewindNode = STAGE_TO_REWIND_NODE[stage];
      if (threadId && rewindNode) {
        try {
          set({ proceeding: true });
          const result = await rewindImplementationPipelineWorkflow(
            threadId,
            rewindNode,
          );
          applyWorkflowResult((updater) => set((s) => updater(s)), result);
        } catch (e) {
          set({ proceeding: false });
          get().setError(stage, String(e));
        }
        return;
      }

      // No active workflow yet (e.g. retry triggered on a stage that never
      // ran via the new path) — fall back to a fresh pipeline start.
      const issue = get().selectedIssue;
      if (issue) {
        set({ pipelineThreadId: null });
        await get().startPipeline(issue);
      }
    },

    handleApproveEdit: (id) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, status: "approved" as SuggestedEditStatus } : e,
        ),
        groomingHighlights: {
          ...s.groomingHighlights,
          editIds: s.groomingHighlights.editIds.filter((e) => e !== id),
        },
      })),

    handleDeclineEdit: (id) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, status: "declined" as SuggestedEditStatus } : e,
        ),
        groomingHighlights: {
          ...s.groomingHighlights,
          editIds: s.groomingHighlights.editIds.filter((e) => e !== id),
        },
      })),

    handleEditSuggested: (id, newSuggested) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, suggested: newSuggested } : e,
        ),
        groomingHighlights: {
          ...s.groomingHighlights,
          editIds: s.groomingHighlights.editIds.filter((e) => e !== id),
        },
      })),

    clearEditHighlight: (id) =>
      set((s) => ({
        groomingHighlights: {
          ...s.groomingHighlights,
          editIds: s.groomingHighlights.editIds.filter((e) => e !== id),
        },
      })),

    clearAllGroomingHighlights: () =>
      set({
        groomingHighlights: { editIds: [], questions: false, ambiguities: false },
      }),

    toggleHighlights: () => set((s) => ({ showHighlights: !s.showHighlights })),

    // ── startPipeline ──────────────────────────────────────────────────────────
    startPipeline: async (issue) => {
      const current = get();

      // ── Save current session into the map before switching ──────────────────
      // Skip if grooming never completed — no point restoring a half-run agent.
      if (
        current.selectedIssue &&
        current.currentStage !== "select" &&
        !(current.currentStage === "grooming" && current.grooming === null)
      ) {
        const snapshot = snapshotSession(current);
        const sessions = new Map(current.sessions);
        sessions.set(current.selectedIssue.key, snapshot);
        set({ sessions });
      }

      // ── Restore an existing session for this ticket ─────────────────────────
      // Only restorable if the session was driven by the LangGraph workflow
      // path and has a live thread we can resume from. Sessions created by
      // the old per-stage flow are discarded — restoring them would leave
      // `pipelineThreadId` null and the next Proceed click would fail with
      // "Pipeline workflow has no active thread".
      const existingSession = get().sessions.get(issue.key);
      if (
        existingSession &&
        existingSession.currentStage !== "select" &&
        existingSession.pipelineThreadId
      ) {
        // Assign a fresh session ID — the old backend process is gone.
        set({
          ...existingSession,
          selectedIssue: issue,
          isSessionActive: true,
          activeSessionId: crypto.randomUUID(),
        });
        return;
      }

      // ── Fresh start for a new ticket ────────────────────────────────────────
      const sessions = get().sessions;
      set({
        ...INITIAL,
        sessions, // preserve the sessions map across resets
        selectedIssue: issue,
        currentStage: "grooming",
        viewingStage: "grooming",
        isSessionActive: true,
        activeSessionId: crypto.randomUUID(),
      });

      // Fetch full issue details
      let fullIssue = issue;
      try {
        fullIssue = await getIssue(issue.key);
        set({ selectedIssue: fullIssue });
      } catch {
        /* fall back to sprint-list version */
      }

      const text = compileTicketText(fullIssue);
      set({ ticketText: text });

      let skills: Partial<Record<SkillType, string>> = {};
      try {
        skills = await loadAgentSkills();
      } catch {
        /* no skills */
      }
      set({ skills });

      // Sync worktrees
      try {
        const config = await getNonSecretConfig();
        if (config["repo_worktree_path"]) {
          const info = await syncWorktree();
          set({ worktreeInfo: info });
        }
        // Pull latest on the grooming worktree so file reads are from develop
        if (config["grooming_worktree_path"] || config["repo_worktree_path"]) {
          await syncGroomingWorktree();
        }
      } catch (e) {
        console.warn("[Meridian] Worktree sync failed:", e);
      }

      // ── Pre-load codebase context via the grooming file probe ────────────
      // The grooming agent expects file contents in its prompt. Without them
      // the model often replies "I need to read X first" rather than
      // producing the schema-conformant JSON. Run the probe step now and
      // pass the result through to the workflow.
      const { worktreeInfo: probeWorktreeInfo } = get();
      const repoContext = probeWorktreeInfo
        ? `\n\n=== CODEBASE CONTEXT ===\nWorktree: ${probeWorktreeInfo.path}\nBranch: ${probeWorktreeInfo.branch} (HEAD: ${probeWorktreeInfo.headCommit})\nCommit: ${probeWorktreeInfo.headMessage}\nYou have access to this codebase. File contents will be injected below after a probe step.`
        : "";

      let codebaseContext = "";
      const readFilesForProbe: string[] = [];
      if (repoContext) {
        try {
          set({ groomingProgress: "Identifying relevant files in the codebase…" });
          const probeRaw = await runGroomingFileProbe(text + repoContext);
          const probe = parseAgentJson<{
            files: string[];
            grep_patterns: string[];
          }>(probeRaw);
          if (probe) {
            const MAX_TOTAL = 40 * 1024;
            let totalSize = 0;
            const parts: string[] = [];
            for (const filePath of (probe.files ?? []).slice(0, 12)) {
              try {
                set({ groomingProgress: `Reading ${filePath}…` });
                const content = await readGroomingFile(filePath);
                const chunk = `--- ${filePath} ---\n${content}\n`;
                if (totalSize + chunk.length > MAX_TOTAL) break;
                parts.push(chunk);
                totalSize += chunk.length;
                readFilesForProbe.push(filePath);
              } catch (e) {
                console.warn("[Meridian] file probe read failed:", filePath, e);
              }
            }
            for (const pattern of (probe.grep_patterns ?? []).slice(0, 6)) {
              try {
                set({ groomingProgress: `Searching codebase for "${pattern}"…` });
                const lines = await grepGroomingFiles(pattern);
                if (lines.length === 0) continue;
                const chunk = `--- grep: ${pattern} ---\n${lines.join("\n")}\n`;
                if (totalSize + chunk.length > MAX_TOTAL) break;
                parts.push(chunk);
                totalSize += chunk.length;
              } catch (e) {
                console.warn("[Meridian] file probe grep failed:", pattern, e);
              }
            }
            codebaseContext = parts.join("\n");
            set({ filesRead: readFilesForProbe, groomingProgress: "" });
          }
        } catch (e) {
          console.warn("[Meridian] file probe failed:", e);
          set({ groomingProgress: "" });
        }
      }

      // ── Pipeline workflow: run all stages via LangGraph in the sidecar ───
      await ensurePipelineListener();

      // Build worktree path from settings (used by the workflow for tool calls).
      let worktreePath = "";
      try {
        const config = await getNonSecretConfig();
        worktreePath = (config["repo_worktree_path"] as string) ?? "";
      } catch {
        /* fall back to empty — workflow tools won't function, but the
           workflow itself will at least surface the missing config */
      }

      const args: PipelineWorkflowArgs = {
        ticketText: text + (repoContext || ""),
        ticketKey: fullIssue.key,
        worktreePath,
        codebaseContext,
        skills: {
          grooming: skills.grooming ?? null,
          patterns: (skills as Record<string, string | undefined>).patterns ?? null,
          implementation: skills.implementation ?? null,
          review: skills.review ?? null,
          testing: (skills as Record<string, string | undefined>).testing ?? null,
        },
      };

      set({ proceeding: true });
      try {
        const result = await runImplementationPipelineWorkflow(args);
        applyWorkflowResult((updater) => set((s) => updater(s)), result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set((s) => ({
          errors: { ...s.errors, [s.currentStage]: msg },
          proceeding: false,
        }));
      }
    },

    sendTriageMessage: async (input) => {
      // The pipeline workflow is paused at the triage interrupt — resume with
      // a `reply` action and the workflow's triage node will take another turn
      // with the engineer's message appended to its history. The next
      // interrupt arrives over the event channel and is mapped onto the
      // triage state slices by `applyInterruptToState`.
      const userMsg: TriageMessage = { role: "user", content: input };
      set((s) => ({
        triageHistory: [...s.triageHistory, userMsg],
        proceeding: true,
        pendingApproval: null,
      }));
      try {
        const threadId = get().pipelineThreadId;
        if (!threadId) {
          throw new Error(
            "Pipeline workflow has no active thread — cannot send triage reply.",
          );
        }
        const result = await resumeImplementationPipelineWorkflow(threadId, {
          action: "reply",
          message: input,
        });
        applyWorkflowResult((updater) => set((s) => updater(s)), result);
      } catch (e) {
        set({ proceeding: false });
        get().setError("triage", String(e));
      }
    },

    finalizePlan: async () => {
      // Finalising the triage chat == approving the triage checkpoint. The
      // workflow then runs the plan + guidance nodes silently and interrupts
      // at the implementation checkpoint, where the user reviews the plan
      // before the implementation agent starts writing code.
      set({ pendingApproval: null, proceeding: true });
      try {
        // Create the feature branch BEFORE implementation runs — once the
        // workflow advances past triage it'll execute plan → guidance →
        // implementation in sequence, and the implementation agent's
        // write_repo_file calls need to land on the feature branch, not
        // the base branch.
        const { selectedIssue, featureBranch } = get();
        if (selectedIssue && !featureBranch) {
          try {
            const info = await createFeatureBranch(
              selectedIssue.key,
              selectedIssue.summary ?? "",
            );
            set({ featureBranch: info.branch, worktreeInfo: info });
          } catch (e) {
            console.warn("[Meridian] createFeatureBranch failed:", e);
          }
        }

        const threadId = get().pipelineThreadId;
        if (!threadId) {
          throw new Error("Pipeline workflow has no active thread — cannot finalize plan.");
        }
        const result = await resumeImplementationPipelineWorkflow(threadId, {
          action: "approve",
        });
        applyWorkflowResult((updater) => set((s) => updater(s)), result);
        get().markComplete("triage");
      } catch (e) {
        set({ proceeding: false });
        get().setError("plan", String(e));
      }
    },

    // ── Submit draft PR (squash → push → create on Bitbucket) ─────────────────
    submitDraftPr: async () => {
      const { selectedIssue, prDescription, featureBranch, createdPr } = get();
      if (createdPr) return; // idempotent
      if (!selectedIssue || !prDescription) {
        set({
          prSubmitStatus: "error",
          prSubmitError: "PR description is not ready yet.",
        });
        return;
      }

      // Mock-mode short-circuit: skip squash / push / createPullRequest so we
      // never touch a real git remote or Bitbucket when the user is driving
      // the pipeline with mock JIRA tickets. Stamp a synthetic BitbucketPr so
      // the UI flow can still advance to Retrospective.
      if (isMockMode()) {
        const now = new Date().toISOString();
        const mockPr: BitbucketPr = {
          id: 0,
          title: prDescription.title,
          description: prDescription.description,
          state: "OPEN",
          author: { displayName: "Mock", nickname: "mock", accountId: null },
          reviewers: [],
          sourceBranch: featureBranch ?? `feature/${selectedIssue.key}`,
          destinationBranch: "develop",
          createdOn: now,
          updatedOn: now,
          commentCount: 0,
          taskCount: 0,
          url: "",
          jiraIssueKey: selectedIssue.key,
          changesRequested: false,
          draft: true,
        };
        set({ createdPr: mockPr, prSubmitStatus: "idle", prSubmitError: null });
        return;
      }

      if (!featureBranch) {
        set({
          prSubmitStatus: "error",
          prSubmitError:
            "No feature branch was recorded for this session — re-run Implementation to create one.",
        });
        return;
      }

      const baseBranch =
        (await getNonSecretConfig().catch(() => ({} as Record<string, string>)))[
          "repo_base_branch"
        ] || "develop";

      // Commit message: use the PR title as subject; the description as body.
      // Keeping the JIRA key first means Bitbucket's JIRA integration picks it
      // up from the commit too, not just the branch name.
      const subject = prDescription.title.startsWith(selectedIssue.key)
        ? prDescription.title
        : `${selectedIssue.key}: ${prDescription.title}`;
      const squashMessage = `${subject}\n\n${prDescription.description}`;

      set({ prSubmitStatus: "squashing", prSubmitError: null });
      try {
        await squashWorktreeCommits(squashMessage);
      } catch (e) {
        set({
          prSubmitStatus: "error",
          prSubmitError: `Squash failed: ${String(e)}`,
        });
        return;
      }

      set({ prSubmitStatus: "pushing" });
      try {
        await pushWorktreeBranch();
      } catch (e) {
        set({
          prSubmitStatus: "error",
          prSubmitError: `Push failed: ${String(e)}`,
        });
        return;
      }

      set({ prSubmitStatus: "creating" });
      try {
        const pr = await createPullRequest(
          prDescription.title,
          prDescription.description,
          featureBranch,
          baseBranch,
        );
        set({ createdPr: pr, prSubmitStatus: "idle" });
      } catch (e) {
        set({
          prSubmitStatus: "error",
          prSubmitError: `Create PR failed: ${String(e)}`,
        });
      }
    },

    // ── Proceed from checkpoint ────────────────────────────────────────────────
    proceedFromStage: async (stage) => {
      set({ pendingApproval: null, proceeding: true });
      try {
        // Side-effects that the old per-stage proceed flow handled around the
        // implementation/tests boundary. The workflow itself doesn't commit;
        // the user's local feature branch needs the commits to accumulate
        // real history that the PR stage can squash later.
        if (stage === "implementation" || stage === "tests") {
          const { selectedIssue } = get();
          if (selectedIssue) {
            const msg = `${selectedIssue.key}: ${stage}`;
            try {
              await commitWorktreeChanges(msg);
            } catch (e) {
              console.warn(`[Meridian] commit after ${stage} failed:`, e);
            }
          }
        }

        const threadId = get().pipelineThreadId;
        if (!threadId) {
          throw new Error(
            "Pipeline workflow has no active thread — cannot resume. Restart the pipeline.",
          );
        }
        const result = await resumeImplementationPipelineWorkflow(threadId, {
          action: "approve",
        });
        applyWorkflowResult((updater) => set((s) => updater(s)), result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set((s) => ({
          errors: { ...s.errors, [stage]: msg },
          proceeding: false,
        }));
      }
    },

    // ── Checkpoint chat ────────────────────────────────────────────────────────
    sendCheckpointMessage: async (stage, input) => {
      await get()._reloadSkills();
      const {
        checkpointChats,
        ticketText,
        grooming,
        impact,
        skills,
        groomingChat,
      } = get();
      const stageLabels: Partial<Record<Stage, string>> = {
        grooming: "GROOMING",
        impact: "IMPACT ANALYSIS",
        plan: "IMPLEMENTATION PLAN",
        implementation: "IMPLEMENTATION RESULT",
        tests: "TEST SUGGESTIONS",
        review: "CODE REVIEW",
        pr: "PR DESCRIPTION",
        retro: "RETROSPECTIVE",
      };
      const s = get();
      const stageOutput =
        stage === "grooming"
          ? s.grooming
          : stage === "impact"
            ? s.impact
            : stage === "plan"
              ? s.plan
              : stage === "implementation"
                ? s.implementation
                : stage === "tests"
                  ? s.tests
                  : stage === "review"
                    ? s.review
                    : stage === "pr"
                      ? s.prDescription
                      : stage === "retro"
                        ? s.retrospective
                        : null;

      // Post-implementation stages benefit from having the implementation output in context.
      const postImplStages: Stage[] = [
        "implementation",
        "tests",
        "review",
        "pr",
        "retro",
      ];
      const isPostImpl = postImplStages.includes(stage);

      const contextParts = [
        compilePipelineContext(
          ticketText,
          grooming,
          impact,
          skills,
          groomingChat,
        ),
        isPostImpl && s.plan
          ? `=== IMPLEMENTATION PLAN ===\n${JSON.stringify(s.plan, null, 2)}`
          : "",
        isPostImpl && s.implementation
          ? `=== IMPLEMENTATION RESULT ===\n${JSON.stringify(s.implementation, null, 2)}`
          : "",
        stageOutput
          ? `=== ${stageLabels[stage] ?? stage.toUpperCase()} OUTPUT ===\n${JSON.stringify(stageOutput, null, 2)}`
          : "",
      ];

      const context = contextParts.filter(Boolean).join("\n\n");

      const prev = checkpointChats[stage] ?? [];
      const newHistory: TriageMessage[] = [
        ...prev,
        { role: "user", content: input },
      ];
      set({ checkpointChats: { ...checkpointChats, [stage]: newHistory } });

      try {
        const raw = await runCheckpointAction(
          stage,
          context,
          JSON.stringify(newHistory),
        );

        const parsed = parseAgentJson<CheckpointActionResult>(raw);
        const message = parsed?.message ?? raw;

        // ── Files were written directly by write_repo_file tool calls ────────
        const filesWritten: string[] = parsed?.files_written ?? [];

        // ── Update implementation state if files were changed ────────────────
        if (
          stage === "implementation" &&
          (filesWritten.length ||
            parsed?.deviations_resolved?.length ||
            parsed?.skipped_resolved?.length)
        ) {
          const devsResolved = new Set(parsed?.deviations_resolved ?? []);
          const skippedResolved = new Set(parsed?.skipped_resolved ?? []);
          set((st) => {
            if (!st.implementation) return {};
            const writtenSet = new Set(filesWritten);
            const updatedFiles = st.implementation.files_changed.map((f) =>
              writtenSet.has(f.path)
                ? { ...f, action: "modified" as const, summary: "Updated via checkpoint chat" }
                : f,
            );
            const newPaths = filesWritten.filter(
              (p) => !st.implementation!.files_changed.some((f) => f.path === p),
            );
            return {
              implementation: {
                ...st.implementation,
                files_changed: [
                  ...updatedFiles,
                  ...newPaths.map((p) => ({
                    path: p,
                    action: "modified" as const,
                    summary: "Created via checkpoint chat",
                  })),
                ],
                deviations: st.implementation.deviations.filter(
                  (d) => !devsResolved.has(d),
                ),
                skipped: st.implementation.skipped.filter(
                  (p) => !skippedResolved.has(p),
                ),
              },
            };
          });
        }

        // ── Apply updated_output for non-implementation stages ───────────────
        if (parsed?.updated_output && stage !== "implementation") {
          switch (stage) {
            case "impact":
              set({ impact: parsed.updated_output as ImpactOutput });
              break;
            case "plan":
              set({ plan: parsed.updated_output as ImplementationPlan });
              break;
            case "tests":
              set({ tests: parsed.updated_output as TestOutput });
              break;
            case "review":
              set({ review: parsed.updated_output as PlanReviewOutput });
              break;
            case "pr":
              set({ prDescription: parsed.updated_output as PrDescriptionOutput });
              break;
            case "retro":
              set({ retrospective: parsed.updated_output as RetrospectiveOutput });
              break;
          }
        }

        // ── Build display message with applied-changes callout ───────────────
        let displayMessage = message;
        if (filesWritten.length) {
          displayMessage += `\n\n**Files updated:** ${filesWritten.map((p) => `\`${p}\``).join(", ")}`;
        }
        if (parsed?.updated_output && stage !== "implementation") {
          displayMessage += "\n\n**Stage output updated.**";
        }

        set((st) => ({
          checkpointStreamText: "",
          checkpointChats: {
            ...st.checkpointChats,
            [stage]: [
              ...(st.checkpointChats[stage] ?? newHistory),
              { role: "assistant", content: displayMessage },
            ],
          },
        }));
      } catch (e) {
        const errMsg = `⚠️ Something went wrong: ${String(e)}`;
        set((st) => ({
          checkpointStreamText: "",
          checkpointChats: {
            ...st.checkpointChats,
            [stage]: [
              ...(st.checkpointChats[stage] ?? newHistory),
              { role: "assistant", content: errMsg },
            ],
          },
        }));
      }
    },

    // ── Grooming conversation ──────────────────────────────────────────────────
    sendGroomingChatMessage: async (input) => {
      const {
        groomingChat,
        grooming,
        groomingEdits,
        ticketText,
        selectedIssue,
      } = get();

      if (groomingChat.length === 0 && get().groomingBaseline === null) {
        set({ groomingBaseline: grooming });
      }

      const userMsg: TriageMessage = { role: "user", content: input };
      const newHistory = [...groomingChat, userMsg];
      set({ groomingChat: newHistory });

      const systemContext = [
        "=== TICKET ===",
        ticketText,
        "=== CURRENT GROOMING ANALYSIS ===",
        JSON.stringify(grooming, null, 2),
        "=== CURRENT SUGGESTED EDITS (with IDs — use same IDs to update, new IDs to add) ===",
        JSON.stringify(
          groomingEdits.map(
            ({
              id,
              field,
              section,
              current,
              suggested,
              reasoning,
              status,
            }) => ({
              id,
              field,
              section,
              current,
              suggested,
              reasoning,
              status,
            }),
          ),
          null,
          2,
        ),
      ].join("\n");

      try {
        const response = await runGroomingChatTurn(
          systemContext,
          JSON.stringify(newHistory),
        );
        const parsed = parseAgentJson<{
          message: string;
          updated_edits: Omit<SuggestedEdit, "status">[];
          updated_questions: string[];
          updated_ambiguities?: string[];
        }>(response);

        // If the full JSON failed to parse (most often because the response
        // was truncated mid-object), try to salvage just the prose `message`
        // field so the user sees clean text in the chat instead of raw JSON.
        // The panel won't update in this case — surface that clearly.
        let displayMessage: string;
        if (parsed?.message) {
          displayMessage = parsed.message;
        } else {
          const m = response.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const salvaged = m
            ? (() => {
                try { return JSON.parse(`"${m[1]}"`) as string; }
                catch { return null; }
              })()
            : null;
          displayMessage = salvaged
            ? `${salvaged}\n\n_(Note: the agent's response couldn't be fully parsed, so the panel above didn't update. Try asking again.)_`
            : "Sorry — the agent's response couldn't be parsed. Try rephrasing your message.";
        }
        set({
          groomingChat: [
            ...newHistory,
            { role: "assistant", content: displayMessage },
          ],
        });

        if (parsed) {
          const highlightEditIds: string[] = [];
          let questionsChanged = false;
          let ambiguitiesChanged = false;

          if (parsed.updated_edits && parsed.updated_edits.length > 0) {
            set((st) => {
              const existingById = new Map(
                st.groomingEdits.map((e) => [e.id, e]),
              );
              const merged = [...st.groomingEdits];
              for (const incoming of parsed.updated_edits) {
                const existing = existingById.get(incoming.id);
                if (existing) {
                  const idx = merged.findIndex((e) => e.id === incoming.id);
                  const textChanged =
                    existing.suggested !== incoming.suggested ||
                    existing.current !== incoming.current;
                  if (textChanged) highlightEditIds.push(incoming.id);
                  merged[idx] = {
                    ...incoming,
                    status: textChanged ? "pending" : existing.status,
                  };
                } else {
                  highlightEditIds.push(incoming.id);
                  merged.push({ ...incoming, status: "pending" });
                }
              }
              return { groomingEdits: merged };
            });
          }
          if (parsed.updated_questions !== undefined) {
            const prior = get().clarifyingQuestions;
            if (
              prior.length !== parsed.updated_questions.length ||
              prior.some((q, i) => q !== parsed.updated_questions[i])
            ) {
              questionsChanged = true;
            }
            set({ clarifyingQuestions: parsed.updated_questions });
          }
          if (parsed.updated_ambiguities !== undefined && get().grooming) {
            const prior = get().grooming?.ambiguities ?? [];
            if (
              prior.length !== parsed.updated_ambiguities.length ||
              prior.some((a, i) => a !== parsed.updated_ambiguities![i])
            ) {
              ambiguitiesChanged = true;
            }
            set((st) => ({
              grooming: st.grooming
                ? { ...st.grooming, ambiguities: parsed.updated_ambiguities! }
                : st.grooming,
            }));
          }

          if (
            highlightEditIds.length > 0 ||
            questionsChanged ||
            ambiguitiesChanged
          ) {
            set({
              groomingHighlights: {
                editIds: highlightEditIds,
                questions: questionsChanged,
                ambiguities: ambiguitiesChanged,
              },
            });
          }
        }

        if (selectedIssue && grooming) {
          set({
            groomingBlockers: detectGroomingBlockers(
              selectedIssue,
              get().grooming!,
            ),
          });
        }
      } catch {
        /* silently handle */
      }
    },

    // ── Push grooming edits to JIRA ────────────────────────────────────────────
    pushGroomingToJira: async () => {
      const { selectedIssue, groomingEdits, grooming } = get();
      if (!selectedIssue) return;
      const approved = groomingEdits.filter((e) => e.status === "approved");
      if (approved.length === 0) return;

      set({ jiraUpdateStatus: "saving", jiraUpdateError: "" });
      try {
        const descriptionFields: SuggestedEdit["field"][] = [
          "description",
          "acceptance_criteria",
        ];
        const descriptionEdits = approved.filter((e) =>
          descriptionFields.includes(e.field),
        );
        const otherEdits = approved.filter(
          (e) => !descriptionFields.includes(e.field),
        );

        if (descriptionEdits.length > 0 || grooming) {
          const g = grooming;
          const lines: string[] = [];
          if (g) lines.push(g.ticket_summary, "");

          const descEdit = descriptionEdits.find(
            (e) => e.field === "description",
          );
          const acEdit = descriptionEdits.find(
            (e) => e.field === "acceptance_criteria",
          );

          if (descEdit) {
            lines.push(descEdit.suggested, "");
          }
          if (acEdit) {
            lines.push("Acceptance Criteria:", acEdit.suggested, "");
          } else if (g && g.acceptance_criteria.length > 0) {
            lines.push("Acceptance Criteria:");
            g.acceptance_criteria.forEach((ac) => lines.push(`- ${ac}`));
            lines.push("");
          }

          await updateJiraIssue(
            selectedIssue.key,
            null,
            lines.join("\n").trim(),
          );
        }

        if (otherEdits.length > 0) {
          const fieldLabels = otherEdits.map((e) => e.section).join(", ");
          set({
            jiraUpdateError: `Saved. Note: ${fieldLabels} cannot be updated via the API — copy the suggested text and paste it into JIRA manually.`,
            jiraUpdateStatus: "saved",
          });
        } else {
          set({ jiraUpdateStatus: "saved" });
        }
      } catch (e) {
        set({ jiraUpdateError: String(e), jiraUpdateStatus: "error" });
      }
    },

    // ── Unified pipeline chat ──────────────────────────────────────────────────
    sendPipelineMessage: async (input) => {
      const s = get();
      if (s.pendingApproval === "grooming") {
        await get().sendGroomingChatMessage(input);
      } else if (s.pendingApproval) {
        await get().sendCheckpointMessage(s.pendingApproval, input);
      } else if (s.currentStage === "triage") {
        await get().sendTriageMessage(input);
      }
    },
  }),
);

// ── File-backed persistence ────────────────────────────────────────────────────

import { loadCache, saveCache } from "@/lib/storeCache";

/**
 * Fields that are transient and must NOT be persisted across app restarts.
 * Streaming progress, in-flight flags etc. reset to defaults on reload.
 */
function serializableState(s: ImplementTicketState) {
  return {
    ...s,
    // Stream texts are only valid while a Tauri command is actively running — clear them so a
    // restored session never shows stale mid-run output from a previous app launch.
    groomingProgress: "",
    groomingStreamText: "",
    impactStreamText: "",
    triageStreamText: "",
    planStreamText: "",
    implementationStreamText: "",
    implementationProgress: null,
    buildCheckStreamText: "",
    testsStreamText: "",
    reviewStreamText: "",
    prStreamText: "",
    retroStreamText: "",
    checkpointStreamText: "",
    proceeding: false,
  };
}

// Set by hydrateImplementStore when a stage was interrupted by an app close.
// Consumed (once) by ImplementTicketScreen to auto-rerun that stage.
let _pendingResume: Stage | null = null;
export function consumePendingResume(): Stage | null {
  const s = _pendingResume;
  _pendingResume = null;
  return s;
}

/**
 * Hydrate the store from the file cache.
 * Call this once on app startup (e.g. from App.tsx or a boot hook).
 */
export async function hydrateImplementStore(): Promise<void> {
  const cached = await loadCache<ImplementTicketState>(IMPLEMENT_STORE_KEY);
  if (!cached) return;
  // Ensure non-serialisable types are always correct instances
  const completedStages =
    cached.completedStages instanceof Set
      ? cached.completedStages
      : new Set((cached.completedStages as unknown as Stage[]) ?? []);
  const sessions =
    cached.sessions instanceof Map
      ? cached.sessions
      : new Map(
          Object.entries(
            (cached.sessions ?? {}) as Record<string, PipelineSession>,
          ),
        );

  // Detect zombie mid-run stages — the Tauri command that was running when the app closed
  // is gone, but the store thinks it's still in progress. Record which stage needs to be
  // resumed so the screen can auto-rerun it when the user navigates back.
  const stage = cached.currentStage as Stage;
  if (stage && stage !== "select" && stage !== "complete") {
    const outputMissing =
      (stage === "grooming" && !cached.grooming) ||
      (stage === "impact" && !cached.impact) ||
      (stage === "plan" && !cached.plan) ||
      (stage === "implementation" && !cached.implementation) ||
      (stage === "tests" && !cached.tests) ||
      (stage === "review" && !cached.review) ||
      (stage === "pr" && !cached.prDescription) ||
      (stage === "retro" && !cached.retrospective);
    if (outputMissing && cached.pendingApproval !== stage) {
      _pendingResume = stage;
    }
  }

  // Discard tests data in the old plan format (pre-tool-loop) — it used `test_strategy`
  // instead of `files_written` and would crash TestsPanel on render.
  const tests =
    cached.tests && "files_written" in cached.tests ? cached.tests : null;

  useImplementTicketStore.setState({
    ...cached,
    tests,
    completedStages,
    sessions,
    // Fresh ID on hydration — no backend process from a prior app run is still alive.
    activeSessionId: crypto.randomUUID(),
  });
}

// Subscribe and save on every state change (debounced).
useImplementTicketStore.subscribe((state) => {
  saveCache(IMPLEMENT_STORE_KEY, serializableState(state));
});
