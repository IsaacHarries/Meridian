import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { type JiraIssue } from "@/lib/tauri/jira";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";
import { type DraftChange, resolveJiraFieldId } from "./_shared";

// ── Draft field row ───────────────────────────────────────────────────────────

function DraftFieldRow({ draft, issue, highlighted, onApprove, onDecline, onEditSuggested }: {
  draft: DraftChange; issue: JiraIssue; highlighted?: boolean;
  onApprove: (id: string) => void; onDecline: (id: string) => void;
  onEditSuggested: (id: string, value: string) => void;
}) {
  const [showFull, setShowFull] = useState(false);
  const cannotResolve = resolveJiraFieldId(draft.field, issue) === null;

  const statusBadge =
    draft.status === "approved"
      ? <Badge className="text-xs bg-green-600 hover:bg-green-600 text-white">{draft.applyResult === "ok" ? "Applied ✓" : "Approved"}</Badge>
      : draft.status === "declined"
      ? <Badge variant="outline" className="text-xs text-muted-foreground">Declined</Badge>
      : <Badge variant="secondary" className="text-xs">Pending</Badge>;

  const borderClass = highlighted
    ? "border-primary/70 bg-primary/5 dark:bg-primary/10"
    : draft.status === "approved"
    ? "border-green-200 dark:border-green-900 bg-green-50/30 dark:bg-green-950/20"
    : "";

  return (
    <div className={`border rounded-lg p-3 space-y-2 transition-colors duration-700 ${borderClass} ${draft.status === "declined" ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{draft.section}</span>
        {statusBadge}
      </div>
      {draft.userEdited && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0" /> You've edited this — AI may have updated its suggestion separately
        </p>
      )}
      {cannotResolve && draft.status !== "declined" && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0" /> Field ID not auto-discovered — cannot apply to JIRA
        </p>
      )}
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-0.5">Current</p>
        {draft.current
          ? <div className="relative">
              <p className={`text-xs text-muted-foreground leading-relaxed ${showFull ? "" : "line-clamp-3"}`}>{draft.current}</p>
              {draft.current.length > 200 && <button className="text-xs text-primary mt-0.5" onClick={() => setShowFull((v) => !v)}>{showFull ? "Show less" : "Show more"}</button>}
            </div>
          : <p className="text-xs text-muted-foreground italic">(none)</p>}
      </div>
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-0.5">Proposed</p>
        <Textarea value={draft.editedSuggested} onChange={(e) => onEditSuggested(draft.id, e.target.value)} rows={4} className="text-xs resize-y" disabled={draft.status === "declined"} />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{draft.reasoning}</p>
      {draft.applyResult === "error" && draft.applyError && (
        <p className="text-xs text-destructive leading-relaxed">{draft.applyError}</p>
      )}
      <div className="flex gap-2">
        {draft.status === "pending" && <>
          <Button size="sm" variant="default" className="h-7 text-xs" onClick={() => onApprove(draft.id)} disabled={cannotResolve}>Approve</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onDecline(draft.id)}>Decline</Button>
        </>}
        {draft.status === "approved" && draft.applyResult !== "ok" && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onDecline(draft.id)}>Decline</Button>
        )}
        {draft.status === "declined" && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onApprove(draft.id)} disabled={cannotResolve}>Re-approve</Button>
        )}
      </div>
    </div>
  );
}

// ── Draft changes panel ───────────────────────────────────────────────────────

export function DraftChangesPanel({ drafts, issue, applying, highlightedIds, onApprove, onDecline, onEditSuggested, onApply }: {
  drafts: DraftChange[]; issue: JiraIssue; applying: boolean; highlightedIds: Set<string>;
  onApprove: (id: string) => void; onDecline: (id: string) => void;
  onEditSuggested: (id: string, value: string) => void; onApply: () => void;
}) {
  const approved = drafts.filter((d) => d.status === "approved");
  const pending = drafts.filter((d) => d.status === "pending");
  const declined = drafts.filter((d) => d.status === "declined");

  return (
    <Card className="shrink-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-semibold">Draft Changes</CardTitle>
          <Button size="sm" onClick={onApply} disabled={approved.length === 0 || applying} className="h-7 text-xs gap-1.5">
            {applying ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying…</> : <>Apply {approved.length > 0 ? `${approved.length} ` : ""}changes to JIRA</>}
          </Button>
        </div>
        {drafts.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">{approved.length} approved · {pending.length} pending · {declined.length} declined</p>
        )}
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {drafts.length === 0
          ? <p className="text-sm text-muted-foreground italic text-center py-4">No changes proposed yet</p>
          : drafts.map((draft) => (
              <DraftFieldRow key={draft.id} draft={draft} issue={issue} highlighted={highlightedIds.has(draft.id)} onApprove={onApprove} onDecline={onDecline} onEditSuggested={onEditSuggested} />
            ))}
      </CardContent>
    </Card>
  );
}
