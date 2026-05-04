import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { type ImplementationPlan } from "@/lib/tauri/workflows";
import { AlertTriangle, FileCode, Shield } from "lucide-react";
import { CollapsibleList } from "./_shared";

export function PlanPanel({
  data,
  isStreaming,
}: {
  data: ImplementationPlan;
  isStreaming?: boolean;
}) {
  const hasSummary = data.summary.trim().length > 0;
  return (
    <div className="space-y-3">
      {hasSummary ? (
        <p className="text-sm font-medium leading-relaxed">{data.summary}</p>
      ) : isStreaming ? (
        <SkeletonLines count={2} />
      ) : null}
      {data.files.length > 0 ? (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <FileCode className="h-4 w-4 text-muted-foreground" /> Files (
            {data.files.length})
          </div>
          <div className="divide-y">
            {data.files.map((f, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-0.5">
                  <code className="text-xs font-mono">{f.path}</code>
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      f.action === "create"
                        ? "bg-green-100 text-green-700"
                        : f.action === "delete"
                          ? "bg-red-100 text-red-700"
                          : "bg-blue-100 text-blue-700"
                    }`}
                  >
                    {f.action}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      ) : isStreaming ? (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <FileCode className="h-4 w-4 text-muted-foreground" /> Files (…)
          </div>
          <div className="divide-y">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-3 py-2 space-y-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <Skeleton className="h-3 w-44" />
                  <Skeleton className="h-3.5 w-12" />
                </div>
                <SkeletonLines count={1} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <CollapsibleList
        title="Order of Operations"
        items={data.order_of_operations}
        loading={isStreaming}
      />
      <CollapsibleList
        title="Edge Cases to Handle"
        items={data.edge_cases}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        loading={isStreaming}
      />
      <CollapsibleList
        title="Do NOT Change"
        items={data.do_not_change}
        icon={<Shield className="h-4 w-4 text-red-500" />}
        loading={isStreaming}
      />
      <CollapsibleList
        title="Assumptions"
        items={data.assumptions}
        loading={isStreaming}
      />
      <CollapsibleList
        title="Open Questions"
        items={data.open_questions}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        loading={isStreaming}
      />
    </div>
  );
}
