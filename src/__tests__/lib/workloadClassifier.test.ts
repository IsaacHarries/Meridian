import { describe, it, expect } from "vitest";
import { classifyWorkloads } from "@/lib/workloadClassifier";
import type { JiraIssue, BitbucketPr } from "@/lib/tauri";

// ── Minimal fixtures ──────────────────────────────────────────────────────────

function makeIssue(
  overrides: Partial<JiraIssue> & { assigneeName?: string }
): JiraIssue {
  const { assigneeName, ...rest } = overrides;
  return {
    id: "1",
    key: "PROJ-1",
    url: "",
    summary: "Test issue",
    description: null,
    descriptionSections: [],
    status: "In Progress",
    statusCategory: "In Progress",
    assignee: assigneeName ? { displayName: assigneeName, accountId: "a1", avatarUrl: "" } : null,
    issueType: "Story",
    storyPoints: null,
    priority: null,
    epicKey: null,
    epicSummary: null,
    labels: [],
    acceptanceCriteria: null,
    stepsToReproduce: null,
    observedBehavior: null,
    expectedBehavior: null,
    sprintId: null,
    sprintName: null,
    namedFields: {},
    discoveredFieldIds: [],
    ...rest,
  } as JiraIssue;
}

function makePr(reviewerNames: string[]): BitbucketPr {
  return {
    id: 1,
    title: "PR",
    description: "",
    state: "OPEN",
    author: { user: { displayName: "Author", accountId: "a0", avatarUrl: "" }, role: "AUTHOR", approved: false },
    reviewers: reviewerNames.map((name) => ({
      user: { displayName: name, accountId: name, avatarUrl: "" },
      role: "REVIEWER",
      approved: false,
    })),
    links: { self: [{ href: "" }] },
    createdDate: 0,
    updatedDate: 0,
    fromRef: { displayId: "feature", latestCommit: "" },
    toRef: { displayId: "main", latestCommit: "" },
    participants: [],
    taskCount: 0,
  } as unknown as BitbucketPr;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("classifyWorkloads", () => {
  it("returns empty array for empty input", () => {
    expect(classifyWorkloads([], [])).toEqual([]);
  });

  it("groups issues by assignee displayName", () => {
    const issues = [
      makeIssue({ key: "P-1", assigneeName: "Alice", storyPoints: 3, statusCategory: "In Progress" }),
      makeIssue({ key: "P-2", assigneeName: "Alice", storyPoints: 2, statusCategory: "In Progress" }),
      makeIssue({ key: "P-3", assigneeName: "Bob", storyPoints: 1, statusCategory: "In Progress" }),
    ];
    const result = classifyWorkloads(issues, []);
    expect(result).toHaveLength(2);
    expect(result.find((d) => d.name === "Alice")?.remainingTickets).toBe(2);
    expect(result.find((d) => d.name === "Bob")?.remainingTickets).toBe(1);
  });

  it("issues with no assignee are grouped as Unassigned", () => {
    const issues = [makeIssue({ key: "P-1", assigneeName: undefined, statusCategory: "In Progress" })];
    const result = classifyWorkloads(issues, []);
    expect(result[0].name).toBe("Unassigned");
  });

  it("Done issues are excluded from remainingTickets count", () => {
    const issues = [
      makeIssue({ key: "P-1", assigneeName: "Alice", statusCategory: "Done" }),
      makeIssue({ key: "P-2", assigneeName: "Alice", statusCategory: "In Progress" }),
    ];
    const result = classifyWorkloads(issues, []);
    expect(result[0].remainingTickets).toBe(1);
  });

  it("all-zero story points — nobody classified as overloaded or underutilised", () => {
    const issues = [
      makeIssue({ key: "P-1", assigneeName: "Alice", storyPoints: 0, statusCategory: "In Progress" }),
      makeIssue({ key: "P-2", assigneeName: "Bob", storyPoints: 0, statusCategory: "In Progress" }),
    ];
    const result = classifyWorkloads(issues, []);
    for (const d of result) expect(d.loadStatus).toBe("balanced");
  });

  it("single developer with points — no classification applied (needs >1 to compare)", () => {
    const issues = [
      makeIssue({ key: "P-1", assigneeName: "Alice", storyPoints: 10, statusCategory: "In Progress" }),
    ];
    const result = classifyWorkloads(issues, []);
    expect(result[0].loadStatus).toBe("balanced");
  });

  it("developer with remainingTickets > 140% of average is overloaded", () => {
    // Alice: 10 remaining, Bob: 1 remaining → avg = 5.5, 140% = 7.7 → Alice overloaded
    const issues = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeIssue({ key: `P-A${i}`, assigneeName: "Alice", storyPoints: 2, statusCategory: "In Progress" })
      ),
      makeIssue({ key: "P-B1", assigneeName: "Bob", storyPoints: 2, statusCategory: "In Progress" }),
    ];
    const result = classifyWorkloads(issues, []);
    expect(result.find((d) => d.name === "Alice")?.loadStatus).toBe("overloaded");
    expect(result.find((d) => d.name === "Bob")?.loadStatus).toBe("underutilised");
  });

  it("developer with remainingTickets < 60% of average is underutilised", () => {
    // Alice: 1 remaining, Bob: 10 remaining → avg = 5.5, 60% = 3.3 → Alice underutilised
    const issues = [
      makeIssue({ key: "P-A1", assigneeName: "Alice", storyPoints: 2, statusCategory: "In Progress" }),
      ...Array.from({ length: 10 }, (_, i) =>
        makeIssue({ key: `P-B${i}`, assigneeName: "Bob", storyPoints: 2, statusCategory: "In Progress" })
      ),
    ];
    const result = classifyWorkloads(issues, []);
    expect(result.find((d) => d.name === "Alice")?.loadStatus).toBe("underutilised");
  });

  it("average computed only from developers with >0 story points", () => {
    // Zero-pt dev Carol should not drag the average down
    // Alice: 10 remaining (pts=5), Bob: 1 remaining (pts=5), Carol: 5 remaining (pts=0)
    // withWork = [Alice, Bob] → avg = 5.5
    // Alice > 7.7 → overloaded; Bob < 3.3 → underutilised; Carol compared to 5.5 → balanced
    const issues = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeIssue({ key: `PA${i}`, assigneeName: "Alice", storyPoints: 5, statusCategory: "In Progress" })
      ),
      makeIssue({ key: "PB1", assigneeName: "Bob", storyPoints: 5, statusCategory: "In Progress" }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeIssue({ key: `PC${i}`, assigneeName: "Carol", storyPoints: 0, statusCategory: "In Progress" })
      ),
    ];
    const result = classifyWorkloads(issues, []);
    expect(result.find((d) => d.name === "Alice")?.loadStatus).toBe("overloaded");
    expect(result.find((d) => d.name === "Bob")?.loadStatus).toBe("underutilised");
    expect(result.find((d) => d.name === "Carol")?.loadStatus).toBe("balanced");
  });

  it("reviewCount counts PRs where dev is a reviewer", () => {
    const issues = [makeIssue({ key: "P-1", assigneeName: "Alice", storyPoints: 1, statusCategory: "In Progress" })];
    const prs = [makePr(["Alice"]), makePr(["Alice"]), makePr(["Bob"])];
    const result = classifyWorkloads(issues, prs);
    expect(result.find((d) => d.name === "Alice")?.reviewCount).toBe(2);
  });

  it("exactly 140% of average stays balanced (strict greater-than boundary)", () => {
    // Alice: 7 remaining, Bob: 3 remaining → avg = 5, 140% = 7 → exactly 7 is NOT > 7 → balanced
    const alice = Array.from({ length: 7 }, (_, i) =>
      makeIssue({ key: `PA${i}`, assigneeName: "Alice", storyPoints: 2, statusCategory: "In Progress" })
    );
    const bob = Array.from({ length: 3 }, (_, i) =>
      makeIssue({ key: `PB${i}`, assigneeName: "Bob", storyPoints: 2, statusCategory: "In Progress" })
    );
    const result = classifyWorkloads([...alice, ...bob], []);
    expect(result.find((d) => d.name === "Alice")?.loadStatus).toBe("balanced");
  });

  it("exactly 60% of average stays balanced (strict less-than boundary)", () => {
    // Alice: 3 remaining, Bob: 7 remaining → avg = 5, 60% = 3 → exactly 3 is NOT < 3 → balanced
    const alice = Array.from({ length: 3 }, (_, i) =>
      makeIssue({ key: `PA${i}`, assigneeName: "Alice", storyPoints: 2, statusCategory: "In Progress" })
    );
    const bob = Array.from({ length: 7 }, (_, i) =>
      makeIssue({ key: `PB${i}`, assigneeName: "Bob", storyPoints: 2, statusCategory: "In Progress" })
    );
    const result = classifyWorkloads([...alice, ...bob], []);
    expect(result.find((d) => d.name === "Alice")?.loadStatus).toBe("balanced");
  });
});
