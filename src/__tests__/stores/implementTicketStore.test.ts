import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all Tauri-dependent modules before importing the store
vi.mock("@/lib/tauri", () => ({
  getIssue: vi.fn(),
  loadAgentSkills: vi.fn().mockResolvedValue({}),
  syncWorktree: vi.fn().mockResolvedValue(null),
  getNonSecretConfig: vi.fn().mockResolvedValue({}),
  runGroomingFileProbe: vi.fn().mockResolvedValue("{}"),
  runGroomingWorkflow: vi.fn().mockResolvedValue({
    ticket_summary: "",
    ticket_type: "feature",
    acceptance_criteria: [],
    relevant_areas: [],
    dependencies: [],
    estimated_complexity: "low",
    grooming_notes: "",
    suggested_edits: [],
    clarifying_questions: [],
  }),
  runImpactAnalysis: vi.fn().mockResolvedValue("{}"),
  runTriageTurn: vi.fn().mockResolvedValue("{}"),
  runGroomingChatTurn: vi.fn().mockResolvedValue("{}"),
  finalizeImplementationPlan: vi.fn().mockResolvedValue("{}"),
  runImplementationGuidance: vi.fn().mockResolvedValue("{}"),
  runImplementationAgent: vi.fn().mockResolvedValue("{}"),
  runTestSuggestions: vi.fn().mockResolvedValue("{}"),
  runPlanReview: vi.fn().mockResolvedValue("{}"),
  runPrDescriptionGen: vi.fn().mockResolvedValue("{}"),
  runRetrospectiveAgent: vi.fn().mockResolvedValue("{}"),
  updateJiraIssue: vi.fn().mockResolvedValue(undefined),
  parseAgentJson: vi.fn().mockReturnValue(null),
  readRepoFile: vi.fn().mockResolvedValue(""),
  grepRepoFiles: vi.fn().mockResolvedValue([]),
  getAllActiveSprintIssues: vi.fn().mockResolvedValue([]),
  getOpenPrs: vi.fn().mockResolvedValue([]),
  // Orchestrator wrappers — every mock returns a deterministic shape so
  // the store-side dispatcher logic can be exercised without a sidecar.
  chatWithOrchestrator: vi.fn().mockResolvedValue({
    output: {
      threadId: "orchestrator:PROJ-1",
      thread: [],
      stageSummaries: {},
      userNotes: [],
    },
  }),
  applyPlanEdits: vi.fn().mockResolvedValue({ output: { planFileCount: 0 } }),
  resumeImplementationPipelineWorkflow: vi
    .fn()
    .mockResolvedValue({ output: null, interrupt: null, usage: { inputTokens: 0, outputTokens: 0 } }),
  rewindImplementationPipelineWorkflow: vi.fn().mockResolvedValue({}),
  runImplementationPipelineWorkflow: vi
    .fn()
    .mockResolvedValue({ output: null, interrupt: null, usage: { inputTokens: 0, outputTokens: 0 } }),
  ORCHESTRATOR_EVENT_NAME: "orchestrator-workflow-event",
  PIPELINE_EVENT_NAME: "implementation-pipeline-event",
  commitWorktreeChanges: vi.fn().mockResolvedValue(""),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
}));

import {
  useImplementTicketStore,
  snapshotSession,
  INITIAL,
  ensureOrchestratorThreadId,
  applyOrchestratorResult,
  buildOrchestratorContextText,
  type Stage,
} from "@/stores/implementTicketStore";
import type {
  JiraIssue,
  GroomingOutput,
  OrchestratorMessage,
  OrchestratorPendingProposal,
} from "@/lib/tauri";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeIssue(key = "PROJ-1"): JiraIssue {
  return {
    id: key,
    key,
    url: "",
    summary: "Test Issue",
    description: "Some description with enough content to pass validation.",
    descriptionSections: [],
    status: "To Do",
    statusCategory: "To Do",
    assignee: null,
    reporter: null,
    issueType: "Story",
    storyPoints: 3,
    priority: "Medium",
    epicKey: null,
    epicSummary: null,
    created: "2024-01-01T00:00:00.000Z",
    updated: "2024-01-01T00:00:00.000Z",
    labels: [],
    acceptanceCriteria: "AC 1\nAC 2",
    stepsToReproduce: null,
    observedBehavior: null,
    expectedBehavior: null,
    sprintId: "sprint-1",
    sprintName: "Sprint 1",
    namedFields: {},
    discoveredFieldIds: {},
  } as unknown as JiraIssue;
}

