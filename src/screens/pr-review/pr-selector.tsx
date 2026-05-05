import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Button } from "@/components/ui/button";
import { priorityColor, priorityRank } from "@/lib/priority";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import {
    CheckCircle2,
    GitPullRequest,
    Loader2,
    RefreshCw,
    Sparkles,
    ThumbsDown,
    ThumbsUp,
} from "lucide-react";
import { useMemo, useState } from "react";

function prAge(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

interface PrSelectorProps {
  prsForReview: BitbucketPr[];
  allOpenPrs: BitbucketPr[];
  loading: boolean;
  onSelect: (pr: BitbucketPr) => void;
  onRefresh: () => void;
  jiraBaseUrl: string;
  myAccountId: string;
  /** Set of PR ids that have a cached review result — shows a badge on those rows */
  cachedPrIds: Set<number>;
  /** Set of PR ids where new commits have arrived since the last review */
  stalePrIds: Set<number>;
  /** Linked JIRA issues keyed by issue key — used for the priority badge / sort */
  linkedIssuesByKey: Map<string, import("@/lib/tauri/jira").JiraIssue>;
}

type PrSortMode = "priority" | "age" | "updated";

export function PrSelector({ prsForReview, allOpenPrs, loading, onSelect, onRefresh, jiraBaseUrl, myAccountId, cachedPrIds, stalePrIds, linkedIssuesByKey }: PrSelectorProps) {
  const [showAll, setShowAll] = useState(false);
  const [hideApproved, setHideApproved] = useState(true);
  const [sortMode, setSortMode] = useState<PrSortMode>("updated");

  const baseList = showAll ? allOpenPrs : prsForReview;

  // Determine which PRs the current user has already approved
  const isApproved = (pr: BitbucketPr) =>
    !!myAccountId && pr.reviewers.some((r) => r.user.accountId === myAccountId && r.approved);

  // True when the current user has marked the PR as Needs Changes
  const iRequestedChanges = (pr: BitbucketPr) =>
    !!myAccountId &&
    pr.reviewers.some(
      (r) =>
        r.user.accountId === myAccountId &&
        r.state.toLowerCase() === "changes_requested",
    );

  const priorityFor = (pr: BitbucketPr): string | null =>
    pr.jiraIssueKey ? linkedIssuesByKey.get(pr.jiraIssueKey)?.priority ?? null : null;

  const approvedCount = baseList.filter(isApproved).length;
  const filtered = hideApproved ? baseList.filter((pr) => !isApproved(pr)) : baseList;

  const list = useMemo(() => {
    const sorted = [...filtered];
    if (sortMode === "priority") {
      // Lower rank = higher priority. Tie-break newest-updated first so new
      // activity floats up within a priority bucket.
      sorted.sort((a, b) => {
        const cmp = priorityRank(priorityFor(a)) - priorityRank(priorityFor(b));
        if (cmp !== 0) return cmp;
        return b.updatedOn.localeCompare(a.updatedOn);
      });
    } else if (sortMode === "age") {
      // Oldest first — surfaces stale PRs that have been waiting longest.
      sorted.sort((a, b) => a.createdOn.localeCompare(b.createdOn));
    } else {
      // "updated" — most recently updated first.
      sorted.sort((a, b) => b.updatedOn.localeCompare(a.updatedOn));
    }
    return sorted;
  }, [filtered, sortMode, linkedIssuesByKey]);

  function PrRow({ pr }: { pr: BitbucketPr }) {
    const iApproved = isApproved(pr);
    const iNeedsChanges = iRequestedChanges(pr);
    const hasCache = cachedPrIds.has(pr.id);
    const isStale = stalePrIds.has(pr.id);
    const approvalCount = pr.reviewers.filter((r) => r.approved).length;
    const reviewerCount = pr.reviewers.length;
    const priority = priorityFor(pr);

    return (
      <button
        onClick={() => onSelect(pr)}
        className="w-full text-left px-4 py-3 rounded-md border bg-card/60 hover:bg-muted/60 transition-colors space-y-1"
      >
        <div className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs font-mono text-muted-foreground">#{pr.id}</span>
          {iApproved && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> Approved
            </span>
          )}
          {iNeedsChanges && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-300/40 dark:border-amber-700/40">
              <ThumbsDown className="h-3 w-3" /> Needs Changes
            </span>
          )}
          {priority && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border border-border bg-muted/40 ${priorityColor(priority)}`}
              title={`JIRA priority: ${priority}`}
            >
              {priority}
            </span>
          )}
          {hasCache && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
              <Sparkles className="h-3 w-3" /> Reviewed
            </span>
          )}
          {hasCache && isStale && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border border-amber-300/40 dark:border-amber-700/40">
              <RefreshCw className="h-3 w-3" /> New commits
            </span>
          )}
          <span className="ml-auto text-xs text-muted-foreground shrink-0">{prAge(pr.createdOn)}</span>
        </div>
        <p className="text-sm font-medium leading-snug">{pr.title}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{pr.author.displayName}</span>
          <span>·</span>
          <span className="font-mono">{pr.sourceBranch.slice(0, 30)}</span>
          {pr.jiraIssueKey && (
            <>
              <span>·</span>
              <JiraTicketLink
                ticketKey={pr.jiraIssueKey}
                url={jiraBaseUrl ? `${jiraBaseUrl.replace(/\/$/, "")}/browse/${pr.jiraIssueKey}` : null}
              />
            </>
          )}
          {pr.commentCount > 0 && (
            <>
              <span>·</span>
              <span>{pr.commentCount} comments</span>
            </>
          )}
          {reviewerCount > 0 && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <ThumbsUp className="h-3 w-3" />
                {approvalCount}/{reviewerCount} approvals
              </span>
            </>
          )}
        </div>
      </button>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading PRs…
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold">
          {showAll ? "All open PRs" : "PRs assigned to you for review"}
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Sort:</span>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as PrSortMode)}
              className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="updated">Recently updated</option>
              <option value="age">PR age (oldest first)</option>
              <option value="priority">JIRA priority</option>
            </select>
          </label>
          {/* Hide approved toggle — only meaningful when the user has an accountId */}
          {myAccountId && approvedCount > 0 && (
            <button
              onClick={() => setHideApproved(!hideApproved)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
                hideApproved
                  ? "bg-muted text-muted-foreground border-border hover:text-foreground"
                  : "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-700"
              }`}
              title={hideApproved ? `Show ${approvedCount} approved PR${approvedCount !== 1 ? "s" : ""}` : "Hide approved PRs"}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {hideApproved ? `${approvedCount} approved hidden` : "Showing approved"}
            </button>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show mine only" : "Show all open"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            title="Re-fetch the PR list from Bitbucket"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-2">
          <GitPullRequest className="h-8 w-8 opacity-40" />
          <p className="text-sm">
            {showAll
              ? hideApproved && approvedCount > 0
                ? `All open PRs are already approved by you.`
                : "No open PRs found."
              : hideApproved && approvedCount > 0
                ? `All PRs assigned to you are already approved.`
                : "No PRs assigned to you for review."}
          </p>
          {hideApproved && approvedCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setHideApproved(false)}>
              Show approved PRs
            </Button>
          ) : !showAll ? (
            <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
              Show all open PRs
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((pr) => <PrRow key={pr.id} pr={pr} />)}
        </div>
      )}
    </div>
  );
}
