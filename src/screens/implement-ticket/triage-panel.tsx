import { MarkdownBlock } from "@/components/MarkdownBlock";
import { type TriageMessage, type TriageTurnOutput } from "@/lib/tauri/workflows";
import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { RevisionRow, type TriageRevision } from "./_shared";

// ── Triage panel ─────────────────────────────────────────────────────────────
// Living-document layout: the latest agent proposal sits at the top as the
// "current plan", and prior rounds collapse into a Revisions timeline so the
// engineer can see how the plan got here without scrolling a chat transcript.
// Live-streams the agent's in-progress reply at the top while a follow-up is
// being processed.

export function buildRevisions(
  history: TriageMessage[],
  turns: TriageTurnOutput[],
): {
  current: string | null;
  revisions: TriageRevision[];
} {
  if (turns.length === 0) return { current: null, revisions: [] };
  const current = turns[turns.length - 1].proposal;

  // Skip the seed "Please analyse this ticket…" message and pair each user
  // clarification with the proposal that was current right before it was sent.
  const userTurns = history
    .slice(history[0]?.role === "user" ? 1 : 0)
    .filter((m) => m.role === "user");

  const revisions: TriageRevision[] = [];
  for (let i = 0; i < userTurns.length; i++) {
    const prior = turns[i];
    if (!prior) continue;
    revisions.push({
      clarification: userTurns[i].content,
      previousProposal: prior.proposal,
    });
  }
  return { current, revisions };
}

export function TriagePanel({
  history,
  turns,
  streamText,
}: {
  history: TriageMessage[];
  turns: TriageTurnOutput[];
  streamText: string;
}) {
  const { current, revisions } = buildRevisions(history, turns);
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  return (
    <div className="space-y-4">
      {/* Current proposal — the headline */}
      <div className="rounded-md border bg-card/40">
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/20">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">
              Current proposed approach
            </span>
            {revisions.length > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                v{revisions.length + 1}
              </span>
            )}
          </div>
          {streamText && (
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Updating
            </span>
          )}
        </div>
        <div className="px-4 py-3">
          {streamText ? (
            <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-muted-foreground">
              {streamText}
            </pre>
          ) : current ? (
            <MarkdownBlock text={current} />
          ) : (
            <p className="text-sm text-muted-foreground italic">
              Waiting for the agent's first proposal…
            </p>
          )}
        </div>
      </div>

      {/* Revisions timeline */}
      {revisions.length > 0 && (
        <div>
          <button
            onClick={() => setRevisionsOpen((v) => !v)}
            className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
          >
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform ${revisionsOpen ? "rotate-90" : ""}`}
            />
            Revisions ({revisions.length})
          </button>
          {revisionsOpen && (
            <div className="mt-2 space-y-2">
              {revisions.map((rev, i) => (
                <RevisionRow key={i} revision={rev} index={i} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
