import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { type PlanReviewOutput } from "@/lib/tauri/workflows";
import { AlertTriangle } from "lucide-react";
import { CollapsibleList } from "./_shared";

function ConfidenceBadge({
  level,
}: {
  level: "ready" | "needs_attention" | "requires_rework";
}) {
  if (level === "ready")
    return (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
        Ready
      </span>
    );
  if (level === "needs_attention")
    return (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
        Needs attention
      </span>
    );
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
      Requires rework
    </span>
  );
}

export function ReviewPanel({
  data,
  isStreaming,
}: {
  data: PlanReviewOutput;
  isStreaming?: boolean;
}) {
  const hasSummary = data.summary.trim().length > 0;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {data.confidence ? (
          <ConfidenceBadge level={data.confidence} />
        ) : isStreaming ? (
          <Skeleton className="h-5 w-24" />
        ) : null}
        {hasSummary ? (
          <p className="text-sm text-muted-foreground">{data.summary}</p>
        ) : isStreaming ? (
          <Skeleton className="h-3 flex-1 max-w-[420px]" />
        ) : null}
      </div>
      {data.findings.length > 0 ? (
        <div className="space-y-2">
          {data.findings.map((f, i) => (
            <div key={i} className="border rounded-md px-3 py-2">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    f.severity === "blocking"
                      ? "bg-red-100 text-red-700"
                      : f.severity === "non_blocking"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {f.severity}
                </span>
                <span className="text-sm font-medium">{f.area}</span>
              </div>
              <p className="text-sm text-muted-foreground">{f.feedback}</p>
            </div>
          ))}
        </div>
      ) : isStreaming ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="border rounded-md px-3 py-2 space-y-1">
              <div className="flex items-center gap-2 mb-1">
                <Skeleton className="h-3.5 w-16" />
                <Skeleton className="h-3.5 w-32" />
              </div>
              <SkeletonLines count={1} />
            </div>
          ))}
        </div>
      ) : null}
      <CollapsibleList
        title="Address Before Starting"
        items={data.things_to_address}
        icon={<AlertTriangle className="h-4 w-4 text-red-500" />}
        loading={isStreaming}
      />
      <CollapsibleList
        title="Keep in Mind While Implementing"
        items={data.things_to_watch}
        loading={isStreaming}
      />
    </div>
  );
}
