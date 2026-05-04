import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type JiraIssue, type JiraSprint } from "@/lib/tauri/jira";

// ── Data helpers ──────────────────────────────────────────────────────────────

export function totalPoints(issues: JiraIssue[]): number {
  return issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

// Changelog-based: use completedInSprint when available (set by the backend by
// replaying the issue's status history to the sprint's completeDate). Falls back
// to current status only when no changelog data was fetched (e.g. active sprints).
export function isDone(issue: JiraIssue, _sprintEndDate?: string | null): boolean {
  if (issue.completedInSprint !== null && issue.completedInSprint !== undefined) {
    return issue.completedInSprint;
  }
  // Fallback for active sprints or issues fetched without a completeDate.
  return issue.statusCategory === "Done";
}

export function sprintPrs(prs: BitbucketPr[], sprint: JiraSprint): BitbucketPr[] {
  const start = sprint.startDate ?? "";
  const end = sprint.endDate ?? "9999";
  return prs.filter((pr) => pr.updatedOn >= start && pr.updatedOn <= end);
}

export function avgMergeHours(prs: BitbucketPr[]): number | null {
  if (prs.length === 0) return null;
  const total = prs.reduce((sum, pr) => {
    return (
      sum +
      (new Date(pr.updatedOn).getTime() - new Date(pr.createdOn).getTime()) /
        3_600_000
    );
  }, 0);
  return Math.round(total / prs.length);
}

export function formatDuration(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function sprintDateRange(sprint: JiraSprint): string {
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (sprint.startDate && sprint.endDate)
    return `${fmt(sprint.startDate)} – ${fmt(sprint.endDate)}`;
  if (sprint.endDate) return `Ended ${fmt(sprint.endDate)}`;
  return "";
}

// ── Per-sprint data cache ─────────────────────────────────────────────────────

export interface SprintData {
  issues: JiraIssue[];
  prs: BitbucketPr[];
}

// ── Velocity trend types ──────────────────────────────────────────────────────

export interface TrendPoint {
  sprint: JiraSprint;
  committed: number;
  completed: number;
  pct: number;
}