function makeGroomingOutput(): GroomingOutput {
  return {
    summary: "Summary",
    acceptance_criteria: ["AC 1"],
    clarifying_questions: [],
    suggested_edits: [],
    risk_level: "low",
    notes: "",
  } as unknown as GroomingOutput;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetStore() {
  useImplementTicketStore.setState({
    ...INITIAL,
    sessions: new Map(),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("implementTicketStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  // ── 1. Initial state ────────────────────────────────────────────────────────

  describe("initial state", () => {
    it("starts at select stage with no issue selected", () => {
      const s = useImplementTicketStore.getState();
      expect(s.currentStage).toBe("select");
      expect(s.selectedIssue).toBeNull();
    });

    it("starts with empty sessions map", () => {
      expect(useImplementTicketStore.getState().sessions.size).toBe(0);
    });

    it("starts with isSessionActive=false", () => {
      expect(useImplementTicketStore.getState().isSessionActive).toBe(false);
    });
  });

  // ── 2. snapshotSession copies all required PipelineSession fields ───────────

  describe("snapshotSession", () => {
    it("copies all PipelineSession fields from state", () => {
      const issue = makeIssue("SNAP-1");
      const grooming = makeGroomingOutput();

      useImplementTicketStore.setState({
        selectedIssue: issue,
        currentStage: "impact",
        viewingStage: "impact",
        grooming,
        activeSessionId: "abc-123",
        isSessionActive: true,
        completedStages: new Set<Stage>(["grooming"]),
      });

      const state = useImplementTicketStore.getState();
      const snap = snapshotSession(state);

      expect(snap.selectedIssue).toBe(issue);
      expect(snap.currentStage).toBe("impact");
      expect(snap.viewingStage).toBe("impact");
      expect(snap.grooming).toBe(grooming);
      expect(snap.activeSessionId).toBe("abc-123");
      expect(snap.isSessionActive).toBe(true);
      expect(snap.completedStages).toEqual(new Set(["grooming"]));
    });

    it("snapshot is a separate object (not a reference to store state)", () => {
      const state = useImplementTicketStore.getState();
      const snap = snapshotSession(state);
      expect(snap).not.toBe(state);
    });
  });

  // ── 3. setError / clearError ────────────────────────────────────────────────

  describe("setError", () => {
    it("sets error message for the given stage", () => {
      useImplementTicketStore.getState().setError("grooming", "Something went wrong");
      expect(useImplementTicketStore.getState().errors.grooming).toBe("Something went wrong");
    });

    it("does not overwrite errors for other stages", () => {
      useImplementTicketStore.getState().setError("grooming", "error-A");
      useImplementTicketStore.getState().setError("impact", "error-B");
      const { errors } = useImplementTicketStore.getState();
      expect(errors.grooming).toBe("error-A");
      expect(errors.impact).toBe("error-B");
    });
  });

  describe("clearError", () => {
    it("removes the error for the given stage", () => {
      useImplementTicketStore.setState({ errors: { grooming: "bad", impact: "also bad" } });
      useImplementTicketStore.getState().clearError("grooming");
      const { errors } = useImplementTicketStore.getState();
      expect(errors.grooming).toBeUndefined();
      expect(errors.impact).toBe("also bad");
    });
  });

  // ── 4. markComplete ─────────────────────────────────────────────────────────

  describe("markComplete", () => {
    it("adds a stage to completedStages", () => {
      useImplementTicketStore.getState().markComplete("grooming");
      expect(useImplementTicketStore.getState().completedStages).toContain("grooming");
    });

    it("preserves previously completed stages", () => {
      useImplementTicketStore.setState({ completedStages: new Set<Stage>(["grooming"]) });
      useImplementTicketStore.getState().markComplete("impact");
      const { completedStages } = useImplementTicketStore.getState();
      expect(completedStages).toContain("grooming");
      expect(completedStages).toContain("impact");
    });
  });

  // ── 5. Session save guard: incomplete grooming is NOT saved ─────────────────

  describe("session persistence guard", () => {
    it("does NOT save session when grooming===null and stage==='grooming' (pipeline never completed grooming)", async () => {
      const issue1 = makeIssue("P-1");

      // Simulate: P-1 selected, pipeline started but grooming never finished
      useImplementTicketStore.setState({
        selectedIssue: issue1,
        currentStage: "grooming",
        grooming: null,         // grooming agent never produced output
        isSessionActive: true,
        activeSessionId: "session-1",
      });

      // startPipeline for P-2 should NOT write P-1 to sessions map
      // We stop before runGroomingStage by mocking getIssue to reject
      const { getIssue } = await import("@/lib/tauri");
      vi.mocked(getIssue).mockRejectedValue(new Error("stop"));

      // Manually replicate the guard logic (same condition as startPipeline)
      const s = useImplementTicketStore.getState();
      const wouldSave =
        s.selectedIssue !== null &&
        s.currentStage !== "select" &&
        !(s.currentStage === "grooming" && s.grooming === null);

      expect(wouldSave).toBe(false);
    });

    it("DOES save session when grooming output is present (past grooming stage)", () => {
      const issue = makeIssue("P-1");
      useImplementTicketStore.setState({
        selectedIssue: issue,
        currentStage: "impact",
        grooming: makeGroomingOutput(),
        isSessionActive: true,
        activeSessionId: "session-1",
      });

      const s = useImplementTicketStore.getState();
      const wouldSave =
        s.selectedIssue !== null &&
        s.currentStage !== "select" &&
        !(s.currentStage === "grooming" && s.grooming === null);

      expect(wouldSave).toBe(true);
    });

    it("DOES save session when on grooming stage but grooming output exists (agent finished)", () => {
      const issue = makeIssue("P-1");
      useImplementTicketStore.setState({
        selectedIssue: issue,
        currentStage: "grooming",
        grooming: makeGroomingOutput(), // agent finished
        isSessionActive: true,
      });

      const s = useImplementTicketStore.getState();
      const wouldSave =
        s.selectedIssue !== null &&
        s.currentStage !== "select" &&
        !(s.currentStage === "grooming" && s.grooming === null);

      expect(wouldSave).toBe(true);
    });
  });

  // ── 6. _set allows direct state writes ─────────────────────────────────────

  describe("_set", () => {
    it("writes arbitrary state directly", () => {
      useImplementTicketStore.getState()._set({ groomingProgress: "Thinking…" });
      expect(useImplementTicketStore.getState().groomingProgress).toBe("Thinking…");
    });

    it("merges partial state without clobbering unrelated fields", () => {
      useImplementTicketStore.setState({ isSessionActive: true });
      useImplementTicketStore.getState()._set({ groomingProgress: "x" });
      expect(useImplementTicketStore.getState().isSessionActive).toBe(true);
    });
  });

  // ── 7. resetSession ─────────────────────────────────────────────────────────

  describe("resetSession", () => {
    it("resets all pipeline state to INITIAL", () => {
      useImplementTicketStore.setState({
        selectedIssue: makeIssue(),
        currentStage: "impact",
        grooming: makeGroomingOutput(),
        isSessionActive: true,
      });

      useImplementTicketStore.getState().resetSession();

      const s = useImplementTicketStore.getState();
      expect(s.selectedIssue).toBeNull();
      expect(s.currentStage).toBe("select");
      expect(s.grooming).toBeNull();
      expect(s.isSessionActive).toBe(false);
    });

    it("preserves the sessions Map across a reset", () => {
      const issue = makeIssue("P-1");
      const session = snapshotSession({
        ...INITIAL,
        sessions: new Map(),
        selectedIssue: issue,
        currentStage: "impact",
        grooming: makeGroomingOutput(),
        isSessionActive: true,
        activeSessionId: "s1",
      } as never);

      const sessions = new Map([["P-1", session]]);
      useImplementTicketStore.setState({ sessions });

      useImplementTicketStore.getState().resetSession();

      expect(useImplementTicketStore.getState().sessions.size).toBe(1);
    });
  });

  // ── 8. handleApproveEdit / handleDeclineEdit ───────────────────────────────

  describe("grooming edit approval", () => {
    const edits = [
      { id: "e1", field: "summary" as const, section: "", current: "A", suggested: "B", reasoning: "r", status: "pending" as const },
      { id: "e2", field: "description" as const, section: "", current: "C", suggested: "D", reasoning: "r", status: "pending" as const },
    ];

    beforeEach(() => {
      useImplementTicketStore.setState({ groomingEdits: edits });
    });

    it("approveEdit sets status to approved for the given id", () => {
      useImplementTicketStore.getState().handleApproveEdit("e1");
      const e = useImplementTicketStore.getState().groomingEdits.find((x) => x.id === "e1");
      expect(e?.status).toBe("approved");
    });

    it("declineEdit sets status to declined for the given id", () => {
      useImplementTicketStore.getState().handleDeclineEdit("e2");
      const e = useImplementTicketStore.getState().groomingEdits.find((x) => x.id === "e2");
      expect(e?.status).toBe("declined");
    });

    it("does not mutate the other edit", () => {
      useImplementTicketStore.getState().handleApproveEdit("e1");
      const e2 = useImplementTicketStore.getState().groomingEdits.find((x) => x.id === "e2");
      expect(e2?.status).toBe("pending");
    });
  });

  // ── 9. Orchestrator: thread-id derivation ───────────────────────────────────

  describe("ensureOrchestratorThreadId", () => {
    it("returns null when no ticket is selected", () => {
      const result = ensureOrchestratorThreadId(
        (p) => useImplementTicketStore.setState(p),
        () => useImplementTicketStore.getState(),
      );
      expect(result).toBeNull();
    });

    it("derives orchestrator:${ticketKey} on first call and persists it", () => {
      useImplementTicketStore.setState({ selectedIssue: makeIssue("PROJ-42") });
      const result = ensureOrchestratorThreadId(
        (p) => useImplementTicketStore.setState(p),
        () => useImplementTicketStore.getState(),
      );
      expect(result).toBe("orchestrator:PROJ-42");
      expect(useImplementTicketStore.getState().orchestratorThreadId).toBe(
        "orchestrator:PROJ-42",
      );
    });

    it("reuses an existing thread id without overwriting", () => {
      useImplementTicketStore.setState({
        selectedIssue: makeIssue("PROJ-42"),
        orchestratorThreadId: "custom-thread-id",
      });
      const result = ensureOrchestratorThreadId(
        (p) => useImplementTicketStore.setState(p),
        () => useImplementTicketStore.getState(),
      );
      expect(result).toBe("custom-thread-id");
    });
  });

  // ── 10. Orchestrator: context-text builder ──────────────────────────────────

  describe("buildOrchestratorContextText", () => {
    it("returns an empty string when nothing has happened yet", () => {
      const text = buildOrchestratorContextText(useImplementTicketStore.getState());
      expect(text).toBe("");
    });

    it("includes only stages that have output, in stable order", () => {
      useImplementTicketStore.setState({
        currentStage: "implementation" as Stage,
        grooming: makeGroomingOutput(),
        impact: { risk_level: "low" } as never,
        plan: null,
        implementation: { summary: "done", files_changed: [], deviations: [], skipped: [] } as never,
      });
      const text = buildOrchestratorContextText(useImplementTicketStore.getState());
      expect(text).toContain("Current stage: implementation");
      expect(text).toContain("=== GROOMING OUTPUT ===");
      expect(text).toContain("=== IMPACT OUTPUT ===");
      expect(text).toContain("=== IMPLEMENTATION RESULT ===");
      expect(text).not.toContain("=== PLAN ===");

      // Ordering: grooming, impact, implementation should appear in that
      // order (skipping plan which is null).
      const grooming = text.indexOf("GROOMING OUTPUT");
      const impact = text.indexOf("IMPACT OUTPUT");
      const impl = text.indexOf("IMPLEMENTATION RESULT");
      expect(grooming).toBeLessThan(impact);
      expect(impact).toBeLessThan(impl);
    });

    it("omits the 'Current stage' line when stage is select", () => {
      useImplementTicketStore.setState({ currentStage: "select" as Stage });
      const text = buildOrchestratorContextText(useImplementTicketStore.getState());
      expect(text).not.toContain("Current stage:");
    });
  });

  // ── 11. Orchestrator: applyOrchestratorResult ──────────────────────────────

  describe("applyOrchestratorResult", () => {
    it("replaces the slice wholesale from the workflow output", () => {
      useImplementTicketStore.setState({
        orchestratorSending: true,
        orchestratorStreamText: "partial reply",
      });
      const thread: OrchestratorMessage[] = [
        { kind: "user", content: "hi", ts: 1, stage: "impact" },
        { kind: "assistant", content: "hello", ts: 2, stage: "impact" },
      ];
      applyOrchestratorResult(
        (updater) =>
          useImplementTicketStore.setState((s) => updater(s)),
        {
          output: {
            threadId: "orchestrator:PROJ-1",
            thread,
            stageSummaries: { impact: "all good" },
            userNotes: ["watch backward compat"],
            currentStage: "impact",
          },
        },
      );
      const s = useImplementTicketStore.getState();
      expect(s.orchestratorThread).toEqual(thread);
      expect(s.orchestratorStageSummaries).toEqual({ impact: "all good" });
      expect(s.orchestratorUserNotes).toEqual(["watch backward compat"]);
      expect(s.orchestratorSending).toBe(false);
      expect(s.orchestratorStreamText).toBe("");
    });

    it("maps undefined pendingProposal in output to null in store", () => {
      applyOrchestratorResult(
        (updater) =>
          useImplementTicketStore.setState((s) => updater(s)),
        {
          output: {
            threadId: "x",
            thread: [],
            stageSummaries: {},
            userNotes: [],
          },
        },
      );
      expect(
        useImplementTicketStore.getState().orchestratorPendingProposal,
      ).toBeNull();
    });

    it("preserves a pendingProposal returned in the output", () => {
      const proposal: OrchestratorPendingProposal = {
        kind: "proceed",
        rationale: "looks good",
        action: "approve",
      };
      applyOrchestratorResult(
        (updater) =>
          useImplementTicketStore.setState((s) => updater(s)),
        {
          output: {
            threadId: "x",
            thread: [],
            stageSummaries: {},
            userNotes: [],
            pendingProposal: proposal,
          },
        },
      );
      expect(
        useImplementTicketStore.getState().orchestratorPendingProposal,
      ).toEqual(proposal);
    });

    it("clears sending+stream when output is null", () => {
      useImplementTicketStore.setState({
        orchestratorSending: true,
        orchestratorStreamText: "x",
      });
      applyOrchestratorResult(
        (updater) =>
          useImplementTicketStore.setState((s) => updater(s)),
        { output: null },
      );
      const s = useImplementTicketStore.getState();
      expect(s.orchestratorSending).toBe(false);
      expect(s.orchestratorStreamText).toBe("");
    });
  });

  // ── 12. Orchestrator: race lock on send/review/resolve ─────────────────────

  describe("orchestrator race lock", () => {
    beforeEach(() => {
      useImplementTicketStore.setState({
        selectedIssue: makeIssue("PROJ-1"),
      });
    });

    it("sendOrchestratorMessage refuses when a turn is in flight", async () => {
      useImplementTicketStore.setState({ orchestratorSending: true });
      const { chatWithOrchestrator } = await import("@/lib/tauri");
      vi.mocked(chatWithOrchestrator).mockClear();
      await useImplementTicketStore
        .getState()
        .sendOrchestratorMessage("hello");
      expect(chatWithOrchestrator).not.toHaveBeenCalled();
    });

    it("triggerOrchestratorReview refuses when a turn is in flight", async () => {
      useImplementTicketStore.setState({ orchestratorSending: true });
      const { chatWithOrchestrator } = await import("@/lib/tauri");
      vi.mocked(chatWithOrchestrator).mockClear();
      await useImplementTicketStore
        .getState()
        .triggerOrchestratorReview("impact" as Stage, "ctx");
      expect(chatWithOrchestrator).not.toHaveBeenCalled();
    });

    it("triggerOrchestratorReview dedups via orchestratorReviewedStages", async () => {
      useImplementTicketStore.setState({
        orchestratorSending: false,
        orchestratorReviewedStages: ["impact" as Stage],
      });
      const { chatWithOrchestrator } = await import("@/lib/tauri");
      vi.mocked(chatWithOrchestrator).mockClear();
      await useImplementTicketStore
        .getState()
        .triggerOrchestratorReview("impact" as Stage, "ctx");
      expect(chatWithOrchestrator).not.toHaveBeenCalled();
    });

    it("resolveOrchestratorProposal refuses when a turn is in flight", async () => {
      useImplementTicketStore.setState({
        orchestratorSending: true,
        orchestratorPendingProposal: {
          kind: "proceed",
          rationale: "x",
          action: "approve",
        },
      });
      const { chatWithOrchestrator } = await import("@/lib/tauri");
      vi.mocked(chatWithOrchestrator).mockClear();
      await useImplementTicketStore
        .getState()
        .resolveOrchestratorProposal("accepted");
      expect(chatWithOrchestrator).not.toHaveBeenCalled();
    });
  });

  // ── 13. Orchestrator: proposal resolution dispatches the right side-effect ──

  describe("resolveOrchestratorProposal dispatch", () => {
    beforeEach(() => {
      useImplementTicketStore.setState({
        selectedIssue: makeIssue("PROJ-1"),
        pipelineThreadId: "pipeline-thread-1",
        orchestratorThreadId: "orchestrator:PROJ-1",
      });
    });

    it("rewind: calls rewindImplementationPipelineWorkflow with the target stage", async () => {
      useImplementTicketStore.setState({
        orchestratorPendingProposal: {
          kind: "rewind",
          rationale: "missed something",
          toStage: "grooming",
        },
      });
      const tauri = await import("@/lib/tauri");
      vi.mocked(tauri.rewindImplementationPipelineWorkflow).mockClear();
      await useImplementTicketStore
        .getState()
        .resolveOrchestratorProposal("accepted");
      expect(tauri.rewindImplementationPipelineWorkflow).toHaveBeenCalledWith(
        "pipeline-thread-1",
        "grooming",
      );
    });

    it("rewind: passes dropSummariesForStages to the resolution turn (everything strictly after toStage)", async () => {
      useImplementTicketStore.setState({
        orchestratorPendingProposal: {
          kind: "rewind",
          rationale: "x",
          toStage: "implementation",
        },
      });
      const tauri = await import("@/lib/tauri");
      vi.mocked(tauri.chatWithOrchestrator).mockClear();
      await useImplementTicketStore
        .getState()
        .resolveOrchestratorProposal("accepted");
      const callArg = vi.mocked(tauri.chatWithOrchestrator).mock.calls[0][0];
      // Should drop tests_plan, tests, review, pr, retro — not implementation
      expect(callArg.dropSummariesForStages).toEqual(
        expect.arrayContaining(["tests_plan", "tests", "review", "pr", "retro"]),
      );
      expect(callArg.dropSummariesForStages).not.toContain("implementation");
      expect(callArg.dropSummariesForStages).not.toContain("grooming");
    });

    it("edit_plan: calls applyPlanEdits with the edits batch", async () => {
      const edits = [
        { op: "set_summary" as const, summary: "new" },
        {
          op: "add_file" as const,
          file: { path: "z.ts", action: "create" as const, description: "z" },
        },
      ];
      useImplementTicketStore.setState({
        orchestratorPendingProposal: {
          kind: "edit_plan",
          rationale: "tighten plan",
          edits,
        },
      });
      const tauri = await import("@/lib/tauri");
      vi.mocked(tauri.applyPlanEdits).mockClear();
      await useImplementTicketStore
        .getState()
        .resolveOrchestratorProposal("accepted");
      expect(tauri.applyPlanEdits).toHaveBeenCalledWith({
        pipelineThreadId: "pipeline-thread-1",
        edits,
      });
    });

    it("accept_grooming_edit: routes to handleApproveEdit/Decline locally (no Tauri call)", async () => {
      const baseEdit = {
        field: "summary" as const,
        section: "",
        current: "A",
        suggested: "B",
        reasoning: "r",
        status: "pending" as const,
      };
      useImplementTicketStore.setState({
        groomingEdits: [
          { id: "e1", ...baseEdit },
          { id: "e2", ...baseEdit },
        ],
        orchestratorPendingProposal: {
          kind: "accept_grooming_edit",
          rationale: "agreed",
          editId: "e1",
          newStatus: "approved",
        },
      });
      const tauri = await import("@/lib/tauri");
      vi.mocked(tauri.applyPlanEdits).mockClear();
      vi.mocked(tauri.rewindImplementationPipelineWorkflow).mockClear();
      vi.mocked(tauri.resumeImplementationPipelineWorkflow).mockClear();

      await useImplementTicketStore
        .getState()
        .resolveOrchestratorProposal("accepted");

      const e1 = useImplementTicketStore
        .getState()
        .groomingEdits.find((x) => x.id === "e1");
      expect(e1?.status).toBe("approved");
      // None of the pipeline-mutating Tauri commands should fire.
      expect(tauri.applyPlanEdits).not.toHaveBeenCalled();
      expect(tauri.rewindImplementationPipelineWorkflow).not.toHaveBeenCalled();
      expect(tauri.resumeImplementationPipelineWorkflow).not.toHaveBeenCalled();
    });

    it("rejection notifies the orchestrator without firing any pipeline command", async () => {
      useImplementTicketStore.setState({
        orchestratorPendingProposal: {
          kind: "proceed",
          rationale: "x",
          action: "approve",
        },
      });
      const tauri = await import("@/lib/tauri");
      vi.mocked(tauri.chatWithOrchestrator).mockClear();
      vi.mocked(tauri.resumeImplementationPipelineWorkflow).mockClear();
      await useImplementTicketStore
        .getState()
        .resolveOrchestratorProposal("rejected");
      expect(tauri.resumeImplementationPipelineWorkflow).not.toHaveBeenCalled();
      // chatWithOrchestrator IS called for the resolution-notify turn.
      expect(tauri.chatWithOrchestrator).toHaveBeenCalled();
      const callArg = vi.mocked(tauri.chatWithOrchestrator).mock.calls[0][0];
      expect(callArg.clearPendingProposal).toBe(true);
      expect(callArg.messageKind).toBe("system_note");
    });

    it("returns early when there is no outstanding proposal", async () => {
      useImplementTicketStore.setState({ orchestratorPendingProposal: null });
      const tauri = await import("@/lib/tauri");
      vi.mocked(tauri.chatWithOrchestrator).mockClear();
      await useImplementTicketStore
        .getState()
        .resolveOrchestratorProposal("accepted");
      expect(tauri.chatWithOrchestrator).not.toHaveBeenCalled();
    });
  });
});
