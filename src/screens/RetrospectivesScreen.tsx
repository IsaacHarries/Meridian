import { APP_HEADER_TITLE, WorkflowPanelHeader } from "@/components/appHeaderLayout";
import { TrendAnalysisPanel } from "@/components/TrendAnalysisPanel";
import { Button } from "@/components/ui/button";
import { type BitbucketPr, getMergedPrs } from "@/lib/tauri/bitbucket";
import { type JiraIssue, type JiraSprint, type SprintReportCache, getAllActiveSprints, getCompletedSprints, getSprintIssuesById, loadSprintReport, saveSprintReport } from "@/lib/tauri/jira";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    type SprintData,
    type TrendPoint,
    isDone,
    sprintDateRange,
    totalPoints,
} from "./retrospectives/_shared";
import { AiSummaryPanel } from "./retrospectives/ai-summary-panel";
import { PrActivityCard } from "./retrospectives/pr-activity-card";
import { TeamBreakdownCard } from "./retrospectives/team-breakdown-card";
import { TicketCompletionCard } from "./retrospectives/ticket-completion-card";
import { VelocityCard } from "./retrospectives/velocity-card";
import { VelocityTrend } from "./retrospectives/velocity-trend";

interface RetrospectivesScreenProps {
  onBack: () => void;
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
          const data: SprintData = {
            issues: disk.issues,
            prs: disk.prs,
            aiSummary: disk.aiSummary,
            aiSummaryGeneratedAt: disk.aiSummaryGeneratedAt,
          };
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

  // Persist a freshly-generated AI retrospective summary into both the
  // in-memory cache (so navigating away and back shows it instantly) and
  // the disk cache (so it survives app restarts). Merges with the existing
  // sprint data so a re-fetch isn't needed.
  const handleSummaryGenerated = useCallback(
    (sprintId: number, summary: string) => {
      const generatedAt = new Date().toISOString();
      const existing = cache.current.get(sprintId);
      if (!existing) return;
      const updated: SprintData = {
        ...existing,
        aiSummary: summary,
        aiSummaryGeneratedAt: generatedAt,
      };
      cache.current.set(sprintId, updated);
      setCachedData((prev) =>
        prev && selectedId === sprintId ? updated : prev,
      );
      const report: SprintReportCache = {
        issues: updated.issues,
        prs: updated.prs,
        cachedAt: new Date().toISOString(),
        aiSummary: summary,
        aiSummaryGeneratedAt: generatedAt,
      };
      saveSprintReport(sprintId, report).catch(() => {});
    },
    [selectedId],
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
        const completed = totalPoints(issues.filter((i: JiraIssue) => isDone(i, sprint.endDate)));
        const pct = committed > 0 ? Math.round((completed / committed) * 100) : 0;
        return { sprint, committed, completed, pct };
      });

    setTrendData(points);
  }, [sprints]);

  const selectedSprint = sprints.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="min-h-screen">
      <WorkflowPanelHeader
        panel="retrospectives"
        leading={
          <>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={onBack}>
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
              cachedSummary={cachedData.aiSummary}
              cachedSummaryAt={cachedData.aiSummaryGeneratedAt}
              onSummaryGenerated={(summary) =>
                handleSummaryGenerated(selectedSprint.id, summary)
              }
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
