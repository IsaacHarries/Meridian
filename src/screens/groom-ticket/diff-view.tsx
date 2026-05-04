import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { computeUnifiedDiff, type UnifiedDiffEntry } from "./_shared";

// ── Pre-accept inline diff view ─────────────────────────────────────────────
//
// Replaces the editor while an AI suggestion is pending. Renders a
// paragraph-level unified diff: unchanged paragraphs in muted text so the
// user has context, removed paragraphs in red with strikethrough, added
// paragraphs in green. Modified paragraphs render as removed-then-added
// pairs. Read-only — Accept loads the suggestion into the editor (which
// returns to its normal editable state).

export function InlineDiffView({
  currentText,
  suggestedText,
  decisions,
  onResolve,
}: {
  currentText: string;
  suggestedText: string;
  decisions: Map<number, "accepted" | "declined">;
  onResolve: (entryIdx: number, decision: "accepted" | "declined") => void;
}) {
  const entries = computeUnifiedDiff(currentText, suggestedText);
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic px-3 py-3">
        No content to diff.
      </p>
    );
  }
  return (
    <div className="px-3 py-2 space-y-2 max-h-[420px] overflow-y-auto">
      {entries.map((entry, i) => {
        if (entry.kind === "unchanged") {
          return (
            <div
              key={i}
              className="text-foreground/60 text-sm whitespace-pre-wrap break-words"
            >
              {entry.newText}
            </div>
          );
        }
        const resolved = decisions.get(i);
        return (
          <DiffEntryProposal
            key={i}
            entry={entry}
            resolved={resolved}
            onAccept={() => onResolve(i, "accepted")}
            onDecline={() => onResolve(i, "declined")}
          />
        );
      })}
    </div>
  );
}

/** A single proposed change in the pre-accept diff view, with its own
 *  Accept / Decline buttons. While pending, both old and new are visible
 *  side-by-side; once resolved (one of the two clicked) the row fades to
 *  show only the chosen side, so the user can scan what they decided
 *  without losing context. */
export function DiffEntryProposal({
  entry,
  resolved,
  onAccept,
  onDecline,
}: {
  entry: UnifiedDiffEntry;
  resolved: "accepted" | "declined" | undefined;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const showOld = entry.kind === "removed" || entry.kind === "modified";
  const showNew = entry.kind === "added" || entry.kind === "modified";

  // When resolved, mute the side that "lost" so the user can still see
  // both halves but the decision is obvious.
  const oldMuted = resolved === "accepted";
  const newMuted = resolved === "declined";

  // Inline action affordance — for modified entries the buttons live next
  // to the proposed new text (Accept = adopt new). For pure adds they sit
  // next to the inserted paragraph; for pure removes, next to the doomed
  // paragraph. There's no separate header bar; the +/- sigil and colour
  // already say what kind of change it is.
  const actionsOnNew = entry.kind === "added" || entry.kind === "modified";
  const actions = (
    <DiffEntryActions
      entry={entry}
      resolved={resolved}
      onAccept={onAccept}
      onDecline={onDecline}
    />
  );

  return (
    <div className="space-y-1">
      {showOld && (
        <DiffParagraphBlock
          kind="removed"
          text={entry.oldText}
          dim={oldMuted}
          actions={actionsOnNew ? null : actions}
        />
      )}
      {showNew && (
        <DiffParagraphBlock
          kind="added"
          text={entry.newText}
          dim={newMuted}
          actions={actionsOnNew ? actions : null}
        />
      )}
    </div>
  );
}

export function DiffEntryActions({
  entry,
  resolved,
  onAccept,
  onDecline,
}: {
  entry: UnifiedDiffEntry;
  resolved: "accepted" | "declined" | undefined;
  onAccept: () => void;
  onDecline: () => void;
}) {
  if (resolved) {
    return (
      <span
        className={cn(
          "text-[10px] uppercase tracking-wide font-semibold whitespace-nowrap mt-1",
          resolved === "accepted"
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-muted-foreground",
        )}
      >
        {resolved === "accepted" ? "✓ Accepted" : "✕ Declined"}
      </span>
    );
  }
  return (
    <div className="flex gap-1 shrink-0">
      <Button
        size="sm"
        className="h-5 px-1.5 text-[11px] gap-1"
        onClick={onAccept}
        title={
          entry.kind === "removed"
            ? "Accept removal — drop this paragraph"
            : "Accept this change"
        }
      >
        <Check className="h-3 w-3" />
        Accept
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 px-1.5 text-[11px] gap-1"
        onClick={onDecline}
        title={
          entry.kind === "added"
            ? "Decline — don't insert this paragraph"
            : "Keep the existing text instead"
        }
      >
        <X className="h-3 w-3" />
        Decline
      </Button>
    </div>
  );
}

export function DiffParagraphBlock({
  kind,
  text,
  dim,
  actions,
}: {
  kind: "added" | "removed";
  text: string;
  dim?: boolean;
  /** Optional inline action area rendered to the right of the text — used
   *  by `DiffEntryProposal` to dock per-entry Accept/Decline buttons next
   *  to the paragraph they refer to instead of in a separate header bar. */
  actions?: React.ReactNode;
}) {
  const colors =
    kind === "added"
      ? "border-emerald-400/60 bg-emerald-50/60 dark:bg-emerald-950/20"
      : "border-rose-400/60 bg-rose-50/60 dark:bg-rose-950/20";
  const sigil = kind === "added" ? "+" : "−";
  const sigilColor =
    kind === "added"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
  return (
    <div
      className={cn(
        "rounded-sm border-l-2 pl-2 pr-1 py-0.5 flex gap-2 items-start",
        colors,
        dim && "opacity-40",
      )}
    >
      <span
        className={cn("font-mono text-xs select-none mt-0.5", sigilColor)}
        aria-hidden="true"
      >
        {sigil}
      </span>
      <div
        className={cn(
          "flex-1 min-w-0 text-sm whitespace-pre-wrap break-words",
          kind === "removed" && "line-through decoration-rose-400/60",
        )}
      >
        {text}
      </div>
      {actions}
    </div>
  );
}
