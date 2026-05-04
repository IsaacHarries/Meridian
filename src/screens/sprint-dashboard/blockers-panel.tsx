import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { openUrl } from "@/lib/tauri/core";
import { type JiraIssue } from "@/lib/tauri/jira";
import { AlertTriangle } from "lucide-react";
import {
    daysSince,
    isBlocked,
    isInReview,
    statusCategory,
} from "./_shared";

// ── Blockers & risks panel ────────────────────────────────────────────────────

interface RiskMeta {
  label: string;
  value: string;
}

export interface Risk {
  key: string;
  summary: string;
  type: "blocked" | "stale-pr" | "no-progress" | "not-started";
  metadata: RiskMeta[];
  url?: string;
}

export function buildRisks(
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

export function BlockersPanel({
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
