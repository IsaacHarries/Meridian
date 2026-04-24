import { useEffect, useState, useCallback, useRef } from "react";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import { MarkdownBlock } from "@/components/MarkdownBlock";
import { TrendAnalysisPanel } from "@/components/TrendAnalysisPanel";
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  TrendingUp,
  Sparkles,
  Copy,
  Check,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  type JiraSprint,
  type JiraIssue,
  type BitbucketPr,
  type SprintReportCache,
  getCompletedSprints,
  getAllActiveSprints,
  getSprintIssuesById,
  getMergedPrs,
  generateSprintRetrospective,
  saveSprintReport,
  loadSprintReport,
} from "@/lib/tauri";

interface RetrospectivesScreenProps {
  onBack: () => void;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function totalPoints(issues: JiraIssue[]): number {
  return issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

// Changelog-based: use completedInSprint when available (set by the backend by
// replaying the issue's status history to the sprint's completeDate). Falls back
// to current status only when no changelog data was fetched (e.g. active sprints).
function isDone(issue: JiraIssue, _sprintEndDate?: string | null): boolean {
  if (issue.completedInSprint !== null && issue.completedInSprint !== undefined) {
    return issue.completedInSprint;
  }
  // Fallback for active sprints or issues fetched without a completeDate.
  return issue.statusCategory === "Done";
}

function sprintPrs(prs: BitbucketPr[], sprint: JiraSprint): BitbucketPr[] {
  const start = sprint.startDate ?? "";
  const end = sprint.endDate ?? "9999";
  return prs.filter((pr) => pr.updatedOn >= start && pr.updatedOn <= end);
}

function avgMergeHours(prs: BitbucketPr[]): number | null {
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

function formatDuration(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function sprintDateRange(sprint: JiraSprint): string {
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (sprint.startDate && sprint.endDate)
    return `${fmt(sprint.startDate)} – ${fmt(sprint.endDate)}`;
  if (sprint.endDate) return `Ended ${fmt(sprint.endDate)}`;
  return "";
}

// ── Per-sprint data cache ─────────────────────────────────────────────────────

interface SprintData {
  issues: JiraIssue[];
  prs: BitbucketPr[];
}

// ── Velocity card ─────────────────────────────────────────────────────────────

function VelocityCard({ sprint, issues }: { sprint: JiraSprint; issues: JiraIssue[] }) {
  const committed = totalPoints(issues);
  const completed = totalPoints(issues.filter((i) => isDone(i, sprint.endDate)));
  const pct = committed > 0 ? Math.round((completed / committed) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Velocity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold tabular-nums">{committed}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Committed pts</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums text-emerald-600">{completed}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Completed pts</p>
          </div>
          <div>
            <p
              className={`text-2xl font-bold tabular-nums ${
                pct >= 80
                  ? "text-emerald-600"
                  : pct >= 60
                  ? "text-amber-500"
                  : "text-red-500"
              }`}
            >
              {pct}%
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Completion rate</p>
          </div>
        </div>

        {committed > 0 && (
          <div className="space-y-1">
            <div className="h-3 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{completed} done</span>
              <span>{committed - completed} not completed</span>
            </div>
          </div>
        )}

        {sprint.goal && (
          <p className="text-xs text-muted-foreground border-t pt-3 italic">
            Goal: {sprint.goal}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Ticket completion card ────────────────────────────────────────────────────

function TicketCompletionCard({ sprint, issues }: { sprint: JiraSprint; issues: JiraIssue[] }) {
  const [showCarryOver, setShowCarryOver] = useState(false);
  const done = issues.filter((i) => isDone(i, sprint.endDate));
  const carryOver = issues.filter((i) => !isDone(i, sprint.endDate));
  const pct = issues.length > 0 ? Math.round((done.length / issues.length) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Ticket Completion</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold tabular-nums">{issues.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Committed</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums text-emerald-600">{done.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Completed</p>
          </div>
          <div>
            <p
              className={`text-2xl font-bold tabular-nums ${
                carryOver.length === 0
                  ? "text-emerald-600"
                  : carryOver.length <= 2
                  ? "text-amber-500"
                  : "text-red-500"
              }`}
            >
              {carryOver.length}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Carry-over</p>
          </div>
        </div>

        {issues.length > 0 && (
          <div className="h-3 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        {carryOver.length > 0 && (
          <div className="border-t pt-3">
            <button
              onClick={() => setShowCarryOver((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
            >
              {showCarryOver ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {carryOver.length} ticket{carryOver.length !== 1 ? "s" : ""} not completed
            </button>
            {showCarryOver && (
              <ul className="mt-2 space-y-1">
                {carryOver.map((issue) => (
                  <li key={issue.key} className="flex items-center gap-2 text-xs py-0.5">
                    <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                    <span className="truncate text-muted-foreground">{issue.summary}</span>
                    <Badge variant="secondary" className="text-[10px] shrink-0 ml-auto">
                      {issue.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── PR activity card ──────────────────────────────────────────────────────────

function PrActivityCard({
  sprint,
  allPrs,
}: {
  sprint: JiraSprint;
  allPrs: BitbucketPr[];
}) {
  const [showPrs, setShowPrs] = useState(false);
  const prs = sprintPrs(allPrs, sprint);
  const avg = avgMergeHours(prs);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <GitPullRequest className="h-4 w-4" />
          Pull Requests
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold tabular-nums">{prs.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Merged this sprint</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums">
              {avg !== null ? formatDuration(avg) : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Avg time to merge</p>
          </div>
        </div>

        {prs.length > 0 && (
          <div className="border-t pt-3">
            <button
              onClick={() => setShowPrs((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
            >
              {showPrs ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              View {prs.length} merged PR{prs.length !== 1 ? "s" : ""}
            </button>
            {showPrs && (
              <ul className="mt-2 space-y-1">
                {prs.map((pr) => (
                  <li key={pr.id} className="flex items-center gap-2 text-xs py-0.5">
                    <span className="font-mono text-muted-foreground shrink-0">#{pr.id}</span>
                    <span className="truncate text-muted-foreground">{pr.title}</span>
                    <span className="shrink-0 text-muted-foreground/60 ml-auto">
                      {formatDuration(
                        Math.round(
                          (new Date(pr.updatedOn).getTime() -
                            new Date(pr.createdOn).getTime()) /
                            3_600_000
                        )
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {prs.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-1">
            No merged PRs recorded for this sprint period.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Team breakdown card ───────────────────────────────────────────────────────

function TeamBreakdownCard({ sprint, issues }: { sprint: JiraSprint; issues: JiraIssue[] }) {
  const devMap = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!devMap.has(name)) devMap.set(name, []);
    devMap.get(name)!.push(issue);
  }

  const devs = Array.from(devMap.entries())
    .map(([name, devIssues]) => ({
      name,
      donePts: totalPoints(devIssues.filter((i) => isDone(i, sprint.endDate))),
      assignedPts: totalPoints(devIssues),
      doneCount: devIssues.filter((i) => isDone(i, sprint.endDate)).length,
      totalCount: devIssues.length,
    }))
    .sort((a, b) => b.donePts - a.donePts);

  const maxPts = Math.max(...devs.map((d) => d.assignedPts), 1);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Team Breakdown</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {devs.map((dev) => (
          <div key={dev.name} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{dev.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {dev.doneCount}/{dev.totalCount} tickets · {dev.donePts}/{dev.assignedPts} pts
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500"
                style={{
                  width: `${maxPts > 0 ? (dev.donePts / maxPts) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        ))}
        {devs.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-2">
            No assigned issues found.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── AI Retrospective Summary ──────────────────────────────────────────────────

function buildSprintContext(
  sprint: JiraSprint,
  issues: JiraIssue[],
  prs: BitbucketPr[]
): string {
  const done = issues.filter((i) => isDone(i, sprint.endDate));
  const committed = issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const completed = done.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const carryOver = issues.filter((i) => !isDone(i, sprint.endDate));
  const sprintPrsLocal = prs.filter((pr) => {
    const start = sprint.startDate ?? "";
    const end = sprint.endDate ?? "9999";
    return pr.updatedOn >= start && pr.updatedOn <= end;
  });
  const merged = sprintPrsLocal.filter((pr) => pr.state === "MERGED");
  const avgMerge =
    merged.length > 0
      ? Math.round(
          merged.reduce(
            (s, pr) =>
              s +
              (new Date(pr.updatedOn).getTime() - new Date(pr.createdOn).getTime()) /
                3_600_000,
            0
          ) / merged.length
        )
      : null;

  const devMap = new Map<string, { done: number; total: number; pts: number }>();
  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!devMap.has(name)) devMap.set(name, { done: 0, total: 0, pts: 0 });
    const entry = devMap.get(name)!;
    entry.total++;
    entry.pts += issue.storyPoints ?? 0;
    if (isDone(issue, sprint.endDate)) entry.done++;
  }

  const lines: string[] = [
    `Sprint: ${sprint.name}`,
    sprint.goal ? `Goal: ${sprint.goal}` : "",
    `Dates: ${sprint.startDate?.slice(0, 10) ?? "?"} → ${sprint.endDate?.slice(0, 10) ?? "?"}`,
    "",
    `Story points: ${completed} completed / ${committed} committed (${committed > 0 ? Math.round((completed / committed) * 100) : 0}%)`,
    `Tickets: ${done.length} done / ${issues.length} total`,
    carryOver.length > 0
      ? `Carry-over (not completed): ${carryOver.map((i) => `${i.key} "${i.summary}"`).join(", ")}`
      : "No carry-over tickets.",
    "",
    `PRs merged this sprint: ${merged.length}`,
    `Total PRs: ${sprintPrsLocal.length}`,
    avgMerge !== null ? `Average time to merge: ${avgMerge}h` : "",
    "",
    "Team breakdown:",
    ...Array.from(devMap.entries()).map(
      ([name, d]) =>
        `  ${name}: ${d.done}/${d.total} tickets done, ${d.pts} story points`
    ),
  ];

  return lines.filter((l) => l !== "").join("\n");
}

function AiSummaryPanel({
  sprint,
  issues,
  prs,
}: {
  sprint: JiraSprint;
  issues: JiraIssue[];
  prs: BitbucketPr[];
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function generate() {
    setState("loading");
    setError("");
    try {
      const context = buildSprintContext(sprint, issues, prs);
      const result = await generateSprintRetrospective(context);
      setSummary(result);
      setState("done");
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-purple-400" />
            AI Retrospective Summary
          </CardTitle>
          <div className="flex items-center gap-2">
            {state === "done" && (
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={handleCopy}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
            <Button
              size="sm"
              variant={state === "done" ? "outline" : "default"}
              className="gap-1.5"
              onClick={generate}
              disabled={state === "loading"}
            >
              {state === "loading" ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…</>
              ) : state === "done" ? (
                <><RefreshCw className="h-3.5 w-3.5" /> Regenerate</>
              ) : (
                <><Sparkles className="h-3.5 w-3.5" /> Generate summary</>
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {state === "idle" && (
          <p className="text-sm text-muted-foreground">
            Generate a retrospective summary — what went well, what could improve, patterns,
            and suggested discussion points for the retro meeting.
          </p>
        )}
        {state === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            The AI is analysing the sprint…
          </div>
        )}
        {state === "error" && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}
        {state === "done" && <MarkdownBlock text={summary} />}
      </CardContent>
    </Card>
  );
}

// ── Velocity trend chart ──────────────────────────────────────────────────────

interface TrendPoint {
  sprint: JiraSprint;
  committed: number;
  completed: number;
  pct: number;
}

function VelocityTrend({ points }: { points: TrendPoint[] }) {
  const maxPts = Math.max(...points.map((p) => p.committed), 1);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Velocity Trend
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-2 h-28">
          {points.map((point) => (
            <div key={point.sprint.id} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {point.pct}%
              </span>
              <div
                className="w-full relative rounded-t-sm overflow-hidden bg-muted"
                style={{ height: `${(point.committed / maxPts) * 80}px`, minHeight: "8px" }}
              >
                <div
                  className={`absolute bottom-0 left-0 right-0 rounded-t-sm ${
                    point.pct >= 80
                      ? "bg-emerald-500"
                      : point.pct >= 60
                      ? "bg-amber-500"
                      : "bg-red-500"
                  }`}
                  style={{ height: `${point.pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          {points.map((point) => (
            <div key={point.sprint.id} className="flex-1 text-center">
              <p
                className="text-[9px] text-muted-foreground truncate"
                title={point.sprint.name}
              >
                {point.sprint.name.replace(/sprint\s*/i, "S")}
              </p>
              <p className="text-[9px] text-muted-foreground tabular-nums">
                {point.completed}/{point.committed}
              </p>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 mt-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-muted inline-block" /> Committed
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-emerald-500 inline-block" /> Completed
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function RetrospectivesScreen({ onBack }: RetrospectivesScreenProps) {
  const [sprints, setSprints] = useState<JiraSprint[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingSprint, setLoadingSprint] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [sprintError, setSprintError] = useState<string | null>(null);

  // Cache: sprintId → { issues, prs }
  const cache = useRef(new Map<number, SprintData>());
  const [cachedData, setCachedData] = useState<SprintData | null>(null);
  const [trendData, setTrendData] = useState<TrendPoint[]>([]);
  const [loadingTrend, setLoadingTrend] = useState(false);

  // Fetch the sprint list — extracted so the refresh button can call it directly.
  // Includes active sprints: the user closes sprints *after* the retro meeting,
  // so the retro often happens while the sprint is still active.
  const loadSprintList = useCallback(() => {
    setLoadingList(true);
    setListError(null);
    Promise.all([
      getAllActiveSprints().catch(() => [] as JiraSprint[]),
      getCompletedSprints(10),
    ])
      .then(([active, completed]) => {
        const list = [...active, ...completed];
        setSprints(list);
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch((e) => setListError(String(e)))
      .finally(() => setLoadingList(false));
  }, []);

  useEffect(() => { loadSprintList(); }, [loadSprintList]);

  // Fetch data for selected sprint
  const loadSprint = useCallback(
    async (sprintId: number, sprint: JiraSprint) => {
      // 1. In-memory cache (fastest — no I/O)
      if (cache.current.has(sprintId)) {
        setCachedData(cache.current.get(sprintId)!);
        setSprintError(null);
        return;
      }
      setLoadingSprint(true);
      setSprintError(null);
      setCachedData(null);
      try {
        // 2. Disk cache — avoids re-fetching on app restart
        const disk = await loadSprintReport(sprintId);
        if (disk) {
          const data: SprintData = { issues: disk.issues, prs: disk.prs };
          cache.current.set(sprintId, data);
          setCachedData(data);
          return;
        }
        // 3. Fetch from JIRA / Bitbucket
        const [issues, prs] = await Promise.all([
          getSprintIssuesById(sprintId, sprint.completeDate),
          getMergedPrs(sprint.startDate ?? undefined).catch(() => [] as BitbucketPr[]),
        ]);
        const data: SprintData = { issues, prs };
        cache.current.set(sprintId, data);
        setCachedData(data);
        // Persist to disk in the background — don't block the UI
        const report: SprintReportCache = { issues, prs, cachedAt: new Date().toISOString() };
        saveSprintReport(sprintId, report).catch(() => {});
      } catch (e) {
        setSprintError(String(e));
      } finally {
        setLoadingSprint(false);
      }
    },
    []
  );

  // Load selected sprint whenever selection changes
  useEffect(() => {
    if (selectedId === null) return;
    const sprint = sprints.find((s) => s.id === selectedId);
    if (!sprint) return;
    loadSprint(selectedId, sprint);
  }, [selectedId, sprints, loadSprint]);

  // Build trend data whenever cache grows. Active sprints are excluded — an
  // in-flight sprint would skew the completion-rate trend downward.
  const buildTrend = useCallback(async () => {
    const completedOnly = sprints.filter((s) => s.state !== "active");
    const toLoad = completedOnly.slice(0, 6).filter((s) => !cache.current.has(s.id));

    if (toLoad.length > 0) {
      setLoadingTrend(true);
      for (const sprint of toLoad) {
        try {
          // Check disk cache before hitting the API
          const disk = await loadSprintReport(sprint.id);
          if (disk) {
            cache.current.set(sprint.id, { issues: disk.issues, prs: disk.prs });
            continue;
          }
          const [issues, prs] = await Promise.all([
            getSprintIssuesById(sprint.id, sprint.completeDate),
            getMergedPrs(sprint.startDate ?? undefined).catch(() => [] as BitbucketPr[]),
          ]);
          cache.current.set(sprint.id, { issues, prs });
          const report: SprintReportCache = { issues, prs, cachedAt: new Date().toISOString() };
          saveSprintReport(sprint.id, report).catch(() => {});
        } catch {
          // Skip sprints that fail to load
        }
      }
      setLoadingTrend(false);
    }

    const points: TrendPoint[] = completedOnly
      .slice(0, 6)
      .reverse()
      .filter((s) => cache.current.has(s.id))
      .map((sprint) => {
        const { issues } = cache.current.get(sprint.id)!;
        const committed = totalPoints(issues);
        const completed = totalPoints(issues.filter((i) => isDone(i, sprint.endDate)));
        const pct = committed > 0 ? Math.round((completed / committed) * 100) : 0;
        return { sprint, committed, completed, pct };
      });

    setTrendData(points);
  }, [sprints]);

  const selectedSprint = sprints.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="min-h-screen">
      <WorkflowPanelHeader
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className={APP_HEADER_TITLE}>Sprint Retrospectives</h1>
          </>
        }
        trailing={
          <Button
            variant="ghost"
            size="icon"
            onClick={() => { cache.current.clear(); loadSprintList(); }}
            disabled={loadingList}
            title="Refresh sprint list"
          >
            <RefreshCw className={`h-4 w-4 ${loadingList ? "animate-spin" : ""}`} />
          </Button>
        }
      />

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6 bg-background/60 rounded-xl">
        {/* Error loading sprint list */}
        {listError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load sprints</p>
              <p className="text-xs opacity-80 mt-0.5">{listError}</p>
            </div>
          </div>
        )}

        {/* Sprint selector */}
        {loadingList ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Loading sprints…
          </div>
        ) : sprints.length === 0 && !listError ? (
          <p className="text-sm text-muted-foreground">No sprints found.</p>
        ) : (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            {sprints.map((sprint) => {
              const isActive = sprint.state === "active";
              return (
                <button
                  key={sprint.id}
                  onClick={() => setSelectedId(sprint.id)}
                  className={`shrink-0 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${
                    selectedId === sprint.id
                      ? "border-foreground bg-foreground/60 text-background"
                      : "border-border bg-card/60 hover:bg-accent/60"
                  }`}
                >
                  <p className="font-medium whitespace-nowrap flex items-center gap-1.5">
                    {sprint.name}
                    {isActive && (
                      <span className="inline-flex items-center gap-1 text-[9px] font-medium uppercase tracking-wide rounded px-1.5 py-0.5 bg-emerald-500/20 text-emerald-500">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Active
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] opacity-60 mt-0.5 whitespace-nowrap">
                    {sprintDateRange(sprint)}
                  </p>
                </button>
              );
            })}
          </div>
        )}

        {/* Sprint data */}
        {sprintError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <p>{sprintError}</p>
          </div>
        )}

        {loadingSprint && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading sprint data…
          </div>
        )}

        {cachedData && selectedSprint && !loadingSprint && (
          <>
            {/* Sprint header */}
            <div>
              <h2 className="text-lg font-semibold">{selectedSprint.name}</h2>
              <p className="text-sm text-muted-foreground">{sprintDateRange(selectedSprint)}</p>
            </div>

            {/* Metrics grid */}
            <div className="grid gap-4 sm:grid-cols-2">
              <VelocityCard sprint={selectedSprint} issues={cachedData.issues} />
              <TicketCompletionCard sprint={selectedSprint} issues={cachedData.issues} />
              <PrActivityCard sprint={selectedSprint} allPrs={cachedData.prs} />
              <TeamBreakdownCard sprint={selectedSprint} issues={cachedData.issues} />
            </div>

            <AiSummaryPanel
              sprint={selectedSprint}
              issues={cachedData.issues}
              prs={cachedData.prs}
            />
          </>
        )}

        {/* Trend analysis — completed sprints only; active sprints would skew
            completion-rate stats since the sprint isn't finished yet. */}
        {sprints.filter((s) => s.state !== "active").length > 1 && (
          <div className="border-t pt-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Trend Analysis
              </h2>
              {trendData.length === 0 && !loadingTrend && (
                <Button variant="outline" size="sm" onClick={buildTrend}>
                  Load trend data
                </Button>
              )}
              {loadingTrend && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Loading…
                </span>
              )}
            </div>
            {trendData.length >= 2 && <VelocityTrend points={trendData} />}
            {trendData.length === 1 && (
              <p className="text-xs text-muted-foreground">
                Load at least 2 sprints to see trend data.
              </p>
            )}

            <TrendAnalysisPanel sprints={sprints.filter((s) => s.state !== "active")} />
          </div>
        )}
      </main>
    </div>
  );
}
