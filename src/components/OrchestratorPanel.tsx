// Reusable bits for the orchestrator chat panel: per-entry rendering, the
// suggest-confirm proposal card, and the pure helpers that drive their
// rendering. Extracted from ImplementTicketScreen so they're testable in
// isolation.

import { MarkdownBlock } from "@/components/MarkdownBlock";
import { Button } from "@/components/ui/button";
import { type OrchestratorMessage, type OrchestratorPendingProposal, type PlanEditOp } from "@/lib/tauri/orchestrator";
import { CheckCircle2, Sparkles } from "lucide-react";

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Title shown on a proposal confirm card — switches on the `kind`
 *  discriminator. Pure; safe to test directly. */
export function proposalCardTitle(proposal: OrchestratorPendingProposal): string {
  switch (proposal.kind) {
    case "proceed":
      return `Proposed: ${proposal.action}`;
    case "rewind":
      return `Proposed: rewind to ${proposal.toStage}`;
    case "reply":
      return `Proposed: send triage reply`;
    case "edit_plan":
      return `Proposed: ${proposal.edits.length} plan edit${proposal.edits.length === 1 ? "" : "s"}`;
    case "accept_grooming_edit":
      return `Proposed: ${proposal.newStatus} grooming edit`;
  }
}

/** Render one plan-edit op as a single short line for the proposal card.
 *  Pure formatting — exhaustive switch over the op discriminator. */
export function renderPlanEditOp(op: PlanEditOp): string {
  switch (op.op) {
    case "add_file":
      return `+ add ${op.file.action} ${op.file.path} — ${op.file.description}`;
    case "remove_file":
      return `− remove ${op.path}`;
    case "update_file": {
      const fields = Object.entries(op.fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `~ update ${op.path} (${fields})`;
    }
    case "set_summary":
      return `summary ← "${op.summary.length > 60 ? op.summary.slice(0, 60) + "…" : op.summary}"`;
    case "add_assumption":
      return `+ assumption: ${op.text}`;
    case "add_open_question":
      return `+ open question: ${op.text}`;
  }
}

/** Walk a flat orchestrator thread and group consecutive entries by their
 *  `stage` tag, preserving order. Adjacent entries with the same stage end
 *  up in the same group; a stage change opens a new group. Entries with
 *  undefined stage stay grouped with whatever neighbours share that
 *  undefined tag. */
export function groupOrchestratorThreadByStage(
  thread: OrchestratorMessage[],
): Array<{ stage: string | undefined; entries: OrchestratorMessage[] }> {
  const grouped: Array<{ stage: string | undefined; entries: OrchestratorMessage[] }> = [];
  for (const m of thread) {
    const last = grouped[grouped.length - 1];
    if (last && last.stage === m.stage) {
      last.entries.push(m);
    } else {
      grouped.push({ stage: m.stage, entries: [m] });
    }
  }
  return grouped;
}

// ── Components ──────────────────────────────────────────────────────────────

/** Render one orchestrator thread entry. The `kind` discriminator determines
 *  whether it's a chat bubble, an inline tool-call row, or a centred
 *  system-note divider. */
export function OrchestratorEntry({ entry }: { entry: OrchestratorMessage }) {
  if (entry.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed bg-primary text-primary-foreground">
          <p className="whitespace-pre-wrap">{entry.content}</p>
        </div>
      </div>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed bg-muted text-foreground">
          <MarkdownBlock text={entry.content} />
        </div>
      </div>
    );
  }
  if (entry.kind === "tool_call") {
    const argSummary =
      typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args);
    const argTrim = argSummary.length > 80 ? argSummary.slice(0, 80) + "…" : argSummary;
    return (
      <div className="flex justify-start" data-testid="orchestrator-tool-call">
        <div className="max-w-[90%] rounded-md px-2 py-1 text-xs font-mono bg-muted/40 text-muted-foreground border border-border/50 flex items-center gap-2">
          <span className="font-semibold text-foreground/80">{entry.name}</span>
          <span className="opacity-70">({argTrim})</span>
          {entry.error ? (
            <span className="text-destructive">⚠ {entry.error}</span>
          ) : null}
        </div>
      </div>
    );
  }
  // system_note
  return (
    <div className="flex justify-center" data-testid="orchestrator-system-note">
      <div className="text-xs text-muted-foreground italic px-2 py-0.5">
        {entry.content}
      </div>
    </div>
  );
}

/** Confirm card rendered at the bottom of the chat when the orchestrator has
 *  proposed a pipeline action. Accept fires the appropriate Tauri command;
 *  reject just notifies the orchestrator so it can move on. */
export function ProposalCard({
  proposal,
  onAccept,
  onReject,
  disabled,
}: {
  proposal: OrchestratorPendingProposal;
  onAccept: () => void;
  onReject: () => void;
  disabled: boolean;
}) {
  const title = proposalCardTitle(proposal);
  return (
    <div className="my-2 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
          {title}
        </p>
      </div>
      <p className="text-xs text-amber-900/90 dark:text-amber-100/90">
        {proposal.rationale}
      </p>
      {proposal.kind === "reply" && (
        <div
          data-testid="proposal-reply-message"
          className="rounded bg-background/40 border border-amber-200 dark:border-amber-900 p-2 text-xs whitespace-pre-wrap"
        >
          {proposal.message}
        </div>
      )}
      {proposal.kind === "edit_plan" && (
        <ul
          data-testid="proposal-edit-list"
          className="space-y-1 rounded bg-background/40 border border-amber-200 dark:border-amber-900 p-2 text-xs font-mono"
        >
          {proposal.edits.map((e, i) => (
            <li key={i} className="break-words">
              {renderPlanEditOp(e)}
            </li>
          ))}
        </ul>
      )}
      {proposal.kind === "accept_grooming_edit" && (
        <p className="text-xs font-mono text-amber-900/90 dark:text-amber-100/90">
          Edit <code>{proposal.editId}</code> → <strong>{proposal.newStatus}</strong>
        </p>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={onReject}
          disabled={disabled}
          className="h-7"
        >
          Reject
        </Button>
        <Button
          size="sm"
          onClick={onAccept}
          disabled={disabled}
          className="h-7 gap-1.5"
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Accept
        </Button>
      </div>
    </div>
  );
}
