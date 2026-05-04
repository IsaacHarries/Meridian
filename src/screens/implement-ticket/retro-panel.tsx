import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { SkeletonLines } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { type SkillType, loadAgentSkills, saveAgentSkill } from "@/lib/tauri/templates";
import { type RetroSkillSuggestion, type RetrospectiveOutput } from "@/lib/tauri/workflows";
import {
    AlertTriangle,
    Check,
    CheckCircle2,
    Sparkles,
} from "lucide-react";
import { useState } from "react";
import { CollapsibleList } from "./_shared";

interface RetroPanelProps {
  data: RetrospectiveOutput;
  isStreaming?: boolean;
}

const SKILL_LABEL: Record<SkillType, string> = {
  grooming: "Grooming Conventions",
  patterns: "Codebase Patterns",
  implementation: "Implementation Standards",
  review: "Review Standards",
};

interface ActiveApply {
  index: number;
  skillType: SkillType;
  draft: string;
}

export function RetroPanel({ data, isStreaming }: RetroPanelProps) {
  const [active, setActive] = useState<ActiveApply | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openApply(index: number, suggestion: RetroSkillSuggestion) {
    setError(null);
    setBusy(true);
    try {
      const skills = await loadAgentSkills();
      const existing = (skills[suggestion.skill] ?? "").trimEnd();
      const draft = existing
        ? `${existing}\n- ${suggestion.suggestion}`
        : `- ${suggestion.suggestion}`;
      setActive({ index, skillType: suggestion.skill, draft });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveApply() {
    if (!active) return;
    setError(null);
    setBusy(true);
    try {
      await saveAgentSkill(active.skillType, active.draft);
      setApplied((prev) => {
        const next = new Set(prev);
        next.add(active.index);
        return next;
      });
      setActive(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const hasSummary = data.summary.trim().length > 0;
  return (
    <div className="space-y-3">
      {hasSummary ? (
        <p className="text-sm leading-relaxed">{data.summary}</p>
      ) : isStreaming ? (
        <SkeletonLines count={2} />
      ) : null}
      <CollapsibleList
        title="What Went Well"
        items={data.what_went_well}
        icon={<CheckCircle2 className="h-4 w-4 text-green-500" />}
        loading={isStreaming}
      />
      <CollapsibleList
        title="What Could Improve"
        items={data.what_could_improve}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        loading={isStreaming}
      />
      <CollapsibleList
        title="Patterns Identified"
        items={data.patterns_identified}
        loading={isStreaming}
      />
      {data.agent_skill_suggestions.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-purple-500" />
            <span className="flex-1">
              Agent Skill Suggestions ({data.agent_skill_suggestions.length})
            </span>
          </div>
          <div className="divide-y">
            {data.agent_skill_suggestions.map((s, i) => {
              const isApplied = applied.has(i);
              return (
                <div
                  key={i}
                  className="px-3 py-2 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    <Badge variant="outline" className="text-xs">
                      {SKILL_LABEL[s.skill] ?? s.skill}
                    </Badge>
                    <p className="text-sm text-muted-foreground leading-snug">
                      {s.suggestion}
                    </p>
                  </div>
                  {isApplied ? (
                    <span className="text-xs text-green-600 flex items-center gap-1 shrink-0 mt-0.5">
                      <Check className="h-3 w-3" /> Applied
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs shrink-0 mt-0.5"
                      disabled={busy}
                      onClick={() => openApply(i, s)}
                    >
                      Apply
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      <Dialog
        open={active !== null}
        onOpenChange={(open) => !open && setActive(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Apply to {active ? SKILL_LABEL[active.skillType] : ""}
            </DialogTitle>
            <DialogDescription>
              Review the updated skill body before saving. The suggestion has
              been appended as a bullet — edit freely.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={active?.draft ?? ""}
            onChange={(e) =>
              setActive((prev) =>
                prev ? { ...prev, draft: e.target.value } : prev,
              )
            }
            className="font-mono text-xs min-h-[260px]"
          />
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActive(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={saveApply} disabled={busy}>
              {busy ? "Saving…" : "Save to skill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
