import { useEffect, useState, useMemo } from "react";
import { AlertTriangle, Settings, TrendingUp, CheckSquare, GitPullRequest } from "lucide-react";

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
import { fireShootingStar } from "@/lib/backgrounds";
import { fireSupernova, fireBlackHole, fireComet, firePulsar, fireMeteorShower, fireWormhole, clearAllEffects, setEffectsEnabled } from "@/lib/spaceEffects";
import {
  type CredentialStatus,
  type JiraSprint,
  type JiraIssue,
  type BitbucketPr,
  anthropicComplete,
  jiraComplete,
  bitbucketComplete,
  getActiveSprint,
  getActiveSprintIssues,
  getPrsForReview,
} from "@/lib/tauri";
import type { WorkflowId } from "@/screens/WorkflowScreen";

interface LandingScreenProps {
  credStatus: CredentialStatus;
  onOpenSettings: () => void;
  onNavigate: (workflow: WorkflowId) => void;
}

// ── Missing credentials banner ────────────────────────────────────────────────

function MissingCredentialsBanner({
  credStatus,
  onOpenSettings,
}: {
  credStatus: CredentialStatus;
  onOpenSettings: () => void;
}) {
  const missing: string[] = [];
  if (!anthropicComplete(credStatus)) missing.push("Anthropic");
  if (!jiraComplete(credStatus)) missing.push("JIRA");
  if (!bitbucketComplete(credStatus)) missing.push("Bitbucket");

  if (missing.length === 0) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        Missing credentials: <strong>{missing.join(", ")}</strong>. Some features won't work
        until they're configured.
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenSettings}
        className="shrink-0 border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
      >
        Configure
      </Button>
    </div>
  );
}

// ── Sprint summary widget ─────────────────────────────────────────────────────

interface SprintData {
  sprint: JiraSprint | null;
  issues: JiraIssue[];
  prs: BitbucketPr[];
}

