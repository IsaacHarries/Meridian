import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type JiraIssue } from "@/lib/tauri/jira";
import {
    ChevronDown,
    ChevronRight,
    GitPullRequest,
    User,
} from "lucide-react";
import { useState } from "react";
import {
    daysSince,
    statusCategory,
    totalPoints,
} from "./_shared";

// ── Team performance card ─────────────────────────────────────────────────────

export interface DevStats {
  name: string;
  issues: JiraIssue[];
  assignedPts: number;
  donePts: number;
  doneCount: number;
  inProgressPts: number;
  inProgressCount: number;
  inReviewPts: number;
  inReviewCount: number;
  totalCount: number;
  openPrs: BitbucketPr[];
  mergedPrs: BitbucketPr[];
}

export function buildDevStats(
  issues: JiraIssue[],
  openPrs: BitbucketPr[],
  mergedPrs: BitbucketPr[]
): DevStats[] {
  const map = new Map<string, JiraIssue[]>();

  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(issue);
  }

  return Array.from(map.entries())
    .map(([name, devIssues]) => {
      const done       = devIssues.filter((i) => statusCategory(i) === "done");
      const inReview   = devIssues.filter((i) => statusCategory(i) === "inreview");
      const inProgress = devIssues.filter((i) => statusCategory(i) === "inprogress");
      return {
        name,
        issues: devIssues,
        assignedPts:     totalPoints(devIssues),
        donePts:         totalPoints(done),
        doneCount:       done.length,
        inProgressPts:   totalPoints(inProgress),
        inProgressCount: inProgress.length,
        inReviewPts:     totalPoints(inReview),
        inReviewCount:   inReview.length,
        totalCount:      devIssues.length,
        openPrs:   openPrs.filter((p) => p.author.displayName === name),
        mergedPrs: mergedPrs.filter((p) => p.author.displayName === name),
      };
    })
    .sort((a, b) => b.donePts - a.donePts);
}

function DevRow({
  dev,
}: {
  dev: DevStats;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b last:border-0">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 py-3 text-sm text-left hover:bg-muted/40 px-1 rounded transition-colors"
      >
        <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0">
          <User className="h-3.5 w-3.5 text-muted-foreground" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium truncate">{dev.name}</span>
            <span className="text-xs text-muted-foreground shrink-0 ml-2">
              {dev.doneCount + dev.inReviewCount + dev.inProgressCount}/{dev.totalCount} tickets
            </span>
          </div>
          {/* Segmented bar: done | in review | in progress (by ticket count) */}
          <div className="h-1.5 rounded-full bg-muted overflow-hidden flex">
            {dev.totalCount > 0 && dev.doneCount > 0 && (
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${(dev.doneCount / dev.totalCount) * 100}%` }}
                title={`Done: ${dev.doneCount} tickets`}
              />
            )}
            {dev.totalCount > 0 && dev.inReviewCount > 0 && (
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${(dev.inReviewCount / dev.totalCount) * 100}%` }}
                title={`In Review: ${dev.inReviewCount} tickets`}
              />
            )}
            {dev.totalCount > 0 && dev.inProgressCount > 0 && (
              <div
                className="h-full bg-amber-500 transition-all"
                style={{ width: `${(dev.inProgressCount / dev.totalCount) * 100}%` }}
                title={`In Progress: ${dev.inProgressCount} tickets`}
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          <span title={`Done: ${dev.doneCount} · In Review: ${dev.inReviewCount} · In Progress: ${dev.inProgressCount}`}>
            <span className="text-emerald-600 font-medium">{dev.doneCount}</span>
            {dev.inReviewCount > 0 && <span className="text-blue-500 font-medium">+{dev.inReviewCount}</span>}
            {dev.inProgressCount > 0 && <span className="text-amber-500 font-medium">+{dev.inProgressCount}</span>}
            <span>/{dev.totalCount}</span>
          </span>
          {(dev.openPrs.length > 0 || dev.mergedPrs.length > 0) && (
            <span
              className="flex items-center gap-0.5"
              title={`${dev.openPrs.length} open PR(s), ${dev.mergedPrs.length} merged`}
            >
              <GitPullRequest className="h-3 w-3" />
              {dev.openPrs.length + dev.mergedPrs.length}
            </span>
          )}
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="pb-3 px-1 space-y-1">
          {dev.issues.map((issue) => {
            const cat = statusCategory(issue);
            const dotColor =
              cat === "done"
                ? "bg-emerald-500"
                : cat === "inreview"
                ? "bg-blue-500"
                : cat === "inprogress"
                ? "bg-amber-500"
                : "bg-muted-foreground/30";
            return (
              <div key={issue.key} className="flex items-center gap-2 text-xs py-1 pl-10">
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`} />
                <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                <span className="truncate text-muted-foreground">{issue.summary}</span>
                {issue.storyPoints != null && (
                  <span className="shrink-0 text-muted-foreground/60">
                    {issue.storyPoints}pt
                  </span>
                )}
                <span className="shrink-0 text-muted-foreground/60 ml-auto">{issue.status}</span>
              </div>
            );
          })}
          {dev.openPrs.length > 0 && (
            <div className="pl-10 pt-1 space-y-1">
              {dev.openPrs.map((pr) => (
                <div key={pr.id} className="flex items-center gap-2 text-xs py-0.5 text-blue-500">
                  <GitPullRequest className="h-3 w-3 shrink-0" />
                  <span className="truncate">#{pr.id} {pr.title}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {daysSince(pr.createdOn)}d old
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TeamPerformanceCard({
  devStats,
}: {
  devStats: DevStats[];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Team Performance</CardTitle>
      </CardHeader>
      <CardContent className="px-3">
        {devStats.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No assigned issues found.
          </p>
        ) : (
          <>
            {devStats.map((dev) => (
              <DevRow key={dev.name} dev={dev} />
            ))}
            <div className="flex items-center gap-4 pt-3 pb-1 px-1 border-t mt-1">
              <span className="text-[10px] text-muted-foreground">Legend:</span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="h-2 w-2 rounded-sm bg-emerald-500 inline-block" /> Done
              </span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="h-2 w-2 rounded-sm bg-blue-500 inline-block" /> In Review
              </span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="h-2 w-2 rounded-sm bg-amber-500 inline-block" /> In Progress
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
