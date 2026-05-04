import { type JiraIssue } from "@/lib/tauri/jira";
import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from "lucide-react";
import { useState } from "react";
import { effectiveDescription } from "./_shared";

export function FieldDiagnostics({ issue }: { issue: JiraIssue }) {
  const [open, setOpen] = useState(false);
  // Match the per-ticket-type filter used by TicketFieldsPanel — steps /
  // observed / expected only matter on bugs, so showing them as "missing"
  // on a Story/Task creates noise.
  const isBug = issue.issueType.toLowerCase() === "bug";
  const fields = [
    { label: "Description", value: effectiveDescription(issue) },
    { label: "Acceptance Criteria", value: issue.acceptanceCriteria },
    ...(isBug
      ? [
          { label: "Steps to Reproduce", value: issue.stepsToReproduce },
          { label: "Observed Behavior", value: issue.observedBehavior },
          { label: "Expected Behavior", value: issue.expectedBehavior },
        ]
      : []),
  ];
  const missing = fields.filter((f) => !f.value);
  const present = fields.filter((f) => !!f.value);

  return (
    <div className="mt-2">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Fields received
        <span className="text-emerald-600 font-medium">{present.length} ✓</span>
        {missing.length > 0 && <span className="text-amber-500 font-medium">{missing.length} missing</span>}
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {fields.map((f) => (
            <div key={f.label} className="flex items-start gap-2 text-xs">
              {f.value ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" /> : <XCircle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />}
              <span className={f.value ? "text-foreground" : "text-muted-foreground"}>
                {f.label}
                {f.value && <span className="text-muted-foreground ml-1">— {f.value.slice(0, 60)}{f.value.length > 60 ? "…" : ""}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
