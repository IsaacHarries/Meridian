import { type TestFileWritten, type TestOutput, type TestPlan, type TestPlanFile } from "@/lib/tauri/workflows";
import { TestTube } from "lucide-react";
import { CollapsibleList } from "./_shared";

export function TestPlanPanel({ data }: { data: TestPlan }) {
  const files = data.files ?? [];
  const edgeCases = data.edge_cases_covered ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">{data.summary}</p>
      {files.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <TestTube className="h-4 w-4 text-muted-foreground" /> Proposed Test
            Files ({files.length})
          </div>
          <div className="divide-y">
            {files.map((f: TestPlanFile, i: number) => (
              <div key={i} className="px-3 py-2 space-y-1">
                <div className="flex items-baseline gap-2">
                  <p className="text-xs font-mono text-foreground">{f.path}</p>
                  {f.framework && (
                    <span className="text-xs text-muted-foreground">
                      {f.framework}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{f.description}</p>
                {f.cases.length > 0 && (
                  <ul className="list-disc pl-5 space-y-0.5 text-sm text-muted-foreground">
                    {f.cases.map((c, j) => (
                      <li key={j}>{c}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <CollapsibleList title="Edge Cases Planned" items={edgeCases} />
      {data.coverage_notes && (
        <p className="text-sm text-muted-foreground italic">
          {data.coverage_notes}
        </p>
      )}
    </div>
  );
}

export function TestsPanel({ data }: { data: TestOutput }) {
  const filesWritten = data.files_written ?? [];
  const edgeCases = data.edge_cases_covered ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">{data.summary}</p>
      {filesWritten.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <TestTube className="h-4 w-4 text-muted-foreground" /> Test Files
            Written ({filesWritten.length})
          </div>
          <div className="divide-y">
            {filesWritten.map((f: TestFileWritten, i: number) => (
              <div key={i} className="px-3 py-2">
                <p className="text-xs font-mono text-foreground mb-0.5">
                  {f.path}
                </p>
                <p className="text-sm text-muted-foreground">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      <CollapsibleList
        title="Edge Cases Covered"
        items={edgeCases}
      />
      {data.coverage_notes && (
        <p className="text-sm text-muted-foreground italic">
          {data.coverage_notes}
        </p>
      )}
    </div>
  );
}
