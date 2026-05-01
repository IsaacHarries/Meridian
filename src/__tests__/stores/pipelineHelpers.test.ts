import { describe, it, expect } from "vitest";
import { compileTicketText, detectGroomingBlockers } from "@/stores/implementTicketStore";
import type { JiraIssue, GroomingOutput } from "@/lib/tauri";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: "1",
    key: "PROJ-1",
    url: "",
    summary: "Test Issue",
    description: "A sufficiently long description that passes validation.",
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
    acceptanceCriteria: null,
    stepsToReproduce: null,
    observedBehavior: null,
    expectedBehavior: null,
    sprintId: null,
    sprintName: null,
    namedFields: {},
    discoveredFieldIds: {},
    ...overrides,
  } as unknown as JiraIssue;
}

function makeGrooming(overrides: Partial<GroomingOutput> = {}): GroomingOutput {
  return {
    ticket_summary: "summary",
    ticket_type: "Story",
    acceptance_criteria: ["AC 1"],
    relevant_areas: [],
    dependencies: [],
    estimated_complexity: "low",
    grooming_notes: "",
    suggested_edits: [],
    clarifying_questions: [],
    ...overrides,
  } as unknown as GroomingOutput;
}

// ── compileTicketText ─────────────────────────────────────────────────────────

describe("compileTicketText", () => {
  it("always includes Ticket, Title, Type, Status lines", () => {
    const text = compileTicketText(makeIssue());
    expect(text).toContain("Ticket: PROJ-1");
    expect(text).toContain("Title: Test Issue");
    expect(text).toContain("Type: Story");
    expect(text).toContain("Status: To Do");
  });

  it("includes Story points line when storyPoints is not null", () => {
    const text = compileTicketText(makeIssue({ storyPoints: 5 }));
    expect(text).toContain("Story points: 5");
  });

  it("omits Story points line when storyPoints is null", () => {
    const text = compileTicketText(makeIssue({ storyPoints: null }));
    expect(text).not.toContain("Story points");
  });

  it("includes Priority line when priority is set", () => {
    const text = compileTicketText(makeIssue({ priority: "High" }));
    expect(text).toContain("Priority: High");
  });

  it("omits Priority line when priority is null", () => {
    const text = compileTicketText(makeIssue({ priority: null }));
    expect(text).not.toContain("Priority");
  });

  it("includes Epic with key when both epicSummary and epicKey are set", () => {
    const text = compileTicketText(makeIssue({ epicSummary: "My Epic", epicKey: "EPIC-1" }));
    expect(text).toContain("Epic: My Epic (EPIC-1)");
  });

  it("includes Epic without parenthetical when epicKey is null", () => {
    const text = compileTicketText(makeIssue({ epicSummary: "My Epic", epicKey: null }));
    expect(text).toContain("Epic: My Epic");
    expect(text).not.toContain("(");
  });

  it("omits Epic line when epicSummary is null", () => {
    const text = compileTicketText(makeIssue({ epicSummary: null }));
    expect(text).not.toContain("Epic:");
  });

  it("includes Labels line when labels array is non-empty", () => {
    const text = compileTicketText(makeIssue({ labels: ["frontend", "urgent"] }));
    expect(text).toContain("Labels: frontend, urgent");
  });

  it("omits Labels line when labels array is empty", () => {
    const text = compileTicketText(makeIssue({ labels: [] }));
    expect(text).not.toContain("Labels:");
  });

  it("includes Assignee line when assignee is set", () => {
    const text = compileTicketText(
      makeIssue({ assignee: { displayName: "Alice", accountId: "a1", emailAddress: null } })
    );
    expect(text).toContain("Assignee: Alice");
  });

  it("omits Assignee line when assignee is null", () => {
    const text = compileTicketText(makeIssue({ assignee: null }));
    expect(text).not.toContain("Assignee:");
  });

  // ── Description variants ──────────────────────────────────────────────────

  it("renders descriptionSections with headings as ## headers", () => {
    const text = compileTicketText(
      makeIssue({
        description: null,
        descriptionSections: [{ heading: "Overview", content: "Some detail." }],
      })
    );
    expect(text).toContain("## Overview");
    expect(text).toContain("Some detail.");
  });

  it("renders descriptionSections without heading as bare content", () => {
    const text = compileTicketText(
      makeIssue({
        description: null,
        descriptionSections: [{ heading: null, content: "Raw content." }],
      })
    );
    expect(text).not.toContain("## null");
    expect(text).toContain("Raw content.");
  });

  it("falls back to flat description when descriptionSections is empty", () => {
    const text = compileTicketText(
      makeIssue({ description: "Flat description text.", descriptionSections: [] })
    );
    expect(text).toContain("Description:\nFlat description text.");
  });

  it("renders '(none)' when both description and descriptionSections are absent", () => {
    const text = compileTicketText(
      makeIssue({ description: null, descriptionSections: [] })
    );
    expect(text).toContain("Description: (none)");
  });

  // ── Optional structured sections ──────────────────────────────────────────

  it("includes Acceptance Criteria section when set", () => {
    const text = compileTicketText(makeIssue({ acceptanceCriteria: "- Must work" }));
    expect(text).toContain("## Acceptance Criteria\n- Must work");
  });

  it("omits Acceptance Criteria section when null", () => {
    const text = compileTicketText(makeIssue({ acceptanceCriteria: null }));
    expect(text).not.toContain("Acceptance Criteria");
  });

  it("includes Steps to Reproduce section when set", () => {
    const text = compileTicketText(makeIssue({ stepsToReproduce: "1. Click button" }));
    expect(text).toContain("## Steps to Reproduce\n1. Click button");
  });

  it("includes Observed Behavior section when set", () => {
    const text = compileTicketText(makeIssue({ observedBehavior: "It crashed" }));
    expect(text).toContain("## Observed Behavior\nIt crashed");
  });

  it("includes Expected Behavior section when set", () => {
    const text = compileTicketText(makeIssue({ expectedBehavior: "It should work" }));
    expect(text).toContain("## Expected Behavior\nIt should work");
  });

  // ── namedFields ───────────────────────────────────────────────────────────

  it("includes unknown namedFields under Additional Fields", () => {
    const text = compileTicketText(makeIssue({ namedFields: { "Team": "Platform" } }));
    expect(text).toContain("## Additional Fields");
    expect(text).toContain("Team: Platform");
  });

  it("filters out known field names from namedFields", () => {
    const text = compileTicketText(
      makeIssue({ namedFields: { "Acceptance Criteria": "AC here", "Team": "Platform" } })
    );
    expect(text).not.toContain("Acceptance Criteria: AC here");
    expect(text).toContain("Team: Platform");
  });

  it("filters out known names case-insensitively", () => {
    const text = compileTicketText(
      makeIssue({ namedFields: { "ACCEPTANCE CRITERIA": "AC", "steps to reproduce": "steps" } })
    );
    expect(text).not.toContain("ACCEPTANCE CRITERIA");
    expect(text).not.toContain("steps to reproduce");
  });

  it("omits Additional Fields section when namedFields is empty", () => {
    const text = compileTicketText(makeIssue({ namedFields: {} }));
    expect(text).not.toContain("Additional Fields");
  });

  it("storyPoints=0 is included (0 is not null)", () => {
    const text = compileTicketText(makeIssue({ storyPoints: 0 }));
    expect(text).toContain("Story points: 0");
  });
});

