import { getIgnoredDevs } from "@/lib/preferences";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri/jira", () => ({
  getAllActiveSprintIssues: vi.fn(),
}));

vi.mock("@/lib/tauri/bitbucket", () => ({
  getOpenPrs: vi.fn(),
}));

vi.mock("@/lib/preferences", () => ({
  getIgnoredDevs: vi.fn(),
}));
// Import after mocks so zustand store picks up mocked modules
// Each test calls useWorkloadAlertStore.getState() directly — no React needed.
import { getOpenPrs, type BitbucketPr } from "@/lib/tauri/bitbucket";
import { getAllActiveSprintIssues, type JiraIssue, type JiraSprint } from "@/lib/tauri/jira";
import { useWorkloadAlertStore } from "@/stores/workloadAlertStore";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeIssue(
  key: string,
  assigneeName: string | null,
  statusCategory: string,
  storyPoints: number
): JiraIssue {
  return {
    id: key,
    key,
    url: "",
    summary: key,
    description: "desc",
    descriptionSections: [],
    status: statusCategory,
    statusCategory,
    assignee: assigneeName
      ? { displayName: assigneeName, accountId: assigneeName, emailAddress: null }
      : null,
    reporter: null,
    issueType: "Story",
    storyPoints,
    priority: null,
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
  } as unknown as JiraIssue;
}

const MOCK_SPRINT: JiraSprint = {
  id: 1,
  name: "Sprint 1",
  state: "active",
  startDate: null,
  endDate: null,
  completeDate: null,
  goal: null,
};

// 10 Alice issues + 1 Bob issue → Alice overloaded, Bob underutilised
const OVERLOAD_ISSUES = [
  ...Array.from({ length: 10 }, (_, i) =>
    makeIssue(`PA-${i}`, "Alice", "In Progress", 2)
  ),
  makeIssue("PB-0", "Bob", "In Progress", 2),
];

const SPRINT_PAIRS_OVERLOADED: [JiraSprint, JiraIssue[]][] = [
  [MOCK_SPRINT, OVERLOAD_ISSUES],
];

const SPRINT_PAIRS_EMPTY: [JiraSprint, JiraIssue[]][] = [];

const OPEN_PRS: BitbucketPr[] = [];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("workloadAlertStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useWorkloadAlertStore.setState({
      overloadedDevs: [],
      underutilisedDevs: [],
      lastCheckedAt: null,
      checking: false,
      checkError: null,
    });
    vi.clearAllMocks();
    vi.mocked(getOpenPrs).mockResolvedValue(OPEN_PRS);
    vi.mocked(getIgnoredDevs).mockResolvedValue(new Set<string>());
  });

  it("starts with empty overloadedDevs and underutilisedDevs", () => {
    const s = useWorkloadAlertStore.getState();
    expect(s.overloadedDevs).toEqual([]);
    expect(s.underutilisedDevs).toEqual([]);
  });

  it("starts with checking=false and no errors", () => {
    const s = useWorkloadAlertStore.getState();
    expect(s.checking).toBe(false);
    expect(s.checkError).toBeNull();
  });

  it("starts with lastCheckedAt=null", () => {
    expect(useWorkloadAlertStore.getState().lastCheckedAt).toBeNull();
  });

  it("sets overloadedDevs when a dev exceeds 140% of average", async () => {
    vi.mocked(getAllActiveSprintIssues).mockResolvedValue(SPRINT_PAIRS_OVERLOADED);

    await useWorkloadAlertStore.getState().checkWorkload();

    const s = useWorkloadAlertStore.getState();
    expect(s.overloadedDevs).toContain("Alice");
    expect(s.underutilisedDevs).toContain("Bob");
  });

  it("sets lastCheckedAt to a recent ISO timestamp after a successful check", async () => {
    vi.mocked(getAllActiveSprintIssues).mockResolvedValue(SPRINT_PAIRS_EMPTY);
    const before = Date.now();

    await useWorkloadAlertStore.getState().checkWorkload();

    const ts = useWorkloadAlertStore.getState().lastCheckedAt;
    expect(ts).not.toBeNull();
    expect(new Date(ts!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("clears overloadedDevs when sprint has no issues", async () => {
    useWorkloadAlertStore.setState({ overloadedDevs: ["Alice"] });
    vi.mocked(getAllActiveSprintIssues).mockResolvedValue(SPRINT_PAIRS_EMPTY);

    await useWorkloadAlertStore.getState().checkWorkload();

    expect(useWorkloadAlertStore.getState().overloadedDevs).toEqual([]);
  });

  it("sets checkError and keeps checking=false on Tauri failure", async () => {
    vi.mocked(getAllActiveSprintIssues).mockRejectedValue(new Error("network"));

    await useWorkloadAlertStore.getState().checkWorkload();

    const s = useWorkloadAlertStore.getState();
    expect(s.checking).toBe(false);
    expect(s.checkError).toMatch(/network/);
  });

  it("returns existing overloadedDevs on error (does not clear them)", async () => {
    useWorkloadAlertStore.setState({ overloadedDevs: ["Carol"] });
    vi.mocked(getAllActiveSprintIssues).mockRejectedValue(new Error("fail"));

    const result = await useWorkloadAlertStore.getState().checkWorkload();

    expect(result).toContain("Carol");
  });

  it("no-ops if already checking (returns current overloadedDevs)", async () => {
    useWorkloadAlertStore.setState({ checking: true, overloadedDevs: ["Dave"] });

    const result = await useWorkloadAlertStore.getState().checkWorkload();

    expect(getAllActiveSprintIssues).not.toHaveBeenCalled();
    expect(result).toContain("Dave");
  });

  it("filters out ignored developers from overloadedDevs", async () => {
    vi.mocked(getAllActiveSprintIssues).mockResolvedValue(SPRINT_PAIRS_OVERLOADED);
    vi.mocked(getIgnoredDevs).mockResolvedValue(new Set(["Alice"]));

    await useWorkloadAlertStore.getState().checkWorkload();

    expect(useWorkloadAlertStore.getState().overloadedDevs).not.toContain("Alice");
  });

  it("overloaded dev is not also listed as underutilised", async () => {
    vi.mocked(getAllActiveSprintIssues).mockResolvedValue(SPRINT_PAIRS_OVERLOADED);

    await useWorkloadAlertStore.getState().checkWorkload();

    const { overloadedDevs, underutilisedDevs } = useWorkloadAlertStore.getState();
    for (const name of overloadedDevs) {
      expect(underutilisedDevs).not.toContain(name);
    }
  });

  it("handles getOpenPrs failure gracefully (falls back to empty PR list)", async () => {
    vi.mocked(getAllActiveSprintIssues).mockResolvedValue(SPRINT_PAIRS_OVERLOADED);
    vi.mocked(getOpenPrs).mockRejectedValue(new Error("bitbucket down"));

    await expect(
      useWorkloadAlertStore.getState().checkWorkload()
    ).resolves.not.toThrow();
  });
});
