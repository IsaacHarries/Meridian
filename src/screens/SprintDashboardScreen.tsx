import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  GitPullRequest,
  User,
  CheckCircle2,
  ClipboardCheck,
  XCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import {
  createGlobalCommands,
  type ChatTurn,
  type SlashCommand,
} from "@/lib/slashCommands";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  type JiraSprint,
  type JiraIssue,
  type BitbucketPr,
  type BitbucketTask,
  type CredentialStatus,
  aiProviderComplete,
  chatSprintDashboard,
  generateWorkloadSuggestions,
  getAllActiveSprintIssues,
  getOpenPrs,
  getMergedPrs,
  getPrTasks,
  openUrl,
} from "@/lib/tauri";
import { classifyWorkloads } from "@/lib/workloadClassifier";
import { getIgnoredDevs, setIgnoredDevs } from "@/lib/preferences";
import { useWorkloadAlertStore } from "@/stores/workloadAlertStore";

interface SprintDashboardScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Data types ────────────────────────────────────────────────────────────────

interface DashboardData {
  sprint: JiraSprint | null;
  issues: JiraIssue[];
  openPrs: BitbucketPr[];
  mergedPrs: BitbucketPr[];
  /** tasks keyed by PR id — only fetched for 2+-approval candidates */
  prTasks: Map<number, BitbucketTask[]>;
}

interface AllSprintsData {
  sprints: Array<{ sprint: JiraSprint; issues: JiraIssue[] }>;
  openPrs: BitbucketPr[];
  mergedPrs: BitbucketPr[];
  prTasks: Map<number, BitbucketTask[]>;
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

// ── Business-day helpers (mirrors sprint-dashboard utils.py) ─────────────────
// Counts Mon–Fri only, with partial days, so weekends don't inflate PR age.

function businessDaysAgo(isoStr: string): number {
  const dt  = new Date(isoStr).getTime();
  const now = Date.now();
  if (dt >= now) return 0;

  let total = 0;
  let cursor = dt;
  while (cursor < now) {
    const d = new Date(cursor);
    const dow = d.getUTCDay(); // 0=Sun … 6=Sat
    if (dow >= 1 && dow <= 5) {
      // midnight ending this business day
      const dayEnd = Date.UTC(
        d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1
      );
      const chunkEnd = Math.min(now, dayEnd);
      total += (chunkEnd - cursor) / 86_400_000;
    }
    // advance cursor to midnight of next day
    const d2 = new Date(cursor);
    cursor = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate() + 1);
  }
  return total;
}

/** Sprint progress 0→1: fraction of **business** days elapsed (matches get_sprint_progress). */
function sprintProgress(sprint: { startDate?: string | null; endDate?: string | null } | null): number | null {
  if (!sprint?.startDate || !sprint?.endDate) return null;
  const startMs = new Date(sprint.startDate).getTime();
  const endMs   = new Date(sprint.endDate).getTime();
  if (endMs <= startMs) return null;

  function countBdays(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 0;
    let total = 0;
    let cursor = fromMs;
    while (cursor < toMs) {
      const d = new Date(cursor);
      const dow = d.getUTCDay();
      if (dow >= 1 && dow <= 5) {
        const dayEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
        const chunkEnd = Math.min(toMs, dayEnd);
        total += (chunkEnd - cursor) / 86_400_000;
      }
      const d2 = new Date(cursor);
      cursor = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate() + 1);
    }
    return total;
  }

  const totalBdays   = countBdays(startMs, endMs);
  const elapsedBdays = countBdays(startMs, Math.min(Date.now(), endMs));
  if (totalBdays <= 0) return 1;
  return Math.min(1, Math.max(0, elapsedBdays / totalBdays));
}

// ── PR health classification (mirrors sprint-dashboard classifier.py) ─────────
// Thresholds match config.py: stale=7bd, warning=5bd, no-commit=3bd
const STALE_PR_DAYS   = 7;
const WARNING_PR_DAYS = 5;
const NO_COMMIT_DAYS  = 3;

type PrHealthStatus = "good" | "warn" | "urgent";

function classifyPr(pr: BitbucketPr, progress: number | null): PrHealthStatus {
  const ageBd  = businessDaysAgo(pr.createdOn);
  // updatedOn is the best proxy we have for last-commit age without fetching commits
  const updBd  = businessDaysAgo(pr.updatedOn);

  if (ageBd >= STALE_PR_DAYS) return "urgent";
  // 5+ bd old AND no activity in last 24 calendar hours → urgent
  if (ageBd >= WARNING_PR_DAYS && updBd >= 1) return "urgent";
  if (ageBd >= WARNING_PR_DAYS || updBd >= NO_COMMIT_DAYS) return "warn";

  // Sprint-pressure escalation (≥75% elapsed → warn; ≥90% → urgent)
  if (progress !== null) {
    if (progress >= 0.90) return "urgent";
    if (progress >= 0.75) return "warn";
  }

  return "good";
}

