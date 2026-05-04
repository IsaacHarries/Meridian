import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type BitbucketComment } from "@/lib/tauri/bitbucket";
import { type ReviewFinding, type ReviewLens } from "@/lib/tauri/pr-review";
import { usePrReviewStore } from "@/stores/prReview/store";
import {
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    FileCode,
    ListTodo,
    Loader2,
    MessageCirclePlus,
    Send,
} from "lucide-react";
import { useState } from "react";
import { SeverityBadge, lineRangeToIdeSuffix } from "./_shared";

interface FindingCardProps {
  finding: ReviewFinding;
  onJumpToFile: (path: string, line?: number) => void;
  /** Posts the comment. Returns the created BitbucketComment so a task can be attached. */
  onPostComment: (content: string, file: string | null, lineRange: string | null) => Promise<BitbucketComment>;
}

/**
 * Build a draft comment from a finding.
 * Produces a compact, professional comment suitable for Bitbucket.
 */
function buildDraftComment(finding: ReviewFinding): string {
  const severityLabel =
    finding.severity === "blocking" ? "🚫 Blocking"
    : finding.severity === "non_blocking" ? "⚠️ Non-blocking"
    : "💬 Nitpick";

  const lines = [`**${severityLabel}: ${finding.title}**`, "", finding.description];

  if (finding.file) {
    lines.push("");
    lines.push(`_File: \`${finding.file}${lineRangeToIdeSuffix(finding.line_range)}\`_`);
  }

  return lines.join("\n");
}

/**
 * Build a draft task description from a finding.
 * Produces an actionable one-liner suitable for a Bitbucket task.
 */
function buildDraftTask(finding: ReviewFinding): string {
  return `Address: ${finding.title}`;
}

export function FindingCard({ finding, onJumpToFile, onPostComment }: FindingCardProps) {
  const [expanded, setExpanded] = useState(finding.severity === "blocking");
  const [showDraft, setShowDraft] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [includeTask, setIncludeTask] = useState(true);
  const [draftTaskText, setDraftTaskText] = useState("");
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState("");
  const [posted, setPosted] = useState(false);

  function openDraft() {
    setDraftText(buildDraftComment(finding));
    setDraftTaskText(buildDraftTask(finding));
    setIncludeTask(true);
    setShowDraft(true);
    setPostErr("");
    setPosted(false);
  }

  async function handlePost() {
    if (!draftText.trim() || posting) return;
    setPosting(true);
    setPostErr("");
    try {
      const comment = await onPostComment(draftText.trim(), finding.file, finding.line_range);
      // If the user wants a task attached, create it on the newly posted comment
      if (includeTask && draftTaskText.trim()) {
        try {
          await usePrReviewStore.getState().createTask(comment.id, draftTaskText.trim());
        } catch {
          // Task creation failure is non-fatal — comment was already posted
        }
      }
      setPosted(true);
      setShowDraft(false);
    } catch (e) {
      setPostErr(String(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="mt-0.5 shrink-0">
          <SeverityBadge severity={finding.severity} />
        </div>
        <span className="flex-1 text-sm font-medium leading-snug">{finding.title}</span>
        {posted && (
          <span className="flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5 mr-1">
            <Check className="h-3 w-3" /> Posted
          </span>
        )}
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t bg-muted/20 space-y-2">
          <p className="text-sm text-muted-foreground leading-relaxed">{finding.description}</p>
          <div className="flex items-center gap-3 flex-wrap">
            {finding.file && (
              <button
                onClick={() => {
                  const lineNum = finding.line_range
                    ? (() => { const m = finding.line_range!.match(/\d+/); return m ? parseInt(m[0], 10) : undefined; })()
                    : undefined;
                  onJumpToFile(finding.file!, lineNum);
                }}
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-mono"
              >
                <FileCode className="h-3 w-3" />
                {finding.file}{lineRangeToIdeSuffix(finding.line_range)}
              </button>
            )}
            {!showDraft && (
              <button
                onClick={openDraft}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
                title="Draft a PR comment for this finding"
              >
                <MessageCirclePlus className="h-3.5 w-3.5" />
                {posted ? "Post again" : "Comment on PR"}
              </button>
            )}
          </div>

          {/* Draft comment editor */}
          {showDraft && (
            <div className="mt-2 space-y-2 rounded-md border border-primary/20 bg-background p-3">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Draft comment
                {finding.file
                  ? ` — will post inline on ${finding.file}${lineRangeToIdeSuffix(finding.line_range)}`
                  : " — will post as a general PR comment"}
              </p>
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                className="min-h-[110px] resize-y text-xs font-mono leading-relaxed"
                disabled={posting}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draftText.trim()) {
                    e.preventDefault();
                    handlePost();
                  }
                }}
              />

              {/* Task draft */}
              <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={includeTask}
                    onChange={(e) => setIncludeTask(e.target.checked)}
                    disabled={posting}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <span className="text-xs font-medium flex items-center gap-1">
                    <ListTodo className="h-3.5 w-3.5 text-muted-foreground" />
                    Include a task on this comment
                  </span>
                </label>
                {includeTask && (
                  <Textarea
                    value={draftTaskText}
                    onChange={(e) => setDraftTaskText(e.target.value)}
                    placeholder="Task description…"
                    className="min-h-[44px] resize-y text-xs leading-relaxed"
                    disabled={posting}
                  />
                )}
              </div>

              {postErr && (
                <p className="text-xs text-destructive">{postErr}</p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handlePost}
                  disabled={!draftText.trim() || posting}
                  className="h-7 text-xs gap-1"
                >
                  {posting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="h-3 w-3" />
                  )}
                  {includeTask && draftTaskText.trim() ? "Post comment + task" : "Post comment"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowDraft(false)}
                  disabled={posting}
                  className="h-7 text-xs"
                >
                  Cancel
                </Button>
                <span className="text-[10px] text-muted-foreground">⌘↵ to post</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface LensPanelProps {
  lens: ReviewLens;
  onJumpToFile: (path: string, line?: number) => void;
  onPostComment: (content: string, file: string | null, lineRange: string | null) => Promise<BitbucketComment>;
}

export function LensPanel({ lens, onJumpToFile, onPostComment }: LensPanelProps) {
  const blockingCount = lens.findings.filter((f) => f.severity === "blocking").length;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{lens.assessment}</p>
      {lens.findings.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4" /> No findings
        </div>
      ) : (
        <>
          {blockingCount > 0 && (
            <p className="text-xs font-medium text-red-600 dark:text-red-400">
              {blockingCount} blocking {blockingCount === 1 ? "issue" : "issues"}
            </p>
          )}
          <div className="space-y-2">
            {lens.findings.map((f, i) => (
              <FindingCard key={i} finding={f} onJumpToFile={onJumpToFile} onPostComment={onPostComment} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
