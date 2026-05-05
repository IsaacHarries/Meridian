import { APP_HEADER_TITLE, WorkflowPanelHeader } from "@/components/appHeaderLayout";
import { Button } from "@/components/ui/button";
import { getIgnoredDevs, setIgnoredDevs } from "@/lib/preferences";
import { type BitbucketPr, type BitbucketTask, getMergedPrs, getOpenPrs, getPrTasks } from "@/lib/tauri/bitbucket";
import { type CredentialStatus, aiProviderComplete } from "@/lib/tauri/credentials";
import { getAllActiveSprintIssues } from "@/lib/tauri/jira";
import { useWorkloadAlertStore } from "@/stores/workloadAlertStore";
import {
    AlertTriangle,
    ArrowLeft,
    RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
    type AllSprintsData,
    type DashboardData,
    daysRemaining,
} from "./sprint-dashboard/_shared";
import { BlockersPanel, buildRisks } from "./sprint-dashboard/blockers-panel";
import { HealthSummaryCard } from "./sprint-dashboard/health-summary-card";
import { SprintChatPanel } from "./sprint-dashboard/sprint-chat-panel";
import { SprintOverview } from "./sprint-dashboard/sprint-overview";
import {
    TeamPerformanceCard,
    buildDevStats,
} from "./sprint-dashboard/team-performance-card";
import { TeamWorkloadSection } from "./sprint-dashboard/team-workload-section";

