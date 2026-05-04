import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type JiraIssue } from "@/lib/tauri/jira";
import { cn } from "@/lib/utils";
import {
    ChevronDown,
    ChevronRight,
    Eye,
    EyeOff,
    GitPullRequest,
    Minus,
    TrendingDown,
    TrendingUp,
} from "lucide-react";
import { useState } from "react";
import {
    buildWorkloads,
    statusCategory,
    type DevWorkload,
    type LoadStatus,
} from "./_shared";

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
                  <li key={issue.key} className="flex items-center gap-2 text-xs min-w-0">
                    <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="truncate min-w-0 flex-1">{issue.summary}</span>
                      </TooltipTrigger>
                      <TooltipContent>{issue.summary}</TooltipContent>
                    </Tooltip>
                    {issue.storyPoints != null && (
                      <span className="text-muted-foreground/60 shrink-0">
                        {issue.storyPoints}pt
                      </span>
                    )}
                    <Badge variant="secondary" className="text-[10px] shrink-0">
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
                    className="flex items-center gap-2 text-xs text-muted-foreground min-w-0"
                  >
                    <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="truncate line-through min-w-0 flex-1">
                          {issue.summary}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{issue.summary}</TooltipContent>
                    </Tooltip>
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

export function TeamWorkloadSection({
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
            unstartedTickets.length > 0
              ? "lg:grid-cols-[minmax(0,1fr)_360px]"
              : "lg:grid-cols-1",
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
                  <div key={t.key} className="flex items-center gap-2 text-xs min-w-0">
                    <JiraTicketLink ticketKey={t.key} url={t.url} />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="truncate min-w-0 flex-1">{t.summary}</span>
                      </TooltipTrigger>
                      <TooltipContent>{t.summary}</TooltipContent>
                    </Tooltip>
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
