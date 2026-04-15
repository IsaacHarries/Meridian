import { useEffect, useState, useCallback } from "react";
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Sparkles,
  GitPullRequest,
  Loader2,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import {
  type JiraSprint,
  type JiraIssue,
  type BitbucketPr,
  type CredentialStatus,
  aiProviderComplete,
  getActiveSprint,
  getActiveSprintIssues,
  getOpenPrs,
  getMergedPrs,
  generateStandupBriefing,
} from "@/lib/tauri";

interface StandupScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

interface DayWindow {
  start: Date;
  end: Date;
  label: string;
}

function prevWorkingDay(): DayWindow {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const prev = new Date(today);
  prev.setDate(prev.getDate() - 1);
  while (prev.getDay() === 0 || prev.getDay() === 6) {
    prev.setDate(prev.getDate() - 1);
  }

  const start = new Date(prev);
  start.setHours(0, 0, 0, 0);
  const end = new Date(prev);
  end.setHours(23, 59, 59, 999);

  return {
    start,
    end,
    label: prev.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    }),
  };
}

function wasUpdatedOn(dateStr: string, window: DayWindow): boolean {
  const d = new Date(dateStr);
  return d >= window.start && d <= window.end;
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

function isBlocked(issue: JiraIssue): boolean {
  return (
    issue.labels.some((l) => l.toLowerCase() === "blocked") ||
    issue.status.toLowerCase().includes("blocked")
  );
}

function isInProgress(issue: JiraIssue): boolean {
  return issue.statusCategory === "In Progress";
}

// ── Standup data types ────────────────────────────────────────────────────────

interface MemberActivity {
  name: string;
  updatedYesterday: JiraIssue[];
  inProgress: JiraIssue[];
  blocked: JiraIssue[];
  prsRaisedYesterday: BitbucketPr[];
  prsMergedYesterday: BitbucketPr[];
  noActivity: boolean;
}

interface Thresholds {
  stalePrDays: number;
  noProgressDays: number;
  atRiskDays: number;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  stalePrDays: 2,
  noProgressDays: 3,
  atRiskDays: 3,
};

// ── Data compilation ──────────────────────────────────────────────────────────

function compileStandupData(
  issues: JiraIssue[],
  openPrs: BitbucketPr[],
  mergedPrs: BitbucketPr[],
  sprint: JiraSprint | null,
  thresholds: Thresholds
): {
  members: MemberActivity[];
  stalePrs: BitbucketPr[];
  atRiskTickets: JiraIssue[];
  prevDay: DayWindow;
} {
  const prevDay = prevWorkingDay();

  // Filter merged PRs to yesterday
  const mergedYesterday = mergedPrs.filter((pr) => wasUpdatedOn(pr.updatedOn, prevDay));
  const raisedYesterday = openPrs.filter((pr) => wasUpdatedOn(pr.createdOn, prevDay));

  // Group issues by assignee
  const memberMap = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!memberMap.has(name)) memberMap.set(name, []);
    memberMap.get(name)!.push(issue);
  }

  const members: MemberActivity[] = Array.from(memberMap.entries()).map(
    ([name, memberIssues]) => {
      const updatedYesterday = memberIssues.filter((i) =>
        wasUpdatedOn(i.updated, prevDay)
      );
      const inProgress = memberIssues.filter(
        (i) => isInProgress(i) && !isBlocked(i)
      );
      const blocked = memberIssues.filter(isBlocked);
      const prsRaisedYesterday = raisedYesterday.filter(
        (pr) => pr.author.displayName === name
      );
      const prsMergedYesterday = mergedYesterday.filter(
        (pr) => pr.author.displayName === name
      );
      const noActivity =
        updatedYesterday.length === 0 &&
        prsRaisedYesterday.length === 0 &&
        prsMergedYesterday.length === 0;

      return {
        name,
        updatedYesterday,
        inProgress,
        blocked,
        prsRaisedYesterday,
        prsMergedYesterday,
        noActivity,
      };
    }
  );

  // Sort: blocked first, then active yesterday, then no activity
  members.sort((a, b) => {
    if (a.blocked.length > 0 && b.blocked.length === 0) return -1;
    if (b.blocked.length > 0 && a.blocked.length === 0) return 1;
    if (!a.noActivity && b.noActivity) return -1;
    if (a.noActivity && !b.noActivity) return 1;
    return a.name.localeCompare(b.name);
  });

  // Stale PRs
  const stalePrs = openPrs.filter(
    (pr) => daysSince(pr.updatedOn) >= thresholds.stalePrDays
  );

  // At-risk unstarted tickets
  const daysLeft = sprint?.endDate ? daysUntil(sprint.endDate) : null;
  const atRiskTickets =
    daysLeft !== null && daysLeft <= thresholds.atRiskDays
      ? issues.filter((i) => i.statusCategory === "To Do")
      : [];

  return { members, stalePrs, atRiskTickets, prevDay };
}

