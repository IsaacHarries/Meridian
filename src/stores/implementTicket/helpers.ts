import { useAiSelectionStore } from "@/stores/aiSelectionStore";
import {
    modelKey,
    useTokenUsageStore,
} from "@/stores/tokenUsageStore";

import { type JiraIssue } from "@/lib/tauri/jira";
import { type OrchestratorTurnOutput } from "@/lib/tauri/orchestrator";
import { type SkillType } from "@/lib/tauri/templates";
import { type GroomingOutput, type ImpactOutput, type ImplementationOutput, type PipelineWorkflowResult, type PlanReviewOutput, type PrDescriptionOutput, type SuggestedEdit, type SuggestedEditStatus, type TestOutput, type TestPlan, type TriageMessage, type TriageTurnOutput } from "@/lib/tauri/workflows";
import { type ReplanCheckpointPayload, type VerificationOutput } from "@/lib/tauri/worktree";
import { NODE_TO_STAGE, STAGE_ORDER } from "./constants";
import { useImplementTicketStore } from "./store";
import type {
    GroomingBlocker,
    ImplementTicketState,
    PipelineSession,
    Stage,
} from "./types";

// ── Apply a workflow interrupt's payload to the matching store slice ────────

export function applyInterruptToState(
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
      case "implementation": {
        // The implementation checkpoint payload is the implementation output
        // with the post-implementation verification result attached as a
        // sibling `verification` field. Split them back out so the panel
        // renders both alongside each other.
        const combined = (payload ?? {}) as ImplementationOutput & {
          verification?: VerificationOutput | null;
        };
        const { verification, ...implOutput } = combined;
        updates.implementation = implOutput as ImplementationOutput;
        updates.verificationOutput = verification ?? null;
        // Plan + guidance are intermediate silent stages — their
        // partial-stream snapshots are no longer relevant once
        // implementation has produced an interrupt.
        updates.partialPlan = null;
        updates.partialGuidance = null;
        break;
      }
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

// ── Apply the result of one workflow.start / workflow.resume call ──────────

/** Map a workflow result (interrupt or final) onto the store; called after
 *  every workflow.start / workflow.resume call. Also reports the call's
 *  token usage into the cross-panel token-usage store so the badge in
 *  the Implement Ticket header reflects cumulative agent cost. */
export function applyWorkflowResult(
  set: (updater: (s: ImplementTicketState) => Partial<ImplementTicketState>) => void,
  result: PipelineWorkflowResult,
): void {
  if (result.usage) {
    let mk: string | undefined;
    try {
      const ai = useAiSelectionStore.getState();
      const stage = useImplementTicketStore.getState().currentStage;
      // tests_plan shares an AI selection with tests in
      // aiSelectionStore — collapse here so resolve() accepts it.
      const validStage =
        stage === "grooming" ||
        stage === "impact" ||
        stage === "triage" ||
        stage === "plan" ||
        stage === "implementation" ||
        stage === "review" ||
        stage === "pr" ||
        stage === "retro"
          ? stage
          : stage === "tests_plan" || stage === "tests"
            ? "tests"
            : null;
      const r = ai.resolve("implement_ticket", validStage);
      if (r.model) mk = modelKey(r.provider, r.model);
    } catch {
      /* fall back to panel-only bucket */
    }
    useTokenUsageStore
      .getState()
      .addUsage("implement_ticket", result.usage, mk);
  }
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
      pipelineActivity: null,
      // The workflow completed — the retrospective is the final stage
      // and its partial snapshot is no longer needed.
      partialRetrospective: null,
    }));
  }
}

// ── Pure helpers (no store coupling) ────────────────────────────────────────

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
export function formatTriageChatContent(turn: TriageTurnOutput): string {
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

  // A JiraIssue carries description content in EITHER the top-level
  // `description` string (legacy / simple tickets) OR the
  // `descriptionSections` array (rich Atlassian Document Format payload
  // split by headings — what every modern Jira instance returns and
  // what `compileTicketText` already prefers when building the agent's
  // prompt). We have to mirror that "either source" logic here, or
  // tickets like DEMO-2 — whose description content lives entirely
  // under `descriptionSections` — get falsely flagged as having no
  // description even though the agent saw plenty of content.
  const sectionContent = (issue.descriptionSections ?? [])
    .map((s) => `${s.heading ?? ""}\n${s.content ?? ""}`)
    .join("\n")
    .trim();
  const descriptionContent = (issue.description ?? "").trim();
  const totalDescriptionLen = descriptionContent.length + sectionContent.length;
  if (totalDescriptionLen < 10) {
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

// ── Session snapshot helper ────────────────────────────────────────────────

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
    verificationOutput: s.verificationOutput,
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
  result: { output: OrchestratorTurnOutput | null },
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

/** Strip per-edit `reasoning` fields from grooming output before
 *  stringifying it into the orchestrator's context. Reasoning is the
 *  agent's own justification for each suggested edit — useful at
 *  draft time, but on subsequent chat turns it's the original agent
 *  explaining itself to a future copy of itself. Dropping it cuts the
 *  largest chunk of churn out of every replay turn. */
export function stripGroomingReasoning(g: GroomingOutput): unknown {
  return {
    ...g,
    suggested_edits: g.suggested_edits.map((e) => {
      const { reasoning: _r, ...rest } = e;
      return rest;
    }),
  };
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
    parts.push(
      `=== GROOMING OUTPUT ===\n${JSON.stringify(stripGroomingReasoning(s.grooming), null, 2)}`,
    );
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

// ── Persistence helpers ─────────────────────────────────────────────────────

/**
 * Fields that are transient and must NOT be persisted across app restarts.
 * Streaming progress, in-flight flags etc. reset to defaults on reload.
 */
export function serializableState(s: ImplementTicketState) {
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
    pipelineActivity: null,
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

// ── Pending-resume bookkeeping (set by hydrate, consumed by screen) ─────────

let _pendingResume: Stage | null = null;

export function setPendingResume(stage: Stage | null): void {
  _pendingResume = stage;
}

export function consumePendingResume(): Stage | null {
  const s = _pendingResume;
  _pendingResume = null;
  return s;
}
