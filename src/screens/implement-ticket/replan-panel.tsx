import { Button } from "@/components/ui/button";
import { type ReplanCheckpointPayload } from "@/lib/tauri/worktree";
import {
    AlertTriangle,
    ChevronRight,
    FileCode,
    Loader2,
    RefreshCw,
    X,
} from "lucide-react";

/** Surfaces the `replan` checkpoint payload — per-file post-write verification
 *  failures, prior plan, and the partial files already on disk. The
 *  three-button approval row (Revise / Accept partial / Abort) is rendered by
 *  the screen, not this panel. */
export function ReplanPanel({ data }: { data: ReplanCheckpointPayload }) {
  const reasonLabel: Record<ReplanCheckpointPayload["reason"], string> = {
    verification_failed:
      "One or more files didn't end up in the expected state on disk after the implementation pass.",
    user_requested: "Plan revision requested.",
  };
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
            Plan revision suggested
          </p>
        </div>
        <p className="text-sm text-amber-900/90 dark:text-amber-100/90">
          {reasonLabel[data.reason]}
        </p>
        <p className="text-xs text-muted-foreground">
          {data.revisions_remaining > 0
            ? `Revisions remaining: ${data.revisions_remaining} (used ${data.revisions_used}).`
            : `Revision budget exhausted — accept the partial work or abort.`}
        </p>
      </div>

      {data.verification_failures.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <FileCode className="h-4 w-4 text-muted-foreground" />
            Verification failures ({data.verification_failures.length})
          </div>
          <div className="divide-y">
            {data.verification_failures.map((f, i) => (
              <div key={i} className="px-3 py-2 space-y-1">
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono">{f.path}</code>
                  <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">
                    {f.outcome}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    expected: {f.expected_action}
                  </span>
                </div>
                {f.detail && (
                  <p className="text-xs text-muted-foreground">{f.detail}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.previously_written_files.length > 0 && (
        <div className="rounded-md border bg-muted/20 p-3 space-y-1">
          <p className="text-xs font-medium">
            Files written by the prior plan (still on disk):
          </p>
          <ul className="text-xs text-muted-foreground font-mono space-y-0.5">
            {data.previously_written_files.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            A revised plan can address these files explicitly. Nothing is
            reverted automatically.
          </p>
        </div>
      )}
    </div>
  );
}

/** Three-button approval row used by the `replan` checkpoint. */
export function ReplanApprovalRow({
  onRevise,
  onAccept,
  onAbort,
  proceeding,
  canRevise,
}: {
  onRevise: () => void;
  onAccept: () => void;
  onAbort: () => void;
  proceeding: boolean;
  canRevise: boolean;
}) {
  return (
    <div className="mt-5 border-t pt-4 flex items-center gap-3">
      <Button
        onClick={onAbort}
        disabled={proceeding}
        variant="ghost"
        size="sm"
        className="gap-2"
      >
        <X className="h-4 w-4" />
        Abort
      </Button>
      <div className="ml-auto flex items-center gap-3">
        <Button
          onClick={onAccept}
          disabled={proceeding}
          variant="outline"
          className="gap-2"
        >
          <ChevronRight className="h-4 w-4" />
          Accept partial
        </Button>
        <Button
          onClick={onRevise}
          disabled={proceeding || !canRevise}
          className="gap-2"
          title={canRevise ? undefined : "Revision budget exhausted"}
        >
          {proceeding ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Revise plan
        </Button>
      </div>
    </div>
  );
}