interface PrHealthCounts {
  good: number;
  warn: number;
  urgent: number;
  total: number;
  /** 0–1, same formula as sprint-dashboard quality_score */
  qualityScore: number;
}

function computePrHealth(openPrs: BitbucketPr[], progress: number | null): PrHealthCounts {
  let good = 0, warn = 0, urgent = 0;
  for (const pr of openPrs) {
    const s = classifyPr(pr, progress);
    if (s === "good") good++;
    else if (s === "warn") warn++;
    else urgent++;
  }
  const scorable = good + warn + urgent;
  const qualityScore = scorable > 0 ? (good + warn * 0.5) / scorable : 1;
  return { good, warn, urgent, total: openPrs.length, qualityScore };
}

interface SprintHealthResult {
  /** 0–100 */
  healthPct: number;
  /** 0–100 */
  pacePct: number;
  /** 0–100 */
  prHealthPct: number;
}

function computeSprintHealth(
  issues: JiraIssue[],
  sprint: { startDate?: string | null; endDate?: string | null } | null,
  prHealth: PrHealthCounts,
): SprintHealthResult {
  const progress = sprintProgress(sprint);
  const totalTickets = issues.length;
  const doneTickets  = issues.filter((i) => statusCategory(i) === "done").length;

  let pacePct = 100;
  if (progress !== null && totalTickets > 0) {
    const expectedCompletion = progress;
    const actualCompletion   = doneTickets / totalTickets;
    let paceRatio: number;
    if (expectedCompletion <= 0 || actualCompletion >= expectedCompletion) {
      paceRatio = 1.0;
    } else {
      const gracefulFloor = Math.max(0, 1 - expectedCompletion);
      const actualRatio   = actualCompletion / expectedCompletion;
      paceRatio = Math.max(gracefulFloor, actualRatio);
    }
    pacePct = Math.round(paceRatio * 100);
  }

  const qualityBoost = 0.75 + 0.25 * prHealth.qualityScore;
  const healthPct    = Math.round((pacePct / 100) * qualityBoost * 100);
  const prHealthPct  = Math.round(prHealth.qualityScore * 100);

  return { healthPct, pacePct, prHealthPct };
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

// ── PR attention / QA lists (mirrors reporters.py) ───────────────────────────

// Exempt task prefixes — matches EXEMPT_TASK_PREFIXES in config.py
const EXEMPT_TASK_PREFIXES = ["qa review", "design review"];

interface PrListItem {
  pr: BitbucketPr;
  status: PrHealthStatus;
  ageBd: number;
  updBd: number;
  approvalCount: number;
  /** True if any unresolved, non-exempt task exists (mirrors has_blocking_incomplete_tasks) */
  hasBlockingTasks: boolean;
}

function hasBlockingIncompleteTasks(tasks: BitbucketTask[]): boolean {
  return tasks.some(
    (t) =>
      !t.resolved &&
      !EXEMPT_TASK_PREFIXES.some((pfx) => t.content.toLowerCase().startsWith(pfx))
  );
}

function buildPrListItems(
  openPrs: BitbucketPr[],
  progress: number | null,
  prTasks: Map<number, BitbucketTask[]>,
): PrListItem[] {
  return openPrs.map((pr) => {
    // `has` — not `length` — distinguishes "not fetched" (unknown → assume
    // blocking) from "fetched but zero tasks" (nothing blocking, ready for QA).
    const fetched = prTasks.has(pr.id);
    const tasks = prTasks.get(pr.id) ?? [];
    return {
      pr,
      status: classifyPr(pr, progress),
      ageBd: businessDaysAgo(pr.createdOn),
      updBd: businessDaysAgo(pr.updatedOn),
      approvalCount: pr.reviewers.filter((r) => r.approved).length,
      hasBlockingTasks: fetched ? hasBlockingIncompleteTasks(tasks) : true,
    };
  });
}

/** PRs that need attention — warn or urgent, non-draft, sorted urgent-first */
function buildAttentionPrs(items: PrListItem[]): PrListItem[] {
  return items
    .filter((i) => !i.pr.draft && (i.status === "urgent" || i.status === "warn"))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "urgent" ? -1 : 1;
      return b.ageBd - a.ageBd;
    });
}

/**
 * PRs ready for QA — mirrors sprint_status.py exactly:
 *   num_approvals >= 2
 *   not changes_requested
 *   has_blocking_tasks is not True  (unresolved tasks that aren't "qa review"/"design review")
 *   not draft
 * lint_passing is omitted — we don't fetch build statuses from the list API.
 */
