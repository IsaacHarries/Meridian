import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { type DescriptionSection } from "@/lib/tauri/jira";
import { type GroomingOutput, type SuggestedEdit } from "@/lib/tauri/workflows";
import {
    AlertTriangle,
    Bug,
    Check,
    CheckCircle2,
    ChevronDown,
    Circle,
    ExternalLink,
    Eye,
    EyeOff,
    FileCode,
    Loader2,
    Pencil,
    X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
    CollapsibleSection,
    DiffedCollapsibleList,
    ResolvableList,
    diffStringArrays,
} from "./_shared";
import { DescriptionSectionsPanel } from "./description-sections-panel";

// ── Grooming progress banner ──────────────────────────────────────────────────

export function GroomingProgressBanner({
  message,
  streamText,
}: {
  message: string;
  streamText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the stream panel as new tokens arrive
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamText, expanded]);

  if (!message) return null;

  return (
    <div className="border rounded-md overflow-hidden bg-muted/20">
      {/* Status row */}
      <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin shrink-0 text-primary" />
        <span className="flex-1 leading-snug">{message}</span>
        {streamText && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
            {expanded ? "Hide" : "Show"} output
          </button>
        )}
      </div>
      {/* Streaming text panel */}
      {expanded && streamText && (
        <div
          ref={scrollRef}
          className="border-t px-4 py-3 max-h-64 overflow-y-auto font-mono text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed bg-muted/10"
        >
          {streamText}
          <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-primary animate-pulse align-middle" />
        </div>
      )}
    </div>
  );
}

// ── Suggested Edit components ─────────────────────────────────────────────────

