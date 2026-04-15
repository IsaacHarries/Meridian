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
  type TestOutput,
  type PlanReviewOutput,
  type PrDescriptionOutput,
  type RetrospectiveOutput,
  type TriageMessage,
  type SuggestedEdit,
  type SuggestedEditStatus,
  type RetroKbEntry,
  type SkillType,
  type WorktreeInfo,
  type GroomingBlocker,
  getIssue,
  loadAgentSkills,
  syncWorktree,
  getNonSecretConfig,
  runGroomingFileProbe,
  runGroomingAgent,
  runImpactAnalysis,
  runTriageTurn,
  runGroomingChatTurn,
  finalizeImplementationPlan,
  runImplementationGuidance,
  runTestSuggestions,
  runPlanReview,
  runPrDescriptionGen,
  runRetrospectiveAgent,
  updateJiraIssue,
  saveKnowledgeEntry,
  parseAgentJson,
  readRepoFile,
  grepRepoFiles,
} from "@/lib/tauri";

// ── Re-export Stage type so the screen and store share one definition ──────────

export type Stage =
  | "select"
  | "grooming"
  | "impact"
  | "triage"
  | "plan"
  | "guidance"
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
    ([name]) => !knownNames.has(name.toLowerCase())
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
  skills: Partial<Record<SkillType, string>> = {}
): string {
  const parts: string[] = [];
  if (skills.grooming)
    parts.push(`=== GROOMING CONVENTIONS (follow these) ===\n${skills.grooming}`);
  if (skills.patterns)
    parts.push(`=== CODEBASE PATTERNS (follow these) ===\n${skills.patterns}`);
  if (skills.implementation)
    parts.push(
      `=== IMPLEMENTATION STANDARDS (follow these) ===\n${skills.implementation}`
    );
  parts.push(`=== TICKET ===\n${ticketText}`);
  if (grooming)
    parts.push(`=== GROOMING ANALYSIS ===\n${JSON.stringify(grooming, null, 2)}`);
  if (impact)
    parts.push(`=== IMPACT ANALYSIS ===\n${JSON.stringify(impact, null, 2)}`);
  return parts.join("\n\n");
}

function prependSkill(
  text: string,
  skill: string | undefined,
  label: string
): string {
  if (!skill) return text;
  return `=== ${label} (follow these) ===\n${skill}\n\n${text}`;
}

export function detectGroomingBlockers(
  issue: JiraIssue,
  grooming: GroomingOutput
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
  tests: TestOutput | null;
  review: PlanReviewOutput | null;
  prDescription: PrDescriptionOutput | null;
  retrospective: RetrospectiveOutput | null;

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

  // ── Actions ──────────────────────────────────────────────────────────────────
  /** Directly write state — used by event listeners outside React tree */
  _set: (partial: Partial<ImplementTicketState>) => void;

  resetSession: () => void;
  startPipeline: (issue: JiraIssue) => Promise<void>;
  runImpactStage: () => Promise<void>;
  runTriageStage: () => Promise<void>;
  sendTriageMessage: (input: string) => Promise<void>;
  finalizePlan: () => Promise<void>;
  runGuidanceStage: () => Promise<void>;
  runTestsStage: () => Promise<void>;
  runReviewStage: () => Promise<void>;
  runPrStage: () => Promise<void>;
  runRetroStage: () => Promise<void>;
  proceedFromStage: (stage: Stage) => Promise<void>;
  sendCheckpointMessage: (stage: Stage, input: string) => Promise<void>;
  sendGroomingChatMessage: (input: string) => Promise<void>;
  handleApproveEdit: (id: string) => void;
  handleDeclineEdit: (id: string) => void;
  pushGroomingToJira: () => Promise<void>;
  saveToKnowledgeBase: (entries: RetroKbEntry[]) => Promise<void>;
  markComplete: (stage: Stage) => void;
  setError: (stage: Stage, err: string) => void;
}

// ── Initial state (no session) ─────────────────────────────────────────────────

