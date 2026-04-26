import { AlertTriangle } from "lucide-react";
import type { WorkflowBadge } from "@/lib/landingLayouts";
import { cn } from "@/lib/utils";

export function CardBadge({
  badge,
  className,
}: {
  badge: WorkflowBadge;
  className?: string;
}) {
  if (badge.kind === "session") {
    return (
      <span
        className={cn(
          "flex items-center gap-1 rounded-full bg-primary/15 border border-primary/30 px-1.5 py-0.5 text-[10px] font-medium text-primary",
          className,
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
        {badge.label}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-500",
        className,
      )}
    >
      <AlertTriangle className="h-2.5 w-2.5" />
      {badge.label}
    </span>
  );
}
