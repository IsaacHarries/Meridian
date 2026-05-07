import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type JiraIssue } from "@/lib/tauri/jira";
import { type SuggestedEditField } from "@/lib/tauri/workflows";
import { Check, Loader2 } from "lucide-react";
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";
import {
    type DraftChange,
    FIELD_LABELS,
    joinDescriptionSections,
} from "./_shared";
import { FieldEditor, type FieldEditorHandle } from "./field-editor";

export interface TicketFieldsPanelHandle {
  /** Auto-save every dirty field editor to JIRA. Used by the parent
   *  before switching tickets so unsaved typed/accepted edits land
   *  against the *current* ticket instead of either being lost or
   *  bleeding into the next ticket's local editor state. */
  flushAllDirty: () => Promise<void>;
}

// ── All-fields panel ──────────────────────────────────────────────────────────
//
// Surfaces every relevant field on the loaded ticket up-front so the user
// can read the whole ticket without first running AI analysis. Fields
// render through MarkdownBlock so headings / bold / lists / code / links
// look the way they do in JIRA. Clicking Edit swaps the rendered view for
// a plain Textarea on the raw markdown source; Save commits via
// `saveFieldEdit` and switches back to the rendered view. The Textarea is
// never mounted unless the user explicitly chose to edit, so opening a
// ticket can't trip the dirty flag (no round-trip on display). Fields the
// user can't edit yet (custom fields whose JIRA IDs haven't been
// auto-discovered) show a read-only badge instead of the Edit button.

