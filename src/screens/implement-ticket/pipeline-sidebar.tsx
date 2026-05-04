import { type Stage } from "@/stores/implementTicket/types";
import {
    AlertTriangle,
    BookOpen,
    CheckCircle2,
    Circle,
    ClipboardList,
    FileCode,
    GitPullRequest,
    Loader2,
    Shield,
    TestTube,
} from "lucide-react";
import { STAGE_LABELS, STAGE_ORDER } from "./_shared";

interface PipelineSidebarProps {
  currentStage: Stage;
  completedStages: Set<Stage>;
  activeStage: Stage;
  pendingApproval: Stage | null;
  onClickStage: (stage: Stage) => void;
}

export function PipelineSidebar({
  currentStage,
  completedStages,
  activeStage,
  pendingApproval,
  onClickStage,
}: PipelineSidebarProps) {
  const icons: Record<string, React.ReactNode> = {
    grooming: <BookOpen className="h-3.5 w-3.5" />,
    impact: <Shield className="h-3.5 w-3.5" />,
    triage: <ClipboardList className="h-3.5 w-3.5" />,
    plan: <ClipboardList className="h-3.5 w-3.5" />,
    implementation: <FileCode className="h-3.5 w-3.5" />,
    tests: <TestTube className="h-3.5 w-3.5" />,
    review: <Shield className="h-3.5 w-3.5" />,
    pr: <GitPullRequest className="h-3.5 w-3.5" />,
    retro: <BookOpen className="h-3.5 w-3.5" />,
  };

  return (
    <div className="min-h-0 w-48 shrink-0 overflow-y-auto border-r bg-muted/20 p-3 space-y-1">
      {STAGE_ORDER.map((stage) => {
        const done = completedStages.has(stage);
        const active = activeStage === stage;
        const running =
          currentStage === stage && !done && pendingApproval !== stage;
        const pending = pendingApproval === stage;
        const reachable = done || active || running || pending;
        return (
          <button
            key={stage}
            onClick={() => reachable && onClickStage(stage)}
            disabled={!reachable}
            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-xs transition-colors ${
              active
                ? "bg-primary text-primary-foreground font-medium"
                : pending
                  ? "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 font-medium hover:bg-amber-100 dark:hover:bg-amber-950/50 cursor-pointer"
                  : done
                    ? "text-foreground hover:bg-muted/60 cursor-pointer"
                    : "text-muted-foreground cursor-default opacity-50"
            }`}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            ) : pending ? (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            ) : done ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
            ) : (
              <span className="shrink-0 opacity-60">
                {icons[stage] ?? <Circle className="h-3.5 w-3.5" />}
              </span>
            )}
            <span>{STAGE_LABELS[stage]}</span>
          </button>
        );
      })}
    </div>
  );
}
