import { GitCommit, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type WorkflowStep } from "./_shared";

export function CommitPushStep({
  step,
  stepMessage,
  commitSha,
  stepError,
  onPush,
  onBack,
}: {
  step: WorkflowStep;
  stepMessage: string;
  commitSha: string;
  stepError: string | null;
  onPush: () => void;
  onBack: () => void;
}) {
  return (
    <div className="rounded-xl border bg-card/60 p-6 space-y-4">
      <div className="flex items-center gap-3">
        <GitCommit className="h-5 w-5 text-primary shrink-0" />
        <div>
          <p className="text-sm font-medium">{stepMessage}</p>
          {commitSha && (
            <p className="text-xs text-muted-foreground font-mono mt-0.5">sha: {commitSha}</p>
          )}
        </div>
      </div>

      {stepError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <X className="h-4 w-4 shrink-0" /> {stepError}
        </div>
      )}

      {step === "pushing" && (
        <div className="flex gap-2">
          <Button onClick={onPush} className="gap-1.5">
            <Upload className="h-4 w-4" />
            Push to Origin
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Done for now (don't push yet)
          </Button>
        </div>
      )}
    </div>
  );
}
