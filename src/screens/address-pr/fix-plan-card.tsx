import { useState } from "react";
import { ChevronDown, ChevronRight, ThumbsUp, ThumbsDown, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { type FixProposal, confidenceBadgeVariant } from "./_shared";

export function FixPlanCard({
  fix,
  index,
  onToggleApprove,
  onToggleSkip,
  onAnnotationChange,
}: {
  fix: FixProposal;
  index: number;
  onToggleApprove: (i: number) => void;
  onToggleSkip: (i: number) => void;
  onAnnotationChange: (i: number, text: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className={`rounded-lg border ${fix.skipped ? "opacity-40" : ""} ${fix.approved && !fix.skipped ? "border-primary/30 bg-primary/5" : "border-border bg-card/60"}`}>
      <button
        className="w-full flex items-start gap-2 p-3 text-left"
        onClick={() => setExpanded((p) => !p)}
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-muted-foreground shrink-0">#{fix.commentId}</span>
            <Badge variant={confidenceBadgeVariant(fix.confidence)} className="text-[10px]">
              {fix.confidence}
            </Badge>
            {fix.file && (
              <span className="text-xs font-mono text-muted-foreground truncate">{fix.file}</span>
            )}
          </div>
          <p className="text-sm font-medium leading-snug">{fix.commentSummary}</p>
          <p className="text-xs text-muted-foreground">by {fix.reviewerName}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant={fix.approved && !fix.skipped ? "default" : "outline"}
            className="h-6 w-6 p-0"
            onClick={() => onToggleApprove(index)}
            title="Approve this fix"
          >
            <ThumbsUp className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant={fix.skipped ? "destructive" : "outline"}
            className="h-6 w-6 p-0"
            onClick={() => onToggleSkip(index)}
            title="Skip this fix"
          >
            <ThumbsDown className="h-3 w-3" />
          </Button>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t pt-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Proposed fix</p>
            <p className="text-sm leading-relaxed">{fix.proposedFix}</p>
          </div>
          {fix.affectedFiles.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Files</p>
              <div className="flex flex-wrap gap-1">
                {fix.affectedFiles.map((f) => (
                  <code key={f} className="text-xs bg-muted rounded px-1.5 py-0.5">{f}</code>
                ))}
              </div>
            </div>
          )}
          {fix.confidence === "Needs human judgment" && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              This fix requires human judgment. Annotate below with instructions if you want the agent to attempt it.
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Additional instructions (optional)</p>
            <Textarea
              value={fix.annotation}
              onChange={(e) => onAnnotationChange(index, e.target.value)}
              placeholder="Leave blank to follow the proposed fix as-is, or add notes to guide the agent…"
              className="text-xs min-h-[60px] resize-none"
              disabled={fix.skipped}
            />
          </div>
        </div>
      )}
    </div>
  );
}
