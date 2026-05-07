import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { openUrl } from "@/lib/tauri/core";
import { type JiraIssue } from "@/lib/tauri/jira";
import { Check, ExternalLink, Loader2, Pencil, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type DraftChange } from "./_shared";
import { DiffParagraphBlock } from "./diff-view";
import { FieldDiagnostics } from "./field-diagnostics";

/**
 * Top-of-panel summary card. Owns the inline-editable ticket title and
 * surfaces any AI-suggested replacement title as a small strip next to
 * it — the same Accept / Decline contract the inline FieldEditor uses,
 * but stripped down to a single line because a title is one-shot text
 * (no per-paragraph diff to negotiate). Accepting a suggestion loads
 * the proposed text into the editor and flips into edit mode so the
 * user can review and click Save before it actually goes to JIRA;
 * Decline marks the suggestion declined without touching the title.
 *
 * Title-case enforcement happens upstream in `saveFieldEdit` — the user
 * can type whatever they like, and JIRA will receive the title cased
 * version on save (and on AI-suggested applies via the bulk path).
 */
export function TicketSummaryCard({
  issue,
  analyzed,
  analyzing,
  onAnalyze,
  claudeAvailable,
  pendingDraft,
  onSaveSummary,
  onAcceptSuggestion,
  onDeclineSuggestion,
}: {
  issue: JiraIssue;
  analyzed: boolean;
  analyzing: boolean;
  onAnalyze: () => void;
  claudeAvailable: boolean;
  /** Pending AI suggestion targeting the `summary` field, if any. */
  pendingDraft?: DraftChange;
  /** Persist a typed/accepted title to JIRA. Caller normalises casing. */
  onSaveSummary: (newValue: string) => Promise<void>;
  onAcceptSuggestion: (draftId: string) => void;
  onDeclineSuggestion: (draftId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.summary);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the editor's local draft in sync with the underlying issue
  // when it changes externally (ticket switch, post-save refetch). We
  // only resync while NOT editing — typing should never get clobbered
  // by an in-flight refetch landing.
  useEffect(() => {
    if (!editing) {
      setDraft(issue.summary);
      setError(null);
    }
  }, [issue.summary, issue.id, editing]);

  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(issue.summary);
    setError(null);
    setEditing(true);
    // Defer focus until React has rendered the input.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancelEdit() {
    setDraft(issue.summary);
    setError(null);
    setEditing(false);
  }

  async function commit() {
    if (saving) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === issue.summary.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSaveSummary(trimmed);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Accepting a suggestion loads it into the editor and flips on edit
  // mode rather than auto-saving — keeps the human-in-the-loop contract:
  // the agent proposes, the user confirms via Save.
  function acceptSuggestion() {
    if (!pendingDraft) return;
    setDraft(pendingDraft.editedSuggested);
    setError(null);
    setEditing(true);
    onAcceptSuggestion(pendingDraft.id);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const analyseLabel = analyzing
    ? "Analysing…"
    : analyzed
      ? "Re-analyse"
      : "Start analysis";

  return (
    <Card className="shrink-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <JiraTicketLink ticketKey={issue.key} url={issue.url} />
              <Badge variant="outline" className="text-xs">
                {issue.issueType}
              </Badge>
              {issue.storyPoints != null && (
                <Badge variant="secondary" className="text-xs">
                  {issue.storyPoints} pts
                </Badge>
              )}
              {issue.priority && (
                <Badge variant="outline" className="text-xs">
                  {issue.priority}
                </Badge>
              )}
            </div>
            {editing ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Input
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    placeholder="Ticket title"
                    disabled={saving}
                    className="h-8 text-sm"
                  />
                  <Button
                    size="sm"
                    className="h-8 px-2 gap-1"
                    onClick={() => void commit()}
                    disabled={saving || !draft.trim()}
                  >
                    {saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2 gap-1"
                    onClick={cancelEdit}
                    disabled={saving}
                  >
                    <X className="h-3.5 w-3.5" />
                    Cancel
                  </Button>
                </div>
                {error && (
                  <p className="text-xs text-destructive">{error}</p>
                )}
              </div>
            ) : (
              <div className="group flex items-start gap-1.5">
                <CardTitle className="text-base leading-snug">
                  {issue.summary}
                </CardTitle>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 opacity-60 group-hover:opacity-100"
                  onClick={startEdit}
                  title="Edit title"
                  aria-label="Edit title"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </div>
            )}
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => issue.url && openUrl(issue.url)}
              title="Open in JIRA"
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1" /> JIRA
            </Button>
          </div>
        </div>
        {pendingDraft && (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="font-medium text-foreground">
                AI suggests a new title
              </span>
              {pendingDraft.reasoning && (
                <span className="italic leading-snug truncate">
                  — {pendingDraft.reasoning}
                </span>
              )}
            </div>
            {/* Red/green diff so the user can scan exactly what's
                changing. Actions dock on the green (added) block to
                mirror the inline-diff convention used by FieldEditor for
                description / AC / bug fields — Accept = adopt the new
                title, Decline = keep the existing one. */}
            <DiffParagraphBlock
              kind="removed"
              text={pendingDraft.current ?? issue.summary}
            />
            <DiffParagraphBlock
              kind="added"
              text={pendingDraft.editedSuggested}
              actions={
                <div className="flex gap-1 shrink-0">
                  <Button
                    size="sm"
                    className="h-5 px-1.5 text-[11px] gap-1"
                    onClick={acceptSuggestion}
                    title="Accept this change"
                  >
                    <Check className="h-3 w-3" />
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1.5 text-[11px] gap-1"
                    onClick={() => onDeclineSuggestion(pendingDraft.id)}
                    title="Keep the existing title instead"
                  >
                    <X className="h-3 w-3" />
                    Decline
                  </Button>
                </div>
              }
            />
          </div>
        )}
        {issue.epicSummary && (
          <p className="text-xs text-muted-foreground mt-1">
            Epic: {issue.epicSummary}
          </p>
        )}
      </CardHeader>
      <CardContent className="pt-0 border-t">
        <FieldDiagnostics issue={issue} />
      </CardContent>
    </Card>
  );
}
