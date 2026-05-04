import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type JiraIssue, type JiraSprint } from "@/lib/tauri/jira";
import { isDone, totalPoints } from "./_shared";

// Treats "In Review" loosely: anything tagged review/testing/QA counts —
// matches SprintDashboard's bucket so a ticket sitting in PR review shows
// up in the same bar segment in both screens.
function isInReviewIssue(issue: JiraIssue): boolean {
  const s = issue.status.toLowerCase();
  return s.includes("review") || s.includes("testing") || s.includes("qa");
}

export function TeamBreakdownCard({ sprint, issues }: { sprint: JiraSprint; issues: JiraIssue[] }) {
  const devMap = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!devMap.has(name)) devMap.set(name, []);
    devMap.get(name)!.push(issue);
  }

  const devs = Array.from(devMap.entries())
    .map(([name, devIssues]) => {
      const done = devIssues.filter((i) => isDone(i, sprint.endDate));
      // Reviewed/in-progress buckets are mutually exclusive with Done so a
      // single ticket only contributes to one segment of the bar.
      const remaining = devIssues.filter((i) => !isDone(i, sprint.endDate));
      const inReview = remaining.filter(isInReviewIssue);
      const inProgress = remaining.filter(
        (i) => !isInReviewIssue(i) && i.statusCategory === "In Progress",
      );
      return {
        name,
        donePts: totalPoints(done),
        assignedPts: totalPoints(devIssues),
        doneCount: done.length,
        inReviewCount: inReview.length,
        inProgressCount: inProgress.length,
        totalCount: devIssues.length,
      };
    })
    .sort((a, b) => b.doneCount - a.doneCount);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Team Breakdown</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {devs.map((dev) => {
          const activeCount =
            dev.doneCount + dev.inReviewCount + dev.inProgressCount;
          return (
            <div key={dev.name} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{dev.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {activeCount}/{dev.totalCount} tickets · {dev.donePts}/{dev.assignedPts} pts
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden flex">
                {dev.totalCount > 0 && dev.doneCount > 0 && (
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${(dev.doneCount / dev.totalCount) * 100}%` }}
                    title={`Done: ${dev.doneCount} ticket${dev.doneCount === 1 ? "" : "s"}`}
                  />
                )}
                {dev.totalCount > 0 && dev.inReviewCount > 0 && (
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{ width: `${(dev.inReviewCount / dev.totalCount) * 100}%` }}
                    title={`In Review: ${dev.inReviewCount} ticket${dev.inReviewCount === 1 ? "" : "s"}`}
                  />
                )}
                {dev.totalCount > 0 && dev.inProgressCount > 0 && (
                  <div
                    className="h-full bg-amber-500 transition-all"
                    style={{ width: `${(dev.inProgressCount / dev.totalCount) * 100}%` }}
                    title={`In Progress: ${dev.inProgressCount} ticket${dev.inProgressCount === 1 ? "" : "s"}`}
                  />
                )}
              </div>
            </div>
          );
        })}
        {devs.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-2">
            No assigned issues found.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