function StatPill({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card/60 px-3 py-2 text-sm">
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function SprintSummary({ credStatus }: { credStatus: CredentialStatus }) {
  const [data, setData] = useState<SprintData | null>(null);
  const [error, setError] = useState(false);

  const canFetch = jiraComplete(credStatus) && bitbucketComplete(credStatus);

  useEffect(() => {
    if (!canFetch) return;
    Promise.all([getActiveSprint(), getActiveSprintIssues(), getPrsForReview()])
      .then(([sprint, issues, prs]) => setData({ sprint, issues, prs }))
      .catch(() => setError(true));
  }, [canFetch]);

  // Not configured yet — show inert placeholder
  if (!canFetch) {
    return (
      <div className="flex flex-wrap gap-2">
        <StatPill icon={TrendingUp} label="Sprint" value="—" />
        <StatPill icon={CheckSquare} label="Tickets done" value="—/—" />
        <StatPill icon={GitPullRequest} label="PRs to review" value="—" />
      </div>
    );
  }

  if (!data || error) {
    // Loading or silently failed
    return (
      <div className="flex flex-wrap gap-2">
        <StatPill icon={TrendingUp} label="Sprint" value="…" />
        <StatPill icon={CheckSquare} label="Tickets done" value="…" />
        <StatPill icon={GitPullRequest} label="PRs to review" value="…" />
      </div>
    );
  }

  const { sprint, issues, prs } = data;

  const doneCount = issues.filter((i) => i.statusCategory === "Done").length;
  const totalCount = issues.length;

  const daysRemaining = sprint?.endDate
    ? Math.ceil((new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000)
    : null;

  const sprintLabel = sprint
    ? daysRemaining !== null
      ? `${sprint.name} · ${daysRemaining > 0 ? `${daysRemaining}d left` : "ended"}`
      : sprint.name
    : "No active sprint";

  return (
    <div className="flex flex-wrap gap-2">
      <StatPill icon={TrendingUp} label="Sprint" value={sprintLabel} />
      <StatPill
        icon={CheckSquare}
        label="Tickets done"
        value={totalCount > 0 ? `${doneCount}/${totalCount}` : "—"}
      />
      <StatPill icon={GitPullRequest} label="PRs to review" value={String(prs.length)} />
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
    description: "AI-assisted code review across 4 analysis lenses",
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
    title: "Ticket Quality Checker",
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
];


// ── Landing screen ────────────────────────────────────────────────────────────

export function LandingScreen({ credStatus, onOpenSettings, onNavigate }: LandingScreenProps) {
  const quip = useMemo(
    () => QUIPS[Math.floor(Math.random() * QUIPS.length)],
    []
  );
  const allComplete =
    anthropicComplete(credStatus) && jiraComplete(credStatus) && bitbucketComplete(credStatus);

  const [hideContent, setHideContent] = useState(false);
  const [effectsOn, setEffectsOn] = useState(true);

  function toggleEffects() {
    const next = !effectsOn;
    setEffectsOn(next);
    setEffectsEnabled(next);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="font-semibold tracking-tight">Meridian</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={onOpenSettings}>
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {!hideContent && (
        <main className="flex-1 flex items-center">
          <div className="w-full max-w-5xl mx-auto px-6 py-8 space-y-8 bg-background/60 rounded-xl">
            {!allComplete && (
              <MissingCredentialsBanner credStatus={credStatus} onOpenSettings={onOpenSettings} />
            )}

            <div className="space-y-3">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight mb-1">{quip}</h1>
              </div>
              <SprintSummary credStatus={credStatus} />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {WORKFLOW_CARDS.map((card) => (
                <button
                  key={card.id}
                  onClick={() => onNavigate(card.id)}
                  className="group flex flex-col gap-2 rounded-xl border bg-card/60 p-4 text-left transition-colors hover:bg-accent/60 cursor-pointer"
                >
                  <span className="text-2xl">{card.emoji}</span>
                  <div>
                    <p className="text-sm font-medium leading-snug">{card.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                      {card.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </main>
      )}

      {/* TEMP: space effects test buttons */}
      <div className="fixed bottom-4 left-0 right-0 z-50 flex justify-center">
        <div className="flex flex-wrap justify-center gap-1.5 bg-black/30 backdrop-blur-sm border border-white/10 rounded-2xl px-3 py-2">
          {/* Hide/show content */}
          <button
            onClick={() => setHideContent(h => !h)}
            className="rounded-full bg-white/15 border border-white/25 px-3 py-1.5 text-xs text-white/80 hover:bg-white/25 transition-colors"
          >
            {hideContent ? "◧ show" : "◨ hide"}
          </button>
          <div className="w-px bg-white/15 self-stretch mx-0.5" />
          {/* Effects toggle switch */}
          <button
            onClick={toggleEffects}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
              effectsOn
                ? "bg-white/20 border-white/35 text-white/90 hover:bg-white/30"
                : "bg-white/5 border-white/15 text-white/40 hover:bg-white/10"
            }`}
          >
            {effectsOn ? "⬤ fx on" : "○ fx off"}
          </button>
          {/* Clear all */}
          <button
            onClick={clearAllEffects}
            className="rounded-full bg-red-500/20 border border-red-400/30 px-3 py-1.5 text-xs text-red-300/80 hover:bg-red-500/30 transition-colors"
          >
            ✕ clear
          </button>
          <div className="w-px bg-white/15 self-stretch mx-0.5" />
          {/* Individual effect buttons */}
          {(
            [
              ["✦", "shooting star",  fireShootingStar],
              ["☄", "comet",          fireComet],
              ["⁂", "meteor shower",  fireMeteorShower],
              ["☉", "supernova",      fireSupernova],
              ["◉", "black hole",     fireBlackHole],
              ["✷", "pulsar",         firePulsar],
              ["⊕", "wormhole",       fireWormhole],
            ] as [string, string, () => void][]
          ).map(([icon, label, fn]) => (
            <button
              key={label}
              onClick={fn}
              className="rounded-full bg-white/10 border border-white/20 px-3 py-1.5 text-xs text-white/70 hover:bg-white/20 transition-colors"
            >
              {icon} {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
