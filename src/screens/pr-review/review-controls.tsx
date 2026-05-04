import { Button } from "@/components/ui/button";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type ReviewReport } from "@/lib/tauri/pr-review";
import {
    Check,
    Download,
    GitBranch,
    Loader2,
    Play,
    RefreshCw,
    Sparkles,
    Square,
} from "lucide-react";

interface ReviewControlsProps {
  reviewing: boolean;
  claudeAvailable: boolean;
  loadingDetails: boolean;
  diffStale: boolean;
  report: ReviewReport | null;
  checkoutStatus: "idle" | "checking-out" | "ready" | "error";
  checkoutError: string;
  worktreeBranch: string | null;
  selectedPr: BitbucketPr | null;
  pullingBranch: boolean;
  pullBranchError: string;
  pullBranchSuccess: boolean;
  checkingForUpdates: boolean;
  runCommand: string;
  setRunCommand: (s: string) => void;
  runCommandError: string;
  setRunCommandError: (s: string) => void;
  runningCommand: boolean;
  onRunReview: () => void;
  onCancelReview: () => void;
  onPullBranch: () => void;
  onRunInTerminal: () => void;
}

export function ReviewControls({
  reviewing,
  claudeAvailable,
  loadingDetails,
  diffStale,
  report,
  checkoutStatus,
  checkoutError,
  worktreeBranch,
  selectedPr,
  pullingBranch,
  pullBranchError,
  pullBranchSuccess,
  checkingForUpdates,
  runCommand,
  setRunCommand,
  runCommandError,
  setRunCommandError,
  runningCommand,
  onRunReview,
  onCancelReview,
  onPullBranch,
  onRunInTerminal,
}: ReviewControlsProps) {
  return (
    <div className="p-4 border-b shrink-0">
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          onClick={() => reviewing ? onCancelReview() : onRunReview()}
          disabled={!reviewing && (!claudeAvailable || loadingDetails)}
          variant={reviewing ? "destructive" : "default"}
          className={`gap-2 flex-1 ${!reviewing && diffStale ? "ring-2 ring-amber-500/60" : ""}`}
        >
          {reviewing ? (
            <><Square className="h-4 w-4" /> Stop review</>
          ) : report ? (
            <><RefreshCw className="h-4 w-4" /> Re-run review</>
          ) : (
            <><Sparkles className="h-4 w-4" /> Run AI Review</>
          )}
        </Button>
        {checkoutStatus === "checking-out" && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Checking out branch…
          </span>
        )}
        {checkoutStatus === "ready" && worktreeBranch && (
          <span className="flex items-center gap-1.5 text-xs text-green-600">
            <GitBranch className="h-3 w-3" /> {worktreeBranch}
          </span>
        )}
        {checkoutStatus === "error" && (
          <span className="flex items-center gap-1.5 text-xs text-amber-600" title={`Branch checkout failed: ${checkoutError}`}>
            <GitBranch className="h-3 w-3" /> Branch checkout failed
          </span>
        )}
        {/* Pull branch button — re-fetches and checks out the PR branch in the worktree */}
        {selectedPr?.sourceBranch && (
          <button
            onClick={onPullBranch}
            disabled={pullingBranch || reviewing}
            title={`Pull ${selectedPr.sourceBranch} into the worktree`}
            className="shrink-0 flex items-center gap-1.5 px-2 h-7 rounded-md border border-input bg-background text-xs text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {pullingBranch
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : pullBranchSuccess
              ? <Check className="h-3 w-3 text-green-600" />
              : <Download className="h-3 w-3" />}
            {pullingBranch ? "Pulling…" : pullBranchSuccess ? "Pulled" : "Pull branch"}
          </button>
        )}
      </div>
      {pullBranchError && (
        <p className="mt-1 text-[11px] text-destructive leading-snug">{pullBranchError}</p>
      )}

      {/* Stale diff banner */}
      {diffStale && !reviewing && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <RefreshCw className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            <span className="font-medium">New commits detected.</span>{" "}
            The diff has been refreshed with the latest changes.
            Re-run the AI review to assess the updated code.
          </span>
        </div>
      )}

      {/* Checking for updates indicator */}
      {checkingForUpdates && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Checking for new commits…
        </div>
      )}

      {/* ── Run branch command ── */}
      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={runCommand}
          onChange={(e) => { setRunCommand(e.target.value); setRunCommandError(""); }}
          className="flex-1 min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
          placeholder="command to run…"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter" && runCommand.trim() && !runningCommand && checkoutStatus === "ready") {
              e.preventDefault();
              onRunInTerminal();
            }
          }}
          disabled={runningCommand || checkoutStatus !== "ready"}
        />
        <button
          onClick={onRunInTerminal}
          disabled={!runCommand.trim() || runningCommand || checkoutStatus !== "ready"}
          title={checkoutStatus !== "ready" ? "Pull the branch first to enable running commands" : "Open a Terminal window and run this command in the worktree directory"}
          className="shrink-0 flex items-center justify-center h-7 w-7 rounded-md bg-green-600 text-white hover:bg-green-700 active:bg-green-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {runningCommand
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Play className="h-3.5 w-3.5 ml-0.5" />}
        </button>
      </div>
      {runCommandError && (
        <p className="mt-1 text-[11px] text-destructive leading-snug">{runCommandError}</p>
      )}
    </div>
  );
}
