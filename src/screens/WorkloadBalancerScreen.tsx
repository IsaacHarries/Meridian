import { useEffect, useState, useCallback } from "react";
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  Sparkles,
  Loader2,
  Copy,
  Check,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  type JiraSprint,
  type JiraIssue,
  type BitbucketPr,
  type CredentialStatus,
  anthropicComplete,
  getActiveSprint,
  getActiveSprintIssues,
  getOpenPrs,
  generateWorkloadSuggestions,
} from "@/lib/tauri";

interface WorkloadBalancerScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function isDone(issue: JiraIssue): boolean {
  return issue.statusCategory === "Done";
}

function remainingPoints(issues: JiraIssue[]): number {
  return issues.filter((i) => !isDone(i)).reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

function totalPoints(issues: JiraIssue[]): number {
  return issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

function isUnstarted(issue: JiraIssue): boolean {
  return issue.statusCategory === "To Do";
}

// ── Developer workload model ──────────────────────────────────────────────────

type LoadStatus = "overloaded" | "balanced" | "underutilised";

interface DevWorkload {
  name: string;
  issues: JiraIssue[];
  remainingPts: number;
  totalPts: number;
  donePts: number;
  reviewCount: number;      // open PRs where this dev is a reviewer
  loadStatus: LoadStatus;
}

function buildWorkloads(
  issues: JiraIssue[],
  openPrs: BitbucketPr[]
): DevWorkload[] {
  const map = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(issue);
  }

  const raw = Array.from(map.entries()).map(([name, devIssues]) => ({
    name,
    issues: devIssues,
    remainingPts: remainingPoints(devIssues),
    totalPts: totalPoints(devIssues),
    donePts: totalPoints(devIssues.filter(isDone)),
    reviewCount: openPrs.filter((pr) =>
      pr.reviewers.some((r) => r.user.displayName === name)
    ).length,
    loadStatus: "balanced" as LoadStatus,
  }));

  // Classify load relative to team average remaining pts
  const withWork = raw.filter((d) => d.totalPts > 0);
  if (withWork.length > 1) {
    const avg =
      withWork.reduce((s, d) => s + d.remainingPts, 0) / withWork.length;
    for (const d of raw) {
      if (d.remainingPts > avg * 1.4) d.loadStatus = "overloaded";
      else if (d.remainingPts < avg * 0.6 && avg > 0) d.loadStatus = "underutilised";
    }
  }

  return raw.sort((a, b) => b.remainingPts - a.remainingPts);
}

// ── Format for Claude ─────────────────────────────────────────────────────────

function formatForClaude(
  sprint: JiraSprint | null,
  workloads: DevWorkload[],
  unstartedTickets: JiraIssue[]
): string {
  const lines: string[] = [
    `Sprint: ${sprint?.name ?? "Unknown"}`,
    `Days remaining: ${sprint?.endDate ? Math.ceil((new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000) : "unknown"}`,
    "",
    "Developer workloads:",
  ];

  for (const d of workloads) {
    lines.push(
      `  ${d.name}: ${d.remainingPts}pt remaining (${d.issues.filter((i) => !isDone(i)).length} tickets), ` +
        `${d.reviewCount} PRs to review, status: ${d.loadStatus}`
    );
    for (const issue of d.issues.filter((i) => !isDone(i))) {
      lines.push(
        `    - ${issue.key} "${issue.summary}" (${issue.storyPoints ?? 0}pt, ${issue.status})`
      );
    }
  }

  lines.push("", "Unstarted tickets (candidates for reassignment):");
  for (const t of unstartedTickets) {
    const assignee = t.assignee?.displayName ?? "Unassigned";
    lines.push(
      `  ${t.key} "${t.summary}" (${t.storyPoints ?? 0}pt) — currently: ${assignee}`
    );
  }

  const teamAvg =
    workloads.length > 0
      ? Math.round(
          workloads.reduce((s, d) => s + d.remainingPts, 0) / workloads.length
        )
      : 0;
  lines.push("", `Team average remaining: ${teamAvg}pt`);

  return lines.join("\n");
}

// ── Capacity bar ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<LoadStatus, { bar: string; badge: string; icon: React.ElementType }> = {
  overloaded: {
    bar: "bg-red-500",
    badge: "destructive",
    icon: TrendingUp,
  },
  balanced: {
    bar: "bg-emerald-500",
    badge: "success",
    icon: Minus,
  },
  underutilised: {
    bar: "bg-blue-400",
    badge: "secondary",
    icon: TrendingDown,
  },
};