function buildReadyForQaPrs(items: PrListItem[]): PrListItem[] {
  return items.filter(
    (i) => !i.pr.draft && i.approvalCount >= 2 && !i.pr.changesRequested && !i.hasBlockingTasks
  );
}

// ── Health summary card ───────────────────────────────────────────────────────

function GradientBar({ pct, warningAt = 60, dangerAt = 40 }: { pct: number; warningAt?: number; dangerAt?: number }) {
  const color =
    pct >= warningAt ? "bg-emerald-500"
    : pct >= dangerAt ? "bg-amber-500"
    : "bg-red-500";

  return (
    <div className="h-3 rounded-full bg-muted overflow-hidden w-full">
      <div
        className={`h-full rounded-full transition-all ${color}`}
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </div>
  );
}

function HealthSummaryCard({
  issues,
  sprint,
  openPrs,
  prTasks,
}: {
  issues: JiraIssue[];
  sprint: { startDate?: string | null; endDate?: string | null } | null;
  openPrs: BitbucketPr[];
  prTasks: Map<number, BitbucketTask[]>;
}) {
  const progress    = sprintProgress(sprint);
  const prHealth    = computePrHealth(openPrs, progress);
  const health      = computeSprintHealth(issues, sprint, prHealth);

  const totalTickets = issues.length;
  const doneTickets  = issues.filter((i) => statusCategory(i) === "done").length;

  const healthColor =
    health.healthPct >= 75 ? "text-emerald-600 dark:text-emerald-400"
    : health.healthPct >= 50 ? "text-amber-600 dark:text-amber-400"
    : "text-red-600 dark:text-red-400";

  const prColor =
    prHealth.qualityScore >= 0.75 ? "text-emerald-600 dark:text-emerald-400"
    : prHealth.qualityScore >= 0.5 ? "text-amber-600 dark:text-amber-400"
    : "text-red-600 dark:text-red-400";

  const prItems      = buildPrListItems(openPrs, progress, prTasks);
  const attentionPrs = buildAttentionPrs(prItems);
  const readyForQa   = buildReadyForQaPrs(prItems);
  const needsVerification = issues.filter(
    (i) => i.status.trim().toLowerCase() === "needs verification"
  );

  return (
    <Card>
      <CardContent className="pt-4 pb-4 space-y-4">
        {/* ── Health bars ── */}
        <div className="grid grid-cols-2 gap-6">
          {/* Sprint Health */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Sprint Health</span>
              <span className={`text-lg font-bold tabular-nums ${healthColor}`}>
                {health.healthPct}%
              </span>
            </div>
            <GradientBar pct={health.healthPct} warningAt={75} dangerAt={50} />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Pace: <strong className="text-foreground">{health.pacePct}%</strong>
                {progress !== null && (
                  <span className="ml-1 opacity-70">({Math.round(progress * 100)}% elapsed)</span>
                )}
              </span>
              <span>{doneTickets}/{totalTickets} tickets done</span>
            </div>
          </div>

          {/* PR Health */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">PR Health</span>
              <span className={`text-lg font-bold tabular-nums ${prColor}`}>
                {health.prHealthPct}%
              </span>
            </div>
            {prHealth.total === 0 ? (
              <div className="h-3 rounded-full bg-muted w-full" />
            ) : (
              <div className="flex h-3 rounded-full overflow-hidden w-full gap-px">
                {prHealth.good > 0 && (
                  <div className="h-full bg-emerald-500" style={{ width: `${(prHealth.good / prHealth.total) * 100}%` }} title={`Good: ${prHealth.good}`} />
                )}
                {prHealth.warn > 0 && (
                  <div className="h-full bg-amber-500" style={{ width: `${(prHealth.warn / prHealth.total) * 100}%` }} title={`Warning: ${prHealth.warn}`} />
                )}
                {prHealth.urgent > 0 && (
                  <div className="h-full bg-red-500" style={{ width: `${(prHealth.urgent / prHealth.total) * 100}%` }} title={`Urgent: ${prHealth.urgent}`} />
                )}
              </div>
            )}
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
                Good <strong className="text-foreground">{prHealth.good}</strong>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-amber-500 inline-block" />
                Warn <strong className="text-foreground">{prHealth.warn}</strong>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-red-500 inline-block" />
                Urgent <strong className="text-foreground">{prHealth.urgent}</strong>
              </span>
              <span
                className="ml-auto opacity-70"
                title="All open PRs in the repo — sprint_status.py only counts PRs linked to Needs Review tickets"
              >
                {prHealth.total} open PRs
              </span>
            </div>
          </div>
        </div>

        {/* ── Needs Attention ── */}
        {attentionPrs.length > 0 && (
          <div className="border-t pt-3 space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-red-500" />
              PRs Needs Attention
              <span className="ml-1 rounded-full bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 px-1.5 py-0.5 text-[10px] font-medium leading-none">
                {attentionPrs.length}
              </span>
            </p>
            {attentionPrs.map(({ pr, status, ageBd, updBd, approvalCount }) => (
              <div key={pr.id} className="py-2 border-b last:border-0 space-y-1">
                {/* Row 1: status dot + clickable title */}
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${status === "urgent" ? "bg-red-500" : "bg-amber-500"}`} />
                  <button
                    onClick={() => pr.url && openUrl(pr.url)}
                    className="flex-1 min-w-0 truncate text-xs font-medium text-left hover:underline hover:text-primary transition-colors"
                    title="Open in Bitbucket"
                  >
                    {pr.title}
                  </button>
                </div>
                {/* Row 2: labelled metadata */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 text-xs text-muted-foreground">
                  <span>PR <span className="font-mono text-foreground">#{pr.id}</span></span>
                  <span>Open <strong className="text-foreground">{Math.round(ageBd)} business days</strong></span>
                  <span>Last activity <strong className="text-foreground">{Math.round(updBd) === 0 ? "today" : `${Math.round(updBd)}bd ago`}</strong></span>
                  <span>Approvals <strong className="text-foreground">{approvalCount}</strong></span>
                  {pr.jiraIssueKey && (
                    <JiraTicketLink ticketKey={pr.jiraIssueKey} url={null} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Ready for QA ── */}
        {readyForQa.length > 0 && (
          <div className={`${attentionPrs.length === 0 ? "border-t pt-3" : "pt-1"} space-y-1.5`}>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              Ready for QA
              <span className="ml-1 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 px-1.5 py-0.5 text-[10px] font-medium leading-none">
                {readyForQa.length}
              </span>
            </p>
            {readyForQa.map(({ pr, approvalCount }) => (
              <div key={pr.id} className="flex items-center gap-2 text-xs py-1 border-b last:border-0">
                <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                <span className="font-mono text-muted-foreground shrink-0">#{pr.id}</span>
                <button
                  onClick={() => pr.url && openUrl(pr.url)}
                  className="flex-1 min-w-0 truncate font-medium text-left hover:underline hover:text-primary transition-colors"
                  title="Open in Bitbucket"
                >
                  {pr.title}
                </button>
                {pr.jiraIssueKey && (
                  <JiraTicketLink ticketKey={pr.jiraIssueKey} url={null} className="shrink-0" />
                )}
                <span className="shrink-0 text-emerald-600 dark:text-emerald-400 font-medium">
                  ✅{approvalCount} approvals
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── Needs Verification ── */}
        {needsVerification.length > 0 && (
          <div
            className={`${
              attentionPrs.length === 0 && readyForQa.length === 0
                ? "border-t pt-3"
                : "pt-1"
            } space-y-1.5`}
          >
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <ClipboardCheck className="h-3.5 w-3.5 text-sky-500" />
              Needs Verification
              <span className="ml-1 rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300 px-1.5 py-0.5 text-[10px] font-medium leading-none">
                {needsVerification.length}
              </span>
            </p>
            {needsVerification.map((issue) => (
              <div key={issue.key} className="py-2 border-b last:border-0 space-y-1">
                {/* Row 1: status dot + clickable title */}
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full shrink-0 bg-sky-500" />
                  <button
                    onClick={() => issue.url && openUrl(issue.url)}
                    className="flex-1 min-w-0 truncate text-xs font-medium text-left hover:underline hover:text-primary transition-colors"
                    title={issue.url ? "Open in JIRA" : undefined}
                    disabled={!issue.url}
                  >
                    {issue.summary}
                  </button>
                </div>
                {/* Row 2: JiraTicketLink + badge + structured metadata */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 text-xs text-muted-foreground">
                  <JiraTicketLink ticketKey={issue.key} url={issue.url ?? undefined} />
                  <Badge variant="secondary" className="text-[10px]">Needs Verification</Badge>
                  <span>
                    Assignee <strong className="text-foreground">{issue.assignee?.displayName ?? "Unassigned"}</strong>
                  </span>
                  <span>
                    Last update <strong className="text-foreground">{daysSince(issue.updated)}d ago</strong>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* All clear */}
        {attentionPrs.length === 0 &&
          readyForQa.length === 0 &&
          needsVerification.length === 0 &&
          prHealth.total > 0 && (
            <div className="border-t pt-3 flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              All PRs are in good standing
            </div>
          )}
      </CardContent>
    </Card>
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

// ── Blockers & risks panel ────────────────────────────────────────────────────

interface RiskMeta {
  label: string;
  value: string;
}

interface Risk {
  key: string;
  summary: string;
  type: "blocked" | "stale-pr" | "no-progress" | "not-started";
  metadata: RiskMeta[];
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
      metadata: [
        { label: "Status", value: issue.status },
        { label: "Assignee", value: issue.assignee?.displayName ?? "Unassigned" },
        { label: "Last update", value: `${daysSince(issue.updated)}d ago` },
      ],
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
        metadata: [
          { label: "PR", value: `#${pr.id}` },
          { label: "Open", value: `${age}d` },
          { label: "Last activity", value: `${age}d ago` },
          { label: "Author", value: pr.author.displayName },
        ],
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
        metadata: [
          { label: "Status", value: issue.status },
          { label: "Assignee", value: issue.assignee?.displayName ?? "Unassigned" },
          { label: "No update for", value: `${daysSince(issue.updated)}d` },
        ],
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
        metadata: [
          { label: "Status", value: "Not started" },
          { label: "Assignee", value: issue.assignee?.displayName ?? "Unassigned" },
          { label: "Sprint ends in", value: `${daysLeft}d` },
        ],
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
          Jira Ticket Blockers & Risks
          <Badge variant="warning" className="ml-auto">{risks.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        {risks.map((risk, i) => {
          const meta = RISK_META[risk.type];
          const dotColor = risk.type === "blocked" ? "bg-red-500" : "bg-amber-500";
          return (
            <div key={i} className="py-2 border-b last:border-0 space-y-1">
              {/* Row 1: status dot + clickable title */}
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} />
                <button
                  onClick={() => risk.url && openUrl(risk.url)}
                  className="flex-1 min-w-0 truncate text-xs font-medium text-left hover:underline hover:text-primary transition-colors"
                  title={risk.url ? "Open in browser" : undefined}
                  disabled={!risk.url}
                >
                  {risk.summary}
                </button>
              </div>
              {/* Row 2: structured key/value metadata */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 text-xs text-muted-foreground">
                <JiraTicketLink ticketKey={risk.key} url={risk.type !== "stale-pr" ? (risk.url ?? undefined) : undefined} />
                <Badge variant={meta.variant} className="text-[10px]">{meta.label}</Badge>
                {risk.metadata.map(({ label, value }) => (
                  <span key={label}>
                    {label} <strong className="text-foreground">{value}</strong>
                  </span>
                ))}
              </div>
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
  inProgressPts: number;
  inProgressCount: number;
  inReviewPts: number;
  inReviewCount: number;
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

function TeamPerformanceCard({
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

// ── Team workload (merged from the former Workload Balancer screen) ──────────

type LoadStatus = "overloaded" | "balanced" | "underutilised";

interface DevWorkload {
  name: string;
  issues: JiraIssue[];
  remainingPts: number;
  totalPts: number;
  donePts: number;
  reviewCount: number;
  loadStatus: LoadStatus;
}

function remainingPoints(issues: JiraIssue[]): number {
  return issues
    .filter((i) => statusCategory(i) !== "done")
    .reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

function buildWorkloads(issues: JiraIssue[], openPrs: BitbucketPr[]): DevWorkload[] {
  // Use the shared classifier so the load-status badge here always matches the
  // landing-page attention badge driven by the same logic.
  const classified = classifyWorkloads(issues, openPrs);
  const statusMap = new Map(classified.map((d) => [d.name, d.loadStatus]));

  const map = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(issue);
  }

  const raw: DevWorkload[] = Array.from(map.entries()).map(([name, devIssues]) => ({
    name,
    issues: devIssues,
    remainingPts: remainingPoints(devIssues),
    totalPts: totalPoints(devIssues),
    donePts: totalPoints(devIssues.filter((i) => statusCategory(i) === "done")),
    reviewCount: openPrs.filter((pr) =>
      pr.reviewers.some((r) => r.user.displayName === name),
    ).length,
    loadStatus: (statusMap.get(name) ?? "balanced") as LoadStatus,
  }));

  return raw.sort(
    (a, b) =>
      b.issues.filter((i) => statusCategory(i) !== "done").length -
      a.issues.filter((i) => statusCategory(i) !== "done").length,
  );
}

function formatWorkloadForClaude(
  sprint: JiraSprint | null,
  workloads: DevWorkload[],
  unstartedTickets: JiraIssue[],
): string {
  const lines: string[] = [
    `Sprint: ${sprint?.name ?? "Unknown"}`,
    `Days remaining: ${sprint?.endDate ? Math.ceil((new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000) : "unknown"}`,
    "",
    "Developer workloads:",
  ];

  for (const d of workloads) {
    const remaining = d.issues.filter((i) => statusCategory(i) !== "done");
    lines.push(
      `  ${d.name}: ${d.remainingPts}pt remaining (${remaining.length} tickets), ` +
        `${d.reviewCount} PRs to review, status: ${d.loadStatus}`,
    );
    for (const issue of remaining) {
      lines.push(
        `    - ${issue.key} "${issue.summary}" (${issue.storyPoints ?? 0}pt, ${issue.status})`,
      );
    }
  }

  lines.push("", "Unstarted tickets (candidates for reassignment):");
  for (const t of unstartedTickets) {
    const assignee = t.assignee?.displayName ?? "Unassigned";
    lines.push(
      `  ${t.key} "${t.summary}" (${t.storyPoints ?? 0}pt) — currently: ${assignee}`,
    );
  }

  const teamAvg =
    workloads.length > 0
      ? Math.round(workloads.reduce((s, d) => s + d.remainingPts, 0) / workloads.length)
      : 0;
  lines.push("", `Team average remaining: ${teamAvg}pt`);

  return lines.join("\n");
}

const LOAD_STATUS_STYLE: Record<
  LoadStatus,
  { bar: string; badge: "destructive" | "success" | "secondary"; icon: React.ElementType; label: string }
> = {
  overloaded: { bar: "bg-red-500", badge: "destructive", icon: TrendingUp, label: "Overloaded" },
  balanced: { bar: "bg-emerald-500", badge: "success", icon: Minus, label: "Balanced" },
  underutilised: { bar: "bg-blue-400", badge: "secondary", icon: TrendingDown, label: "Under-utilised" },
};

function DevCard({
  dev,
  maxTickets,
  ignored,
  onToggleIgnored,
}: {
  dev: DevWorkload;
  maxTickets: number;
  ignored: boolean;
  onToggleIgnored: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const style = LOAD_STATUS_STYLE[ignored ? "balanced" : dev.loadStatus];
  const Icon = style.icon;
  const remaining = dev.issues.filter((i) => statusCategory(i) !== "done");
  const done = dev.issues.filter((i) => statusCategory(i) === "done");
  const remainingPct = maxTickets > 0 ? (remaining.length / maxTickets) * 100 : 0;

  return (
    <Card className={ignored ? "opacity-50" : ""}>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-medium text-sm">{dev.name}</span>
              {!ignored && (
                <Badge variant={style.badge} className="text-[10px] gap-0.5">
                  <Icon className="h-2.5 w-2.5" />
                  {style.label}
                </Badge>
              )}
              {ignored && (
                <span className="text-[10px] text-muted-foreground">Not tracked</span>
              )}
            </div>
            <div className="h-2.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${ignored ? "bg-muted-foreground/30" : style.bar}`}
                style={{ width: `${remainingPct}%` }}
              />
            </div>
          </div>

          <div className="text-xs text-muted-foreground text-right shrink-0 space-y-0.5">
            <p>
              <span className="font-medium text-foreground tabular-nums">
                {remaining.length}
              </span>{" "}
              ticket{remaining.length !== 1 ? "s" : ""} remaining
            </p>
            <p>{dev.remainingPts}pt left</p>
            {dev.reviewCount > 0 && (
              <p className="flex items-center gap-0.5 justify-end">
                <GitPullRequest className="h-3 w-3" />
                {dev.reviewCount} to review
              </p>
            )}
          </div>

          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleIgnored();
            }}
            title={ignored ? "Start tracking" : "Stop tracking"}
            className="shrink-0 p-1 rounded hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground"
          >
            {ignored ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>

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
                    <JiraTicketLink ticketKey={issue.key} url={issue.url} />
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
                    <JiraTicketLink ticketKey={issue.key} url={issue.url} />
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

function TeamWorkloadSection({
  issues,
  openPrs,
  ignoredDevs,
  onToggleIgnoredDev,
}: {
  issues: JiraIssue[];
  openPrs: BitbucketPr[];
  ignoredDevs: Set<string>;
  onToggleIgnoredDev: (name: string) => void;
}) {
  const workloads = buildWorkloads(issues, openPrs).sort((a, b) => {
    const aIgnored = ignoredDevs.has(a.name) ? 1 : 0;
    const bIgnored = ignoredDevs.has(b.name) ? 1 : 0;
    return aIgnored - bIgnored; // ignored sink to bottom
  });
  const unstartedTickets = issues.filter((i) => statusCategory(i) === "todo");
  const tracked = workloads.filter((d) => !ignoredDevs.has(d.name));
  const overloaded = tracked.filter((d) => d.loadStatus === "overloaded").length;
  const underutilised = tracked.filter((d) => d.loadStatus === "underutilised").length;
  const totalRemaining = tracked.reduce(
    (s, d) => s + d.issues.filter((i) => statusCategory(i) !== "done").length,
    0,
  );
  const avgRemaining = tracked.length > 0 ? Math.round(totalRemaining / tracked.length) : 0;
  const maxTickets = Math.max(
    ...workloads.map((d) => d.issues.filter((i) => statusCategory(i) !== "done").length),
    1,
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Team Workload</CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              Team avg <strong className="text-foreground tabular-nums">{avgRemaining}</strong> tickets remaining
            </span>
            {overloaded > 0 && (
              <Badge variant="destructive" className="gap-1">
                <TrendingUp className="h-2.5 w-2.5" />
                {overloaded} overloaded
              </Badge>
            )}
            {underutilised > 0 && (
              <Badge variant="secondary" className="gap-1 border-blue-500/30 text-blue-600">
                <TrendingDown className="h-2.5 w-2.5" />
                {underutilised} under-utilised
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "grid gap-4 items-start",
            unstartedTickets.length > 0 ? "lg:grid-cols-[1fr_360px]" : "lg:grid-cols-1",
          )}
        >
          <div className="space-y-3">
            {workloads.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                No assigned issues found in the active sprint.
              </p>
            ) : (
              workloads.map((dev) => (
                <DevCard
                  key={dev.name}
                  dev={dev}
                  maxTickets={maxTickets}
                  ignored={ignoredDevs.has(dev.name)}
                  onToggleIgnored={() => onToggleIgnoredDev(dev.name)}
                />
              ))
            )}
          </div>

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
                    <JiraTicketLink ticketKey={t.key} url={t.url} />
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
      </CardContent>
    </Card>
  );
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
    <div className="h-screen flex flex-col overflow-hidden">
      <WorkflowPanelHeader
        panel="sprint_dashboard"
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={onBack}>
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
            data={data}
            aiAvailable={aiAvailable}
          />
        </aside>
      </div>
    </div>
  );
}

// ── Chat panel ────────────────────────────────────────────────────────────────

function buildSprintContext(data: DashboardData): string {
  const workloads = buildWorkloads(data.issues, data.openPrs);
  const unstarted = data.issues.filter((i) => statusCategory(i) === "todo");
  const days = daysRemaining(data.sprint?.endDate ?? null);

  const lines: string[] = [];
  lines.push(`Sprint: ${data.sprint?.name ?? "(combined view across active sprints)"}`);
  if (data.sprint?.startDate) lines.push(`Start: ${data.sprint.startDate}`);
  if (data.sprint?.endDate) {
    lines.push(`End: ${data.sprint.endDate} (${days ?? "?"} days remaining)`);
  }
  lines.push(
    `Totals: ${data.issues.length} tickets, ${totalPoints(data.issues)}pt across the sprint.`,
  );
  lines.push("");

  lines.push("ISSUES:");
  for (const i of data.issues) {
    const assignee = i.assignee?.displayName ?? "Unassigned";
    const pts = i.storyPoints != null ? `${i.storyPoints}pt` : "?pt";
    lines.push(
      `  ${i.key} [${i.status}] "${i.summary}" — ${assignee} — ${pts}`,
    );
  }
  lines.push("");

  lines.push("OPEN PRS:");
  if (data.openPrs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const pr of data.openPrs) {
      const approvals = pr.reviewers.filter((r) => r.approved).length;
      const flags = [
        pr.draft ? "draft" : null,
        pr.changesRequested ? "changes-requested" : null,
      ]
        .filter(Boolean)
        .join(", ");
      const ageBd = Math.floor(businessDaysAgo(pr.createdOn));
      lines.push(
        `  #${pr.id} "${pr.title}" by ${pr.author.displayName} — ${approvals} approval${approvals === 1 ? "" : "s"}, ${ageBd}bd old${flags ? ` (${flags})` : ""}`,
      );
    }
  }
  lines.push("");

  lines.push(formatWorkloadForClaude(data.sprint, workloads, unstarted));
  return lines.join("\n");
}

function SprintChatPanel({
  data,
  aiAvailable,
}: {
  data: DashboardData | null;
  aiAvailable: boolean;
}) {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep a ref so callbacks see the latest snapshot without having to rebuild
  // on every sprint data tick.
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, busy]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!aiAvailable) {
        toast.error("Configure an AI provider in Settings to use chat.");
        return;
      }
      if (!dataRef.current) {
        toast.error("Load sprint data before chatting.");
        return;
      }
      const userMsg: ChatTurn = { role: "user", content: text };
      const nextHistory: ChatTurn[] = [...history, userMsg];
      setHistory(nextHistory);
      setBusy(true);
      try {
        const context = buildSprintContext(dataRef.current);
        const reply = await chatSprintDashboard(
          context,
          JSON.stringify(nextHistory),
        );
        setHistory([
          ...nextHistory,
          { role: "assistant", content: reply.trim() },
        ]);
      } catch (e) {
        toast.error("Chat failed", { description: String(e) });
      } finally {
        setBusy(false);
      }
    },
    [history, aiAvailable],
  );

  const runRebalance = useCallback(async () => {
    if (!aiAvailable) {
      toast.error("Configure an AI provider in Settings to use /rebalance.");
      return;
    }
    if (!dataRef.current) {
      toast.error("Load sprint data before rebalancing.");
      return;
    }
    const { sprint, issues, openPrs } = dataRef.current;
    const workloads = buildWorkloads(issues, openPrs);
    const unstarted = issues.filter((i) => statusCategory(i) === "todo");
    const userMsg: ChatTurn = { role: "user", content: "/rebalance" };
    const nextHistory: ChatTurn[] = [...history, userMsg];
    setHistory(nextHistory);
    setBusy(true);
    try {
      const text = formatWorkloadForClaude(sprint, workloads, unstarted);
      const result = await generateWorkloadSuggestions(text);
      setHistory([
        ...nextHistory,
        { role: "assistant", content: result.trim() },
      ]);
    } catch (e) {
      toast.error("Rebalance failed", { description: String(e) });
    } finally {
      setBusy(false);
    }
  }, [history, aiAvailable]);

  const commands: SlashCommand[] = useMemo(
    () => [
      ...createGlobalCommands({
        history,
        clearHistory: () => setHistory([]),
        sendMessage,
        removeLastAssistantMessage: () =>
          setHistory((h) =>
            h[h.length - 1]?.role === "assistant" ? h.slice(0, -1) : h,
          ),
      }),
      {
        name: "rebalance",
        description:
          "Analyse workload distribution and suggest ticket reassignments",
        execute: async () => {
          await runRebalance();
        },
      },
      {
        name: "standup",
        description: "Generate a concise standup briefing for this sprint",
        execute: async () => {
          await sendMessage(
            "Write a concise standup briefing for this sprint. Three short sections: " +
              "**Shipped** (tickets done or PRs merged since yesterday), " +
              "**In flight** (what each developer is actively working on), " +
              "**Blocked / at risk** (blockers, stalled PRs, overloaded people). " +
              "Reference ticket keys and names. Keep it tight — this is read aloud in 2 minutes.",
          );
        },
      },
      {
        name: "risks",
        description: "Rank at-risk tickets with reasons",
        execute: async () => {
          await sendMessage(
            "List the tickets most at risk of not completing this sprint, ranked by severity. " +
              "For each, cite the ticket key and a one-line reason (e.g. stale PR, blocked status, " +
              "overloaded assignee, missing AC, no activity). Group them under **High**, **Medium**, **Low**.",
          );
        },
      },
      {
        name: "stale",
        description: "List PRs that have gone stale",
        execute: async () => {
          await sendMessage(
            "List the open PRs that have gone stale (≥5 business days old, or ≥3 business days since last update). " +
              "For each, give: PR number, title, author, age, and a suggested nudge (e.g. ping a reviewer, " +
              "rebase, split into smaller PRs). Skip drafts unless they've been drafts for over a week.",
          );
        },
      },
      {
        name: "ready",
        description: "List PRs that could move to QA / merge",
        execute: async () => {
          await sendMessage(
            "List the open PRs that are ready to move forward: 2+ approvals, no changes-requested, " +
              "and not drafts. For each, cite the PR number, title, author, and any remaining PR tasks " +
              "that still need to be resolved before merge.",
          );
        },
      },
      {
        name: "dev",
        description: "Focus the next question on a specific developer",
        args: "<name>",
        execute: ({ args, setInput }) => {
          const name = args.trim();
          if (!name) {
            setInput("/dev ");
            return;
          }
          setInput(`Focus on ${name} — `);
        },
      },
      {
        name: "ticket",
        description: "Focus the next question on a specific ticket",
        args: "<KEY>",
        execute: ({ args, setInput }) => {
          const key = args.trim();
          if (!key) {
            setInput("/ticket ");
            return;
          }
          setInput(`What's the status of ${key} — `);
        },
      },
    ],
    [history, sendMessage, runRebalance],
  );

  return (
    <>
      <div className="shrink-0 px-4 py-2.5 border-b flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Ask about this sprint
        </p>
        {busy && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground italic text-center pt-6">
            {aiAvailable ? (
              <>
                Ask anything about this sprint — velocity, blockers, at-risk
                tickets, or who's overloaded. Try{" "}
                <span className="font-mono">/rebalance</span> for workload
                suggestions. Type <span className="font-mono">/</span> to see
                all commands.
              </>
            ) : (
              "Configure an AI provider in Settings to chat about this sprint."
            )}
          </p>
        ) : (
          history.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "flex",
                msg.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}
        {busy && (
          <div className="flex justify-start pt-1">
            <div className="bg-muted rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2 border-t">
        <SlashCommandInput
          value={input}
          onChange={setInput}
          onSend={sendMessage}
          commands={commands}
          busy={busy}
          placeholder={
            aiAvailable
              ? "Ask about this sprint. Enter to send. / for commands."
              : "Chat unavailable — configure AI in Settings."
          }
        />
      </div>
    </>
  );
}
