import { useEffect, useState, useMemo } from "react";
import { AlertTriangle, TrendingUp, CheckSquare, GitPullRequest } from "lucide-react";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { HeaderRecordButton } from "@/components/HeaderRecordButton";
import { HeaderTasksButton } from "@/components/HeaderTasksButton";
import { HeaderTimeTracker } from "@/components/HeaderTimeTracker";
import { APP_HEADER_BAR } from "@/components/appHeaderLayout";
import { useOpenSettings } from "@/context/OpenSettingsContext";
import { useImplementTicketStore } from "@/stores/implementTicketStore";
import { useMeetingsStore } from "@/stores/meetingsStore";
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
  "Two days for a one-line fix...",
  "It's idempotent in theory...",
  "The migration worked in dev...",
  "Stack trace ends in node_modules...",
  "Force-pushing on a Friday — what could go wrong?",
  "Mocked the database, broke it in prod...",
  "Six tabs of Stack Overflow open...",
  "TypeScript is yelling at me again...",
  "I'll write the README later...",
  "Optional chaining solves everything...",
  "node_modules is heavier than my soul...",
  "Deploying on Friday, what could go wrong...",
  "Comment says TODO, the date says 2017...",
  "Rebase or merge? I always forget...",
  "It's a temporary fix (in prod for 3 years)...",
  "Dependabot opened 14 PRs overnight...",
  "The standup ran 45 minutes...",
  "Refactor or rewrite? Yes...",
  "Daylight saving broke our cron jobs...",
  "It works in incognito mode...",
  "Senior engineer, junior googler...",
  "Did you mean: any?",
  "Cargo check passed, that's enough testing...",
  "Asked the AI and got three different answers...",
  "The retro keeps surfacing the same issue...",
  "Story points are emotions, not measurements...",
  "PR title says 'minor fix' — 47 files changed...",
  "We added telemetry to debug the telemetry...",
  "There are only two hard problems...",
  "Just rm -rf node_modules and try again...",
  "The estimate was conservative, in geological time...",
  "I'll fix the lint warnings in a follow-up PR...",
  "The bug is intermittent, ship it...",
  "Yes I read the design doc... mostly...",
  "Pair programming: now we're both stuck...",
  "DRY until we don't, then DAMP, then WET...",
  "Vibe coding...",
  "Two services, one bug, six teams...",
  "Backwards compatibility is a state of mind...",
  "Hot reload? Lukewarm reload at best...",
  "The runbook is in someone's DMs...",
  "If it compiles, it tests itself...",
  "Naming is the hardest part...",
  "Wrote the test after seeing what the code did...",
  "Defer the hard call to the next reviewer...",
  "Logged it as a P3, hoping nobody notices...",
  "The 5xx is intermittent, the customer is consistent...",
  "Reduced the latency by 12ms, declared victory...",
  "Cleaned up the imports, called it a day...",
  "/* TODO: explain this */",
  "It's not technical debt if you ignore it long enough...",
  "Closed as 'works as intended'...",
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
import { WORKFLOW_ICONS } from "@/lib/workflowIcons";
import {
  useLandingLayoutId,
  type RenderableCard,
} from "@/lib/landingLayouts";
import { ConstellationLayout } from "@/components/landing/ConstellationLayout";
import { BentoLayout } from "@/components/landing/BentoLayout";
import { ShapedLayout } from "@/components/landing/ShapedLayout";
import { OrbitalLayout } from "@/components/landing/OrbitalLayout";

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
  title: string;
  description: string;
}[] = [
  {
    id: "implement-ticket",
    title: "Implement a Ticket",
    description: "Full 8-agent pipeline from JIRA ticket to PR",
  },
  {
    id: "review-pr",
    title: "Review a Pull Request",
    description: "AI-assisted code review across 5 analysis lenses",
  },
  {
    id: "sprint-dashboard",
    title: "Sprint Dashboard",
    description: "Real-time sprint health, team performance, and blockers",
  },
  {
    id: "retrospectives",
    title: "Sprint Retrospectives",
    description: "Metrics and AI summaries for completed sprints",
  },
  {
    id: "ticket-quality",
    title: "Groom Tickets",
    description: "Readiness assessment for backlog and sprint tickets",
  },
  {
    id: "address-pr-comments",
    title: "Address PR Tasks & Comments",
    description: "AI reviews your PR's tasks and comments and applies fixes in a worktree",
  },
  {
    id: "meetings",
    title: "Meetings",
    description: "Transcribe meetings locally with whisper or capture freeform notes — then ask an AI about past conversations",
  },
  {
    id: "time-tracking",
    title: "Time Tracking",
    description: "Automatic work-hours tracker — pauses on screen lock or idle, banks overtime for later in the week",
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

  // When transcription is off in Settings, drop "Transcribe" from the
  // Meetings tile copy — leave only the freeform-notes framing.
  const transcriptionDisabled = useMeetingsStore((s) => s.transcriptionDisabled);

  const layoutId = useLandingLayoutId();
  const isOrbital = layoutId === "orbital";

  return (
    <div className="min-h-screen flex flex-col">
      <header className={APP_HEADER_BAR}>
        <div className="flex h-14 w-full items-center gap-3 overflow-hidden pl-3 pr-2.5 sm:pl-4 sm:pr-3">
          <h1 className="flex-1 min-w-0 truncate pl-2 text-base font-medium tracking-tight text-foreground/90">
            {quip}
          </h1>
          <div className="flex items-center gap-2 shrink-0">
            <HeaderTimeTracker className="relative z-10" />
            <HeaderRecordButton className="relative z-10" />
            <HeaderTasksButton className="relative z-10" />
            <HeaderSettingsButton className="relative z-10 shrink-0" />
          </div>
        </div>
      </header>

      {/* Sprint-summary strip — spans the full window width below the header.
          relative + z-20 keeps it stacked above the orbital's overflowing
          backdrop circle (which lives in <main> and bleeds upward). */}
      <div className="relative z-20 border-b border-border/60 bg-background/40 backdrop-blur-sm">
        <div className="px-6 py-3">
          <SprintSummary credStatus={credStatus} />
        </div>
      </div>

      <main className={`flex-1 flex ${isOrbital ? "flex-col min-h-0" : "items-center"}`}>
          <div
            className={
              isOrbital
                ? "flex-1 w-full flex flex-col gap-3 px-3 sm:px-4 py-3 min-h-0"
                : "w-full max-w-5xl mx-auto px-6 py-6 space-y-6 bg-background/60 rounded-xl"
            }
          >
            {!allComplete && (
              <div className={isOrbital ? "max-w-6xl mx-auto w-full" : undefined}>
                <MissingCredentialsBanner credStatus={credStatus} />
              </div>
            )}

            {(() => {
              const renderable: RenderableCard[] = WORKFLOW_CARDS.map((card) => {
                const description =
                  card.id === "meetings" && transcriptionDisabled
                    ? "Capture freeform notes about your meetings — then ask an AI about past conversations"
                    : card.description;
                let badge: RenderableCard["badge"] = null;
                if (card.id === "implement-ticket" && implementActive) {
                  badge = { kind: "session", label: implementBadgeLabel ?? "In progress" };
                } else if (card.id === "review-pr" && prActive) {
                  badge = { kind: "session", label: prBadgeLabel ?? "In progress" };
                } else if (card.id === "sprint-dashboard" && workloadNeedsAttention) {
                  const parts: string[] = [];
                  if (overloadedDevs.length > 0) parts.push(`${overloadedDevs.length} overloaded`);
                  if (underutilisedDevs.length > 0) parts.push(`${underutilisedDevs.length} under-utilised`);
                  badge = { kind: "attention", label: parts.join(", ") };
                }
                return {
                  id: card.id,
                  Icon: WORKFLOW_ICONS[card.id],
                  title: card.title,
                  description,
                  badge,
                };
              });
              switch (layoutId) {
                case "bento":   return <BentoLayout      cards={renderable} onNavigate={onNavigate} />;
                case "shaped":  return <ShapedLayout     cards={renderable} onNavigate={onNavigate} />;
                case "orbital": return <OrbitalLayout    cards={renderable} onNavigate={onNavigate} />;
                default:        return <ConstellationLayout cards={renderable} onNavigate={onNavigate} />;
              }
            })()}
          </div>
        </main>

    </div>
  );
}