// ── Format standup data as readable text for Claude ───────────────────────────

function formatForClaude(
  sprint: JiraSprint | null,
  members: MemberActivity[],
  stalePrs: BitbucketPr[],
  atRiskTickets: JiraIssue[],
  prevDay: DayWindow
): string {
  const lines: string[] = [
    `Date: ${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`,
    `Sprint: ${sprint?.name ?? "Unknown"}`,
    `Activity window: ${prevDay.label}`,
    "",
  ];

  for (const m of members) {
    lines.push(`Team member: ${m.name}`);

    const yesterday: string[] = [];
    for (const issue of m.updatedYesterday) {
      yesterday.push(`${issue.key} "${issue.summary}" → ${issue.status}`);
    }
    for (const pr of m.prsMergedYesterday) {
      yesterday.push(`Merged PR #${pr.id}: ${pr.title}`);
    }
    for (const pr of m.prsRaisedYesterday) {
      yesterday.push(`Raised PR #${pr.id}: ${pr.title}`);
    }
    lines.push(
      `  Yesterday: ${yesterday.length > 0 ? yesterday.join("; ") : "No activity recorded"}`
    );

    const today = m.inProgress.map(
      (i) => `${i.key} "${i.summary}"${i.storyPoints ? ` (${i.storyPoints}pt)` : ""}`
    );
    lines.push(`  Today: ${today.length > 0 ? today.join("; ") : "Nothing in progress"}`);

    const blockers = m.blocked.map((i) => `${i.key} "${i.summary}"`);
    lines.push(`  Blockers: ${blockers.length > 0 ? blockers.join("; ") : "None"}`);
    lines.push("");
  }

  if (stalePrs.length > 0) {
    lines.push("Stale PRs (no activity):");
    for (const pr of stalePrs) {
      lines.push(`  PR #${pr.id} by ${pr.author.displayName}: "${pr.title}" (${daysSince(pr.updatedOn)}d stale)`);
    }
    lines.push("");
  }

  if (atRiskTickets.length > 0) {
    lines.push("At-risk unstarted tickets:");
    for (const t of atRiskTickets) {
      lines.push(`  ${t.key} "${t.summary}" — not started, sprint ending soon`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Member card ───────────────────────────────────────────────────────────────

function MemberCard({ member }: { member: MemberActivity }) {
  const [expanded, setExpanded] = useState(true);
  const hasActivity =
    member.updatedYesterday.length > 0 ||
    member.prsRaisedYesterday.length > 0 ||
    member.prsMergedYesterday.length > 0;

  return (
    <Card className={member.blocked.length > 0 ? "border-red-500/40" : ""}>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-muted/30 transition-colors rounded-t-lg"
      >
        <div className="flex-1 flex items-center gap-2">
          <span className="font-medium text-sm">{member.name}</span>
          {member.blocked.length > 0 && (
            <Badge variant="destructive" className="text-[10px]">
              {member.blocked.length} blocked
            </Badge>
          )}
          {member.noActivity && (
            <Badge variant="secondary" className="text-[10px]">
              No activity
            </Badge>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <CardContent className="pt-0 pb-4 space-y-3 text-sm">
          {/* Yesterday */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Yesterday
            </p>
            {!hasActivity ? (
              <p className="text-muted-foreground text-xs italic">No activity recorded</p>
            ) : (
              <ul className="space-y-1">
                {member.updatedYesterday.map((issue) => (
                  <li key={issue.key} className="flex items-center gap-2 text-xs">
                    <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                    <span className="truncate">{issue.summary}</span>
                    <Badge variant="secondary" className="text-[10px] shrink-0 ml-auto">
                      {issue.status}
                    </Badge>
                  </li>
                ))}
                {member.prsMergedYesterday.map((pr) => (
                  <li key={`merged-${pr.id}`} className="flex items-center gap-2 text-xs text-emerald-600">
                    <GitPullRequest className="h-3 w-3 shrink-0" />
                    <span className="truncate">Merged PR #{pr.id}: {pr.title}</span>
                  </li>
                ))}
                {member.prsRaisedYesterday.map((pr) => (
                  <li key={`raised-${pr.id}`} className="flex items-center gap-2 text-xs text-blue-500">
                    <GitPullRequest className="h-3 w-3 shrink-0" />
                    <span className="truncate">Raised PR #{pr.id}: {pr.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Today */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Today
            </p>
            {member.inProgress.length === 0 ? (
              <p className="text-muted-foreground text-xs italic">Nothing in progress</p>
            ) : (
              <ul className="space-y-1">
                {member.inProgress.map((issue) => (
                  <li key={issue.key} className="flex items-center gap-2 text-xs">
                    <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                    <span className="truncate">{issue.summary}</span>
                    {issue.storyPoints != null && (
                      <span className="text-muted-foreground/60 shrink-0">{issue.storyPoints}pt</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Blockers */}
          {member.blocked.length > 0 && (
            <div>
              <p className="text-xs font-medium text-red-500 uppercase tracking-wide mb-1.5">
                Blockers
              </p>
              <ul className="space-y-1">
                {member.blocked.map((issue) => (
                  <li key={issue.key} className="flex items-center gap-2 text-xs text-red-600">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    <JiraTicketLink ticketKey={issue.key} url={issue.url} className="text-red-600" />
                    <span className="truncate">{issue.summary}</span>
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

// ── Flags panel ───────────────────────────────────────────────────────────────

function FlagsPanel({
  stalePrs,
  atRiskTickets,
  noActivityMembers,
}: {
  stalePrs: BitbucketPr[];
  atRiskTickets: JiraIssue[];
  noActivityMembers: string[];
}) {
  const total = stalePrs.length + atRiskTickets.length + noActivityMembers.length;
  if (total === 0) return null;

  return (
    <Card className="border-amber-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          Flags for scrum master
          <Badge variant="warning" className="ml-auto">{total}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-xs">
        {noActivityMembers.map((name) => (
          <div key={name} className="flex items-center gap-2 py-0.5 text-muted-foreground">
            <span className="w-20 shrink-0 font-medium text-foreground">{name}</span>
            <span>No activity recorded yesterday</span>
          </div>
        ))}
        {stalePrs.map((pr) => (
          <div key={pr.id} className="flex items-center gap-2 py-0.5">
            <GitPullRequest className="h-3 w-3 text-amber-500 shrink-0" />
            <span className="font-mono text-muted-foreground shrink-0">PR #{pr.id}</span>
            <span className="truncate">{pr.title}</span>
            <span className="text-muted-foreground shrink-0 ml-auto">
              {daysSince(pr.updatedOn)}d no activity
            </span>
          </div>
        ))}
        {atRiskTickets.map((t) => (
          <div key={t.key} className="flex items-center gap-2 py-0.5">
            <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
            <JiraTicketLink ticketKey={t.key} url={t.url} />
            <span className="truncate">{t.summary}</span>
            <Badge variant="warning" className="text-[10px] shrink-0 ml-auto">Not started</Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── AI briefing panel ─────────────────────────────────────────────────────────

function AiBriefingPanel({
  claudeAvailable,
  briefing,
  loading,
  error,
  onGenerate,
}: {
  claudeAvailable: boolean;
  briefing: string | null;
  loading: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (briefing) {
      navigator.clipboard.writeText(briefing);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-purple-400" />
          AI Standup Briefing
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!claudeAvailable && (
          <p className="text-xs text-muted-foreground">
            Configure an AI provider in Settings to generate AI-written briefings.
          </p>
        )}

        {claudeAvailable && !briefing && !loading && !error && (
          <Button variant="outline" size="sm" onClick={onGenerate} className="gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-purple-400" />
            Generate briefing
          </Button>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Generating briefing…
          </div>
        )}

        {error && (
          <div className="text-xs text-destructive flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {briefing && (
          <div className="space-y-3">
            <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed text-foreground bg-muted/60 rounded-md p-3 max-h-96 overflow-y-auto">
              {briefing}
            </pre>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5">
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy to clipboard"}
              </Button>
              <Button variant="ghost" size="sm" onClick={onGenerate} className="gap-1.5">
                <RefreshCw className="h-3 w-3" />
                Regenerate
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Threshold config ──────────────────────────────────────────────────────────

function ThresholdConfig({
  thresholds,
  onChange,
}: {
  thresholds: Thresholds;
  onChange: (t: Thresholds) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Settings2 className="h-3 w-3" />
        Thresholds
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-4 text-xs">
          {(
            [
              { key: "stalePrDays", label: "Stale PR after" },
              { key: "noProgressDays", label: "No progress after" },
              { key: "atRiskDays", label: "At-risk sprint days ≤" },
            ] as { key: keyof Thresholds; label: string }[]
          ).map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5 text-muted-foreground">
              {label}
              <input
                type="number"
                min={1}
                max={14}
                value={thresholds[key]}
                onChange={(e) =>
                  onChange({ ...thresholds, [key]: Math.max(1, parseInt(e.target.value) || 1) })
                }
                className="w-10 rounded border bg-background/60 px-1.5 py-0.5 text-center text-foreground"
              />
              days
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function StandupScreen({ credStatus, onBack }: StandupScreenProps) {
  const [sprint, setSprint] = useState<JiraSprint | null>(null);
  const [members, setMembers] = useState<MemberActivity[]>([]);
  const [stalePrs, setStalePrs] = useState<BitbucketPr[]>([]);
  const [atRiskTickets, setAtRiskTickets] = useState<JiraIssue[]>([]);
  const [prevDay, setPrevDay] = useState<DayWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);

  const [briefing, setBriefing] = useState<string | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [briefingError, setBriefingError] = useState<string | null>(null);

  const claudeAvailable = aiProviderComplete(credStatus);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setBriefing(null);
    setBriefingError(null);
    try {
      const sprintData = await getActiveSprint();
      const prevDayWindow = prevWorkingDay();
      const [issues, openPrs, mergedPrs] = await Promise.all([
        getActiveSprintIssues(),
        getOpenPrs().catch(() => [] as BitbucketPr[]),
        getMergedPrs(prevDayWindow.start.toISOString()).catch(() => [] as BitbucketPr[]),
      ]);

      const compiled = compileStandupData(issues, openPrs, mergedPrs, sprintData, thresholds);
      setSprint(sprintData);
      setMembers(compiled.members);
      setStalePrs(compiled.stalePrs);
      setAtRiskTickets(compiled.atRiskTickets);
      setPrevDay(compiled.prevDay);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [thresholds]);

  const generateBriefing = useCallback(async () => {
    if (!prevDay) return;
    setBriefingLoading(true);
    setBriefingError(null);
    try {
      const text = formatForClaude(sprint, members, stalePrs, atRiskTickets, prevDay);
      const result = await generateStandupBriefing(text);
      setBriefing(result);
    } catch (e) {
      setBriefingError(String(e));
    } finally {
      setBriefingLoading(false);
    }
  }, [sprint, members, stalePrs, atRiskTickets, prevDay]);

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — only run on mount; refresh is manual

  const noActivityMembers = members
    .filter((m) => m.noActivity)
    .map((m) => m.name);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="min-h-screen">
      <WorkflowPanelHeader
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className={`${APP_HEADER_TITLE} leading-none`}>Daily Standup</h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{today}</p>
            </div>
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

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-4 bg-background/60 rounded-xl">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-16 justify-center">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading standup data…
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load standup data</p>
              <p className="text-xs opacity-80 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* Sprint + date context */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {sprint ? (
                  <>
                    <span className="font-medium text-foreground">{sprint.name}</span>
                    {prevDay && (
                      <span> · activity from {prevDay.label}</span>
                    )}
                  </>
                ) : (
                  "No active sprint"
                )}
              </span>
              <ThresholdConfig thresholds={thresholds} onChange={setThresholds} />
            </div>

            {/* AI briefing */}
            <AiBriefingPanel
              claudeAvailable={claudeAvailable}
              briefing={briefing}
              loading={briefingLoading}
              error={briefingError}
              onGenerate={generateBriefing}
            />

            {/* Flags */}
            <FlagsPanel
              stalePrs={stalePrs}
              atRiskTickets={atRiskTickets}
              noActivityMembers={noActivityMembers}
            />

            {/* Per-member cards */}
            {members.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No team members found in the active sprint.
              </p>
            ) : (
              members.map((member) => (
                <MemberCard key={member.name} member={member} />
              ))
            )}
          </>
        )}
      </main>
    </div>
  );
}