interface SprintDashboardScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function SprintDashboardScreen({ credStatus, onBack }: SprintDashboardScreenProps) {
  const [allData, setAllData] = useState<AllSprintsData | null>(null);
  const [selectedSprintIndex, setSelectedSprintIndex] = useState<number | "all">(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Workload state (merged from the former Workload Balancer screen)
  const aiAvailable = aiProviderComplete(credStatus);
  const checkWorkload = useWorkloadAlertStore((s) => s.checkWorkload);
  const [ignoredDevs, setIgnoredDevsState] = useState<Set<string>>(new Set());

  useEffect(() => {
    getIgnoredDevs().then(setIgnoredDevsState).catch(() => {});
  }, []);

  const toggleIgnoredDev = useCallback(
    (name: string) => {
      setIgnoredDevsState((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        // Persist, then refresh the alert store so the landing badge reflects
        // the new ignored list without waiting for the next poll.
        setIgnoredDevs(next).then(() => checkWorkload()).catch(() => {});
        return next;
      });
    },
    [checkWorkload],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sprintIssuesPairs = await getAllActiveSprintIssues();
      const firstSprint = sprintIssuesPairs[0]?.[0] ?? null;

      const [openPrs, mergedPrs] = await Promise.all([
        getOpenPrs().catch(() => [] as BitbucketPr[]),
        getMergedPrs(firstSprint?.startDate ?? undefined).catch(() => [] as BitbucketPr[]),
      ]);

      // Lazily fetch tasks only for PRs that are candidates for Ready for QA
      const candidates = openPrs.filter(
        (pr) =>
          !pr.draft &&
          pr.reviewers.filter((r) => r.approved).length >= 2 &&
          !pr.changesRequested
      );
      const taskResults = await Promise.allSettled(
        candidates.map((pr) => getPrTasks(pr.id).then((tasks) => ({ id: pr.id, tasks })))
      );
      const prTasks = new Map<number, BitbucketTask[]>();
      for (const result of taskResults) {
        if (result.status === "fulfilled") {
          prTasks.set(result.value.id, result.value.tasks);
        }
      }

      setAllData({
        sprints: sprintIssuesPairs.map(([sprint, issues]) => ({ sprint, issues })),
        openPrs,
        mergedPrs,
        prTasks,
      });
      setSelectedSprintIndex(0);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSelectSprint = useCallback((idx: number | "all") => {
    setSelectedSprintIndex(idx);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Derive the currently-selected sprint's data. Open/merged PRs are fetched
  // globally — when a single sprint is selected we filter them down to PRs
  // tied to that sprint's issues so PR Health (and everything downstream)
  // reflects the chosen sprint instead of the global PR list.
  let data: DashboardData | null = null;
  if (allData) {
    if (selectedSprintIndex === "all") {
      data = {
        sprint: null,
        issues: allData.sprints.flatMap((s) => s.issues),
        openPrs: allData.openPrs,
        mergedPrs: allData.mergedPrs,
        prTasks: allData.prTasks,
      };
    } else {
      const selected = allData.sprints[selectedSprintIndex];
      if (selected) {
        const issueKeys = new Set(selected.issues.map((i) => i.key));
        const inSprint = (pr: BitbucketPr) =>
          pr.jiraIssueKey != null && issueKeys.has(pr.jiraIssueKey);
        data = {
          sprint: selected.sprint,
          issues: selected.issues,
          openPrs: allData.openPrs.filter(inSprint),
          mergedPrs: allData.mergedPrs.filter(inSprint),
          prTasks: allData.prTasks,
        };
      }
    }
  }

  const days = data?.sprint ? daysRemaining(data.sprint.endDate) : null;
  const risks = data ? buildRisks(data.issues, data.openPrs, days) : [];
  const devStats = data
    ? buildDevStats(data.issues, data.openPrs, data.mergedPrs)
    : [];

  const multiSprint = (allData?.sprints.length ?? 0) > 1;

  // Key for the chat panel — resetting when the selected sprint changes
  // unmounts the panel and clears its chat history, since the prior
  // conversation was grounded in a different sprint's data.
  const sprintChatKey =
    selectedSprintIndex === "all"
      ? "all"
      : String(allData?.sprints[selectedSprintIndex]?.sprint.id ?? "none");

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <WorkflowPanelHeader
        panel="sprint_dashboard"
        leading={
          <>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className={APP_HEADER_TITLE}>Sprint Dashboard</h1>
          </>
        }
        trailing={
          <Button
            variant="ghost"
            size="icon"
            onClick={load}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        }
      />

      <div className="flex flex-1 min-h-0">
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-6 py-8 bg-background/60 rounded-xl">
        {loading && !allData && (
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

        {allData && allData.sprints.length === 0 && (
          <div className="text-center py-24 text-muted-foreground text-sm">
            No active sprints found for the configured board.
          </div>
        )}

        {allData && allData.sprints.length > 0 && (
          <div className="space-y-4">
            {/* Sprint selector tabs — only shown when there are multiple active sprints */}
            {multiSprint && (
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => handleSelectSprint("all")}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors border ${
                    selectedSprintIndex === "all"
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground border-border hover:bg-muted"
                  }`}
                >
                  All Sprints
                </button>
                {allData.sprints.map(({ sprint }, idx) => (
                  <button
                    key={sprint.id}
                    onClick={() => handleSelectSprint(idx)}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors border ${
                      idx === selectedSprintIndex
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:bg-muted"
                    }`}
                  >
                    {sprint.name}
                  </button>
                ))}
              </div>
            )}

            {data && (
              <>
                <HealthSummaryCard
                  issues={data.issues}
                  sprint={data.sprint}
                  openPrs={data.openPrs}
                  prTasks={data.prTasks}
                />
                <SprintOverview
                  sprint={data.sprint}
                  issues={data.issues}
                  openPrs={data.openPrs}
                  mergedPrs={data.mergedPrs}
                />
                <TeamWorkloadSection
                  issues={data.issues}
                  openPrs={data.openPrs}
                  ignoredDevs={ignoredDevs}
                  onToggleIgnoredDev={toggleIgnoredDev}
                />
                <BlockersPanel risks={risks} />
                <TeamPerformanceCard devStats={devStats} />
              </>
            )}
          </div>
        )}
          </div>
        </main>

        <aside className="w-[420px] shrink-0 border-l bg-background/40 flex flex-col min-h-0">
          <SprintChatPanel
            key={sprintChatKey}
            sprintKey={sprintChatKey}
            data={data}
            aiAvailable={aiAvailable}
          />
        </aside>
      </div>
    </div>
  );
}