export function SuggestedEditCard({
  edit,
  onApprove,
  onDecline,
  onEdit,
  highlighted,
}: {
  edit: SuggestedEdit;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  onEdit: (id: string, newSuggested: string) => void;
  highlighted?: boolean;
}) {
  const isPending = edit.status === "pending";
  const isApproved = edit.status === "approved";
  const isDeclined = edit.status === "declined";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(edit.suggested);

  function startEditing() {
    setDraft(edit.suggested);
    setEditing(true);
  }

  function saveEditing() {
    const next = draft.trim();
    if (next.length > 0 && next !== edit.suggested) onEdit(edit.id, next);
    setEditing(false);
  }

  function cancelEditing() {
    setDraft(edit.suggested);
    setEditing(false);
  }

  return (
    <div
      className={`border rounded-md overflow-hidden transition-opacity ${isDeclined ? "opacity-40" : ""} ${highlighted ? "animate-update-glow ring-1 ring-primary/40" : ""}`}
    >
      {/* Header */}
      <div
        className={`px-3 py-2 flex items-center justify-between text-sm font-medium ${
          isApproved
            ? "bg-green-50 dark:bg-green-950/30 border-b border-green-200 dark:border-green-800"
            : isDeclined
              ? "bg-muted/30 border-b"
              : "bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800"
        }`}
      >
        <div className="flex items-center gap-2">
          {isApproved && (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
          )}
          {isDeclined && (
            <Circle className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {isPending && (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          )}
          <span
            className={isDeclined ? "line-through text-muted-foreground" : ""}
          >
            {edit.section}
          </span>
          {edit.current === null && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
              missing
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!isDeclined && !editing && (
            <button
              onClick={startEditing}
              title="Edit the suggested text"
              className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border hover:bg-muted transition-colors"
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
          {isPending && !editing && (
            <>
              <button
                onClick={() => onApprove(edit.id)}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-600 text-white hover:bg-green-700 transition-colors"
              >
                <Check className="h-3 w-3" /> Approve
              </button>
              <button
                onClick={() => onDecline(edit.id)}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border hover:bg-muted transition-colors"
              >
                Decline
              </button>
            </>
          )}
          {isApproved && !editing && (
            <button
              onClick={() => onDecline(edit.id)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Undo
            </button>
          )}
          {isDeclined && !editing && (
            <button
              onClick={() => onApprove(edit.id)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Restore
            </button>
          )}
        </div>
      </div>
      {/* Diff / editor */}
      {!isDeclined && (
        <div className="divide-y text-xs font-mono">
          {edit.current !== null && (
            <div className="px-3 py-2 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 whitespace-pre-wrap leading-relaxed">
              <span className="select-none mr-1 opacity-60">−</span>
              {edit.current}
            </div>
          )}
          {editing ? (
            <div className="bg-green-50 dark:bg-green-950/20">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    saveEditing();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEditing();
                  }
                }}
                autoFocus
                rows={Math.max(3, Math.min(20, draft.split("\n").length + 1))}
                className="w-full px-3 py-2 bg-transparent text-green-800 dark:text-green-200 font-mono text-xs leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-green-500/50"
                placeholder="Edit the suggested text…"
              />
              <div className="flex items-center justify-end gap-1 px-2 py-1 border-t border-green-200/50 dark:border-green-800/40 bg-green-50/60 dark:bg-green-950/30">
                <span className="text-[10px] text-muted-foreground mr-auto pl-1">
                  ⌘/Ctrl+Enter to save · Esc to cancel
                </span>
                <button
                  onClick={cancelEditing}
                  className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border hover:bg-muted transition-colors"
                >
                  <X className="h-3 w-3" /> Cancel
                </button>
                <button
                  onClick={saveEditing}
                  disabled={draft.trim().length === 0}
                  className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Check className="h-3 w-3" /> Save
                </button>
              </div>
            </div>
          ) : (
            <div className="px-3 py-2 bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-300 whitespace-pre-wrap leading-relaxed">
              <span className="select-none mr-1 opacity-60">+</span>
              {edit.suggested}
            </div>
          )}
        </div>
      )}
      {/* Reasoning */}
      {!isDeclined && (
        <div className="px-3 py-2 text-xs text-muted-foreground italic border-t">
          {edit.reasoning}
        </div>
      )}
    </div>
  );
}

// ── Files-read panel ─────────────────────────────────────────────────────────

export function FilesReadPanel({ files }: { files: string[] }) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  return (
    <div className="border rounded-md overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2 flex items-center justify-between text-sm bg-muted/20 hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <FileCode className="h-4 w-4" />
          <span>
            {files.length} file{files.length !== 1 ? "s" : ""} read from
            codebase
          </span>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <ul className="divide-y">
          {files.map((f, i) => (
            <li
              key={i}
              className="px-3 py-1.5 text-xs font-mono text-muted-foreground"
            >
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── GroomingPanel ────────────────────────────────────────────────────────────

interface GroomingPanelProps {
  data: GroomingOutput;
  baseline?: GroomingOutput | null;
  descriptionSections?: DescriptionSection[];
  description?: string | null;
  stepsToReproduce?: string | null;
  observedBehavior?: string | null;
  expectedBehavior?: string | null;
  suggestedEdits: SuggestedEdit[];
  clarifyingQuestions: string[];
  clarifyingQuestionsInitial: string[];
  highlights: { editIds: string[]; questions: boolean };
  showHighlights: boolean;
  onToggleHighlights: () => void;
  filesRead: string[];
  onApproveEdit: (id: string) => void;
  onDeclineEdit: (id: string) => void;
  onEditSuggested: (id: string, newSuggested: string) => void;
  onUpdateJira: () => void;
  jiraUpdateStatus: "idle" | "saving" | "saved" | "error";
  jiraUpdateError: string;
  /** True while the grooming agent is still streaming and the final
   *  GroomingOutput hasn't landed. Empty fields render as skeleton glow
   *  rows so the panel layout is visible from stage entry. */
  isStreaming?: boolean;
}

export function GroomingPanel({
  data,
  baseline,
  descriptionSections,
  description,
  stepsToReproduce,
  observedBehavior,
  expectedBehavior,
  suggestedEdits,
  clarifyingQuestions,
  clarifyingQuestionsInitial,
  highlights,
  showHighlights,
  onToggleHighlights,
  filesRead,
  onApproveEdit,
  onDeclineEdit,
  onEditSuggested,
  onUpdateJira,
  jiraUpdateStatus,
  jiraUpdateError,
  isStreaming,
}: GroomingPanelProps) {
  const hasDiff = baseline != null;
  const hasSummary = data.ticket_summary.trim().length > 0;

  const relevantItems = hasDiff
    ? diffStringArrays(
        baseline!.relevant_areas.map((a) => `${a.area} — ${a.reason}`),
        data.relevant_areas.map((a) => `${a.area} — ${a.reason}`),
      )
    : data.relevant_areas.map((a) => ({
        text: `${a.area} — ${a.reason}`,
        status: "unchanged" as const,
      }));

  const depItems = hasDiff
    ? diffStringArrays(baseline!.dependencies, data.dependencies)
    : data.dependencies.map((t) => ({ text: t, status: "unchanged" as const }));

  const summaryChanged =
    hasDiff && baseline!.ticket_summary !== data.ticket_summary;

  const pendingCount = suggestedEdits.filter(
    (e) => e.status === "pending",
  ).length;
  const approvedCount = suggestedEdits.filter(
    (e) => e.status === "approved",
  ).length;

  return (
    <div className="space-y-3">
      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
        {data.ticket_type && hasSummary ? (
          <Badge variant="secondary">{data.ticket_type}</Badge>
        ) : isStreaming ? (
          <Skeleton className="h-5 w-14" />
        ) : (
          <Badge variant="secondary">{data.ticket_type}</Badge>
        )}
        {data.estimated_complexity && hasSummary ? (
          <Badge
            variant={
              data.estimated_complexity === "high"
                ? "destructive"
                : data.estimated_complexity === "medium"
                  ? "secondary"
                  : "outline"
            }
          >
            {data.estimated_complexity} complexity
          </Badge>
        ) : isStreaming ? (
          <Skeleton className="h-5 w-28" />
        ) : (
          <Badge variant="outline">{data.estimated_complexity} complexity</Badge>
        )}
        {approvedCount > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 font-medium">
            {approvedCount} approved
          </span>
        )}
        {pendingCount > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 font-medium">
            {pendingCount} pending review
          </span>
        )}
      </div>

      {/* Summary */}
      <div
        className={`rounded px-2 py-1 -mx-2 ${summaryChanged ? "bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800" : ""}`}
      >
        {hasSummary ? (
          <p className="text-sm leading-relaxed">{data.ticket_summary}</p>
        ) : isStreaming ? (
          <SkeletonLines count={2} />
        ) : null}
        {summaryChanged && (
          <p className="text-xs text-muted-foreground line-through mt-0.5">
            {baseline!.ticket_summary}
          </p>
        )}
      </div>

      {/* Highlights toggle — shows when there is anything to highlight */}
      {(highlights.editIds.length > 0 || highlights.questions) && (
        <div className="flex items-center justify-end">
          <button
            onClick={onToggleHighlights}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
            title={
              showHighlights
                ? "Hide the update highlights"
                : "Show the update highlights"
            }
          >
            {showHighlights ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            {showHighlights ? "Hide highlights" : "Show highlights"}
          </button>
        </div>
      )}

      {/* Open items — clarifying questions (with strike-through when
          resolved through chat). Subsumes the previous Ambiguities
          section: the agent now phrases ambiguous ticket details as
          questions in this list rather than keeping a parallel list. */}
      <ResolvableList
        title="Clarifying Questions"
        initial={clarifyingQuestionsInitial}
        current={clarifyingQuestions}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        highlight={showHighlights && highlights.questions}
      />

      {/* JIRA description sections */}
      {(descriptionSections?.length || description) && (
        <DescriptionSectionsPanel
          sections={descriptionSections ?? []}
          fallbackDescription={description}
        />
      )}

      {/* Bug-specific custom fields */}
      {(stepsToReproduce || observedBehavior || expectedBehavior) && (
        <div className="border rounded-md overflow-hidden divide-y">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <Bug className="h-4 w-4 text-muted-foreground" />
            Bug Details
          </div>
          {stepsToReproduce && (
            <CollapsibleSection
              heading="Steps to Reproduce"
              content={stepsToReproduce}
            />
          )}
          {observedBehavior && (
            <CollapsibleSection
              heading="Observed Behavior"
              content={observedBehavior}
            />
          )}
          {expectedBehavior && (
            <CollapsibleSection
              heading="Expected Behavior"
              content={expectedBehavior}
            />
          )}
        </div>
      )}

      {/* Suggested edits — the heart of the new grooming flow */}
      {suggestedEdits.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Suggested ticket improvements
          </p>
          {suggestedEdits.map((edit) => (
            <SuggestedEditCard
              key={edit.id}
              edit={edit}
              onApprove={onApproveEdit}
              onDecline={onDeclineEdit}
              onEdit={onEditSuggested}
              highlighted={
                showHighlights && highlights.editIds.includes(edit.id)
              }
            />
          ))}
          {/* Update JIRA — lives here, below the edits */}
          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              variant={approvedCount > 0 ? "default" : "outline"}
              className="gap-1.5"
              onClick={onUpdateJira}
              disabled={jiraUpdateStatus === "saving" || approvedCount === 0}
              title={
                approvedCount === 0
                  ? "Approve at least one suggested edit first"
                  : `Push ${approvedCount} approved edit${approvedCount !== 1 ? "s" : ""} to JIRA`
              }
            >
              {jiraUpdateStatus === "saving" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5" />
              )}
              Update JIRA{approvedCount > 0 ? ` (${approvedCount})` : ""}
            </Button>
            {jiraUpdateStatus === "saved" && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle2 className="h-3 w-3" /> Saved to JIRA
              </span>
            )}
            {jiraUpdateStatus === "error" && (
              <span
                className="text-xs text-orange-600 leading-tight"
                title={jiraUpdateError}
              >
                {jiraUpdateError.startsWith("Saved.")
                  ? jiraUpdateError
                  : "Error saving — check console"}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Standard grooming analysis */}
      <DiffedCollapsibleList
        title="Relevant Areas"
        items={relevantItems}
        icon={<FileCode className="h-4 w-4 text-muted-foreground" />}
        hasChanges={relevantItems.some((i) => i.status !== "unchanged")}
        loading={isStreaming}
      />
      <DiffedCollapsibleList
        title="Dependencies"
        items={depItems}
        hasChanges={depItems.some((i) => i.status !== "unchanged")}
        loading={isStreaming}
      />
      {data.grooming_notes && (
        <p className="text-sm text-muted-foreground italic">
          {data.grooming_notes}
        </p>
      )}

      {/* Files read from the codebase */}
      <FilesReadPanel files={filesRead} />
    </div>
  );
}
