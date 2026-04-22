/**
 * Zustand store for the Implement a Ticket pipeline.
 *
 * All pipeline state lives here so that navigating away and back preserves
 * progress. In-flight Tauri async calls write to this store via get() and set(),
 * so the component being unmounted has no effect on them.
 */

import { create } from "zustand";
import { getPreferences } from "@/lib/preferences";
import {
  type JiraIssue,
  type GroomingOutput,
  type ImpactOutput,
  type ImplementationPlan,
  type GuidanceOutput,
  type ImplementationOutput,
  type TestOutput,
  type PlanReviewOutput,
  type PrDescriptionOutput,
  type RetrospectiveOutput,
  type TriageMessage,
  type SuggestedEdit,
  type SuggestedEditStatus,
  type RetroKbEntry,
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
  getNonSecretConfig,
  runGroomingFileProbe,
  runGroomingAgent,
  runImpactAnalysis,
  runTriageTurn,
  runCheckpointChatTurn as _runCheckpointChatTurnLegacy,
  runCheckpointAction,
  type CheckpointActionResult,
  runGroomingChatTurn,
  finalizeImplementationPlan,
  runImplementationGuidance,
  runImplementationAgent,
  runBuildCheck,
  type BuildCheckResult,
  runTestAgent,
  runPlanReview,
  getRepoDiff,
  runPrDescriptionGen,
  runRetrospectiveAgent,
  updateJiraIssue,
  saveKnowledgeEntry,
  parseAgentJson,
  readRepoFile,
  grepRepoFiles,
} from "@/lib/tauri";

export type { SkillType };

// ── Re-export Stage type so the screen and store share one definition ──────────

export type Stage =
  | "select"
  | "grooming"
  | "impact"
  | "triage"
  | "plan"
  | "implementation"
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