export const TicketFieldsPanel = forwardRef<TicketFieldsPanelHandle, {
  issue: JiraIssue;
  /** Pending AI suggestions, routed to the matching field row. */
  drafts: DraftChange[];
  onSaveField: (field: SuggestedEditField, value: string) => Promise<void>;
  onAcceptSuggestion: (draftId: string) => void;
  onDeclineSuggestion: (draftId: string) => void;
}>(function TicketFieldsPanel({
  issue,
  drafts,
  onSaveField,
  onAcceptSuggestion,
  onDeclineSuggestion,
}, ref) {
  // Map of registered FieldEditor handles, keyed by field name. Used to
  // call flushIfDirty across every editor when the parent navigates to
  // a different ticket. Refs are deleted on unmount so stale handles
  // pointing at remounted editors never linger.
  const editorRefs = useRef<Map<SuggestedEditField, FieldEditorHandle>>(new Map());

  // Per-field dirty signals fed up from each FieldEditor — drives the
  // "Save all" button's enabled state and counter. Tracked as a Set
  // (rather than booleans per slot) so .size gives the dirty count
  // directly and the empty-Set fast-path is a single check.
  const [dirtyFields, setDirtyFields] = useState<Set<SuggestedEditField>>(
    new Set(),
  );
  const [savingAll, setSavingAll] = useState(false);

  const reportDirty = useCallback(
    (field: SuggestedEditField, dirty: boolean) => {
      setDirtyFields((prev) => {
        const has = prev.has(field);
        if (dirty && has) return prev;
        if (!dirty && !has) return prev;
        const next = new Set(prev);
        if (dirty) next.add(field);
        else next.delete(field);
        return next;
      });
    },
    [],
  );

  async function flushAllDirtyInner() {
    const handles = Array.from(editorRefs.current.values());
    // Sequential rather than Promise.all so a JIRA rate-limit on
    // the first save doesn't fan out into duplicate 429s on the
    // others; the field count here is small (~3–5).
    for (const h of handles) {
      await h.flushIfDirty();
    }
  }

  async function handleSaveAll() {
    if (dirtyFields.size === 0 || savingAll) return;
    setSavingAll(true);
    const count = dirtyFields.size;
    try {
      await flushAllDirtyInner();
      toast.success(`Saved ${count} field${count === 1 ? "" : "s"} to JIRA`);
    } catch (e) {
      toast.error("Couldn't save all fields", { description: String(e) });
    } finally {
      setSavingAll(false);
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      async flushAllDirty() {
        await flushAllDirtyInner();
      },
    }),
    [],
  );
  const description = joinDescriptionSections(issue);
  // Steps / observed / expected are only meaningful on bug-type tickets;
  // hiding them on Story/Task/etc. avoids cluttering the panel with empty
  // rows the user is never going to fill in for a feature ticket. The
  // ticket title (`summary`) is rendered separately by TicketSummaryCard
  // at the top of the screen, where it has its own inline-edit affordance
  // and AI-suggestion strip.
  const isBug = issue.issueType.toLowerCase() === "bug";
  const fields: { field: SuggestedEditField; value: string | null }[] = [
    { field: "description", value: description || null },
    { field: "acceptance_criteria", value: issue.acceptanceCriteria },
    ...(isBug
      ? ([
          { field: "steps_to_reproduce", value: issue.stepsToReproduce },
          { field: "observed_behavior", value: issue.observedBehavior },
          { field: "expected_behavior", value: issue.expectedBehavior },
        ] as const)
      : []),
  ];

  // Pick the FIRST pending draft per field — multiple drafts on the same
  // field are unusual, and the chat round can refresh suggestions if the
  // user wants a different one.
  const draftByField = new Map<SuggestedEditField, DraftChange>();
  for (const d of drafts) {
    if (d.status !== "pending") continue;
    if (!draftByField.has(d.field)) draftByField.set(d.field, d);
  }

  return (
    <Card>
      <CardHeader className="pb-3 border-b">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">Fields</CardTitle>
            <p className="text-xs text-muted-foreground">
              Edits save directly to JIRA. AI suggestions appear inline on each field.
            </p>
          </div>
          <Button
            size="sm"
            className="h-7 px-2 text-xs gap-1 shrink-0"
            onClick={() => void handleSaveAll()}
            disabled={dirtyFields.size === 0 || savingAll}
            title={
              dirtyFields.size === 0
                ? "No unsaved field edits"
                : `Save ${dirtyFields.size} pending field edit${dirtyFields.size === 1 ? "" : "s"} to JIRA`
            }
          >
            {savingAll ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            Save all
            {dirtyFields.size > 0 && !savingAll && (
              <span className="ml-0.5 text-[10px] opacity-80">
                ({dirtyFields.size})
              </span>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        {fields.map(({ field, value }) => (
          // Key by issue id so local editor state (mode, dirty content,
          // diff decisions) resets when the user switches tickets — a
          // safety net for the auto-save flow: even if flushAllDirty
          // fails, stale text never bleeds into the next ticket.
          <FieldEditor
            key={`${issue.id}-${field}`}
            ref={(handle) => {
              if (handle) editorRefs.current.set(field, handle);
              else editorRefs.current.delete(field);
            }}
            field={field}
            label={FIELD_LABELS[field]}
            value={value ?? ""}
            issue={issue}
            pendingDraft={draftByField.get(field)}
            onSave={(v) => onSaveField(field, v)}
            onAcceptSuggestion={onAcceptSuggestion}
            onDeclineSuggestion={onDeclineSuggestion}
            onDirtyChange={(dirty) => reportDirty(field, dirty)}
          />
        ))}
        {Object.keys(issue.namedFields ?? {}).length > 0 && (
          <div className="space-y-1.5 pt-2 border-t">
            <p className="text-xs font-medium text-muted-foreground">
              Other fields
            </p>
            {Object.entries(issue.namedFields ?? {}).map(([name, value]) => (
              <div
                key={name}
                className="flex items-start gap-2 text-xs leading-snug"
              >
                <span className="font-medium text-foreground shrink-0">
                  {name}:
                </span>
                <span className="text-muted-foreground whitespace-pre-wrap break-words">
                  {value}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t">
          <span>Labels:</span>
          {issue.labels.length === 0 ? (
            <span className="italic">none</span>
          ) : (
            issue.labels.map((l) => (
              <Badge key={l} variant="secondary" className="text-[10px] py-0 px-1.5">
                {l}
              </Badge>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
});
