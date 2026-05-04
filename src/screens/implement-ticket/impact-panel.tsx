import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { type ImpactOutput } from "@/lib/tauri/workflows";
import { AlertTriangle, FileCode } from "lucide-react";
import { CollapsibleList } from "./_shared";

function RiskBadge({ level }: { level: "low" | "medium" | "high" }) {
  const cls =
    level === "high"
      ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
      : level === "medium"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
        : "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {level} risk
    </span>
  );
}

export function ImpactPanel({
  data,
  isStreaming,
}: {
  data: ImpactOutput;
  isStreaming?: boolean;
}) {
  const hasJustification = data.risk_justification.trim().length > 0;
  const hasRecommendations = data.recommendations.trim().length > 0;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {data.risk_level && hasJustification ? (
          <RiskBadge level={data.risk_level} />
        ) : isStreaming ? (
          <Skeleton className="h-5 w-16" />
        ) : (
          <RiskBadge level={data.risk_level} />
        )}
        {hasJustification ? (
          <p className="text-sm text-muted-foreground">
            {data.risk_justification}
          </p>
        ) : isStreaming ? (
          <Skeleton className="h-3 flex-1 max-w-[420px]" />
        ) : null}
      </div>
      <CollapsibleList
        title="Affected Areas"
        items={data.affected_areas}
        loading={isStreaming}
      />
      <CollapsibleList
        title="Potential Regressions"
        items={data.potential_regressions}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        loading={isStreaming}
      />
      <CollapsibleList
        title="Cross-cutting Concerns"
        items={data.cross_cutting_concerns}
        loading={isStreaming}
      />
      <CollapsibleList
        title="Files Needing Consistent Updates"
        items={data.files_needing_consistent_updates}
        icon={<FileCode className="h-4 w-4 text-muted-foreground" />}
        loading={isStreaming}
      />
      {hasRecommendations ? (
        <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30 px-3 py-2">
          <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-1">
            Recommendations
          </p>
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {data.recommendations}
          </p>
        </div>
      ) : isStreaming ? (
        <div className="rounded-md border border-blue-200/60 bg-blue-50/40 dark:border-blue-900/60 dark:bg-blue-950/10 px-3 py-2 space-y-1.5">
          <p className="text-sm font-medium text-blue-800/70 dark:text-blue-200/70">
            Recommendations
          </p>
          <SkeletonLines count={2} />
        </div>
      ) : null}
    </div>
  );
}
