import { MarkdownBlock } from "@/components/MarkdownBlock";
import { TrendCharts } from "@/components/TrendCharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type BitbucketPr, getMergedPrs } from "@/lib/tauri/bitbucket";
import { currentModelKeyFor } from "@/lib/tauri/core";
import { type JiraIssue, type JiraSprint, type SprintReportCache, getSprintIssuesById, loadSprintReport, saveSprintReport } from "@/lib/tauri/jira";
import { type TrendAnalysisRecord, type TrendAnalysisSprintRef, type TrendSprintInput, deleteTrendAnalysis, generateMultiSprintTrends, listTrendAnalyses, loadTrendAnalysis, saveTrendAnalysis } from "@/lib/tauri/trends";
import { subscribeWorkflowStream } from "@/lib/workflowStream";
import { useTokenUsageStore } from "@/stores/tokenUsageStore";
import {
    AlertTriangle,
    Check,
    CheckSquare,
    ChevronDown,
    ChevronRight,
    Copy,
    Loader2,
    Sparkles,
    Square,
    Trash2,
    XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

// ── Input transformation ──────────────────────────────────────────────────────

/**
 * Transform per-sprint raw JIRA/Bitbucket data into the trimmed shape the Rust
 * trend agent expects. Pre-filters PRs to the sprint's date window and
 * pre-computes each PR's cycle hours (trivial subtraction); Rust handles all
 * aggregation (averages, ratios, counts).
 */
function buildTrendInputs(
  entries: { sprint: JiraSprint; issues: JiraIssue[]; prs: BitbucketPr[] }[],
): TrendSprintInput[] {
  return entries.map(({ sprint, issues, prs }) => {
    const windowStart = sprint.startDate ?? "";
    const windowEnd = sprint.endDate ?? "9999";
    const sprintPrs = prs.filter(
      (pr) => pr.updatedOn >= windowStart && pr.updatedOn <= windowEnd,
    );

    return {
      name: sprint.name,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      goal: sprint.goal,
      issues: issues.map((i) => ({
        key: i.key,
        summary: i.summary,
        status: i.status,
        statusCategory: i.statusCategory,
        issueType: i.issueType || "Unknown",
        priority: i.priority,
        storyPoints: i.storyPoints,
        assignee: i.assignee?.displayName ?? null,
        completedInSprint: i.completedInSprint,
        labels: i.labels ?? [],
      })),
      prs: sprintPrs.map((pr) => {
        const created = new Date(pr.createdOn).getTime();
        const updated = new Date(pr.updatedOn).getTime();
        const cycleHours =
          Number.isFinite(created) && Number.isFinite(updated)
            ? (updated - created) / 3_600_000
            : null;
        return {
          id: pr.id,
          title: pr.title,
          state: pr.state,
          author: pr.author?.displayName ?? null,
          createdOn: pr.createdOn,
          updatedOn: pr.updatedOn,
          cycleHours,
          commentCount: pr.commentCount ?? 0,
        };
      }),
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sprintDateRange(sprint: JiraSprint): string {
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (sprint.startDate && sprint.endDate)
    return `${fmt(sprint.startDate)} – ${fmt(sprint.endDate)}`;
  if (sprint.endDate) return `Ended ${fmt(sprint.endDate)}`;
  return "";
}

function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function makeAnalysisId(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `trend_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

// ── Types & props ─────────────────────────────────────────────────────────────

type Phase =
  | { kind: "select" }
  | {
      kind: "loading";
      progress: Record<number, "pending" | "fetching" | "done" | "error">;
      sprintIds: number[];
    }
  | { kind: "analyzing" }
  | { kind: "result"; record: TrendAnalysisRecord; fromHistory: boolean }
  | { kind: "error"; message: string };

interface Props {
  sprints: JiraSprint[];
}

const SOFT_WARN_THRESHOLD = 10;

// ── Main panel ────────────────────────────────────────────────────────────────

export function TrendAnalysisPanel({ sprints }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "select" });
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState<TrendAnalysisRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resultCollapsed, setResultCollapsed] = useState(false);
  const [streamText, setStreamText] = useState("");

  // Auto-expand when a different result is opened (or a new one completes).
  const currentRecordId = phase.kind === "result" ? phase.record.id : null;
  useEffect(() => {
    if (currentRecordId !== null) setResultCollapsed(false);
  }, [currentRecordId]);

  useEffect(() => {
    setHistoryLoading(true);
    listTrendAnalyses()
      .then(async (ids) => {
        const records: TrendAnalysisRecord[] = [];
        for (const id of ids) {
          const rec = await loadTrendAnalysis(id).catch(() => null);
          if (rec) records.push(rec);
        }
        setHistory(records);
      })
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, []);

  const selectedCount = selectedIds.size;
  const tooFew = selectedCount < 2;
  const overWarn = selectedCount > SOFT_WARN_THRESHOLD;

  const toggle = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = () => setSelectedIds(new Set(sprints.map((s) => s.id)));
  const clearAll = () => setSelectedIds(new Set());

  async function runAnalysis() {
    const chosen = sprints.filter((s) => selectedIds.has(s.id));
    if (chosen.length < 2) return;

    const initialProgress: Record<
      number,
      "pending" | "fetching" | "done" | "error"
    > = {};
    for (const s of chosen) initialProgress[s.id] = "pending";
    setPhase({
      kind: "loading",
      progress: initialProgress,
      sprintIds: chosen.map((s) => s.id),
    });

    const loaded: { sprint: JiraSprint; issues: JiraIssue[]; prs: BitbucketPr[] }[] =
      [];

    for (const sprint of chosen) {
      setPhase((p) => {
        if (p.kind !== "loading") return p;
        return { ...p, progress: { ...p.progress, [sprint.id]: "fetching" } };
      });
      try {
        const disk = await loadSprintReport(sprint.id);
        if (disk) {
          loaded.push({ sprint, issues: disk.issues, prs: disk.prs });
        } else {
          const [issues, prs] = await Promise.all([
            getSprintIssuesById(sprint.id, sprint.completeDate),
            getMergedPrs(sprint.startDate ?? undefined).catch(
              () => [] as BitbucketPr[],
            ),
          ]);
          loaded.push({ sprint, issues, prs });
          const report: SprintReportCache = {
            issues,
            prs,
            cachedAt: new Date().toISOString(),
          };
          saveSprintReport(sprint.id, report).catch(() => {});
        }
        setPhase((p) => {
          if (p.kind !== "loading") return p;
          return { ...p, progress: { ...p.progress, [sprint.id]: "done" } };
        });
      } catch {
        setPhase((p) => {
          if (p.kind !== "loading") return p;
          return { ...p, progress: { ...p.progress, [sprint.id]: "error" } };
        });
      }
    }

    if (loaded.length < 2) {
      setPhase({
        kind: "error",
        message:
          "Could not load data for at least two of the selected sprints. Check JIRA/Bitbucket connectivity and try again.",
      });
      return;
    }

    setPhase({ kind: "analyzing" });
    setStreamText("");
    const stream = await subscribeWorkflowStream(
      "multi-sprint-trends-workflow-event",
      (t) => setStreamText(t),
      {
        onUsage: (usage) =>
          useTokenUsageStore
            .getState()
            .setCurrentCallUsage("trends", usage, currentModelKeyFor("trends")),
      },
    );
    try {
      // Oldest → newest so "trend direction" language maps naturally.
      loaded.sort((a, b) => {
        const ad = a.sprint.startDate ?? "";
        const bd = b.sprint.startDate ?? "";
        return ad.localeCompare(bd);
      });
      const inputs = buildTrendInputs(loaded);
      const { markdown, stats } = await generateMultiSprintTrends(inputs);

      const record: TrendAnalysisRecord = {
        id: makeAnalysisId(),
        createdAt: new Date().toISOString(),
        sprints: loaded.map<TrendAnalysisSprintRef>(({ sprint }) => ({
          id: sprint.id,
          name: sprint.name,
          startDate: sprint.startDate,
          endDate: sprint.endDate,
        })),
        markdown,
        stats,
      };

      try {
        await saveTrendAnalysis(record);
      } catch (e) {
        toast.error("Couldn't save analysis to disk", { description: String(e) });
      }
      setHistory((prev) => [record, ...prev]);
      setPhase({ kind: "result", record, fromHistory: false });
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    } finally {
      await stream.dispose();
      setStreamText("");
    }
  }

  function handleCopy(markdown: string) {
    navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleDelete(id: string) {
    await deleteTrendAnalysis(id).catch(() => {});
    setHistory((prev) => prev.filter((r) => r.id !== id));
    setPhase((p) =>
      p.kind === "result" && p.record.id === id ? { kind: "select" } : p,
    );
  }

  function resetToSelect() {
    setPhase({ kind: "select" });
    setSelectedIds(new Set());
  }

  const sortedHistory = useMemo(
    () => [...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [history],
  );

  const busy = phase.kind === "loading" || phase.kind === "analyzing";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-purple-400" />
          AI Trend Analysis
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {phase.kind === "select" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Select any number of sprints (min 2). The AI reads raw issue & PR
              data across them and identifies trends, strengths, gaps, and
              concrete actions for next sprint.
            </p>

            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                {selectedCount} of {sprints.length} selected
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={selectAll}>
                  Select all
                </Button>
                <Button variant="ghost" size="sm" onClick={clearAll}>
                  Clear
                </Button>
              </div>
            </div>

            <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
              {sprints.length === 0 ? (
                <p className="text-sm text-muted-foreground px-4 py-6 text-center">
                  No completed sprints available.
                </p>
              ) : (
                sprints.map((sprint) => {
                  const checked = selectedIds.has(sprint.id);
                  return (
                    <button
                      key={sprint.id}
                      type="button"
                      onClick={() => toggle(sprint.id)}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
                    >
                      {checked ? (
                        <CheckSquare className="h-4 w-4 shrink-0 text-foreground" />
                      ) : (
                        <Square className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{sprint.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {sprintDateRange(sprint)}
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {overWarn && (
              <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <p>
                  Analysing {selectedCount} sprints. This will take longer and use
                  more tokens. Consider narrowing the window unless you&apos;re
                  specifically comparing long-term trends.
                </p>
              </div>
            )}

            <div className="flex justify-end">
              <Button
                onClick={runAnalysis}
                disabled={tooFew}
                className="gap-1.5"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {tooFew
                  ? "Select at least 2 sprints"
                  : `Analyse ${selectedCount} sprint${selectedCount === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        )}

        {phase.kind === "loading" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Fetching sprint data from JIRA & Bitbucket…
            </p>
            <ul className="space-y-1.5 max-h-80 overflow-y-auto">
              {phase.sprintIds.map((id) => {
                const sprint = sprints.find((s) => s.id === id);
                if (!sprint) return null;
                const status = phase.progress[id];
                return (
                  <li
                    key={id}
                    className="flex items-center gap-2 text-sm px-3 py-2 rounded-md border"
                  >
                    <span className="shrink-0">
                      {status === "pending" && (
                        <Square className="h-4 w-4 text-muted-foreground" />
                      )}
                      {status === "fetching" && (
                        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                      )}
                      {status === "done" && (
                        <Check className="h-4 w-4 text-emerald-500" />
                      )}
                      {status === "error" && (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                    </span>
                    <span className="flex-1 truncate">{sprint.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {status === "pending" && "Queued"}
                      {status === "fetching" && "Fetching…"}
                      {status === "done" && "Ready"}
                      {status === "error" && "Failed"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {phase.kind === "analyzing" && !streamText && (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
            <p>The AI is analysing trends across the selected sprints…</p>
            <p className="text-xs opacity-70">This typically takes 15–45 seconds.</p>
          </div>
        )}
        {phase.kind === "analyzing" && streamText && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" />
              <span>Analysing trends…</span>
            </div>
            <MarkdownBlock text={streamText} />
          </div>
        )}

        {phase.kind === "result" && (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2 border-b pb-2">
              <button
                type="button"
                onClick={() => setResultCollapsed((v) => !v)}
                className="flex items-start gap-2 min-w-0 text-left hover:opacity-80 transition-opacity"
                title={resultCollapsed ? "Expand analysis" : "Collapse analysis"}
              >
                {resultCollapsed ? (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                )}
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    Analysed {phase.record.sprints.length} sprints ·{" "}
                    {formatSavedAt(phase.record.createdAt)}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {phase.record.sprints.map((s) => s.name).join(", ")}
                  </p>
                </div>
              </button>
              <div className="flex gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={() => handleCopy(phase.record.markdown)}
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button variant="outline" size="sm" onClick={resetToSelect}>
                  New analysis
                </Button>
              </div>
            </div>
            {!resultCollapsed && (
              <>
                {phase.record.stats && phase.record.stats.length > 0 && (
                  <TrendCharts stats={phase.record.stats} />
                )}
                <MarkdownBlock text={phase.record.markdown} />
              </>
            )}
          </div>
        )}

        {phase.kind === "error" && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <p>{phase.message}</p>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" onClick={resetToSelect}>
                Back
              </Button>
            </div>
          </div>
        )}

        {!busy && (
          <div className="border-t pt-4 space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Saved Analyses
            </h4>
            {historyLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading history…
              </div>
            ) : sortedHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No saved analyses yet. The result of each new analysis is saved
                here automatically.
              </p>
            ) : (
              <ul className="space-y-1 max-h-56 overflow-y-auto">
                {sortedHistory.map((rec) => {
                  const isViewing =
                    phase.kind === "result" && phase.record.id === rec.id;
                  return (
                    <li
                      key={rec.id}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                        isViewing ? "border-foreground/40 bg-accent/40" : ""
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium">
                          {formatSavedAt(rec.createdAt)}
                        </p>
                        <p className="text-muted-foreground truncate">
                          {rec.sprints.length} sprints ·{" "}
                          {rec.sprints.map((s) => s.name).join(", ")}
                        </p>
                      </div>
                      {isViewing ? (
                        <span className="text-[10px] text-muted-foreground px-2">
                          Viewing
                        </span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() =>
                            setPhase({
                              kind: "result",
                              record: rec,
                              fromHistory: true,
                            })
                          }
                        >
                          View
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDelete(rec.id)}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
