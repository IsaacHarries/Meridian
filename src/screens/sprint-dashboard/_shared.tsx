import { type BitbucketPr, type BitbucketTask } from "@/lib/tauri/bitbucket";
import { type JiraIssue, type JiraSprint } from "@/lib/tauri/jira";
import { classifyWorkloads } from "@/lib/workloadClassifier";

// ── Data types ────────────────────────────────────────────────────────────────

export interface DashboardData {
  sprint: JiraSprint | null;
  issues: JiraIssue[];
  openPrs: BitbucketPr[];
  mergedPrs: BitbucketPr[];
  /** tasks keyed by PR id — only fetched for 2+-approval candidates */
  prTasks: Map<number, BitbucketTask[]>;
}

export interface AllSprintsData {
  sprints: Array<{ sprint: JiraSprint; issues: JiraIssue[] }>;
  openPrs: BitbucketPr[];
  mergedPrs: BitbucketPr[];
  prTasks: Map<number, BitbucketTask[]>;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

export function daysRemaining(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

export function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

export function isInReview(issue: JiraIssue): boolean {
  const s = issue.status.toLowerCase();
  return s.includes("review") || s.includes("testing") || s.includes("qa");
}

export function isBlocked(issue: JiraIssue): boolean {
  return (
    issue.labels.some((l) => l.toLowerCase() === "blocked") ||
    issue.status.toLowerCase().includes("blocked")
  );
}

export function statusCategory(issue: JiraIssue): "todo" | "inprogress" | "inreview" | "done" {
  if (issue.statusCategory === "Done") return "done";
  if (isInReview(issue)) return "inreview";
  if (issue.statusCategory === "In Progress") return "inprogress";
  return "todo";
}

export function totalPoints(issues: JiraIssue[]): number {
  return issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

// ── Business-day helpers (mirrors sprint-dashboard utils.py) ─────────────────
// Counts Mon–Fri only, with partial days, so weekends don't inflate PR age.

export function businessDaysAgo(isoStr: string): number {
  const dt  = new Date(isoStr).getTime();
  const now = Date.now();
  if (dt >= now) return 0;

  let total = 0;
  let cursor = dt;
  while (cursor < now) {
    const d = new Date(cursor);
    const dow = d.getUTCDay(); // 0=Sun … 6=Sat
    if (dow >= 1 && dow <= 5) {
      // midnight ending this business day
      const dayEnd = Date.UTC(
        d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1
      );
      const chunkEnd = Math.min(now, dayEnd);
      total += (chunkEnd - cursor) / 86_400_000;
    }
    // advance cursor to midnight of next day
    const d2 = new Date(cursor);
    cursor = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate() + 1);
  }
  return total;
}

/** Sprint progress 0→1: fraction of **business** days elapsed (matches get_sprint_progress). */
export function sprintProgress(sprint: { startDate?: string | null; endDate?: string | null } | null): number | null {
  if (!sprint?.startDate || !sprint?.endDate) return null;
  const startMs = new Date(sprint.startDate).getTime();
  const endMs   = new Date(sprint.endDate).getTime();
  if (endMs <= startMs) return null;

  function countBdays(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 0;
    let total = 0;
    let cursor = fromMs;
    while (cursor < toMs) {
      const d = new Date(cursor);
      const dow = d.getUTCDay();
      if (dow >= 1 && dow <= 5) {
        const dayEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
        const chunkEnd = Math.min(toMs, dayEnd);
        total += (chunkEnd - cursor) / 86_400_000;
      }
      const d2 = new Date(cursor);
      cursor = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate() + 1);
    }
    return total;
  }

  const totalBdays   = countBdays(startMs, endMs);
  const elapsedBdays = countBdays(startMs, Math.min(Date.now(), endMs));
  if (totalBdays <= 0) return 1;
  return Math.min(1, Math.max(0, elapsedBdays / totalBdays));
}

// ── Segmented bar ─────────────────────────────────────────────────────────────

export interface Segment {
  value: number;
  color: string;
  label: string;
}

export function SegmentedBar({ segments, total }: { segments: Segment[]; total: number }) {
  if (total === 0) {
    return <div className="h-3 rounded-full bg-muted w-full" />;
  }
  return (
    <div className="flex h-3 rounded-full overflow-hidden w-full gap-px">
      {segments.map((seg) =>
        seg.value > 0 ? (
          <div
            key={seg.label}
            className={seg.color}
            style={{ width: `${(seg.value / total) * 100}%` }}
            title={`${seg.label}: ${seg.value}`}
          />
        ) : null
      )}
    </div>
  );
}

// ── Workload helpers (shared by TeamWorkloadSection + SprintChatPanel) ────────

export type LoadStatus = "overloaded" | "balanced" | "underutilised";

export interface DevWorkload {
  name: string;
  issues: JiraIssue[];
  remainingPts: number;
  totalPts: number;
  donePts: number;
  reviewCount: number;
  loadStatus: LoadStatus;
}

export function remainingPoints(issues: JiraIssue[]): number {
  return issues
    .filter((i) => statusCategory(i) !== "done")
    .reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

export function buildWorkloads(issues: JiraIssue[], openPrs: BitbucketPr[]): DevWorkload[] {
  // Use the shared classifier so the load-status badge here always matches the
  // landing-page attention badge driven by the same logic.
  const classified = classifyWorkloads(issues, openPrs);
  const statusMap = new Map(classified.map((d) => [d.name, d.loadStatus]));

  const map = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(issue);
  }

  const raw: DevWorkload[] = Array.from(map.entries()).map(([name, devIssues]) => ({
    name,
    issues: devIssues,
    remainingPts: remainingPoints(devIssues),
    totalPts: totalPoints(devIssues),
    donePts: totalPoints(devIssues.filter((i) => statusCategory(i) === "done")),
    reviewCount: openPrs.filter((pr) =>
      pr.reviewers.some((r) => r.user.displayName === name),
    ).length,
    loadStatus: (statusMap.get(name) ?? "balanced") as LoadStatus,
  }));

  return raw.sort(
    (a, b) =>
      b.issues.filter((i) => statusCategory(i) !== "done").length -
      a.issues.filter((i) => statusCategory(i) !== "done").length,
  );
}

export function formatWorkloadForClaude(
  sprint: JiraSprint | null,
  workloads: DevWorkload[],
  unstartedTickets: JiraIssue[],
): string {
  const lines: string[] = [
    `Sprint: ${sprint?.name ?? "Unknown"}`,
    `Days remaining: ${sprint?.endDate ? Math.ceil((new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000) : "unknown"}`,
    "",
    "Developer workloads:",
  ];

  for (const d of workloads) {
    const remaining = d.issues.filter((i) => statusCategory(i) !== "done");
    lines.push(
      `  ${d.name}: ${d.remainingPts}pt remaining (${remaining.length} tickets), ` +
        `${d.reviewCount} PRs to review, status: ${d.loadStatus}`,
    );
    for (const issue of remaining) {
      lines.push(
        `    - ${issue.key} "${issue.summary}" (${issue.storyPoints ?? 0}pt, ${issue.status})`,
      );
    }
  }

  lines.push("", "Unstarted tickets (candidates for reassignment):");
  for (const t of unstartedTickets) {
    const assignee = t.assignee?.displayName ?? "Unassigned";
    lines.push(
      `  ${t.key} "${t.summary}" (${t.storyPoints ?? 0}pt) — currently: ${assignee}`,
    );
  }

  const teamAvg =
    workloads.length > 0
      ? Math.round(workloads.reduce((s, d) => s + d.remainingPts, 0) / workloads.length)
      : 0;
  lines.push("", `Team average remaining: ${teamAvg}pt`);

  return lines.join("\n");
}
