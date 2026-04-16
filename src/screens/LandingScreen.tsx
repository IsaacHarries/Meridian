import { useEffect, useState, useMemo } from "react";
import { AlertTriangle, TrendingUp, CheckSquare, GitPullRequest } from "lucide-react";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { APP_HEADER_BAR, APP_HEADER_ROW_LANDING } from "@/components/appHeaderLayout";
import { useOpenSettings } from "@/context/OpenSettingsContext";
import { useImplementTicketStore } from "@/stores/implementTicketStore";
import { usePrReviewStore } from "@/stores/prReviewStore";
import { useWorkloadAlertStore } from "@/stores/workloadAlertStore";

const QUIPS = [
  "It works on my machine...",
  "Have you tried turning it off and on again?",
  "undefined is not a function...",
  "git blame yourself...",
  "Ship it, we'll fix it in prod...",
  "It's not a bug, it's a feature...",
  "Works fine, must be a caching issue...",
  "Just one more console.log...",
  "I'll refactor it later...",
  "The build was green when I pushed it...",
  "Have you tried clearing your cache?",
  "It was working yesterday, I swear...",
  "Compiling, please enjoy this loading screen...",
  "Merge conflicts? Never heard of her...",
  "ChatGPT said it would work...",
  "That's a known issue...",
  "We'll fix it in the next sprint...",
  "The tests are flaky, just re-run them...",
  "Did you read the error message?",
  "Ten lines of code, two weeks of debugging...",
  "It's not slow, it's thorough...",
  "I'll add tests once it's stable...",
  "Senior engineer? I just Google faster...",
  "The regex made sense when I wrote it...",
  "Technically it's not deprecated, just discouraged...",
];
import { Button } from "@/components/ui/button";
import {
  type CredentialStatus,
  type JiraSprint,
  type JiraIssue,
  type BitbucketPr,
  aiProviderComplete,
  jiraComplete,
  bitbucketComplete,
  getAllActiveSprintIssues,
  getOpenPrs,
  getPrsForReview,
  getNonSecretConfig,
} from "@/lib/tauri";
import type { WorkflowId } from "@/screens/WorkflowScreen";

interface LandingScreenProps {
  credStatus: CredentialStatus;
  onNavigate: (workflow: WorkflowId) => void;
}

// ── Missing credentials banner ────────────────────────────────────────────────

function MissingCredentialsBanner({ credStatus }: { credStatus: CredentialStatus }) {
  const openSettings = useOpenSettings();
  const missing: string[] = [];
  if (!jiraComplete(credStatus)) missing.push("JIRA");
  if (!bitbucketComplete(credStatus)) missing.push("Bitbucket");

  const noAiProvider = !aiProviderComplete(credStatus);

  if (missing.length === 0 && !noAiProvider) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        {missing.length > 0 && (
          <>Missing credentials: <strong>{missing.join(", ")}</strong>. Some features won't work until they're configured. </>
        )}
        {noAiProvider && (
          <>No AI provider configured — add an Anthropic key, Gemini key, or local LLM URL to enable agent features.</>
        )}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={openSettings}
        className="shrink-0 border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
      >
        Configure
      </Button>
    </div>
  );
}

// ── Sprint summary widget ─────────────────────────────────────────────────────

interface SprintData {
  sprintIssues: Array<[JiraSprint, JiraIssue[]]>;
  openPrs: BitbucketPr[];
  prsForReview: BitbucketPr[];
  myAccountId: string;
}

