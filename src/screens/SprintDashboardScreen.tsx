import { useEffect, useState, useCallback } from "react";
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  GitPullRequest,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  type JiraSprint,
  type JiraIssue,
  type BitbucketPr,
  getActiveSprint,
  getActiveSprintIssues,
  getOpenPrs,
  getMergedPrs,
} from "@/lib/tauri";

interface SprintDashboardScreenProps {
  onBack: () => void;
}

// ── Data types ────────────────────────────────────────────────────────────────

interface DashboardData {
  sprint: JiraSprint | null;
  issues: JiraIssue[];
  openPrs: BitbucketPr[];
  mergedPrs: BitbucketPr[];
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function daysRemaining(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

function isInReview(issue: JiraIssue): boolean {
  const s = issue.status.toLowerCase();
  return s.includes("review") || s.includes("testing") || s.includes("qa");
}

function isBlocked(issue: JiraIssue): boolean {
  return (
    issue.labels.some((l) => l.toLowerCase() === "blocked") ||
    issue.status.toLowerCase().includes("blocked")
  );
}

function statusCategory(issue: JiraIssue): "todo" | "inprogress" | "inreview" | "done" {
  if (issue.statusCategory === "Done") return "done";
  if (isInReview(issue)) return "inreview";
  if (issue.statusCategory === "In Progress") return "inprogress";
  return "todo";
}

function totalPoints(issues: JiraIssue[]): number {
  return issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

// ── Segmented bar ─────────────────────────────────────────────────────────────

interface Segment {
  value: number;
  color: string;
  label: string;
}

function SegmentedBar({ segments, total }: { segments: Segment[]; total: number }) {
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

// ── Sprint overview card ──────────────────────────────────────────────────────

function SprintOverview({
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
              {sprint?.name ?? "No active sprint"}
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

// ── Blockers & risks panel ────────────────────────────────────────────────────

interface Risk {
  key: string;
  summary: string;
  type: "blocked" | "stale-pr" | "no-progress" | "not-started";
  detail: string;
  url?: string;
}

function buildRisks(
  issues: JiraIssue[],
  openPrs: BitbucketPr[],
  daysLeft: number | null
): Risk[] {
  const risks: Risk[] = [];

  // Blocked tickets
  for (const issue of issues.filter(isBlocked)) {
    risks.push({
      key: issue.key,
      summary: issue.summary,
      type: "blocked",
      detail: "Flagged as blocked",
      url: issue.url,
    });
  }

  // Stale open PRs (no activity for > 2 days)
  for (const pr of openPrs) {
    const age = daysSince(pr.updatedOn);
    if (age >= 2) {
      risks.push({
        key: `PR #${pr.id}`,
        summary: pr.title,
        type: "stale-pr",
        detail: `Open ${age}d with no activity`,
        url: pr.url,
      });
    }
  }

  // In-progress tickets with no recent activity (> 3 days since last update)
  for (const issue of issues) {
    if (
      issue.statusCategory === "In Progress" &&
      !isInReview(issue) &&
      !isBlocked(issue) &&
      daysSince(issue.updated) > 3
    ) {
      risks.push({
        key: issue.key,
        summary: issue.summary,
        type: "no-progress",
        detail: `In Progress, no update for ${daysSince(issue.updated)}d`,
        url: issue.url,
      });
    }
  }

  // Not-yet-started tickets when sprint is almost over
  if (daysLeft !== null && daysLeft <= 3) {
    for (const issue of issues.filter((i) => statusCategory(i) === "todo")) {
      risks.push({
        key: issue.key,
        summary: issue.summary,
        type: "not-started",
        detail: `Not started — ${daysLeft}d left in sprint`,
        url: issue.url,
      });
    }
  }

  return risks;
}

const RISK_META: Record<Risk["type"], { label: string; variant: "destructive" | "warning" | "secondary" }> = {
  blocked: { label: "Blocked", variant: "destructive" },
  "stale-pr": { label: "Stale PR", variant: "warning" },
  "no-progress": { label: "No activity", variant: "warning" },
  "not-started": { label: "At risk", variant: "warning" },
};

function BlockersPanel({
  risks,
}: {
  risks: Risk[];
}) {
  if (risks.length === 0) return null;

  return (
    <Card className="border-amber-500/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Blockers & Risks
          <Badge variant="warning" className="ml-auto">{risks.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {risks.map((risk, i) => {
          const meta = RISK_META[risk.type];
          return (
            <div key={i} className="flex items-start gap-3 text-sm py-1.5 border-b last:border-0">
              <Badge variant={meta.variant} className="shrink-0 mt-0.5 text-[11px]">
                {meta.label}
              </Badge>
              <div className="flex-1 min-w-0">
                <span className="font-mono text-xs text-muted-foreground mr-1.5">{risk.key}</span>
                <span className="truncate">{risk.summary}</span>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">{risk.detail}</span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Team performance card ─────────────────────────────────────────────────────

interface DevStats {
  name: string;
  issues: JiraIssue[];
  assignedPts: number;
  donePts: number;
  doneCount: number;
  totalCount: number;
  openPrs: BitbucketPr[];
  mergedPrs: BitbucketPr[];
}

function buildDevStats(
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
      const done = devIssues.filter((i) => statusCategory(i) === "done");
      return {
        name,
        issues: devIssues,
        assignedPts: totalPoints(devIssues),
        donePts: totalPoints(done),
        doneCount: done.length,
        totalCount: devIssues.length,
        openPrs: openPrs.filter((p) => p.author.displayName === name),
        mergedPrs: mergedPrs.filter((p) => p.author.displayName === name),
      };
    })
    .sort((a, b) => b.donePts - a.donePts);
}

function DevRow({
  dev,
  maxPts,
}: {
  dev: DevStats;
  maxPts: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const pct = maxPts > 0 ? (dev.donePts / maxPts) * 100 : 0;

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
              {dev.donePts}/{dev.assignedPts} pts
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          <span title="Tickets done">{dev.doneCount}/{dev.totalCount} tickets</span>
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
                <span className="font-mono text-muted-foreground shrink-0">{issue.key}</span>
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

function TeamPerformanceCard({
  devStats,
}: {
  devStats: DevStats[];
}) {
  const maxPts = Math.max(...devStats.map((d) => d.assignedPts), 1);

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
          devStats.map((dev) => (
            <DevRow key={dev.name} dev={dev} maxPts={maxPts} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function SprintDashboardScreen({ onBack }: SprintDashboardScreenProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sprint = await getActiveSprint();
      const [issues, openPrs, mergedPrs] = await Promise.all([
        getActiveSprintIssues(),
        getOpenPrs().catch(() => [] as BitbucketPr[]),
        getMergedPrs(sprint?.startDate ?? undefined).catch(() => [] as BitbucketPr[]),
      ]);
      setData({ sprint, issues, openPrs, mergedPrs });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const days = data?.sprint ? daysRemaining(data.sprint.endDate) : null;
  const risks = data ? buildRisks(data.issues, data.openPrs, days) : [];
  const devStats = data
    ? buildDevStats(data.issues, data.openPrs, data.mergedPrs)
    : [];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="font-semibold flex-1">Sprint Dashboard</h1>
          <Button
            variant="ghost"
            size="icon"
            onClick={load}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {loading && !data && (
          <div className="flex items-center justify-center py-24 text-muted-foreground text-sm gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading sprint data…
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Failed to load sprint data</p>
              <p className="text-xs opacity-80">{error}</p>
            </div>
          </div>
        )}

        {data && (
          <div className="space-y-4">
            <SprintOverview
              sprint={data.sprint}
              issues={data.issues}
              openPrs={data.openPrs}
              mergedPrs={data.mergedPrs}
            />
            <BlockersPanel risks={risks} />
            <TeamPerformanceCard devStats={devStats} />
          </div>
        )}
      </main>
    </div>
  );
}