function DevCard({
  dev,
  maxPts,
}: {
  dev: DevWorkload;
  maxPts: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const colors = STATUS_COLORS[dev.loadStatus];
  const Icon = colors.icon;
  const remaining = dev.issues.filter((i) => !isDone(i));
  const done = dev.issues.filter(isDone);
  const remainingPct = maxPts > 0 ? (dev.remainingPts / maxPts) * 100 : 0;

  return (
    <Card>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-3">
          {/* Name + badge */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-medium text-sm">{dev.name}</span>
              <Badge variant={colors.badge as "destructive" | "success" | "secondary"} className="text-[10px] gap-0.5">
                <Icon className="h-2.5 w-2.5" />
                {dev.loadStatus === "overloaded"
                  ? "Overloaded"
                  : dev.loadStatus === "underutilised"
                  ? "Under-utilised"
                  : "Balanced"}
              </Badge>
            </div>
            {/* Capacity bar: background = total committed, fill = remaining */}
            <div className="h-2.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${colors.bar}`}
                style={{ width: `${remainingPct}%` }}
              />
            </div>
          </div>

          {/* Stats */}
          <div className="text-xs text-muted-foreground text-right shrink-0 space-y-0.5">
            <p>
              <span className="font-medium text-foreground tabular-nums">
                {dev.remainingPts}pt
              </span>{" "}
              remaining
            </p>
            <p>{remaining.length} tickets left</p>
            {dev.reviewCount > 0 && (
              <p className="flex items-center gap-0.5 justify-end">
                <GitPullRequest className="h-3 w-3" />
                {dev.reviewCount} to review
              </p>
            )}
          </div>

          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
        </div>
      </button>

      {expanded && (
        <CardContent className="pt-1 pb-4 space-y-3">
          {remaining.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Remaining work
              </p>
              <ul className="space-y-1">
                {remaining.map((issue) => (
                  <li key={issue.key} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground shrink-0">
                      {issue.key}
                    </span>
                    <span className="truncate">{issue.summary}</span>
                    {issue.storyPoints != null && (
                      <span className="text-muted-foreground/60 shrink-0">
                        {issue.storyPoints}pt
                      </span>
                    )}
                    <Badge variant="secondary" className="text-[10px] shrink-0 ml-auto">
                      {issue.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {done.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Completed ({done.length})
              </p>
              <ul className="space-y-1">
                {done.map((issue) => (
                  <li
                    key={issue.key}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <span className="font-mono shrink-0">{issue.key}</span>
                    <span className="truncate line-through">{issue.summary}</span>
                    {issue.storyPoints != null && (
                      <span className="shrink-0">{issue.storyPoints}pt</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ── AI suggestions panel ──────────────────────────────────────────────────────

function SuggestionsPanel({
  claudeAvailable,
  suggestions,
  loading,
  error,
  onAnalyse,
}: {
  claudeAvailable: boolean;
  suggestions: string | null;
  loading: boolean;
  error: string | null;
  onAnalyse: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (suggestions) {
      navigator.clipboard.writeText(suggestions);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-purple-400" />
          AI Rebalancing Suggestions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!claudeAvailable && (
          <p className="text-xs text-muted-foreground">
            Configure your Anthropic API key in Settings to get AI rebalancing suggestions.
          </p>
        )}

        {claudeAvailable && !suggestions && !loading && !error && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Claude will analyse the workload distribution and suggest specific ticket
              reassignments.
            </p>
            <Button variant="outline" size="sm" onClick={onAnalyse} className="gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-purple-400" />
              Analyse workload
            </Button>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Analysing workload…
          </div>
        )}

        {error && (
          <div className="text-xs text-destructive flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {suggestions && (
          <div className="space-y-3">
            <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed bg-muted/40 rounded-md p-3 max-h-80 overflow-y-auto">
              {suggestions}
            </pre>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5">
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" size="sm" onClick={onAnalyse} className="gap-1.5">
                <RefreshCw className="h-3 w-3" />
                Re-analyse
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Summary strip ─────────────────────────────────────────────────────────────

function SummaryStrip({
  sprint,
  workloads,
}: {
  sprint: JiraSprint | null;
  workloads: DevWorkload[];
}) {
  const daysLeft = sprint?.endDate
    ? Math.ceil((new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000)
    : null;

  const totalRemaining = workloads.reduce((s, d) => s + d.remainingPts, 0);
  const avgRemaining =
    workloads.length > 0 ? Math.round(totalRemaining / workloads.length) : 0;
  const overloaded = workloads.filter((d) => d.loadStatus === "overloaded").length;
  const underutilised = workloads.filter((d) => d.loadStatus === "underutilised").length;

  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {sprint && (
        <div className="flex items-center gap-1.5 rounded-lg border bg-card px-3 py-2">
          <span className="text-muted-foreground">Sprint</span>
          <span className="font-medium">{sprint.name}</span>
          {daysLeft !== null && (
            <Badge
              variant={daysLeft <= 2 ? "destructive" : daysLeft <= 4 ? "warning" : "secondary"}
              className="ml-1"
            >
              {daysLeft}d left
            </Badge>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 rounded-lg border bg-card px-3 py-2">
        <span className="text-muted-foreground">Team avg</span>
        <span className="font-medium tabular-nums">{avgRemaining}pt remaining</span>
      </div>
      {overloaded > 0 && (
        <div className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-600">
          <TrendingUp className="h-3.5 w-3.5" />
          <span className="font-medium">{overloaded} overloaded</span>
        </div>
      )}
      {underutilised > 0 && (
        <div className="flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-blue-600">
          <TrendingDown className="h-3.5 w-3.5" />
          <span className="font-medium">{underutilised} under-utilised</span>
        </div>
      )}
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function WorkloadBalancerScreen({ credStatus, onBack }: WorkloadBalancerScreenProps) {
  const [sprint, setSprint] = useState<JiraSprint | null>(null);
  const [workloads, setWorkloads] = useState<DevWorkload[]>([]);
  const [unstartedTickets, setUnstartedTickets] = useState<JiraIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<string | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);

  const claudeAvailable = anthropicComplete(credStatus);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuggestions(null);
    setSuggestionsError(null);
    try {
      const [sprintData, issues, openPrs] = await Promise.all([
        getActiveSprint(),
        getActiveSprintIssues(),
        getOpenPrs().catch(() => [] as BitbucketPr[]),
      ]);
      const built = buildWorkloads(issues, openPrs);
      setSprint(sprintData);
      setWorkloads(built);
      setUnstartedTickets(issues.filter(isUnstarted));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const analyse = useCallback(async () => {
    setSuggestionsLoading(true);
    setSuggestionsError(null);
    try {
      const text = formatForClaude(sprint, workloads, unstartedTickets);
      const result = await generateWorkloadSuggestions(text);
      setSuggestions(result);
    } catch (e) {
      setSuggestionsError(String(e));
    } finally {
      setSuggestionsLoading(false);
    }
  }, [sprint, workloads, unstartedTickets]);

  useEffect(() => { load(); }, [load]);

  const maxPts = Math.max(...workloads.map((d) => d.remainingPts), 1);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="font-semibold flex-1">Team Workload Balancer</h1>
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

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-4">
        {loading && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-24">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading workload data…
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load workload data</p>
              <p className="text-xs opacity-80 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {!loading && !error && (
          <>
            <SummaryStrip sprint={sprint} workloads={workloads} />

            <div className="grid gap-4 lg:grid-cols-[1fr_360px] items-start">
              {/* Capacity bars */}
              <div className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Capacity
                </h2>
                {workloads.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">
                    No assigned issues found in the active sprint.
                  </p>
                ) : (
                  workloads.map((dev) => (
                    <DevCard key={dev.name} dev={dev} maxPts={maxPts} />
                  ))
                )}
              </div>

              {/* AI suggestions */}
              <div className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Suggestions
                </h2>
                <SuggestionsPanel
                  claudeAvailable={claudeAvailable}
                  suggestions={suggestions}
                  loading={suggestionsLoading}
                  error={suggestionsError}
                  onAnalyse={analyse}
                />

                {/* Unstarted tickets quick-reference */}
                {unstartedTickets.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">
                        Unstarted tickets ({unstartedTickets.length})
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      {unstartedTickets.map((t) => (
                        <div key={t.key} className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-muted-foreground shrink-0">
                            {t.key}
                          </span>
                          <span className="truncate">{t.summary}</span>
                          {t.storyPoints != null && (
                            <span className="text-muted-foreground/60 shrink-0">
                              {t.storyPoints}pt
                            </span>
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
