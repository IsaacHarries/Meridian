import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { AlertTriangle, CheckSquare, GitBranch, Loader2, MessageSquare, RefreshCw } from "lucide-react";
import { prAge } from "./_shared";

export function PrListPanel({
  prs,
  loading,
  error,
  onSelect,
  onRefresh,
}: {
  prs: BitbucketPr[];
  loading: boolean;
  error: string | null;
  onSelect: (pr: BitbucketPr) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Select one of your open PRs to address tasks and reviewer comments.
        </p>
        <Button variant="ghost" size="icon" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : prs.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground text-sm">
          No open PRs found.
        </div>
      ) : (
        <div className="space-y-2">
          {prs.map((pr) => (
            <button
              key={pr.id}
              onClick={() => onSelect(pr)}
              className="w-full text-left rounded-lg border bg-card/60 hover:bg-accent/60 transition-colors p-3 space-y-1"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium leading-snug flex-1">{pr.title}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {pr.taskCount > 0 && (
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <CheckSquare className="h-2.5 w-2.5" />
                      {pr.taskCount} task{pr.taskCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                  {pr.commentCount > 0 && (
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <MessageSquare className="h-2.5 w-2.5" />
                      {pr.commentCount} comment{pr.commentCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  {pr.sourceBranch}
                </span>
                <span>{prAge(pr.createdOn)}</span>
                {pr.jiraIssueKey && <span className="font-mono">{pr.jiraIssueKey}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
