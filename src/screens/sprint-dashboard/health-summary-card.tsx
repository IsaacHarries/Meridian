import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { type BitbucketPr, type BitbucketTask } from "@/lib/tauri/bitbucket";
import { openUrl } from "@/lib/tauri/core";
import { type JiraIssue } from "@/lib/tauri/jira";
import {
    CheckCircle2,
    ClipboardCheck,
    XCircle,
} from "lucide-react";
import {
    businessDaysAgo,
    daysSince,
    sprintProgress,
    statusCategory,
} from "./_shared";

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

export function HealthSummaryCard({
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