function prependSkill(
  text: string,
  skill: string | undefined,
  label: string,
): string {
  if (!skill) return text;
  return `=== ${label} (follow these) ===\n${skill}\n\n${text}`;
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

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isoNow() {
  return new Date().toISOString();
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
  | "grooming"
  | "impact"
  | "triageHistory"
  | "plan"
  | "guidance"
  | "implementation"
  | "implementationStreamText"
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
  | "filesRead"
  | "groomingChat"
  | "groomingBaseline"
  | "jiraUpdateStatus"
  | "jiraUpdateError"
  | "groomingProgress"
  | "groomingStreamText"
  | "checkpointChats"
  | "errors"
  | "kbSaved"
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

  // ── Agent outputs ────────────────────────────────────────────────────────────
  grooming: GroomingOutput | null;
  impact: ImpactOutput | null;
  triageHistory: TriageMessage[];
  plan: ImplementationPlan | null;
  guidance: GuidanceOutput | null;
  implementation: ImplementationOutput | null;
  implementationStreamText: string;
  buildVerification: BuildCheckResult | null;
  buildCheckStreamText: string;
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
  kbSaved: boolean;
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
  runImpactStage: () => Promise<void>;
  runTriageStage: () => Promise<void>;
  sendTriageMessage: (input: string) => Promise<void>;
  finalizePlan: () => Promise<void>;
  runImplementationStage: () => Promise<void>;
  runTestsStage: () => Promise<void>;
  runReviewStage: () => Promise<void>;
  runPrStage: () => Promise<void>;
  runRetroStage: () => Promise<void>;
  /** Squash feature branch commits, push, and create a PR on Bitbucket (no reviewers). */
  submitDraftPr: () => Promise<void>;
  proceedFromStage: (stage: Stage) => Promise<void>;
  sendCheckpointMessage: (stage: Stage, input: string) => Promise<void>;
  sendGroomingChatMessage: (input: string) => Promise<void>;
  handleApproveEdit: (id: string) => void;
  handleDeclineEdit: (id: string) => void;
  pushGroomingToJira: () => Promise<void>;
  saveToKnowledgeBase: (entries: RetroKbEntry[]) => Promise<void>;
  markComplete: (stage: Stage) => void;
  setError: (stage: Stage, err: string) => void;
  clearError: (stage: Stage) => void;
  runGroomingStage: () => Promise<void>;
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
  | "runImpactStage"
  | "runTriageStage"
  | "sendTriageMessage"
  | "finalizePlan"
  | "runImplementationStage"
  | "runTestsStage"
  | "runReviewStage"
  | "runPrStage"
  | "runRetroStage"
  | "submitDraftPr"
  | "proceedFromStage"
  | "sendCheckpointMessage"
  | "sendGroomingChatMessage"
  | "handleApproveEdit"
  | "handleDeclineEdit"
  | "pushGroomingToJira"
  | "saveToKnowledgeBase"
  | "markComplete"
  | "setError"
  | "clearError"
  | "runGroomingStage"
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
  plan: null,
  guidance: null,
  implementation: null,
  implementationStreamText: "",
  buildVerification: null,
  buildCheckStreamText: "",
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
  kbSaved: false,
  worktreeInfo: null,
  ticketText: "",
  skills: {},
  isSessionActive: false,
  activeSessionId: "",
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
    grooming: s.grooming,
    impact: s.impact,
    triageHistory: s.triageHistory,
    plan: s.plan,
    guidance: s.guidance,
    implementation: s.implementation,
    implementationStreamText: s.implementationStreamText,
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
    filesRead: s.filesRead,
    groomingChat: s.groomingChat,
    groomingBaseline: s.groomingBaseline,
    jiraUpdateStatus: s.jiraUpdateStatus,
    jiraUpdateError: s.jiraUpdateError,
    groomingProgress: s.groomingProgress,
    groomingStreamText: s.groomingStreamText,
    checkpointChats: s.checkpointChats,
    errors: s.errors,
    kbSaved: s.kbSaved,
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
            buildVerification: null,
            buildCheckStreamText: "",
            guidance: null,
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

      set({ errors, completedStages, pendingApproval, ...outputResets });

      switch (stage) {
        case "grooming":
          await get().runGroomingStage();
          break;
        case "impact":
          await get().runImpactStage();
          break;
        case "triage":
          await get().runTriageStage();
          break;
        case "plan":
          await get().finalizePlan();
          break;
        case "implementation":
          await get().runImplementationStage();
          break;
        case "tests":
          await get().runTestsStage();
          break;
        case "review":
          await get().runReviewStage();
          break;
        case "pr":
          await get().runPrStage();
          break;
        case "retro":
          await get().runRetroStage();
          break;
      }
    },

    handleApproveEdit: (id) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, status: "approved" as SuggestedEditStatus } : e,
        ),
      })),

    handleDeclineEdit: (id) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, status: "declined" as SuggestedEditStatus } : e,
        ),
      })),

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
      const existingSession = get().sessions.get(issue.key);
      if (existingSession && existingSession.currentStage !== "select") {
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

      // Sync worktree
      try {
        const config = await getNonSecretConfig();
        if (config["repo_worktree_path"]) {
          const info = await syncWorktree();
          set({ worktreeInfo: info });
        }
      } catch (e) {
        console.warn("[Meridian] Worktree sync failed:", e);
      }

      // Agent 1: Grooming
      await get().runGroomingStage();
    },

    // ── Grooming ───────────────────────────────────────────────────────────────
    runGroomingStage: async () => {
      console.log("[Meridian] runGroomingStage: starting");
      set({ currentStage: "grooming", viewingStage: "grooming" });
      await get()._reloadSkills();
      const { ticketText, worktreeInfo, skills } = get();

      const repoContext = worktreeInfo
        ? `\n\n=== CODEBASE CONTEXT ===\nWorktree: ${worktreeInfo.path}\nBranch: ${worktreeInfo.branch} (HEAD: ${worktreeInfo.headCommit})\nCommit: ${worktreeInfo.headMessage}\nYou have access to this codebase. File contents will be injected below after a probe step.`
        : "";

      try {
        const ticketWithContext = ticketText + repoContext;
        let fileContentsBlock = "";
        const readFiles: string[] = [];

        if (repoContext) {
          try {
            console.log("[Meridian] runGroomingStage: starting file probe");
            set({
              groomingProgress: "Identifying relevant files in the codebase…",
            });
            const probeRaw = await runGroomingFileProbe(ticketWithContext);
            console.log(
              "[Meridian] runGroomingStage: probe raw output received",
            );
            const probe = parseAgentJson<{
              files: string[];
              grep_patterns: string[];
            }>(probeRaw);
            if (probe) {
              console.log("[Meridian] runGroomingStage: probe parsed", probe);
              const MAX_TOTAL = 40 * 1024;
              let totalSize = 0;
              const parts: string[] = [];

              for (const filePath of (probe.files ?? []).slice(0, 12)) {
                try {
                  console.log(
                    "[Meridian] runGroomingStage: reading file",
                    filePath,
                  );
                  set({ groomingProgress: `Reading ${filePath}…` });
                  const content = await readRepoFile(filePath);
                  const chunk = `--- ${filePath} ---\n${content}\n`;
                  if (totalSize + chunk.length > MAX_TOTAL) {
                    console.log(
                      "[Meridian] runGroomingStage: context size limit reached, stopping file reads",
                    );
                    break;
                  }
                  parts.push(chunk);
                  totalSize += chunk.length;
                  readFiles.push(filePath);
                } catch (e) {
                  console.warn(
                    "[Meridian] runGroomingStage: failed to read file",
                    filePath,
                    e,
                  );
                }
              }

              for (const pattern of (probe.grep_patterns ?? []).slice(0, 6)) {
                try {
                  console.log(
                    "[Meridian] runGroomingStage: grepping pattern",
                    pattern,
                  );
                  set({
                    groomingProgress: `Searching codebase for "${pattern}"…`,
                  });
                  const lines = await grepRepoFiles(pattern);
                  if (lines.length === 0) continue;
                  const chunk = `--- grep: ${pattern} ---\n${lines.join("\n")}\n`;
                  if (totalSize + chunk.length > MAX_TOTAL) {
                    console.log(
                      "[Meridian] runGroomingStage: context size limit reached, stopping grep",
                    );
                    break;
                  }
                  parts.push(chunk);
                  totalSize += chunk.length;
                } catch (e) {
                  console.warn(
                    "[Meridian] runGroomingStage: failed to grep pattern",
                    pattern,
                    e,
                  );
                }
              }

              if (parts.length > 0) {
                fileContentsBlock = parts.join("\n");
                set({ filesRead: readFiles });
              }
            }
          } catch (e) {
            console.warn("[Meridian] File probe failed:", e);
            set({ groomingProgress: "" });
          }
        }

        console.log("[Meridian] runGroomingStage: calling runGroomingAgent");
        const groomingInput = prependSkill(
          ticketWithContext,
          skills.grooming,
          "GROOMING CONVENTIONS",
        );
        const raw = await runGroomingAgent(groomingInput, fileContentsBlock);
        console.log("[Meridian] runGroomingStage: runGroomingAgent finished");
        const data = parseAgentJson<GroomingOutput>(raw);
        if (!data) throw new Error("Could not parse grooming output");

        const edits: SuggestedEdit[] = (data.suggested_edits ?? []).map(
          (e) => ({
            ...e,
            status: "pending" as SuggestedEditStatus,
          }),
        );

        const questions = data.clarifying_questions ?? [];
        const initialChat: TriageMessage[] =
          questions.length > 0
            ? [
                {
                  role: "assistant",
                  content:
                    questions.length === 1
                      ? `I have a question before we finalise the grooming:\n\n${questions[0]}`
                      : `I have a few questions before we finalise the grooming:\n\n${questions
                          .map((q, i) => `${i + 1}. ${q}`)
                          .join("\n\n")}`,
                },
              ]
            : [];

        const currentIssue = get().selectedIssue;
        set({
          grooming: data,
          groomingEdits: edits,
          clarifyingQuestions: questions,
          groomingChat: initialChat,
          groomingBlockers: currentIssue
            ? detectGroomingBlockers(currentIssue, data)
            : [],
        });
        get().markComplete("grooming");
        set({ pendingApproval: "grooming" });
      } catch (e) {
        get().setError("grooming", String(e));
      }
    },

    // ── Impact ─────────────────────────────────────────────────────────────────
    runImpactStage: async () => {
      set({
        currentStage: "impact",
        viewingStage: "impact",
        impactStreamText: "",
      });
      try {
        await get()._reloadSkills();
        const { ticketText, grooming, skills, groomingChat } = get();
        const groomingWithQa =
          groomingChat.length > 0
            ? JSON.stringify(grooming) +
              "\n\n=== GROOMING Q&A (resolved) ===\n" +
              groomingChat
                .map(
                  (m) =>
                    `${m.role === "user" ? "User" : "Agent"}: ${m.content}`,
                )
                .join("\n\n")
            : JSON.stringify(grooming);
        const impactInput = prependSkill(
          ticketText,
          skills.patterns,
          "CODEBASE PATTERNS",
        );
        const raw = await runImpactAnalysis(impactInput, groomingWithQa);
        const data = parseAgentJson<ImpactOutput>(raw);
        if (!data) throw new Error("Could not parse impact output");
        set({ impact: data });
        get().markComplete("impact");
        set({ pendingApproval: "impact" });
      } catch (e) {
        get().setError("impact", String(e));
      }
    },

    // ── Triage ─────────────────────────────────────────────────────────────────
    runTriageStage: async () => {
      set({
        currentStage: "triage",
        viewingStage: "triage",
        triageStreamText: "",
      });
      await get()._reloadSkills();
      const { ticketText, grooming, impact, skills, groomingChat } = get();
      const contextText = compilePipelineContext(
        ticketText,
        grooming,
        impact,
        skills,
        groomingChat,
      );
      try {
        const initialMessage =
          "Please analyse this ticket and propose a concrete implementation approach. Ask any clarifying questions you need answered before we can finalise the plan.";
        const response = await runTriageTurn(
          contextText,
          JSON.stringify([{ role: "user", content: initialMessage }]),
        );
        set({
          triageHistory: [
            { role: "user", content: initialMessage },
            { role: "assistant", content: response },
          ],
          triageStreamText: "",
        });
      } catch (e) {
        set({ triageStreamText: "" });
        get().setError("triage", String(e));
      }
    },

    sendTriageMessage: async (input) => {
      await get()._reloadSkills();
      const {
        triageHistory,
        ticketText,
        grooming,
        impact,
        skills,
        groomingChat,
      } = get();
      const userMsg: TriageMessage = { role: "user", content: input };
      const newHistory = [...triageHistory, userMsg];
      set({ triageHistory: newHistory });
      try {
        const contextText = compilePipelineContext(
          ticketText,
          grooming,
          impact,
          skills,
          groomingChat,
        );
        const response = await runTriageTurn(
          contextText,
          JSON.stringify(newHistory),
        );
        set({
          triageHistory: [
            ...newHistory,
            { role: "assistant", content: response },
          ],
          triageStreamText: "",
        });
      } catch (e) {
        set({ triageStreamText: "" });
        get().setError("triage", String(e));
      }
    },

    finalizePlan: async () => {
      set({ currentStage: "plan" });
      try {
        await get()._reloadSkills();
        const {
          ticketText,
          grooming,
          impact,
          skills,
          triageHistory,
          groomingChat,
        } = get();
        const contextText = compilePipelineContext(
          ticketText,
          grooming,
          impact,
          skills,
          groomingChat,
        );
        const raw = await finalizeImplementationPlan(
          contextText,
          JSON.stringify(triageHistory),
        );
        const data = parseAgentJson<ImplementationPlan>(raw);
        if (!data) throw new Error("Could not parse plan output");
        set({ plan: data, viewingStage: "plan" });

        // Run guidance silently as part of plan finalization (not a separate user-visible stage)
        try {
          const guidanceInput = prependSkill(
            prependSkill(ticketText, skills.patterns, "CODEBASE PATTERNS"),
            skills.implementation,
            "IMPLEMENTATION STANDARDS",
          );
          const guidanceRaw = await runImplementationGuidance(
            guidanceInput,
            JSON.stringify(data),
          );
          const guidanceData = parseAgentJson<GuidanceOutput>(guidanceRaw);
          if (guidanceData) set({ guidance: guidanceData });
        } catch {
          /* guidance failure is non-fatal — implementation can proceed with plan alone */
        }

        get().markComplete("triage");
        get().markComplete("plan");
        set({ pendingApproval: "plan" });
      } catch (e) {
        get().setError("plan", String(e));
      }
    },

    // ── Implementation ─────────────────────────────────────────────────────────
    runImplementationStage: async () => {
      set({
        currentStage: "implementation",
        viewingStage: "implementation",
        implementationStreamText: "",
        buildVerification: null,
        buildCheckStreamText: "",
      });
      try {
        await get()._reloadSkills();
        const { ticketText, plan, guidance, selectedIssue, featureBranch } = get();

        // Create a feature branch in the worktree before the agent writes any
        // files. Branch name embeds the JIRA key so Bitbucket auto-links to the
        // ticket. Skips if a branch is already recorded for this session.
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

        const raw = await runImplementationAgent(
          ticketText,
          JSON.stringify(plan),
          guidance ? JSON.stringify(guidance) : "",
        );
        const data = parseAgentJson<ImplementationOutput>(raw);
        if (!data) throw new Error("Could not parse implementation output");
        set({ implementation: data });

        // ── Build verification (if enabled) ──────────────────────────────────
        const prefs = await getPreferences().catch(() => ({} as Record<string, string>));
        const buildVerifyEnabled = prefs["build_verify_enabled"] === "true";
        if (buildVerifyEnabled) {
          set({ buildCheckStreamText: "" });
          try {
            const buildRaw = await runBuildCheck(
              ticketText,
              JSON.stringify(plan),
              raw,
            );
            const buildResult = parseAgentJson<BuildCheckResult>(buildRaw);
            if (buildResult) set({ buildVerification: buildResult });
          } catch (e) {
            console.warn("[Meridian] build check failed:", e);
          }
        }

        get().markComplete("implementation");
        set({ pendingApproval: "implementation" });
      } catch (e) {
        get().setError("implementation", String(e));
      }
    },

    // ── Tests ──────────────────────────────────────────────────────────────────
    runTestsStage: async () => {
      set({
        currentStage: "tests",
        viewingStage: "tests",
        testsStreamText: "",
      });
      try {
        await get()._reloadSkills();
        const { ticketText, plan, implementation } = get();
        let diff = "";
        try {
          diff = await getRepoDiff();
        } catch {
          /* no worktree — proceed without diff */
        }
        const raw = await runTestAgent(
          ticketText,
          JSON.stringify(plan),
          JSON.stringify(implementation),
          diff,
        );
        const data = parseAgentJson<TestOutput>(raw);
        if (!data) {
          console.error("[Meridian] runTestsStage: raw response failed to parse:", raw);
          throw new Error("Could not parse test output");
        }
        set({ tests: data });
        get().markComplete("tests");
        set({ pendingApproval: "tests" });
      } catch (e) {
        get().setError("tests", String(e));
      }
    },

    // ── Review ─────────────────────────────────────────────────────────────────
    runReviewStage: async () => {
      set({
        currentStage: "review",
        viewingStage: "review",
        reviewStreamText: "",
      });
      try {
        await get()._reloadSkills();
        const { ticketText, plan, implementation, tests, skills } = get();
        let diff = "";
        try {
          diff = await getRepoDiff();
        } catch {
          /* no worktree — proceed without diff */
        }
        const reviewPlanJson = skills.review
          ? `=== REVIEW STANDARDS (follow these) ===\n${skills.review}\n\n${JSON.stringify(plan)}`
          : JSON.stringify(plan);
        const raw = await runPlanReview(
          ticketText,
          reviewPlanJson,
          JSON.stringify(implementation),
          JSON.stringify(tests),
          diff,
        );
        const data = parseAgentJson<PlanReviewOutput>(raw);
        if (!data) throw new Error("Could not parse review output");
        set({ review: data });
        get().markComplete("review");
        set({ pendingApproval: "review" });
      } catch (e) {
        get().setError("review", String(e));
      }
    },

    // ── PR Description ─────────────────────────────────────────────────────────
    runPrStage: async () => {
      set({ currentStage: "pr", viewingStage: "pr", prStreamText: "" });
      try {
        await get()._reloadSkills();
        const { ticketText, plan, implementation, review } = get();
        const raw = await runPrDescriptionGen(
          ticketText,
          JSON.stringify(plan),
          JSON.stringify(implementation),
          JSON.stringify(review),
        );
        const data = parseAgentJson<PrDescriptionOutput>(raw);
        if (!data) throw new Error("Could not parse PR description output");
        set({ prDescription: data });
        get().markComplete("pr");
        set({ pendingApproval: "pr" });
      } catch (e) {
        get().setError("pr", String(e));
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

    // ── Retrospective ──────────────────────────────────────────────────────────
    runRetroStage: async () => {
      set({
        currentStage: "retro",
        viewingStage: "retro",
        retroStreamText: "",
      });
      try {
        await get()._reloadSkills();
        const { ticketText, plan, implementation, review } = get();
        const raw = await runRetrospectiveAgent(
          ticketText,
          JSON.stringify(plan),
          JSON.stringify(implementation),
          JSON.stringify(review),
        );
        const data = parseAgentJson<RetrospectiveOutput>(raw);
        if (!data) throw new Error("Could not parse retrospective output");
        set({ retrospective: data });
        get().markComplete("retro");
        set({ pendingApproval: "retro" });
      } catch (e) {
        get().setError("retro", String(e));
      }
    },

    // ── Proceed from checkpoint ────────────────────────────────────────────────
    proceedFromStage: async (stage) => {
      set({ pendingApproval: null, proceeding: true });
      try {
        switch (stage) {
          case "grooming":
            await get().runImpactStage();
            break;
          case "impact":
            await get().runTriageStage();
            break;
          case "plan":
            await get().runImplementationStage();
            break;
          case "implementation": {
            // Commit whatever the implementation agent wrote so the feature
            // branch accumulates real history (later squashed at PR stage).
            const { selectedIssue } = get();
            if (selectedIssue) {
              const msg = `${selectedIssue.key}: implementation`;
              try {
                await commitWorktreeChanges(msg);
              } catch (e) {
                console.warn("[Meridian] commit after implementation failed:", e);
              }
            }
            await get().runTestsStage();
            break;
          }
          case "tests": {
            const { selectedIssue } = get();
            if (selectedIssue) {
              const msg = `${selectedIssue.key}: tests`;
              try {
                await commitWorktreeChanges(msg);
              } catch (e) {
                console.warn("[Meridian] commit after tests failed:", e);
              }
            }
            await get().runReviewStage();
            break;
          }
          case "review":
            await get().runPrStage();
            break;
          case "pr":
            await get().runRetroStage();
            break;
          case "retro":
            set({ currentStage: "complete" });
            break;
        }
      } finally {
        set({ proceeding: false });
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
        }>(response);

        const displayMessage = parsed?.message ?? response;
        set({
          groomingChat: [
            ...newHistory,
            { role: "assistant", content: displayMessage },
          ],
        });

        if (parsed) {
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
                  merged[idx] = {
                    ...incoming,
                    status:
                      existing.status === "pending"
                        ? "pending"
                        : existing.status,
                  };
                } else {
                  merged.push({ ...incoming, status: "pending" });
                }
              }
              return { groomingEdits: merged };
            });
          }
          if (parsed.updated_questions !== undefined) {
            set({ clarifyingQuestions: parsed.updated_questions });
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

    // ── Save to Knowledge Base ─────────────────────────────────────────────────
    saveToKnowledgeBase: async (entries) => {
      const { selectedIssue } = get();
      const now = isoNow();
      for (const entry of entries) {
        await saveKnowledgeEntry({
          id: newId(),
          entryType: entry.type,
          title: entry.title,
          body: entry.body,
          tags: ["auto-generated", selectedIssue?.key ?? "unknown"],
          createdAt: now,
          updatedAt: now,
          linkedJiraKey: selectedIssue?.key ?? null,
          linkedPrId: null,
        });
      }
      set({ kbSaved: true });
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
