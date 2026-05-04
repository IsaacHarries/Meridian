import { type BuildCheckResult } from "@/lib/tauri/worktree";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import { useState } from "react";

export function BuildVerificationPanel({ result }: { result: BuildCheckResult }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div className={cn(
      "border rounded-md overflow-hidden",
      result.build_passed
        ? "border-green-300 dark:border-green-800"
        : "border-red-300 dark:border-red-800",
    )}>
      <div className={cn(
        "px-3 py-2 text-sm font-medium flex items-center gap-2",
        result.build_passed
          ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300"
          : "bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300",
      )}>
        {result.build_passed ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <AlertTriangle className="h-4 w-4" />
        )}
        Build {result.build_passed ? "passed" : "failed"} —{" "}
        <code className="text-xs font-mono">{result.build_command}</code>
        <span className="ml-auto text-xs font-normal opacity-70">
          {result.attempts.length} attempt{result.attempts.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="divide-y">
        {result.attempts.map((a, i) => (
          <div key={i} className="px-3 py-2">
            <button
              className="w-full flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(expanded === i ? null : i)}
            >
              <span className={cn(
                "font-mono px-1 rounded text-[10px]",
                a.exit_code === 0
                  ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                  : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
              )}>
                exit {a.exit_code}
              </span>
              <span>Attempt {a.attempt}</span>
              {a.files_written.length > 0 && (
                <span className="text-blue-600 dark:text-blue-400">
                  → fixed {a.files_written.length} file{a.files_written.length !== 1 ? "s" : ""}
                </span>
              )}
              <ChevronDown className={cn("h-3 w-3 ml-auto transition-transform", expanded === i && "rotate-180")} />
            </button>
            {expanded === i && (
              <pre className="mt-2 text-xs font-mono bg-muted/30 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                {a.output}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
