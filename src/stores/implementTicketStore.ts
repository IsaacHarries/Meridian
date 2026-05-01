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
  runGroomingChatTurn,
  type BuildCheckResult,
  type ReplanCheckpointPayload,
  updateJiraIssue,
  parseAgentJson,
  readGroomingFile,
  grepGroomingFiles,
  cancelImplementationPipelineWorkflow,
  runImplementationPipelineWorkflow,
  resumeImplementationPipelineWorkflow,
  PIPELINE_EVENT_NAME,
  type PipelineEvent,
  type PipelineWorkflowArgs,
  type PipelineWorkflowResult,
  type PipelineResumeAction,
  rewindImplementationPipelineWorkflow,
  chatWithOrchestrator,
  applyPlanEdits,
  type OrchestratorMessage,
  type OrchestratorPendingProposal,
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
if (typeof import.meta !== "undefined" && (import.meta as unknown as { hot?: { dispose?: (cb: () => void) => void } }).hot) {
  (import.meta as unknown as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
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
  replan: "replan",
  test_plan: "tests_plan",
  test_gen: "tests",
  code_review: "review",
  pr_description: "pr",
  do_retrospective: "retro",
};

/** Map a user-facing Stage to the next visible stage when the user clicks
 *  Proceed at that stage's checkpoint. Used to advance viewingStage
 *  optimistically — the moment Proceed is clicked the screen jumps to
 *  the next stage's panel and the partial-output stream starts filling
 *  it in, instead of leaving the user staring at the prior panel for
 *  the duration of the workflow round-trip. */
const NEXT_STAGE_AFTER_PROCEED: Partial<Record<Stage, Exclude<Stage, "select">>> = {
  grooming: "impact",
  impact: "triage",
  // Triage on approve runs do_plan → do_guidance → implementation. Land
  // on `plan` so the plan-finalising panel shows the partial plan
  // streaming in before implementation kicks off.
  triage: "plan",
  // Plan stage isn't checkpointed independently — the proceed comes
  // from triage. Listed for completeness in case the flow ever changes.
  plan: "implementation",
  implementation: "tests_plan",
  tests_plan: "tests",
  tests: "review",
  review: "pr",
  pr: "retro",
  retro: "complete",
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
      // The replan checkpoint payload is only meaningful while we're paused
      // at it; clear it as soon as the workflow advances to any other stage
      // so the UI doesn't render stale failure context.
      replanCheckpoint: stage === "replan" ? s.replanCheckpoint : null,
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
        updates.partialGrooming = null;
        // Mirror the post-grooming UI setup the old per-stage path did:
        // build editable suggestions, surface clarifying questions as a
        // welcome chat message, snapshot the initial Q/A state for the
        // diff-style highlight rendering, and detect blockers.
        const edits: SuggestedEdit[] = (data.suggested_edits ?? []).map((e) => ({
          ...e,
          status: "pending" as SuggestedEditStatus,
        }));
        const questions = data.clarifying_questions ?? [];
        const initialChat: TriageMessage[] =
          questions.length > 0
            ? [
                {
                  role: "assistant",
                  content:
                    questions.length === 1
                      ? `I have one question before we finalise the grooming:\n\n${questions[0]}`
                      : `I have a few questions before we finalise the grooming:\n\n${questions
                          .map((q, i) => `${i + 1}. ${q}`)
                          .join("\n\n")}`,
                },
              ]
            : [];
        updates.groomingEdits = edits;
        updates.clarifyingQuestions = questions;
        updates.clarifyingQuestionsInitial = questions;
        updates.groomingHighlights = {
          editIds: [],
          questions: false,
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
        updates.partialImpact = null;
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
        updates.partialTriageTurn = null;
        break;
      }
      case "implementation":
        updates.implementation = payload as ImplementationOutput;
        // Plan + guidance are intermediate silent stages — their
        // partial-stream snapshots are no longer relevant once
        // implementation has produced an interrupt.
        updates.partialPlan = null;
        updates.partialGuidance = null;
        break;
      case "replan":
        updates.replanCheckpoint = payload as ReplanCheckpointPayload;
        break;
      case "test_plan":
        updates.testPlan = payload as TestPlan;
        break;
      case "test_gen":
        updates.tests = payload as TestOutput;
        break;
      case "code_review":
        updates.review = payload as PlanReviewOutput;
        updates.partialReview = null;
        break;
      case "pr_description":
        updates.prDescription = payload as PrDescriptionOutput;
        updates.partialPrDescription = null;
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
    // Auto-trigger an orchestrator review for stages where it adds value.
    // Grooming/triage have their own dedicated sub-agent chats; replan
    // surfaces its own structured panel; retro is terminal. The trigger
    // itself is dedup-guarded so duplicate calls (e.g. re-render) are no-ops.
    const reason = result.interrupt.reason;
    const reviewable = new Set([
      "impact",
      "implementation",
      "test_plan",
      "test_gen",
      "code_review",
      "pr_description",
    ]);
    if (reviewable.has(reason)) {
      const contextText = JSON.stringify(result.interrupt.payload, null, 2);
      const stage = NODE_TO_STAGE[reason];
      if (stage) {
        // Defer to break out of the current synchronous update cycle so
        // state has settled before we read it inside the action.
        queueMicrotask(() => {
          void useImplementTicketStore.getState().triggerOrchestratorReview(
            stage,
            `=== ${reason.toUpperCase()} OUTPUT ===\n${contextText}`,
          );
        });
      }
    }
  } else if (result.output) {
    set(() => ({
      pipelineFinalState: result.output,
      currentStage: "complete" as Stage,
      pendingApproval: null,
      proceeding: false,
      // The workflow completed — the retrospective is the final stage
      // and its partial snapshot is no longer needed.
      partialRetrospective: null,
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

/** Per-node partial-output field — populated by `streamLLMJson` `progress`
 *  events with `data.partial`. The screen prefers the partial over the
 *  final output while the stage is still streaming so the structured
 *  panel renders incrementally instead of all at once on completion. */
const NODE_TO_PARTIAL_FIELD: Record<string, keyof ImplementTicketState> = {
  grooming: "partialGrooming",
  impact: "partialImpact",
  triage: "partialTriageTurn",
  do_plan: "partialPlan",
  do_guidance: "partialGuidance",
  code_review: "partialReview",
  pr_description: "partialPrDescription",
  do_retrospective: "partialRetrospective",
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

    // Stale-event guard: each pipeline event carries the runId of the
    // workflow.start/resume/rewind call that produced it. If the user
    // has since cancelled / superseded that run (e.g. via Retry at an
    // earlier stage), `currentRunId` won't match and the event is
    // dropped — otherwise the orphan run's late-arriving interrupt
    // would jump the UI back to a later stage. We do allow events
    // through when currentRunId is null, since some store consumers
    // (e.g. session-restore) may not have set it yet.
    const eventRunId = (e as { runId?: string }).runId;
    const expectedRunId = useImplementTicketStore.getState().currentRunId;
    if (expectedRunId && eventRunId && eventRunId !== expectedRunId) {
      return;
    }

    if (e.kind === "progress" && e.status === "started") {
      // Live partial-JSON streaming from any node that uses
      // `streamLLMJson` in the sidecar — surfaces a partial output as
      // the model emits tokens so the UI can render fields incrementally
      // instead of waiting for the full reply (mirrors PR Review's
      // `partialReport`).
      const partialData = e.data as { partial?: unknown } | undefined;
      const partialField = NODE_TO_PARTIAL_FIELD[e.node];
      if (
        partialField &&
        partialData?.partial &&
        typeof partialData.partial === "object"
      ) {
        setState({ [partialField]: partialData.partial } as Partial<ImplementTicketState>);
        return;
      }

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

  // ── Agent outputs ────────────────────────────────────────────────────────────
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
  buildVerification: BuildCheckResult | null;
  buildCheckStreamText: string;
  /** Payload for the `replan` checkpoint, populated when the pipeline pauses
   *  at the plan-revision interrupt. Cleared on next interrupt. */
  replanCheckpoint: ReplanCheckpointPayload | null;
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

  // ── Orchestrator chat (long-lived, spans every stage) ───────────────────────
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
  | "sendOrchestratorMessage"
  | "resolveOrchestratorProposal"
  | "triggerOrchestratorReview"
  | "sendPipelineMessage"
> = {
  selectedIssue: null,
  currentStage: "select",
  viewingStage: "grooming",
  completedStages: new Set(),
  pendingApproval: null,
  proceeding: false,
  grooming: null,
  partialGrooming: null,
  partialImpact: null,
  partialTriageTurn: null,
  partialPlan: null,
  partialGuidance: null,
  partialReview: null,
  partialPrDescription: null,
  partialRetrospective: null,
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
  replanCheckpoint: null,
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
  groomingHighlights: { editIds: [], questions: false },
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
  orchestratorThreadId: null,
  orchestratorThread: [],
  orchestratorStageSummaries: {},
  orchestratorUserNotes: [],
  orchestratorPendingProposal: null,
  orchestratorStreamText: "",
  orchestratorSending: false,
  orchestratorReviewedStages: [],
  errors: {},
  worktreeInfo: null,
  ticketText: "",
  skills: {},
  isSessionActive: false,
  activeSessionId: "",
  pipelineThreadId: null,
  currentRunId: null,
  pipelineFinalState: null,
  sessions: new Map(),
};

// ── Persistence key ────────────────────────────────────────────────────────────

// v2: orchestrator landed; the old shape held `checkpointChats` and other
// fields the new code doesn't read. Bumping the key abandons the stale
// blob so we don't hydrate ghost state into the new schema.
export const IMPLEMENT_STORE_KEY = "meridian-implement-store-v2";

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
    groomingHighlights: s.groomingHighlights,
    filesRead: s.filesRead,
    groomingChat: s.groomingChat,
    groomingBaseline: s.groomingBaseline,
    jiraUpdateStatus: s.jiraUpdateStatus,
    jiraUpdateError: s.jiraUpdateError,
    groomingProgress: s.groomingProgress,
    groomingStreamText: s.groomingStreamText,
    orchestratorThreadId: s.orchestratorThreadId,
    orchestratorThread: s.orchestratorThread,
    orchestratorStageSummaries: s.orchestratorStageSummaries,
    orchestratorUserNotes: s.orchestratorUserNotes,
    orchestratorPendingProposal: s.orchestratorPendingProposal,
    orchestratorReviewedStages: s.orchestratorReviewedStages,
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
            partialGrooming: null,
            groomingEdits: [],
            clarifyingQuestions: [],
            clarifyingQuestionsInitial: [],
            groomingHighlights: {
              editIds: [],
              questions: false,
            },
            groomingBlockers: [],
            groomingProgress: "",
            groomingStreamText: "",
            filesRead: [],
          });
          break;
        case "impact":
          Object.assign(outputResets, {
            impact: null,
            partialImpact: null,
            impactStreamText: "",
          });
          break;
        case "triage":
          Object.assign(outputResets, {
            triageHistory: [],
            triageTurns: [],
            triageStreamText: "",
            partialTriageTurn: null,
          });
          break;
        case "plan":
          Object.assign(outputResets, {
            plan: null,
            guidance: null,
            planStreamText: "",
            partialPlan: null,
            partialGuidance: null,
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
          Object.assign(outputResets, {
            review: null,
            partialReview: null,
            reviewStreamText: "",
          });
          break;
        case "pr":
          Object.assign(outputResets, {
            prDescription: null,
            partialPrDescription: null,
            prStreamText: "",
          });
          break;
        case "retro":
          Object.assign(outputResets, {
            retrospective: null,
            partialRetrospective: null,
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
          // Cancel any in-flight run for this pipeline before we
          // rewind. Retry at an earlier stage explicitly invalidates
          // the prior run — without cancelling, the orphan model call
          // keeps streaming events into the listener and can jump the
          // UI back to a later stage when its interrupt finally lands.
          // The runId guard provides defence-in-depth, but cancelling
          // also stops the sidecar from emitting any further events
          // for the orphan run.
          const priorRunId = get().currentRunId;
          if (priorRunId) {
            try {
              await cancelImplementationPipelineWorkflow(priorRunId);
            } catch (e) {
              // Cancel is best-effort — the prior run may already be
              // done, or the sidecar may have restarted.
              console.warn("[Meridian] cancel prior pipeline run failed:", e);
            }
          }
          const runId = crypto.randomUUID();
          set({ proceeding: true, currentRunId: runId });
          const result = await rewindImplementationPipelineWorkflow(
            threadId,
            rewindNode,
            runId,
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
        set({ pipelineThreadId: null, currentRunId: null });
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
        groomingHighlights: { editIds: [], questions: false },
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

      const runId = crypto.randomUUID();
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
        runId,
      };

      set({ proceeding: true, currentRunId: runId });
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
      const runId = crypto.randomUUID();
      set((s) => ({
        triageHistory: [...s.triageHistory, userMsg],
        proceeding: true,
        pendingApproval: null,
        currentRunId: runId,
      }));
      try {
        const threadId = get().pipelineThreadId;
        if (!threadId) {
          throw new Error(
            "Pipeline workflow has no active thread — cannot send triage reply.",
          );
        }
        const result = await resumeImplementationPipelineWorkflow(
          threadId,
          {
            action: "reply",
            message: input,
          },
          runId,
        );
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
      const runId = crypto.randomUUID();
      set({
        pendingApproval: null,
        proceeding: true,
        currentRunId: runId,
        // Optimistically advance the visible stage to "plan" so the
        // plan-finalising panel renders immediately — same pattern as
        // proceedFromStage. The plan partial fills in as it streams.
        currentStage: "plan",
        viewingStage: "plan",
      });
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
        const result = await resumeImplementationPipelineWorkflow(
          threadId,
          { action: "approve" },
          runId,
        );
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
    proceedFromStage: async (stage, action = { action: "approve" }) => {
      // Advance the visible stage immediately on Proceed so the user
      // jumps to the next stage's panel and watches its partial output
      // stream in, rather than seeing the loading icon on the prior
      // stage for the duration of the workflow round-trip. Only applies
      // to forward-moving actions: revise loops back to plan; abort and
      // reply stay where they are.
      const nextStage =
        action.action === "approve" ? NEXT_STAGE_AFTER_PROCEED[stage] : null;
      // Mint a fresh runId for this resume call so the listener can
      // distinguish events of this run from any prior run that may
      // still be in-flight (the most common case being the user
      // clicking through stages quickly enough that resume N+1's
      // events overlap with resume N's tail).
      const runId = crypto.randomUUID();
      const advanceUpdates: Partial<ImplementTicketState> = {
        pendingApproval: null,
        proceeding: true,
        currentRunId: runId,
      };
      if (nextStage) {
        advanceUpdates.currentStage = nextStage;
        if (nextStage !== "complete") {
          advanceUpdates.viewingStage = nextStage as Exclude<Stage, "select">;
        }
      }
      set(advanceUpdates);
      try {
        // Side-effects that the old per-stage proceed flow handled around the
        // implementation/tests boundary. The workflow itself doesn't commit;
        // the user's local feature branch needs the commits to accumulate
        // real history that the PR stage can squash later. Skip when revising
        // — the partial work hasn't reached an approved state yet.
        const isApprove = action.action === "approve";
        if (isApprove && (stage === "implementation" || stage === "tests")) {
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
        const result = await resumeImplementationPipelineWorkflow(
          threadId,
          action,
          runId,
        );
        applyWorkflowResult((updater) => set((s) => updater(s)), result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set((s) => ({
          errors: { ...s.errors, [stage]: msg },
          proceeding: false,
        }));
      }
    },

    // (sendCheckpointMessage removed — replaced by sendOrchestratorMessage)

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

          if (highlightEditIds.length > 0 || questionsChanged) {
            set({
              groomingHighlights: {
                editIds: highlightEditIds,
                questions: questionsChanged,
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
    // ── Orchestrator actions ──────────────────────────────────────────────────
    sendOrchestratorMessage: async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      // Race lock: a single orchestrator thread can only have one outstanding
      // turn at a time. The sidecar's SQLite checkpointer also serialises on
      // thread_id, but coordinating concurrent invokes from the frontend
      // wastes time + tokens — refuse early.
      if (get().orchestratorSending) {
        console.warn("[orchestrator] refused: another turn is in flight");
        return;
      }
      await get()._reloadSkills();

      const s = get();
      const threadId = ensureOrchestratorThreadId(set, get);
      if (!threadId) {
        console.warn("[orchestrator] cannot send: no active ticket");
        return;
      }

      set({
        orchestratorSending: true,
        orchestratorStreamText: "",
      });

      try {
        const result = await chatWithOrchestrator({
          threadId,
          pipelineThreadId: s.pipelineThreadId ?? undefined,
          message: trimmed,
          messageKind: "user",
          currentStage: s.currentStage,
          contextText: buildOrchestratorContextText(s),
        });
        applyOrchestratorResult(set, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[orchestrator] turn failed:", msg);
        set({
          orchestratorSending: false,
          orchestratorStreamText: "",
        });
      }
    },

    resolveOrchestratorProposal: async (decision) => {
      const s = get();
      const proposal = s.orchestratorPendingProposal;
      if (!proposal) return;
      if (s.orchestratorSending) {
        console.warn("[orchestrator] refused proposal resolution: turn in flight");
        return;
      }

      // On accept, fire the appropriate pipeline command or mutation. On
      // reject, skip and just notify the orchestrator.
      let actionDescription: string;
      // Stage summaries that became stale because of this resolution. Only
      // populated for rewind acceptance — every other resolution leaves
      // existing summaries valid.
      let dropSummariesForStages: string[] = [];
      if (decision === "accepted") {
        try {
          switch (proposal.kind) {
            case "proceed": {
              await get().proceedFromStage(s.currentStage, {
                action: proposal.action,
                ...(proposal.action === "abort" && proposal.reason
                  ? { reason: proposal.reason }
                  : {}),
              } as PipelineResumeAction);
              actionDescription = `User accepted — pipeline ${proposal.action} fired.`;
              break;
            }
            case "rewind": {
              const threadId = s.pipelineThreadId;
              if (!threadId) throw new Error("No active pipeline thread to rewind.");
              await rewindImplementationPipelineWorkflow(threadId, proposal.toStage);
              actionDescription = `User accepted — rewound to ${proposal.toStage}.`;
              // Any summary whose stage came AFTER the rewind target is now
              // stale — its conversation referenced state that no longer
              // exists. Compute the set so the orchestrator's next turn
              // drops them via the new dropSummariesForStages channel.
              const targetIdx = STAGE_ORDER.indexOf(proposal.toStage as Stage);
              if (targetIdx >= 0) {
                dropSummariesForStages = STAGE_ORDER.slice(targetIdx).filter(
                  (st) => st !== proposal.toStage,
                );
              }
              break;
            }
            case "reply": {
              const threadId = s.pipelineThreadId;
              if (!threadId) throw new Error("No active pipeline thread.");
              await resumeImplementationPipelineWorkflow(threadId, {
                action: "reply",
                message: proposal.message,
              });
              actionDescription = `User accepted — triage reply sent.`;
              break;
            }
            case "edit_plan": {
              const threadId = s.pipelineThreadId;
              if (!threadId)
                throw new Error("No active pipeline thread to edit plan on.");
              const result = await applyPlanEdits({
                pipelineThreadId: threadId,
                edits: proposal.edits,
              });
              const fileCount = result.output?.planFileCount;
              actionDescription =
                `User accepted — applied ${proposal.edits.length} plan edit(s).` +
                (fileCount !== undefined ? ` Plan now has ${fileCount} file(s).` : "");
              // Mirror the new plan into local store state so the panel
              // refreshes immediately. We re-fetch via the next interrupt
              // when one fires; for now, mark the plan dirty by reading
              // the orchestrator-supplied state. Since the pipeline isn't
              // currently running, the easiest visible refresh is to
              // include a hint here for the user.
              break;
            }
            case "accept_grooming_edit": {
              if (proposal.newStatus === "approved") {
                get().handleApproveEdit(proposal.editId);
              } else {
                get().handleDeclineEdit(proposal.editId);
              }
              actionDescription = `User accepted — grooming edit ${proposal.editId} ${proposal.newStatus}.`;
              break;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          actionDescription = `User accepted but the action failed: ${msg}`;
        }
      } else {
        actionDescription = `User rejected the proposal.`;
      }

      // Notify the orchestrator so its next turn knows the outcome and
      // clears its `pendingProposal` channel.
      const threadId = ensureOrchestratorThreadId(set, get);
      if (!threadId) return;

      set({
        orchestratorSending: true,
        orchestratorStreamText: "",
      });
      try {
        const result = await chatWithOrchestrator({
          threadId,
          pipelineThreadId: get().pipelineThreadId ?? undefined,
          message: actionDescription,
          messageKind: "system_note",
          currentStage: get().currentStage,
          clearPendingProposal: true,
          dropSummariesForStages,
        });
        applyOrchestratorResult(set, result);
      } catch (err) {
        console.error("[orchestrator] proposal-resolution turn failed:", err);
        set({
          orchestratorSending: false,
          orchestratorStreamText: "",
          // Even if the notify-turn fails, clear locally so the UI doesn't
          // leave a stale confirm card up.
          orchestratorPendingProposal: null,
        });
      }
    },

    triggerOrchestratorReview: async (stage, contextText) => {
      const s = get();
      if (s.orchestratorReviewedStages.includes(stage)) return; // dedup
      // If a turn is in flight, bail rather than queue. The auto-review
      // re-fires next time the user advances; a missed review is far better
      // than a malformed concurrent one.
      if (s.orchestratorSending) return;
      const threadId = ensureOrchestratorThreadId(set, get);
      if (!threadId) return;

      set((st) => ({
        orchestratorReviewedStages: [...st.orchestratorReviewedStages, stage],
        orchestratorSending: true,
        orchestratorStreamText: "",
      }));

      const reviewPrompt =
        `The ${stage} agent just produced its output. Review it briefly for ` +
        `consistency with our prior conversation and any concerns the developer ` +
        `flagged earlier. If everything looks good, say so plainly so we can move on. ` +
        `Be concise — 1 to 3 sentences.`;

      try {
        const result = await chatWithOrchestrator({
          threadId,
          pipelineThreadId: s.pipelineThreadId ?? undefined,
          message: reviewPrompt,
          messageKind: "system_note",
          currentStage: stage,
          contextText,
        });
        applyOrchestratorResult(set, result);
      } catch (err) {
        console.error("[orchestrator] review turn failed:", err);
        set({
          orchestratorSending: false,
          orchestratorStreamText: "",
        });
      }
    },

    sendPipelineMessage: async (input) => {
      const s = get();
      // Grooming and triage keep their dedicated chats — they're tightly
      // coupled to their sub-agent's state machine. Every other stage
      // routes through the long-lived orchestrator.
      if (s.pendingApproval === "grooming") {
        await get().sendGroomingChatMessage(input);
      } else if (s.currentStage === "triage") {
        await get().sendTriageMessage(input);
      } else {
        await get().sendOrchestratorMessage(input);
      }
    },
  }),
);

// ── Orchestrator helpers ─────────────────────────────────────────────────────

/** Ensure `orchestratorThreadId` is set for the currently-selected ticket;
 *  initialises lazily so the same chat thread is reused across sessions. */
export function ensureOrchestratorThreadId(
  set: (partial: Partial<ImplementTicketState>) => void,
  get: () => ImplementTicketState,
): string | null {
  const s = get();
  if (s.orchestratorThreadId) return s.orchestratorThreadId;
  const key = s.selectedIssue?.key;
  if (!key) return null;
  const threadId = `orchestrator:${key}`;
  set({ orchestratorThreadId: threadId });
  return threadId;
}

/** Apply the result of one orchestrator turn to the store. The sidecar
 *  returns the full updated state; we replace the slice wholesale rather
 *  than diffing. */
export function applyOrchestratorResult(
  set: (
    updater: (s: ImplementTicketState) => Partial<ImplementTicketState>,
  ) => void,
  result: { output: import("@/lib/tauri").OrchestratorTurnOutput | null },
): void {
  const out = result.output;
  if (!out) {
    set(() => ({
      orchestratorSending: false,
      orchestratorStreamText: "",
    }));
    return;
  }
  set(() => ({
    orchestratorThread: out.thread,
    orchestratorStageSummaries: out.stageSummaries,
    orchestratorUserNotes: out.userNotes,
    orchestratorPendingProposal: out.pendingProposal ?? null,
    orchestratorSending: false,
    orchestratorStreamText: "",
  }));
}

/** Build the per-turn context text the orchestrator gets for grounding.
 *  Cheap to assemble; saves the orchestrator from having to call
 *  `get_pipeline_state` for routine "what stage am I on / what did the
 *  current agent produce" questions. */
export function buildOrchestratorContextText(s: ImplementTicketState): string {
  const parts: string[] = [];
  if (s.currentStage && s.currentStage !== "select") {
    parts.push(`Current stage: ${s.currentStage}`);
  }
  if (s.grooming) {
    parts.push(`=== GROOMING OUTPUT ===\n${JSON.stringify(s.grooming, null, 2)}`);
  }
  if (s.impact) {
    parts.push(`=== IMPACT OUTPUT ===\n${JSON.stringify(s.impact, null, 2)}`);
  }
  if (s.plan) {
    parts.push(`=== PLAN ===\n${JSON.stringify(s.plan, null, 2)}`);
  }
  if (s.implementation) {
    parts.push(
      `=== IMPLEMENTATION RESULT ===\n${JSON.stringify(s.implementation, null, 2)}`,
    );
  }
  if (s.testPlan) {
    parts.push(`=== TEST PLAN ===\n${JSON.stringify(s.testPlan, null, 2)}`);
  }
  if (s.tests) {
    parts.push(`=== TESTS WRITTEN ===\n${JSON.stringify(s.tests, null, 2)}`);
  }
  if (s.review) {
    parts.push(`=== CODE REVIEW ===\n${JSON.stringify(s.review, null, 2)}`);
  }
  if (s.prDescription) {
    parts.push(`=== PR DESCRIPTION ===\n${JSON.stringify(s.prDescription, null, 2)}`);
  }
  return parts.join("\n\n");
}

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
    // Partial agent outputs are also mid-run scratch state — drop on
    // serialise so a restored session shows the final outputs only.
    partialGrooming: null,
    partialImpact: null,
    partialTriageTurn: null,
    partialPlan: null,
    partialGuidance: null,
    partialReview: null,
    partialPrDescription: null,
    partialRetrospective: null,
    // currentRunId only refers to a live in-flight run. A restored
    // session has no live run — drop it so the listener doesn't
    // accidentally accept events from an unrelated run that happens to
    // share the persisted id.
    currentRunId: null,
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
