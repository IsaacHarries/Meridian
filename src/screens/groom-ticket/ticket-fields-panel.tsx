import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type JiraIssue } from "@/lib/tauri/jira";
import { type SuggestedEditField } from "@/lib/tauri/workflows";
import {
    type DraftChange,
    FIELD_LABELS,
    joinDescriptionSections,
} from "./_shared";
import { FieldEditor } from "./field-editor";

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

export function TicketFieldsPanel({
  issue,
  drafts,
  onSaveField,
  onAcceptSuggestion,
  onDeclineSuggestion,
}: {
  issue: JiraIssue;
  /** Pending AI suggestions, routed to the matching field row. */
  drafts: DraftChange[];
  onSaveField: (field: SuggestedEditField, value: string) => Promise<void>;
  onAcceptSuggestion: (draftId: string) => void;
  onDeclineSuggestion: (draftId: string) => void;
}) {
  const description = joinDescriptionSections(issue);
  // Steps / observed / expected are only meaningful on bug-type tickets;
  // hiding them on Story/Task/etc. avoids cluttering the panel with empty
  // rows the user is never going to fill in for a feature ticket.
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
        <CardTitle className="text-sm font-semibold">Fields</CardTitle>
        <p className="text-xs text-muted-foreground">
          Edits save directly to JIRA. AI suggestions appear inline on each field.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        {fields.map(({ field, value }) => (
          <FieldEditor
            key={field}
            field={field}
            label={FIELD_LABELS[field]}
            value={value ?? ""}
            issue={issue}
            pendingDraft={draftByField.get(field)}
            onSave={(v) => onSaveField(field, v)}
            onAcceptSuggestion={onAcceptSuggestion}
            onDeclineSuggestion={onDeclineSuggestion}
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
}
