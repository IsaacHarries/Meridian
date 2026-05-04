import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type JiraIssue, type JiraSprint } from "@/lib/tauri/jira";
import { Clock, GitPullRequest } from "lucide-react";
import {
    daysRemaining,
    SegmentedBar,
    statusCategory,
    totalPoints,
    type Segment,
} from "./_shared";

// ── Sprint overview card ──────────────────────────────────────────────────────

export function SprintOverview({
  sprint,
  issues,
  openPrs,
  mergedPrs,
}: {
  sprint: JiraSprint | null;
  issues: JiraIssue[];
  openPrs: BitbucketPr[];
  mergedPrs: BitbucketPr[];
}) {
  const days = daysRemaining(sprint?.endDate ?? null);

  const todo = issues.filter((i) => statusCategory(i) === "todo");
  const inProgress = issues.filter((i) => statusCategory(i) === "inprogress");
  const inReview = issues.filter((i) => statusCategory(i) === "inreview");
  const done = issues.filter((i) => statusCategory(i) === "done");

  const totalPts = totalPoints(issues);
  const donePts = totalPoints(done);
  const inProgressPts = totalPoints([...inProgress, ...inReview]);
  const todoPts = totalPoints(todo);

  const statusSegments: Segment[] = [
    { value: done.length, color: "bg-emerald-500", label: "Done" },
    { value: inReview.length, color: "bg-blue-500", label: "In Review" },
    { value: inProgress.length, color: "bg-amber-500", label: "In Progress" },
    { value: todo.length, color: "bg-muted-foreground/20", label: "To Do" },
  ];

  const pointsSegments: Segment[] = [
    { value: donePts, color: "bg-emerald-500", label: "Done" },
    { value: inProgressPts, color: "bg-amber-500", label: "In Progress" },
    { value: todoPts, color: "bg-muted-foreground/20", label: "To Do" },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">
              {sprint?.name ?? "All Active Sprints"}
            </CardTitle>
            {sprint && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {sprint.startDate
                  ? new Date(sprint.startDate).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })
                  : ""}
                {sprint.startDate && sprint.endDate ? " – " : ""}
                {sprint.endDate
                  ? new Date(sprint.endDate).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })
                  : ""}
              </p>
            )}
          </div>
          {days !== null && (
            <Badge
              variant={days <= 2 ? "destructive" : days <= 4 ? "warning" : "secondary"}
              className="shrink-0"
            >
              <Clock className="h-3 w-3 mr-1" />
              {days > 0 ? `${days}d remaining` : "Sprint ended"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Ticket status */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Tickets ({issues.length} total)</span>
            <span className="text-emerald-600 font-medium">{done.length} done</span>
          </div>
          <SegmentedBar segments={statusSegments} total={issues.length} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
              Done <strong>{done.length}</strong>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-blue-500 inline-block" />
              In Review <strong>{inReview.length}</strong>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-500 inline-block" />
              In Progress <strong>{inProgress.length}</strong>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-muted-foreground/40 inline-block" />
              To Do <strong>{todo.length}</strong>
            </span>
          </div>
        </div>

        {/* Story points */}
        {totalPts > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Story points ({totalPts} committed)</span>
              <span className="text-emerald-600 font-medium">{donePts} done</span>
            </div>
            <SegmentedBar segments={pointsSegments} total={totalPts} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
                Done <strong>{donePts}</strong>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-amber-500 inline-block" />
                In Progress <strong>{inProgressPts}</strong>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/40 inline-block" />
                Remaining <strong>{todoPts}</strong>
              </span>
            </div>
          </div>
        )}

        {/* PR counts */}
        <div className="flex gap-4 pt-1 border-t text-sm">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <GitPullRequest className="h-3.5 w-3.5" />
            <span>
              <strong className="text-foreground">{openPrs.length}</strong> open PRs
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <GitPullRequest className="h-3.5 w-3.5" />
            <span>
              <strong className="text-foreground">{mergedPrs.length}</strong> merged this sprint
            </span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
