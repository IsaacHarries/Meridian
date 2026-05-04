import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { openUrl } from "@/lib/tauri/core";
import { type JiraIssue } from "@/lib/tauri/jira";
import { ExternalLink, Loader2, Sparkles } from "lucide-react";
import { FieldDiagnostics } from "./field-diagnostics";

export function TicketSummaryCard({
  issue,
  analyzed,
  analyzing,
  onAnalyze,
  claudeAvailable,
}: {
  issue: JiraIssue;
  analyzed: boolean;
  analyzing: boolean;
  onAnalyze: () => void;
  claudeAvailable: boolean;
}) {
  // Primary AI button label switches based on whether we've analysed yet,
  // so the user knows the AI hasn't already silently kicked off when they
  // first open a ticket.
  const analyseLabel = analyzing
    ? "Analysing…"
    : analyzed
      ? "Re-analyse"
      : "Start analysis";
  return (
    <Card className="shrink-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <JiraTicketLink ticketKey={issue.key} url={issue.url} />
              <Badge variant="outline" className="text-xs">{issue.issueType}</Badge>
              {issue.storyPoints != null && <Badge variant="secondary" className="text-xs">{issue.storyPoints} pts</Badge>}
              {issue.priority && <Badge variant="outline" className="text-xs">{issue.priority}</Badge>}
            </div>
            <CardTitle className="text-base leading-snug">{issue.summary}</CardTitle>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant={analyzed ? "outline" : "default"}
              size="sm"
              onClick={onAnalyze}
              disabled={analyzing || !claudeAvailable}
              title={
                !claudeAvailable
                  ? "AI provider not configured — see Settings"
                  : analyzed
                    ? "Run the AI grooming agent again"
                    : "Run the AI grooming agent on this ticket"
              }
            >
              {analyzing ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1" />
              )}
              {analyseLabel}
            </Button>
            <Button variant="outline" size="sm" onClick={() => issue.url && openUrl(issue.url)} title="Open in JIRA">
              <ExternalLink className="h-3.5 w-3.5 mr-1" /> JIRA
            </Button>
          </div>
        </div>
        {issue.epicSummary && <p className="text-xs text-muted-foreground mt-1">Epic: {issue.epicSummary}</p>}
      </CardHeader>
      <CardContent className="pt-0 border-t">
        <FieldDiagnostics issue={issue} />
      </CardContent>
    </Card>
  );
}
