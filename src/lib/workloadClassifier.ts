/**
 * Shared workload classification logic.
 *
 * Single source of truth used by both WorkloadBalancerScreen (display) and
 * workloadAlertStore (background polling / badge). Keeping them in sync here
 * prevents the badge and the Capacity list from ever disagreeing.
 */

import { type JiraIssue, type BitbucketPr } from "@/lib/tauri";

export type LoadStatus = "overloaded" | "balanced" | "underutilised";

export interface DevWorkload {
  name: string;
  remainingTickets: number;
  totalPts: number;
  reviewCount: number;
  loadStatus: LoadStatus;
}

function isDone(issue: JiraIssue): boolean {
  return issue.statusCategory === "Done";
}

function isNeedsReview(issue: JiraIssue): boolean {
  return issue.status === "Needs Review";
}

/**
 * Classify every developer's load status from a flat list of sprint issues
 * and the current open PRs.
 *
 * Rules (identical to WorkloadBalancerScreen.buildWorkloads):
 * - Average is computed from developers who have at least 1 story point
 *   assigned (so zero-point-only developers don't skew the baseline).
 * - "Needs Review" tickets are excluded from the count — work in review is
 *   waiting on someone else and shouldn't push a dev over capacity.
 * - Every developer (including zero-point ones) is then classified against
 *   that average:
 *     > 140% → overloaded
 *     < 60%  → underutilised  (only when avg > 0)
 *     else   → balanced
 */
export function classifyWorkloads(
  issues: JiraIssue[],
  openPrs: BitbucketPr[],
): DevWorkload[] {
  const map = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(issue);
  }

  const raw: DevWorkload[] = Array.from(map.entries()).map(([name, devIssues]) => ({
    name,
    remainingTickets: devIssues.filter((i) => !isDone(i) && !isNeedsReview(i)).length,
    totalPts: devIssues.reduce((s, i) => s + (i.storyPoints ?? 0), 0),
    reviewCount: openPrs.filter((pr) =>
      pr.reviewers.some((r) => r.user.displayName === name)
    ).length,
    loadStatus: "balanced" as LoadStatus,
  }));

  // Average computed only from developers who have pointed work
  const withWork = raw.filter((d) => d.totalPts > 0);
  if (withWork.length > 1) {
    const avgTickets =
      withWork.reduce((s, d) => s + d.remainingTickets, 0) / withWork.length;
    // Classification applied to ALL developers (including zero-point ones)
    for (const d of raw) {
      if (d.remainingTickets > avgTickets * 1.4) {
        d.loadStatus = "overloaded";
      } else if (d.remainingTickets < avgTickets * 0.6 && avgTickets > 0) {
        d.loadStatus = "underutilised";
      }
    }
  }

  return raw;
}