// ── detectGroomingBlockers ────────────────────────────────────────────────────

describe("detectGroomingBlockers", () => {
  it("returns no blockers for a clean Story with description, AC, and points", () => {
    const issue = makeIssue({ issueType: "Story", storyPoints: 3, description: "Detailed enough description here." });
    const grooming = makeGrooming({ acceptance_criteria: ["AC 1"] });
    expect(detectGroomingBlockers(issue, grooming)).toEqual([]);
  });

  // ── Description checks ────────────────────────────────────────────────────

  it("blocks when description is null", () => {
    const issue = makeIssue({ description: null });
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-description")).toBe(true);
  });

  it("blocks when description is empty string", () => {
    const issue = makeIssue({ description: "" });
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-description")).toBe(true);
  });

  it("blocks when description is whitespace only", () => {
    const issue = makeIssue({ description: "   " });
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-description")).toBe(true);
  });

  it("blocks when description is fewer than 10 chars after trim", () => {
    const issue = makeIssue({ description: "Too short" }); // 9 chars
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-description")).toBe(true);
  });

  it("does NOT block when description is exactly 10 chars (boundary)", () => {
    const issue = makeIssue({ description: "1234567890" }); // exactly 10
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-description")).toBe(false);
  });

  it("no-description blocker has severity=blocking", () => {
    const issue = makeIssue({ description: null });
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    const b = blockers.find((b) => b.id === "no-description")!;
    expect(b.severity).toBe("blocking");
  });

  // ── Acceptance criteria checks ────────────────────────────────────────────

  it("blocks Story with empty acceptance_criteria", () => {
    const issue = makeIssue({ issueType: "Story" });
    const grooming = makeGrooming({ acceptance_criteria: [] });
    const blockers = detectGroomingBlockers(issue, grooming);
    expect(blockers.some((b) => b.id === "no-ac")).toBe(true);
  });

  it("blocks Task with empty acceptance_criteria", () => {
    const issue = makeIssue({ issueType: "Task" });
    const grooming = makeGrooming({ acceptance_criteria: [] });
    const blockers = detectGroomingBlockers(issue, grooming);
    expect(blockers.some((b) => b.id === "no-ac")).toBe(true);
  });

  it("does NOT block Bug with empty acceptance_criteria (not story/task)", () => {
    const issue = makeIssue({ issueType: "Bug" });
    const grooming = makeGrooming({ acceptance_criteria: [] });
    const blockers = detectGroomingBlockers(issue, grooming);
    expect(blockers.some((b) => b.id === "no-ac")).toBe(false);
  });

  it("no-ac blocker has severity=blocking", () => {
    const issue = makeIssue({ issueType: "Story" });
    const grooming = makeGrooming({ acceptance_criteria: [] });
    const b = detectGroomingBlockers(issue, grooming).find((b) => b.id === "no-ac")!;
    expect(b.severity).toBe("blocking");
  });

  it("no-ac detail message includes the issue type name", () => {
    const issue = makeIssue({ issueType: "Story" });
    const grooming = makeGrooming({ acceptance_criteria: [] });
    const b = detectGroomingBlockers(issue, grooming).find((b) => b.id === "no-ac")!;
    expect(b.detail).toContain("Story");
  });

  // ── Story points checks ───────────────────────────────────────────────────

  it("warns Story with null storyPoints", () => {
    const issue = makeIssue({ issueType: "Story", storyPoints: null });
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-points")).toBe(true);
  });

  it("warns Task with null storyPoints", () => {
    const issue = makeIssue({ issueType: "Task", storyPoints: null });
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-points")).toBe(true);
  });

  it("does NOT warn Bug with null storyPoints (not story/task)", () => {
    const issue = makeIssue({ issueType: "Bug", storyPoints: null });
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-points")).toBe(false);
  });

  it("does NOT warn Story with storyPoints=0 (zero is not null)", () => {
    const issue = makeIssue({ issueType: "Story", storyPoints: 0 });
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-points")).toBe(false);
  });

  it("no-points blocker has severity=warning (not blocking)", () => {
    const issue = makeIssue({ issueType: "Story", storyPoints: null });
    const b = detectGroomingBlockers(issue, makeGrooming()).find((b) => b.id === "no-points")!;
    expect(b.severity).toBe("warning");
  });

  // ── Multiple blockers ─────────────────────────────────────────────────────

  it("returns all three blockers when Story has no description, no AC, and no points", () => {
    const issue = makeIssue({ issueType: "Story", description: null, storyPoints: null });
    const grooming = makeGrooming({ acceptance_criteria: [] });
    const blockers = detectGroomingBlockers(issue, grooming);
    expect(blockers.map((b) => b.id)).toContain("no-description");
    expect(blockers.map((b) => b.id)).toContain("no-ac");
    expect(blockers.map((b) => b.id)).toContain("no-points");
  });

  it("issueType matching is case-insensitive (story lowercase triggers AC check)", () => {
    const issue = makeIssue({ issueType: "story" });
    const grooming = makeGrooming({ acceptance_criteria: [] });
    const blockers = detectGroomingBlockers(issue, grooming);
    expect(blockers.some((b) => b.id === "no-ac")).toBe(true);
  });

  it("issueType matching is case-insensitive (TASK uppercase triggers points check)", () => {
    const issue = makeIssue({ issueType: "TASK", storyPoints: null });
    const blockers = detectGroomingBlockers(issue, makeGrooming());
    expect(blockers.some((b) => b.id === "no-points")).toBe(true);
  });
});