function StatPill({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card/60 px-3 py-2 text-sm">
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

function SprintSummary({ credStatus }: { credStatus: CredentialStatus }) {
  const [data, setData] = useState<SprintData | null>(null);
  const [error, setError] = useState(false);
  // Also read from the store as a fast-path if it's already been loaded
  const myAccountIdFromStore = usePrReviewStore((s) => s.myAccountId);

  const canFetch = jiraComplete(credStatus) && bitbucketComplete(credStatus);

  useEffect(() => {
    if (!canFetch) return;
    Promise.all([
      getAllActiveSprintIssues(),
      getOpenPrs(),
      getPrsForReview(),
      getNonSecretConfig().then((cfg) => cfg["jira_account_id"] ?? "").catch(() => ""),
    ])
      .then(([sprintIssues, openPrs, prsForReview, myAccountId]) =>
        setData({ sprintIssues, openPrs, prsForReview, myAccountId })
      )
      .catch(() => setError(true));
  }, [canFetch]);

  if (!canFetch) {
    return (
      <div className="flex flex-wrap gap-2">
        <StatPill icon={TrendingUp} label="Sprints" value="—" />
        <StatPill icon={CheckSquare} label="Tickets done" value="—/—" />
        <StatPill icon={GitPullRequest} label="Open PRs" value="—" />
      </div>
    );
  }

  if (!data || error) {
    return (
      <div className="flex flex-wrap gap-2">
        <StatPill icon={TrendingUp} label="Sprints" value="…" />
        <StatPill icon={CheckSquare} label="Tickets done" value="…" />
        <StatPill icon={GitPullRequest} label="Open PRs" value="…" />
      </div>
    );
  }

  const { sprintIssues, openPrs, prsForReview, myAccountId: myAccountIdFromData } = data;

  // Prefer the freshly fetched account id; fall back to the store value if the
  // config fetch somehow returned empty (e.g. credential not yet set).
  const myAccountId = myAccountIdFromData || myAccountIdFromStore;

  // Exclude draft PRs — drafts are not ready for review.
  const nonDraftOpenPrs = openPrs.filter((pr) => !pr.draft);

  // PRs awaiting my review: exclude drafts (same filter the PR Review panel applies),
  // then exclude any I've already approved.
  const nonDraftPrsForReview = prsForReview.filter((pr) => !pr.draft);
  const unapprovedPrs = nonDraftPrsForReview.filter((pr) =>
    pr.reviewers.some((r) => {
      const isMe = myAccountId ? r.user.accountId === myAccountId : false;
      return isMe && !r.approved;
    })
  );
  // If accountId isn't loaded yet, use the full non-draft list as a safe fallback.
  const pendingReviewCount = myAccountId ? unapprovedPrs.length : nonDraftPrsForReview.length;

  // Aggregate ticket counts across all active sprints
  const allIssues = sprintIssues.flatMap(([, issues]) => issues);
  const doneCount = allIssues.filter((i) => i.statusCategory === "Done").length;
  const totalCount = allIssues.length;

  // Sprint names and per-sprint days remaining
  const sprints = sprintIssues.map(([s]) => {
    const daysRemaining = s.endDate
      ? Math.ceil((new Date(s.endDate).getTime() - Date.now()) / 86_400_000)
      : null;
    const sub = daysRemaining !== null
      ? daysRemaining > 0 ? `${daysRemaining}d left` : "ended"
      : undefined;
    return { name: s.name, sub };
  });

  return (
    <div className="flex flex-wrap gap-2">
      {sprints.length === 0 ? (
        <StatPill icon={TrendingUp} label="Sprint" value="No active sprints" />
      ) : (
        sprints.map(({ name, sub }, i) => (
          <StatPill
            key={name}
            icon={TrendingUp}
            label={sprints.length > 1 ? `Sprint ${i + 1}` : "Sprint"}
            value={name}
            sub={sub}
          />
        ))
      )}
      <StatPill
        icon={CheckSquare}
        label="Tickets done"
        value={totalCount > 0 ? `${doneCount}/${totalCount}` : "—"}
      />
      <StatPill
        icon={GitPullRequest}
        label="Open PRs"
        value={String(nonDraftOpenPrs.length)}
        sub={pendingReviewCount > 0 ? `${pendingReviewCount} need your review` : undefined}
      />
    </div>
  );
}

// ── Workflow cards ────────────────────────────────────────────────────────────

const WORKFLOW_CARDS: {
  id: WorkflowId;
  emoji: string;
  title: string;
  description: string;
  ready: boolean;
}[] = [
  {
    id: "implement-ticket",
    emoji: "🎫",
    title: "Implement a Ticket",
    description: "Full 8-agent pipeline from JIRA ticket to PR",
    ready: false,
  },
  {
    id: "review-pr",
    emoji: "🔍",
    title: "Review a Pull Request",
    description: "AI-assisted code review across 5 analysis lenses",
    ready: false,
  },
  {
    id: "sprint-dashboard",
    emoji: "📊",
    title: "Sprint Dashboard",
    description: "Real-time sprint health, team performance, and blockers",
    ready: false,
  },
  {
    id: "retrospectives",
    emoji: "🔄",
    title: "Sprint Retrospectives",
    description: "Metrics and AI summaries for completed sprints",
    ready: false,
  },
  {
    id: "standup",
    emoji: "☀️",
    title: "Daily Standup Briefing",
    description: "Auto-generated standup agenda from JIRA activity",
    ready: false,
  },
  {
    id: "workload-balancer",
    emoji: "⚖️",
    title: "Team Workload Balancer",
    description: "Visualise and rebalance work across the team",
    ready: false,
  },
  {
    id: "ticket-quality",
    emoji: "✅",
    title: "Groom Tickets",
    description: "Readiness assessment for backlog and sprint tickets",
    ready: false,
  },
  {
    id: "knowledge-base",
    emoji: "🧠",
    title: "Knowledge Base",
    description: "Searchable log of decisions, patterns, and learnings",
    ready: false,
  },
  {
    id: "address-pr-comments",
    emoji: "💬",
    title: "Address PR Tasks & Comments",
    description: "AI reviews your PR's tasks and comments and applies fixes in a worktree",
    ready: true,
  },
];


// ── Landing screen ────────────────────────────────────────────────────────────

export function LandingScreen({ credStatus, onNavigate }: LandingScreenProps) {
  const quip = useMemo(
    () => QUIPS[Math.floor(Math.random() * QUIPS.length)],
    []
  );
  const allComplete =
    jiraComplete(credStatus) && bitbucketComplete(credStatus);

  const implementSessions = useImplementTicketStore((s) => s.sessions);
  const implementIssue = useImplementTicketStore((s) => s.selectedIssue);
  // Active session + any cached sessions in the map
  const implementActive = implementIssue !== null || implementSessions.size > 0;
  const implementBadgeLabel = implementIssue
    ? implementIssue.key
    : implementSessions.size > 0
    ? `${implementSessions.size} in progress`
    : null;
  const prSessions = usePrReviewStore((s) => s.sessions);
  const prSelectedPr = usePrReviewStore((s) => s.selectedPr);
  // Show badge if any PR has a cached review, or one is actively open
  const prActive = prSessions.size > 0;
  const reviewedCount = [...prSessions.values()].filter(s => s.report || s.rawError).length;
  const prBadgeLabel = reviewedCount > 0
    ? `${reviewedCount} reviewed`
    : prSelectedPr ? `#${prSelectedPr.id}` : null;

  const overloadedDevs = useWorkloadAlertStore((s) => s.overloadedDevs);
  const underutilisedDevs = useWorkloadAlertStore((s) => s.underutilisedDevs);
  const workloadNeedsAttention = overloadedDevs.length > 0 || underutilisedDevs.length > 0;

  return (
    <div className="min-h-screen flex flex-col">
      <header className={APP_HEADER_BAR}>
        <div className={APP_HEADER_ROW_LANDING}>
          <HeaderSettingsButton className="relative z-10 shrink-0" />
        </div>
      </header>

      <main className="flex-1 flex items-center">
          <div className="w-full max-w-5xl mx-auto px-6 py-8 space-y-8 bg-background/60 rounded-xl">
            {!allComplete && (
              <MissingCredentialsBanner credStatus={credStatus} />
            )}

            <div className="space-y-3">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight mb-1">{quip}</h1>
              </div>
              <SprintSummary credStatus={credStatus} />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {WORKFLOW_CARDS.map((card) => {
                const hasSession =
                  (card.id === "implement-ticket" && implementActive) ||
                  (card.id === "review-pr" && prActive);
                const sessionLabel =
                  card.id === "implement-ticket"
                    ? implementBadgeLabel
                    : card.id === "review-pr"
                    ? prBadgeLabel
                    : null;
                const needsAttention =
                  card.id === "workload-balancer" && workloadNeedsAttention;
                const attentionParts: string[] = [];
                if (overloadedDevs.length > 0) attentionParts.push(`${overloadedDevs.length} overloaded`);
                if (underutilisedDevs.length > 0) attentionParts.push(`${underutilisedDevs.length} under-utilised`);
                const attentionLabel = attentionParts.join(", ");
                return (
                <button
                  key={card.id}
                  onClick={() => onNavigate(card.id)}
                  className="group relative flex flex-col gap-2 rounded-xl border bg-card/60 p-4 text-left transition-colors hover:bg-accent/60 cursor-pointer"
                >
                  {hasSession && (
                    <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-primary/15 border border-primary/30 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                      {sessionLabel ?? "In progress"}
                    </span>
                  )}
                  {needsAttention && (
                    <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {attentionLabel}
                    </span>
                  )}
                  <span className="text-2xl">{card.emoji}</span>
                  <div>
                    <p className="text-sm font-medium leading-snug">{card.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                      {card.description}
                    </p>
                  </div>
                </button>
                );
              })}
            </div>
          </div>
        </main>

    </div>
  );
}
