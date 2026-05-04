import { GitCommit, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function DiffReviewStep({
  finalDiff,
  commitMessage,
  setCommitMessage,
  stepError,
  onCommit,
  onBack,
}: {
  finalDiff: string;
  commitMessage: string;
  setCommitMessage: (s: string) => void;
  stepError: string | null;
  onCommit: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card/60 p-4">
        <h2 className="text-sm font-semibold mb-3">Review Changes Before Committing</h2>
        {finalDiff ? (
          <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-[500px] overflow-y-auto bg-muted/50 rounded p-3">
            {finalDiff}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">No changes detected in the worktree.</p>
        )}
      </div>

      <div className="rounded-xl border bg-card/60 p-4 space-y-3">
        <h2 className="text-sm font-semibold">Commit Message</h2>
        <Textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Enter a commit message…"
          className="font-mono text-sm min-h-[80px]"
        />
        {stepError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <X className="h-4 w-4 shrink-0" /> {stepError}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            onClick={onCommit}
            disabled={!commitMessage.trim() || !finalDiff}
            className="gap-1.5"
          >
            <GitCommit className="h-4 w-4" />
            Commit Changes
          </Button>
          <Button
            variant="ghost"
            onClick={onBack}
          >
            Back to Fix Plan
          </Button>
        </div>
      </div>
    </div>
  );
}
