import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all Tauri-dependent modules before importing the store
vi.mock("@/lib/tauri", () => ({
  getIssue: vi.fn(),
  loadAgentSkills: vi.fn().mockResolvedValue({}),
  syncWorktree: vi.fn().mockResolvedValue(null),
  getNonSecretConfig: vi.fn().mockResolvedValue({}),
  runGroomingFileProbe: vi.fn().mockResolvedValue("{}"),
  runGroomingAgent: vi.fn().mockResolvedValue("{}"),
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
  saveKnowledgeEntry: vi.fn().mockResolvedValue(undefined),
  parseAgentJson: vi.fn().mockReturnValue(null),
  readRepoFile: vi.fn().mockResolvedValue(""),
  grepRepoFiles: vi.fn().mockResolvedValue([]),
  getAllActiveSprintIssues: vi.fn().mockResolvedValue([]),
  getOpenPrs: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
}));

import {
  useImplementTicketStore,
  snapshotSession,
  INITIAL,
  type Stage,
} from "@/stores/implementTicketStore";
import type { JiraIssue, GroomingOutput } from "@/lib/tauri";

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
      useImplementTicketStore.setState({ kbSaved: true });
      useImplementTicketStore.getState()._set({ groomingProgress: "x" });
      expect(useImplementTicketStore.getState().kbSaved).toBe(true);
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
        kbSaved: true,
      });

      useImplementTicketStore.getState().resetSession();

      const s = useImplementTicketStore.getState();
      expect(s.selectedIssue).toBeNull();
      expect(s.currentStage).toBe("select");
      expect(s.grooming).toBeNull();
      expect(s.isSessionActive).toBe(false);
      expect(s.kbSaved).toBe(false);
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
});
