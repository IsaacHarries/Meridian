import { Loader2, X } from "lucide-react";
import { type WorkflowStep } from "./_shared";

export function ProgressStep({
  step,
  stepMessage,
  streamBuffer,
  stepError,
}: {
  step: WorkflowStep;
  stepMessage: string;
  streamBuffer: string;
  stepError: string | null;
}) {
  return (
    <div className="rounded-xl border bg-card/60 p-6 flex flex-col items-center justify-center gap-4 min-h-[300px]">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <div className="text-center space-y-1">
        <p className="text-sm font-medium">{stepMessage}</p>
        {step === "analyzing" && streamBuffer && (
          <div className="mt-3 max-w-2xl text-left bg-muted/50 rounded p-3 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
            {streamBuffer}
          </div>
        )}
      </div>
      {stepError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <X className="h-4 w-4 shrink-0" />
          {stepError}
        </div>
      )}
    </div>
  );
}