const INITIAL: Omit<
  ImplementTicketState,
  | "_set"
  | "resetSession"
  | "startPipeline"
  | "runImpactStage"
  | "runTriageStage"
  | "sendTriageMessage"
  | "finalizePlan"
  | "runGuidanceStage"
  | "runTestsStage"
  | "runReviewStage"
  | "runPrStage"
  | "runRetroStage"
  | "proceedFromStage"
  | "sendCheckpointMessage"
  | "sendGroomingChatMessage"
  | "handleApproveEdit"
  | "handleDeclineEdit"
  | "pushGroomingToJira"
  | "saveToKnowledgeBase"
  | "markComplete"
  | "setError"
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
  tests: null,
  review: null,
  prDescription: null,
  retrospective: null,
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
  checkpointChats: {},
  errors: {},
  kbSaved: false,
  worktreeInfo: null,
  ticketText: "",
  skills: {},
  isSessionActive: false,
};

// ── Store ──────────────────────────────────────────────────────────────────────

export const useImplementTicketStore = create<ImplementTicketState>()(
  (set, get) => ({
    ...INITIAL,

    _set: (partial) => set(partial as Partial<ImplementTicketState>),

    resetSession: () => set({ ...INITIAL }),

    markComplete: (stage) =>
      set((s) => ({ completedStages: new Set([...s.completedStages, stage]) })),

    setError: (stage, err) =>
      set((s) => ({ errors: { ...s.errors, [stage]: err } })),

    handleApproveEdit: (id) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, status: "approved" as SuggestedEditStatus } : e
        ),
      })),

    handleDeclineEdit: (id) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, status: "declined" as SuggestedEditStatus } : e
        ),
      })),

    // ── startPipeline ──────────────────────────────────────────────────────────
    startPipeline: async (issue) => {
      set({
        ...INITIAL,
        selectedIssue: issue,
        currentStage: "grooming",
        viewingStage: "grooming",
        isSessionActive: true,
      });

      // Fetch full issue details
      let fullIssue = issue;
      try {
        fullIssue = await getIssue(issue.key);
        set({ selectedIssue: fullIssue });
      } catch { /* fall back to sprint-list version */ }

      const text = compileTicketText(fullIssue);
      set({ ticketText: text });

      let skills: Partial<Record<SkillType, string>> = {};
      try {
        skills = await loadAgentSkills();
      } catch { /* no skills */ }
      set({ skills });

      // Sync worktree
      let repoContext = "";
      try {
        const config = await getNonSecretConfig();
        if (config["repo_worktree_path"]) {
          const info = await syncWorktree();
          set({ worktreeInfo: info });
          repoContext = `\n\n=== CODEBASE CONTEXT ===\nWorktree: ${info.path}\nBranch: ${info.branch} (HEAD: ${info.headCommit})\nCommit: ${info.headMessage}\nYou have access to this codebase. File contents will be injected below after a probe step.`;
        }
      } catch (e) {
        console.warn("[Meridian] Worktree sync failed:", e);
      }

      // Agent 1: Grooming
      try {
        const ticketWithContext = text + repoContext;
        let fileContentsBlock = "";
        const readFiles: string[] = [];

        if (repoContext) {
          try {
            set({ groomingProgress: "Identifying relevant files in the codebase…" });
            const probeRaw = await runGroomingFileProbe(ticketWithContext);
            const probe = parseAgentJson<{ files: string[]; grep_patterns: string[] }>(probeRaw);
            if (probe) {
              const MAX_TOTAL = 40 * 1024;
              let totalSize = 0;
              const parts: string[] = [];

              for (const filePath of (probe.files ?? []).slice(0, 12)) {
                try {
                  set({ groomingProgress: `Reading ${filePath}…` });
                  const content = await readRepoFile(filePath);
                  const chunk = `--- ${filePath} ---\n${content}\n`;
                  if (totalSize + chunk.length > MAX_TOTAL) break;
                  parts.push(chunk);
                  totalSize += chunk.length;
                  readFiles.push(filePath);
                } catch { /* skip */ }
              }

              for (const pattern of (probe.grep_patterns ?? []).slice(0, 6)) {
                try {
                  set({ groomingProgress: `Searching codebase for "${pattern}"…` });
                  const lines = await grepRepoFiles(pattern);
                  if (lines.length === 0) continue;
                  const chunk = `--- grep: ${pattern} ---\n${lines.join("\n")}\n`;
                  if (totalSize + chunk.length > MAX_TOTAL) break;
                  parts.push(chunk);
                  totalSize += chunk.length;
                } catch { /* skip */ }
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

        // Phase 2: Full grooming
        const currentSkills = get().skills;
        const groomingInput = prependSkill(ticketWithContext, currentSkills.grooming, "GROOMING CONVENTIONS");
        const raw = await runGroomingAgent(groomingInput, fileContentsBlock);
        const data = parseAgentJson<GroomingOutput>(raw);
        if (!data) throw new Error("Could not parse grooming output");

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
                      ? `I have a question before we finalise the grooming:\n\n${questions[0]}`
                      : `I have a few questions before we finalise the grooming:\n\n${questions
                          .map((q, i) => `${i + 1}. ${q}`)
                          .join("\n\n")}`,
                },
              ]
            : [];

        const currentFullIssue = get().selectedIssue ?? fullIssue;
        set({
          grooming: data,
          groomingEdits: edits,
          clarifyingQuestions: questions,
          groomingChat: initialChat,
          groomingBlockers: detectGroomingBlockers(currentFullIssue, data),
        });
        get().markComplete("grooming");
        set({ pendingApproval: "grooming" });
      } catch (e) {
        get().setError("grooming", String(e));
      }
    },

    // ── Impact ─────────────────────────────────────────────────────────────────
    runImpactStage: async () => {
      set({ currentStage: "impact", viewingStage: "impact" });
      try {
        const { ticketText, grooming, skills } = get();
        const impactInput = prependSkill(ticketText, skills.patterns, "CODEBASE PATTERNS");
        const raw = await runImpactAnalysis(impactInput, JSON.stringify(grooming));
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
      set({ currentStage: "triage", viewingStage: "triage" });
      const { ticketText, grooming, impact, skills } = get();
      const contextText = compilePipelineContext(ticketText, grooming, impact, skills);
      try {
        const initialMessage =
          "Please analyse this ticket and propose a concrete implementation approach. Ask any clarifying questions you need answered before we can finalise the plan.";
        const response = await runTriageTurn(
          contextText,
          JSON.stringify([{ role: "user", content: initialMessage }])
        );
        set({
          triageHistory: [
            { role: "user", content: initialMessage },
            { role: "assistant", content: response },
          ],
        });
      } catch (e) {
        get().setError("triage", String(e));
      }
    },

    sendTriageMessage: async (input) => {
      const { triageHistory, ticketText, grooming, impact, skills } = get();
      const userMsg: TriageMessage = { role: "user", content: input };
      const newHistory = [...triageHistory, userMsg];
      set({ triageHistory: newHistory });
      try {
        const contextText = compilePipelineContext(ticketText, grooming, impact, skills);
        const response = await runTriageTurn(contextText, JSON.stringify(newHistory));
        set({ triageHistory: [...newHistory, { role: "assistant", content: response }] });
      } catch (e) {
        get().setError("triage", String(e));
      }
    },

    finalizePlan: async () => {
      set({ currentStage: "plan" });
      try {
        const { ticketText, grooming, impact, skills, triageHistory } = get();
        const contextText = compilePipelineContext(ticketText, grooming, impact, skills);
        const raw = await finalizeImplementationPlan(contextText, JSON.stringify(triageHistory));
        const data = parseAgentJson<ImplementationPlan>(raw);
        if (!data) throw new Error("Could not parse plan output");
        set({ plan: data, viewingStage: "plan" });
        get().markComplete("triage");
        get().markComplete("plan");
        set({ pendingApproval: "plan" });
      } catch (e) {
        get().setError("plan", String(e));
      }
    },

    // ── Guidance ───────────────────────────────────────────────────────────────
    runGuidanceStage: async () => {
      set({ currentStage: "guidance", viewingStage: "guidance" });
      try {
        const { ticketText, plan, skills } = get();
        const guidanceInput = prependSkill(
          prependSkill(ticketText, skills.patterns, "CODEBASE PATTERNS"),
          skills.implementation,
          "IMPLEMENTATION STANDARDS"
        );
        const raw = await runImplementationGuidance(guidanceInput, JSON.stringify(plan));
        const data = parseAgentJson<GuidanceOutput>(raw);
        if (!data) throw new Error("Could not parse guidance output");
        set({ guidance: data });
        get().markComplete("guidance");
        set({ pendingApproval: "guidance" });
      } catch (e) {
        get().setError("guidance", String(e));
      }
    },

    // ── Tests ──────────────────────────────────────────────────────────────────
    runTestsStage: async () => {
      set({ currentStage: "tests", viewingStage: "tests" });
      try {
        const { plan, guidance } = get();
        const raw = await runTestSuggestions(JSON.stringify(plan), JSON.stringify(guidance));
        const data = parseAgentJson<TestOutput>(raw);
        if (!data) throw new Error("Could not parse test output");
        set({ tests: data });
        get().markComplete("tests");
        set({ pendingApproval: "tests" });
      } catch (e) {
        get().setError("tests", String(e));
      }
    },

    // ── Review ─────────────────────────────────────────────────────────────────
    runReviewStage: async () => {
      set({ currentStage: "review", viewingStage: "review" });
      try {
        const { plan, guidance, tests, skills } = get();
        const reviewPlanJson = skills.review
          ? `=== REVIEW STANDARDS (follow these) ===\n${skills.review}\n\n${JSON.stringify(plan)}`
          : JSON.stringify(plan);
        const raw = await runPlanReview(reviewPlanJson, JSON.stringify(guidance), JSON.stringify(tests));
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
      set({ currentStage: "pr", viewingStage: "pr" });
      try {
        const { ticketText, plan, review } = get();
        const raw = await runPrDescriptionGen(ticketText, JSON.stringify(plan), JSON.stringify(review));
        const data = parseAgentJson<PrDescriptionOutput>(raw);
        if (!data) throw new Error("Could not parse PR description output");
        set({ prDescription: data });
        get().markComplete("pr");
        set({ pendingApproval: "pr" });
      } catch (e) {
        get().setError("pr", String(e));
      }
    },

    // ── Retrospective ──────────────────────────────────────────────────────────
    runRetroStage: async () => {
      set({ currentStage: "retro", viewingStage: "retro" });
      try {
        const { ticketText, plan, review } = get();
        const raw = await runRetrospectiveAgent(ticketText, JSON.stringify(plan), JSON.stringify(review));
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
          case "grooming":   await get().runImpactStage(); break;
          case "impact":     await get().runTriageStage(); break;
          case "plan":       await get().runGuidanceStage(); break;
          case "guidance":   await get().runTestsStage(); break;
          case "tests":      await get().runReviewStage(); break;
          case "review":     await get().runPrStage(); break;
          case "pr":         await get().runRetroStage(); break;
          case "retro":      set({ currentStage: "complete" }); break;
        }
      } finally {
        set({ proceeding: false });
      }
    },

    // ── Checkpoint chat ────────────────────────────────────────────────────────
    sendCheckpointMessage: async (stage, input) => {
      const { checkpointChats, ticketText, grooming, impact, skills } = get();
      const stageLabels: Record<string, string> = {
        grooming: "GROOMING", impact: "IMPACT ANALYSIS", plan: "IMPLEMENTATION PLAN",
        guidance: "IMPLEMENTATION GUIDANCE", tests: "TEST SUGGESTIONS",
        review: "PLAN REVIEW", pr: "PR DESCRIPTION", retro: "RETROSPECTIVE",
      };
      const s = get();
      const stageOutput =
        stage === "grooming"  ? s.grooming :
        stage === "impact"    ? s.impact :
        stage === "plan"      ? s.plan :
        stage === "guidance"  ? s.guidance :
        stage === "tests"     ? s.tests :
        stage === "review"    ? s.review :
        stage === "pr"        ? s.prDescription :
        stage === "retro"     ? s.retrospective : null;

      const context = [
        compilePipelineContext(ticketText, grooming, impact, skills),
        stageOutput
          ? `=== ${stageLabels[stage] ?? stage.toUpperCase()} OUTPUT ===\n${JSON.stringify(stageOutput, null, 2)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const prev = checkpointChats[stage] ?? [];
      const newHistory: TriageMessage[] = [...prev, { role: "user", content: input }];
      set({ checkpointChats: { ...checkpointChats, [stage]: newHistory } });

      try {
        const response = await runTriageTurn(context, JSON.stringify(newHistory));
        set((st) => ({
          checkpointChats: {
            ...st.checkpointChats,
            [stage]: [...(st.checkpointChats[stage] ?? newHistory), { role: "assistant", content: response }],
          },
        }));
      } catch { /* non-critical */ }
    },

    // ── Grooming conversation ──────────────────────────────────────────────────
    sendGroomingChatMessage: async (input) => {
      const { groomingChat, grooming, groomingEdits, ticketText, selectedIssue } = get();

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
          groomingEdits.map(({ id, field, section, current, suggested, reasoning, status }) => ({
            id, field, section, current, suggested, reasoning, status,
          })),
          null,
          2
        ),
      ].join("\n");

      try {
        const response = await runGroomingChatTurn(systemContext, JSON.stringify(newHistory));
        const parsed = parseAgentJson<{
          message: string;
          updated_edits: Omit<SuggestedEdit, "status">[];
          updated_questions: string[];
        }>(response);

        const displayMessage = parsed?.message ?? response;
        set({
          groomingChat: [...newHistory, { role: "assistant", content: displayMessage }],
        });

        if (parsed) {
          if (parsed.updated_edits && parsed.updated_edits.length > 0) {
            set((st) => {
              const existingById = new Map(st.groomingEdits.map((e) => [e.id, e]));
              const merged = [...st.groomingEdits];
              for (const incoming of parsed.updated_edits) {
                const existing = existingById.get(incoming.id);
                if (existing) {
                  const idx = merged.findIndex((e) => e.id === incoming.id);
                  merged[idx] = {
                    ...incoming,
                    status: existing.status === "pending" ? "pending" : existing.status,
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
          set({ groomingBlockers: detectGroomingBlockers(selectedIssue, get().grooming!) });
        }
      } catch { /* silently handle */ }
    },

    // ── Push grooming edits to JIRA ────────────────────────────────────────────
    pushGroomingToJira: async () => {
      const { selectedIssue, groomingEdits, grooming } = get();
      if (!selectedIssue) return;
      const approved = groomingEdits.filter((e) => e.status === "approved");
      if (approved.length === 0) return;

      set({ jiraUpdateStatus: "saving", jiraUpdateError: "" });
      try {
        const descriptionFields: SuggestedEdit["field"][] = ["description", "acceptance_criteria"];
        const descriptionEdits = approved.filter((e) => descriptionFields.includes(e.field));
        const otherEdits = approved.filter((e) => !descriptionFields.includes(e.field));

        if (descriptionEdits.length > 0 || grooming) {
          const g = grooming;
          const lines: string[] = [];
          if (g) lines.push(g.ticket_summary, "");

          const descEdit = descriptionEdits.find((e) => e.field === "description");
          const acEdit = descriptionEdits.find((e) => e.field === "acceptance_criteria");

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

          await updateJiraIssue(selectedIssue.key, null, lines.join("\n").trim());
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
  })
);

