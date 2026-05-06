import { type VerificationOutput } from "@/lib/tauri/worktree";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import { useState } from "react";

export function VerificationOutputPanel({
  result,
}: {
  result: VerificationOutput;
}) {
  const [open, setOpen] = useState(false);
  const totalSteps = result.steps.length;
  const passed = result.steps.filter((s) => s.passed).length;
  return (
    <div
      className={cn(
        "border rounded-md overflow-hidden",
        result.clean
          ? "border-green-300 dark:border-green-800"
          : "border-amber-300 dark:border-amber-800",
      )}
    >
      <div
        className={cn(
          "px-3 py-2 text-sm font-medium flex items-center gap-2",
          result.clean
            ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300"
            : "bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-300",
        )}
      >
        {result.clean ? (
          <CheckCircle2 className="h-4 w-4 shrink-0" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0" />
        )}
        <span className="flex-1 leading-tight">
          {result.clean ? "Verification passed" : "Verification incomplete"}
          <span className="block text-xs font-normal opacity-80 mt-0.5">
            {result.summary || "—"}
          </span>
        </span>
        <span className="ml-auto text-xs font-normal opacity-70 shrink-0">
          {passed}/{totalSteps} step{totalSteps !== 1 ? "s" : ""}
        </span>
      </div>
      {(totalSteps > 0 || result.unresolved.length > 0 || result.files_written.length > 0) && (
        <button
          className="w-full px-3 py-1.5 text-xs flex items-center gap-2 text-muted-foreground hover:text-foreground hover:bg-muted/30"
          onClick={() => setOpen((o) => !o)}
        >
          <span>{open ? "Hide details" : "Show details"}</span>
          <ChevronDown
            className={cn("h-3 w-3 ml-auto transition-transform", open && "rotate-180")}
          />
        </button>
      )}
      {open && (
        <div className="border-t divide-y">
          {result.steps.map((step, i) => (
            <div key={i} className="px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    "font-mono px-1 rounded text-[10px] shrink-0",
                    step.passed
                      ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                      : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
                  )}
                >
                  {step.passed ? "ok" : "fail"}
                </span>
                <code className="text-xs font-mono truncate" title={step.command}>
                  {step.command}
                </code>
              </div>
              {step.notes && (
                <p className="text-xs text-muted-foreground mt-1 leading-snug">
                  {step.notes}
                </p>
              )}
            </div>
          ))}
          {result.files_written.length > 0 && (
            <div className="px-3 py-2 text-xs">
              <p className="text-muted-foreground font-medium mb-1">
                Fixed {result.files_written.length} file
                {result.files_written.length !== 1 ? "s" : ""}
              </p>
              <ul className="space-y-0.5">
                {result.files_written.map((p) => (
                  <li key={p} className="font-mono text-[11px] text-muted-foreground">
                    · {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.unresolved.length > 0 && (
            <div className="px-3 py-2 text-xs bg-red-50/50 dark:bg-red-950/10">
              <p className="text-red-700 dark:text-red-300 font-medium mb-1">
                Unresolved
              </p>
              <ul className="space-y-1">
                {result.unresolved.map((u, i) => (
                  <li
                    key={i}
                    className="text-xs text-red-700 dark:text-red-300 leading-snug"
                  >
                    · {u}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
