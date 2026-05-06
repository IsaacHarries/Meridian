import { MarkdownBlock } from "@/components/MarkdownBlock";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type JiraIssue } from "@/lib/tauri/jira";
import { type SuggestedEditField } from "@/lib/tauri/workflows";
import { Check, Loader2, Pencil, X } from "lucide-react";
import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import {
    type DraftChange,
    composeFromDecisions,
    computeUnifiedDiff,
    preserveImagesFromOriginal,
    resolveJiraFieldId,
} from "./_shared";
import { InlineDiffView } from "./diff-view";

export interface FieldEditorHandle {
  /** If the field has unsaved edits, push them to JIRA. Used by the
   *  parent to auto-save in-flight edits when the user navigates to a
   *  different ticket without explicitly clicking Save. No-op when not
   *  dirty, not editable, or while an AI suggestion diff is open
   *  (mid-resolution edits aren't a committed change yet). */
  flushIfDirty: () => Promise<void>;
}

export const FieldEditor = forwardRef<FieldEditorHandle, {
  field: SuggestedEditField;
  label: string;
  value: string;
  issue: JiraIssue;
  pendingDraft?: DraftChange;
  onSave: (newValue: string) => Promise<void>;
  /** Marks the draft as accepted in the parent state. The actual content
   *  push into the editor happens locally — confirming a suggestion no
   *  longer writes to JIRA on its own; the user must press Save to submit. */
  onAcceptSuggestion: (draftId: string) => void;
  onDeclineSuggestion: (draftId: string) => void;
}>(function FieldEditor({
  field,
  label,
  value,
  issue,
  pendingDraft,
  onSave,
  onAcceptSuggestion,
  onDeclineSuggestion,
}, ref) {
  // `editorContent` is what the editor currently shows — driven by user
  // typing, suggestion accepts, or external sync. `baseline` is the last
  // value we know matches what JIRA has stored. Save shows whenever they
  // differ. Tracking these separately means we can push a suggestion into
  // the editor (sets editorContent, leaves baseline alone, dirty=true)
  // without needing the editor's imperative API.
  const [editorContent, setEditorContent] = useState(value);
  const [baseline, setBaseline] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // View vs. edit toggle. Default is read-only rendered markdown so the
  // field looks the way it does in JIRA. Clicking Edit switches to a
  // plain Textarea on the raw markdown source — no WYSIWYG round-trip,
  // so opening / re-rendering never silently mutates the value.
  const [mode, setMode] = useState<"view" | "edit">("view");
  // Auto-grow the textarea so the whole field is visible without an
  // inner scrollbar. Resync on every content change (typing, suggestion
  // accept, JIRA refetch) and on edit-mode entry.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editorContent, mode]);
  // Per-entry decisions for the inline pre-accept diff. Keyed by entry
  // index in the unified diff (which is stable across renders for a
  // given suggestion since the AI's text doesn't change while the strip
  // is open). When all changeable entries have a status, the composed
  // result is committed to editorContent and the suggestion is dismissed.
  const [diffDecisions, setDiffDecisions] = useState<
    Map<number, "accepted" | "declined">
  >(new Map());

  // Resync when the underlying JIRA value changes (after save + refetch,
  // ticket switch, etc.). If the user wasn't dirty, adopt the new value
  // into the editor too; otherwise keep the user's edits but update the
  // baseline so the dirty check stays correct against the new JIRA truth.
  useEffect(() => {
    setBaseline((prevBaseline) => {
      setEditorContent((prevContent) =>
        prevContent === prevBaseline ? value : prevContent,
      );
      return value;
    });
    // Intentionally only depend on `value`; including baseline would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // summary & description are always editable on JIRA's side. Custom
  // fields require their JIRA ID to have been discovered (auto-populated
  // by `get_jira_fields`, or configured manually in Settings).
  const fieldId = resolveJiraFieldId(field, issue);
  const editable = fieldId !== null;
  const dirty = editorContent !== baseline;

  // Reset per-entry decisions whenever a new draft arrives (or the
  // current one is cleared). Keyed on the draft id so swapping which
  // suggestion is showing wipes previous resolutions.
  const pendingDraftId = pendingDraft?.id ?? null;
  useEffect(() => {
    setDiffDecisions(new Map());
  }, [pendingDraftId]);

  async function commit() {
    setSaving(true);
    setError(null);
    try {
      await onSave(editorContent);
      // Optimistically pin the new baseline; the parent's refetch will
      // overwrite via the value-resync effect when it lands.
      setBaseline(editorContent);
      setMode("view");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      async flushIfDirty() {
        if (!editable) return;
        if (editorContent === baseline) return;
        // Mid-resolution AI suggestion: the user hasn't committed to the
        // composed result yet, so we don't auto-save. Once they finish
        // resolving the diff, the editor flips to mode==="edit" with the
        // composed text — re-entering this method's scope.
        if (pendingDraft) return;
        await onSave(editorContent);
        setBaseline(editorContent);
        setMode("view");
      },
    }),
    [editable, editorContent, baseline, pendingDraft, onSave],
  );

  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </h4>
          {!editable && (
            <span
              className="text-[10px] text-muted-foreground italic"
              title="JIRA field ID not yet auto-discovered. Run the AI analysis once on this issue type to populate it, or configure the custom field IDs in Settings."
            >
              (read-only — field ID not discovered)
            </span>
          )}
        </div>
        {pendingDraft ? (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs gap-1"
              onClick={() => {
                // Apply every diff entry in one shot — same composition
                // path the per-entry "Accept" buttons use, just with
                // every changeable entry pre-resolved as accepted.
                if (!pendingDraft) return;
                const entries = computeUnifiedDiff(
                  editorContent,
                  preserveImagesFromOriginal(
                    pendingDraft.current ?? baseline,
                    pendingDraft.editedSuggested,
                  ),
                );
                const decisions = new Map<number, "accepted" | "declined">();
                entries.forEach((e, i) => {
                  if (e.kind !== "unchanged") decisions.set(i, "accepted");
                });
                const composed = composeFromDecisions(entries, decisions);
                setEditorContent(composed);
                setError(null);
                setDiffDecisions(new Map());
                setMode("edit");
                onAcceptSuggestion(pendingDraft.id);
              }}
              title="Accept every proposed change at once"
            >
              <Check className="h-3 w-3" />
              Accept all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs gap-1"
              onClick={() => onDeclineSuggestion(pendingDraft.id)}
              title="Dismiss the whole AI suggestion without applying any changes"
            >
              <X className="h-3 w-3" />
              Decline all
            </Button>
          </div>
        ) : editable && mode === "view" ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs gap-1"
            onClick={() => setMode("edit")}
            title={`Edit ${label.toLowerCase()}`}
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
        ) : editable && mode === "edit" ? (
          <div className="flex gap-1">
            <Button
              size="sm"
              className="h-6 px-2 text-xs gap-1"
              onClick={commit}
              disabled={saving || !dirty}
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs gap-1"
              onClick={() => {
                setEditorContent(baseline);
                setError(null);
                setMode("view");
              }}
              disabled={saving}
            >
              <X className="h-3 w-3" />
              Cancel
            </Button>
          </div>
        ) : null}
      </div>

      {/* When the AI's reasoning is non-empty, surface it as a thin
          italic line under the header so the user knows *why* the
          suggested edit was proposed without a chrome-heavy strip. */}
      {pendingDraft?.reasoning && (
        <p className="text-[11px] text-muted-foreground italic leading-snug px-3 py-1.5 border-b bg-primary/5">
          {pendingDraft.reasoning}
        </p>
      )}

      <div>
        {pendingDraft ? (
          /* Pre-accept preview: show the proposed change as a unified
             diff in the field area, with per-entry Accept / Decline so
             the user can take only the parts they want. As entries are
             resolved, the diff updates in place. Once every change has
             a decision the composed result is committed to the editor
             and the suggestion strip dismisses. */
          <InlineDiffView
            currentText={editorContent}
            suggestedText={preserveImagesFromOriginal(
              pendingDraft.current ?? baseline,
              pendingDraft.editedSuggested,
            )}
            decisions={diffDecisions}
            onResolve={(entryIdx, decision) => {
              const next = new Map(diffDecisions);
              next.set(entryIdx, decision);
              const entries = computeUnifiedDiff(
                editorContent,
                preserveImagesFromOriginal(
                  pendingDraft.current ?? baseline,
                  pendingDraft.editedSuggested,
                ),
              );
              const allResolved = entries.every(
                (e, i) => e.kind === "unchanged" || next.has(i),
              );
              if (allResolved) {
                // Commit the composed result to the editor, jump into
                // edit mode so the Save button is visible (the field is
                // now dirty and the user just made changes), and dismiss
                // the suggestion in parent state.
                const composed = composeFromDecisions(entries, next);
                setEditorContent(composed);
                setError(null);
                setDiffDecisions(new Map());
                setMode("edit");
                onAcceptSuggestion(pendingDraft.id);
              } else {
                setDiffDecisions(next);
              }
            }}
          />
        ) : mode === "edit" ? (
          <Textarea
            ref={textareaRef}
            value={editorContent}
            onChange={(e) => setEditorContent(e.currentTarget.value)}
            placeholder={`Enter ${label.toLowerCase()}…`}
            disabled={saving || !editable}
            spellCheck
            autoFocus
            className="min-h-[60px] rounded-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 resize-none overflow-hidden font-mono text-xs leading-relaxed whitespace-pre-wrap"
          />
        ) : editorContent.trim() ? (
          <div className="px-3 py-2">
            <MarkdownBlock text={editorContent} />
          </div>
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground italic">
            (empty)
          </div>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive px-3 py-1.5 border-t bg-destructive/5">
          {error}
        </p>
      )}
    </div>
  );
});
