import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { createPortal } from "react-dom";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import { createGlobalCommands, type SlashCommand } from "@/lib/slashCommands";
import { fuzzyFilterIssues, mergeIssuesById } from "@/lib/fuzzySearch";
import {
  ArrowLeft,
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Calendar,
  AlertTriangle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Sparkles,
  Check,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Undo2,
} from "lucide-react";
import { diffArrays } from "diff";
import { MarkdownBlock } from "@/components/MarkdownBlock";
import { RichFieldEditor } from "@/components/RichFieldEditor";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type JiraIssue,
  type JiraSprint,
  type CredentialStatus,
  type SuggestedEditField,
  type GroomingOutput,
  type GroomingChatResponse,
  aiProviderComplete,
  jiraComplete,
  getAllActiveSprints,
  getFutureSprints,
  getSprintIssues,
  getIssue,
  searchJiraIssues,
  runGroomingAgent,
  runGroomingFileProbe,
  runGroomingChatTurn,
  grepGroomingFiles,
  readGroomingFile,
  syncGroomingWorktree,
  validateGroomingWorktree,
  updateJiraFields,
  parseAgentJson,
  openUrl,
} from "@/lib/tauri";

interface TicketQualityScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── State model ───────────────────────────────────────────────────────────────

interface GroomChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface DraftChange {
  id: string;
  field: SuggestedEditField;
  section: string;
  current: string | null;
  suggested: string;
  editedSuggested: string;
  userEdited: boolean;
  reasoning: string;
  status: "pending" | "approved" | "declined";
  applyResult?: "ok" | "error";
  applyError?: string;
}

interface GroomSession {
  issue: JiraIssue;
  chat: GroomChatMessage[];
  drafts: DraftChange[];
  thinking: boolean;
  applying: boolean;
  probeStatus: string;
  /**
   * True once the AI grooming agent has produced an output for this issue.
   * Selecting a ticket loads the issue with `analyzed: false` and surfaces
   * the field-editor panel; the user clicks "Start analysis" to flip this
   * to true via `analyzeTicket()`. Re-running analysis stays gated behind
   * an explicit click so we never burn tokens unprompted.
   */
  analyzed: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function compileTicketText(issue: JiraIssue): string {
  const lines: string[] = [];
  lines.push(`Ticket: ${issue.key}`);
  lines.push(`Title: ${issue.summary}`);
  lines.push(`Type: ${issue.issueType}`);
  if (issue.storyPoints != null) lines.push(`Story points: ${issue.storyPoints}`);
  if (issue.priority) lines.push(`Priority: ${issue.priority}`);
  lines.push(`Status: ${issue.status}`);
  if (issue.epicSummary) lines.push(`Epic: ${issue.epicSummary}${issue.epicKey ? ` (${issue.epicKey})` : ""}`);
  if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(", ")}`);
  if (issue.assignee) lines.push(`Assignee: ${issue.assignee.displayName}`);
  lines.push("");
  if (issue.description) { lines.push("Description:"); lines.push(issue.description); }
  else { lines.push("Description: (none)"); }
  if (issue.acceptanceCriteria) { lines.push(""); lines.push("Acceptance Criteria:"); lines.push(issue.acceptanceCriteria); }
  if (issue.stepsToReproduce) { lines.push(""); lines.push("Steps to Reproduce:"); lines.push(issue.stepsToReproduce); }
  if (issue.observedBehavior) { lines.push(""); lines.push("Observed Behavior:"); lines.push(issue.observedBehavior); }
  if (issue.expectedBehavior) { lines.push(""); lines.push("Expected Behavior:"); lines.push(issue.expectedBehavior); }
  return lines.join("\n");
}

function statusAge(issue: JiraIssue): string {
  const days = Math.floor((Date.now() - new Date(issue.updated).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function resolveJiraFieldId(field: SuggestedEditField, issue: JiraIssue): string | null {
  if (field === "summary") return "summary";
  if (field === "description") return "description";
  return issue.discoveredFieldIds?.[field] ?? null;
}

function getCurrentFieldValue(field: SuggestedEditField, issue: JiraIssue): string | null {
  switch (field) {
    case "acceptance_criteria": return issue.acceptanceCriteria ?? null;
    case "steps_to_reproduce":  return issue.stepsToReproduce ?? null;
    case "observed_behavior":   return issue.observedBehavior ?? null;
    case "expected_behavior":   return issue.expectedBehavior ?? null;
    case "description":         return issue.description ?? null;
    case "summary":             return issue.summary ?? null;
    default:                    return null;
  }
}

function suggestedEditsToDraftChanges(edits: GroomingOutput["suggested_edits"], issue: JiraIssue): DraftChange[] {
  // Merge duplicate fields into a single edit (agent occasionally emits multiple AC sections).
  const merged = new Map<string, GroomingOutput["suggested_edits"][number]>();
  for (const e of edits) {
    const existing = merged.get(e.field);
    if (existing) {
      existing.suggested = `${existing.suggested.trimEnd()}\n${e.suggested.trimStart()}`;
      existing.reasoning = `${existing.reasoning} ${e.reasoning}`;
    } else {
      merged.set(e.field, { ...e });
    }
  }
  return Array.from(merged.values()).map((e) => ({
    id: e.id, field: e.field, section: e.section,
    // Agent sometimes returns current: null even when the field has a value.
    // Fall back to the actual field value from the fetched issue.
    current: e.current ?? getCurrentFieldValue(e.field, issue),
    suggested: e.suggested, editedSuggested: e.suggested,
    userEdited: false, reasoning: e.reasoning, status: "pending",
  }));
}

/** True when a draft's target field is rendered inline by `TicketFieldsPanel`,
 *  so it has somewhere to surface as an inline suggestion and shouldn't
 *  also appear in the standalone DraftChangesPanel. Steps/observed/expected
 *  only count as inline-rendered on bug-type tickets, mirroring the panel's
 *  own filter. */
function isInlineField(field: SuggestedEditField, issue: JiraIssue): boolean {
  if (field === "description" || field === "acceptance_criteria") return true;
  const isBug = issue.issueType.toLowerCase() === "bug";
  if (!isBug) return false;
  return (
    field === "steps_to_reproduce" ||
    field === "observed_behavior" ||
    field === "expected_behavior"
  );
}

/** Draft whose target field doesn't have an inline home — e.g. summary,
 *  or a bug-only field on a non-bug ticket. These still need to surface
 *  somewhere, so we keep the legacy DraftChangesPanel for them. */
function isOrphanDraft(draft: DraftChange, issue: JiraIssue): boolean {
  return !isInlineField(draft.field, issue);
}

function hasOrphanDrafts(drafts: DraftChange[], issue: JiraIssue): boolean {
  return drafts.some(
    (d) => d.status !== "declined" && isOrphanDraft(d, issue),
  );
}

function buildOpeningMessage(issue: JiraIssue, output: GroomingOutput): string {
  const { clarifying_questions: questions, ticket_summary } = output;
  if (questions && questions.length > 0) {
    const qs = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    return `I've reviewed **${issue.key}**. ${ticket_summary}\n\nI have a few questions before finalising:\n\n${qs}`;
  }
  const n = output.suggested_edits.length;
  if (n === 0) return `I've reviewed **${issue.key}**. ${ticket_summary}\n\nThe ticket looks well-formed. Is there anything you'd like me to clarify or adjust?`;
  return `I've reviewed **${issue.key}**. ${ticket_summary}\n\nI've drafted ${n} suggested change${n === 1 ? "" : "s"} — review them in the Draft Changes panel below.`;
}

// ── Field diagnostics ─────────────────────────────────────────────────────────

function FieldDiagnostics({ issue }: { issue: JiraIssue }) {
  const [open, setOpen] = useState(false);
  // Match the per-ticket-type filter used by TicketFieldsPanel — steps /
  // observed / expected only matter on bugs, so showing them as "missing"
  // on a Story/Task creates noise.
  const isBug = issue.issueType.toLowerCase() === "bug";
  const fields = [
    { label: "Description", value: issue.description },
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

// ── All-fields panel ──────────────────────────────────────────────────────────
//
// Surfaces every relevant field on the loaded ticket up-front so the user
// can read the whole ticket without first running AI analysis. Each row is
// edit-in-place: clicking Edit swaps the rendered MarkdownBlock for a
// Textarea; Save sends the new value back to JIRA via `saveFieldEdit`,
// which refreshes the issue once the request returns.
//
// Description renders out of `descriptionSections` (joined to markdown so
// embedded images surface); other fields render their plain-string
// projection from the JIRA integration. Fields the user can't edit yet
// (custom fields whose JIRA IDs haven't been auto-discovered) show a
// read-only badge instead of the Edit button.

const FIELD_LABELS: Record<SuggestedEditField, string> = {
  summary: "Summary",
  description: "Description",
  acceptance_criteria: "Acceptance Criteria",
  steps_to_reproduce: "Steps to Reproduce",
  observed_behavior: "Observed Behavior",
  expected_behavior: "Expected Behavior",
};

/**
 * Safety net for AI-driven applies: returns `suggested` with any image
 * markdown from `original` that's missing in the suggestion appended at
 * the end. Match is by URL — alt text differences don't trigger a re-add,
 * which avoids duplicating the same attachment under a renamed alt.
 *
 * Only used on the AI-apply paths (confirm suggestion, apply draft). The
 * inline edit/save path treats the user as authoritative — if they
 * deliberately remove an image while editing, we respect that.
 */
function preserveImagesFromOriginal(
  original: string | null,
  suggested: string,
): string {
  if (!original) return suggested;
  // `![alt](url)` — alt may be empty, url has no balanced parens (good
  // enough for the JIRA-attachment shape we emit; no titles/whitespace).
  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  const originalImages: { full: string; url: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(original)) !== null) {
    originalImages.push({ full: m[0], url: m[2] });
  }
  if (originalImages.length === 0) return suggested;
  const suggestedUrls = new Set<string>();
  imgRe.lastIndex = 0;
  while ((m = imgRe.exec(suggested)) !== null) {
    suggestedUrls.add(m[2]);
  }
  const missing = originalImages.filter((i) => !suggestedUrls.has(i.url));
  if (missing.length === 0) return suggested;
  // Append with a blank-line separator so the images render as their own
  // paragraph rather than running into the suggestion's last line. Keep
  // the original ordering of any duplicates intact (Set above only tracks
  // presence, not count).
  const trailer = missing.map((i) => i.full).join("\n\n");
  const sep = suggested.endsWith("\n\n") ? "" : suggested.endsWith("\n") ? "\n" : "\n\n";
  return `${suggested}${sep}${trailer}`;
}

// ── Per-paragraph diff (for AI-suggestion peek) ──────────────────────────────
//
// After the user accepts an AI suggestion, we keep a "pre-accept" snapshot
// of what the field looked like before. This lets the user compare the
// editor's current content against that snapshot and revert individual
// paragraph-sized changes — e.g. accept the AI's first paragraph but
// revert the third. We split on blank lines (markdown paragraph breaks),
// run the `diff` library's array diff to align, and pair each removed
// chunk with the immediately-following added chunk so the user sees a
// "before / after" rather than separate add/remove rows.

interface DiffEntry {
  /** "modified" = old text was rewritten; "added" = new paragraph that
   *  wasn't present before; "removed" = paragraph deleted from the
   *  baseline. We surface only changed entries to the user — unchanged
   *  paragraphs would just be noise alongside the editor that already
   *  shows them. */
  kind: "modified" | "added" | "removed";
  oldText: string;
  newText: string;
}

/** Same shape as `DiffEntry` but extended with "unchanged" — used by the
 *  pre-accept inline diff view so the user sees changed paragraphs in
 *  context with the surrounding unchanged ones. */
interface UnifiedDiffEntry {
  kind: "modified" | "added" | "removed" | "unchanged";
  oldText: string;
  newText: string;
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Plain-text projection of a markdown paragraph — used to match diff
 * entries (markdown source) against rendered DOM nodes (no syntax) when
 * positioning gutter bars in the editor. Strips the most common markdown
 * sigils so `**bold**` matches `bold`, `[text](url)` matches `text`,
 * etc. Image embeds collapse to their alt text since the rendered DOM
 * for an image is just its alt attribute.
 */
function markdownToPlainText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^[-+*]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Apply a per-entry decision map to a unified diff and emit the resulting
 * markdown. "accepted" on a modified entry adopts the new paragraph;
 * "declined" keeps the old. Added entries only appear when accepted;
 * removed entries only stay when declined. Unchanged paragraphs always
 * pass through. Joins paragraphs with a blank line so the result is
 * canonical markdown.
 */
function composeFromDecisions(
  entries: UnifiedDiffEntry[],
  decisions: Map<number, "accepted" | "declined">,
): string {
  const out: string[] = [];
  entries.forEach((entry, i) => {
    const decision = decisions.get(i);
    if (entry.kind === "unchanged") {
      out.push(entry.newText);
      return;
    }
    if (entry.kind === "modified") {
      out.push(decision === "accepted" ? entry.newText : entry.oldText);
      return;
    }
    if (entry.kind === "added") {
      if (decision === "accepted") out.push(entry.newText);
      return;
    }
    if (entry.kind === "removed") {
      if (decision !== "accepted") out.push(entry.oldText);
      return;
    }
  });
  return out.join("\n\n");
}

/** Like `computeParagraphDiff` but emits "unchanged" entries too. Used by
 *  the inline-diff view shown before the user accepts a suggestion, so
 *  changed paragraphs read in context with their unchanged neighbours. */
function computeUnifiedDiff(
  oldText: string,
  newText: string,
): UnifiedDiffEntry[] {
  const oldParas = splitParagraphs(oldText);
  const newParas = splitParagraphs(newText);
  const chunks = diffArrays(oldParas, newParas);
  const entries: UnifiedDiffEntry[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const next = chunks[i + 1];
    if (c.removed && next?.added) {
      const pairCount = Math.min(c.value.length, next.value.length);
      for (let j = 0; j < pairCount; j++) {
        entries.push({
          kind: "modified",
          oldText: c.value[j],
          newText: next.value[j],
        });
      }
      for (let j = pairCount; j < c.value.length; j++) {
        entries.push({ kind: "removed", oldText: c.value[j], newText: "" });
      }
      for (let j = pairCount; j < next.value.length; j++) {
        entries.push({ kind: "added", oldText: "", newText: next.value[j] });
      }
      i++; // consume the paired added chunk
    } else if (c.removed) {
      for (const p of c.value) {
        entries.push({ kind: "removed", oldText: p, newText: "" });
      }
    } else if (c.added) {
      for (const p of c.value) {
        entries.push({ kind: "added", oldText: "", newText: p });
      }
    } else {
      for (const p of c.value) {
        entries.push({ kind: "unchanged", oldText: p, newText: p });
      }
    }
  }
  return entries;
}

function computeParagraphDiff(
  oldText: string,
  newText: string,
): DiffEntry[] {
  const oldParas = splitParagraphs(oldText);
  const newParas = splitParagraphs(newText);
  const chunks = diffArrays(oldParas, newParas);
  const entries: DiffEntry[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const next = chunks[i + 1];
    if (c.removed && next?.added) {
      // Pair removed-then-added as 1:1 modifications. Padding with empty
      // strings if counts diverge keeps each pair matched up; the
      // overflow surfaces as standalone added/removed entries via the
      // logic below.
      const pairCount = Math.min(c.value.length, next.value.length);
      for (let j = 0; j < pairCount; j++) {
        entries.push({
          kind: "modified",
          oldText: c.value[j],
          newText: next.value[j],
        });
      }
      for (let j = pairCount; j < c.value.length; j++) {
        entries.push({ kind: "removed", oldText: c.value[j], newText: "" });
      }
      for (let j = pairCount; j < next.value.length; j++) {
        entries.push({ kind: "added", oldText: "", newText: next.value[j] });
      }
      i++; // consume the paired `added` chunk
    } else if (c.removed) {
      for (const p of c.value) {
        entries.push({ kind: "removed", oldText: p, newText: "" });
      }
    } else if (c.added) {
      for (const p of c.value) {
        entries.push({ kind: "added", oldText: "", newText: p });
      }
    }
    // unchanged chunks contribute nothing — the editor already shows them.
  }
  return entries;
}

/** Compose a markdown projection of the description from its sections.
 *  Falls back to the plain `issue.description` if no sections are present. */
function joinDescriptionSections(issue: JiraIssue): string {
  if (issue.descriptionSections && issue.descriptionSections.length > 0) {
    return issue.descriptionSections
      .map((s) => (s.heading ? `## ${s.heading}\n${s.content}` : s.content))
      .join("\n\n")
      .trim();
  }
  return issue.description ?? "";
}

function TicketFieldsPanel({
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

function FieldEditor({
  field,
  label,
  value,
  issue,
  pendingDraft,
  onSave,
  onAcceptSuggestion,
  onDeclineSuggestion,
}: {
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
}) {
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
  // Snapshot of editor content at the moment the user accepted an AI
  // suggestion. Used to compute a paragraph-level diff against the
  // current editor content, so the user can peek at and selectively
  // revert individual paragraph changes the AI made. Cleared on Save,
  // Cancel, or another Accept (the new accept overwrites the snapshot).
  const [preAcceptBaseline, setPreAcceptBaseline] = useState<string | null>(null);
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
      // Snapshot is no longer meaningful once the new content is the
      // truth on JIRA — clear so the gutter bars disappear.
      setPreAcceptBaseline(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  /** Revert a single diff entry's change, swapping the AI's text back to
   *  the pre-accept paragraph (or removing/re-inserting for pure
   *  add/remove cases). Operates on the LIVE editor content so further
   *  user edits are preserved when possible — if the new text the user
   *  is reverting has been edited away, the substring search fails and
   *  we surface a hint instead of silently doing the wrong thing. */
  function revertDiffEntry(entry: DiffEntry) {
    setError(null);
    if (entry.kind === "modified") {
      const idx = editorContent.indexOf(entry.newText);
      if (idx === -1) {
        setError(
          "Couldn't auto-revert — the surrounding text has been edited.",
        );
        return;
      }
      setEditorContent(
        editorContent.slice(0, idx) +
          entry.oldText +
          editorContent.slice(idx + entry.newText.length),
      );
    } else if (entry.kind === "added") {
      const idx = editorContent.indexOf(entry.newText);
      if (idx === -1) {
        setError(
          "Couldn't auto-revert — the inserted paragraph has been edited.",
        );
        return;
      }
      // Trim a surrounding paragraph break on whichever side has one so
      // the field doesn't end up with a double blank line.
      const before = editorContent.slice(0, idx);
      const after = editorContent.slice(idx + entry.newText.length);
      const stitched = before.trimEnd() + (after.trimStart() ? "\n\n" : "") + after.trimStart();
      setEditorContent(stitched);
    } else {
      // "removed" — the paragraph existed in the baseline but the AI
      // dropped it. Re-insert at the end of the editor as a paragraph
      // (we don't know the exact original position once other edits have
      // shifted things around).
      const sep = editorContent.endsWith("\n\n")
        ? ""
        : editorContent.endsWith("\n")
          ? "\n"
          : "\n\n";
      setEditorContent(`${editorContent}${sep}${entry.oldText}`);
    }
  }

  // Diff the current editor content against the snapshot taken at accept
  // time. Recomputed on every keystroke, but each step is cheap (split +
  // single-pass diff over a small paragraph array).
  const diffEntries = preAcceptBaseline !== null
    ? computeParagraphDiff(preAcceptBaseline, editorContent)
    : [];

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
        {editable && dirty && (
          <div className="flex gap-1">
            <Button
              size="sm"
              className="h-6 px-2 text-xs gap-1"
              onClick={commit}
              disabled={saving}
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
                setPreAcceptBaseline(null);
              }}
              disabled={saving}
            >
              <X className="h-3 w-3" />
              Cancel
            </Button>
          </div>
        )}
      </div>

      {/* AI suggestion strip — Accept/Decline now live per-change inside
          the diff view. The strip just carries the AI label, reasoning,
          and a "Decline all" quick-out for the user to dismiss the whole
          set without resolving each entry. */}
      {pendingDraft && (
        <div className="border-b bg-primary/5 px-3 py-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <Sparkles className="h-3 w-3" />
              AI suggestion — accept or decline each change below
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs gap-1"
              onClick={() => onDeclineSuggestion(pendingDraft.id)}
              title="Dismiss the whole suggestion without applying any changes"
            >
              <X className="h-3 w-3" />
              Decline all
            </Button>
          </div>
          {pendingDraft.reasoning && (
            <p className="text-[11px] text-muted-foreground italic leading-snug">
              {pendingDraft.reasoning}
            </p>
          )}
        </div>
      )}

      <div className="min-h-[120px]">
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
                // Commit the composed result to the editor, snapshot
                // the pre-accept state for the post-accept revert UX,
                // and dismiss the suggestion in parent state.
                const composed = composeFromDecisions(entries, next);
                setPreAcceptBaseline(editorContent);
                setEditorContent(composed);
                setError(null);
                setDiffDecisions(new Map());
                onAcceptSuggestion(pendingDraft.id);
              } else {
                setDiffDecisions(next);
              }
            }}
          />
        ) : (
          <EditorWithGutter
            editorContent={editorContent}
            setEditorContent={setEditorContent}
            placeholder={`Enter ${label.toLowerCase()}…`}
            disabled={saving || !editable}
            // Gutter bars only render when there's a pre-accept snapshot
            // (immediately after the user has resolved the AI's diff).
            // They disappear on Save / Cancel — at that point the field
            // matches its JIRA truth and there's nothing to "revert to".
            diffEntries={preAcceptBaseline !== null ? diffEntries : []}
            onRevertEntry={revertDiffEntry}
          />
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive px-3 py-1.5 border-t bg-destructive/5">
          {error}
        </p>
      )}
    </div>
  );
}

// ── Pre-accept inline diff view ─────────────────────────────────────────────
//
// Replaces the editor while an AI suggestion is pending. Renders a
// paragraph-level unified diff: unchanged paragraphs in muted text so the
// user has context, removed paragraphs in red with strikethrough, added
// paragraphs in green. Modified paragraphs render as removed-then-added
// pairs. Read-only — Accept loads the suggestion into the editor (which
// returns to its normal editable state).

function InlineDiffView({
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
            <div key={i} className="text-foreground/60">
              <MarkdownBlock text={entry.newText} />
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
function DiffEntryProposal({
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
  const showOld =
    entry.kind === "removed" || entry.kind === "modified";
  const showNew =
    entry.kind === "added" || entry.kind === "modified";

  // When resolved, mute the side that "lost" so the user can still see
  // both halves but the decision is obvious.
  const oldMuted = resolved === "accepted";
  const newMuted = resolved === "declined";

  const kindLabel =
    entry.kind === "modified"
      ? "Modified"
      : entry.kind === "added"
        ? "Added"
        : "Removed";

  return (
    <div className="rounded-md border bg-background overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/40">
        <span
          className={cn(
            "text-[10px] uppercase tracking-wide font-semibold",
            entry.kind === "modified" && "text-amber-600 dark:text-amber-400",
            entry.kind === "added" && "text-emerald-600 dark:text-emerald-400",
            entry.kind === "removed" && "text-rose-600 dark:text-rose-400",
          )}
        >
          {kindLabel}
        </span>
        {resolved ? (
          <span
            className={cn(
              "text-[10px] uppercase tracking-wide font-semibold",
              resolved === "accepted"
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground",
            )}
          >
            {resolved === "accepted" ? "✓ Accepted" : "✕ Declined"}
          </span>
        ) : (
          <div className="flex gap-1">
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
        )}
      </div>
      {showOld && (
        <DiffParagraphBlock
          kind="removed"
          text={entry.oldText}
          dim={oldMuted}
        />
      )}
      {showNew && (
        <DiffParagraphBlock
          kind="added"
          text={entry.newText}
          dim={newMuted}
        />
      )}
    </div>
  );
}

function DiffParagraphBlock({
  kind,
  text,
  dim,
}: {
  kind: "added" | "removed";
  text: string;
  dim?: boolean;
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
          "flex-1 min-w-0",
          kind === "removed" && "line-through decoration-rose-400/60",
        )}
      >
        <MarkdownBlock text={text} />
      </div>
    </div>
  );
}

// ── Post-accept editor + gutter bars + revert popover ───────────────────────
//
// After the user accepts an AI suggestion (per-paragraph), the editor
// returns showing the composed result, but with coloured vertical bars
// in a left-side gutter aligned with each paragraph that changed. The
// alignment is by DOM measurement: we read the rendered ProseMirror
// children's bounding rects, match each against the diff entries by
// plain-text projection (markdown sigils stripped on both sides), and
// position absolute-positioned bar buttons in the gutter at the same
// vertical coordinates. Clicking a bar opens a small popover anchored
// near it showing the pre-accept text and a Revert button.

function EditorWithGutter({
  editorContent,
  setEditorContent,
  placeholder,
  disabled,
  diffEntries,
  onRevertEntry,
}: {
  editorContent: string;
  setEditorContent: (md: string) => void;
  placeholder: string;
  disabled: boolean;
  diffEntries: DiffEntry[];
  onRevertEntry: (entry: DiffEntry) => void;
}) {
  const editorWrapperRef = useRef<HTMLDivElement>(null);
  const [bars, setBars] = useState<
    {
      key: string;
      top: number;
      height: number;
      entry: DiffEntry;
    }[]
  >([]);
  // Anchor for the open popover, captured at click time in viewport
  // (fixed-position) coordinates. The popover is rendered via portal
  // to document.body so the field's overflow:hidden card doesn't clip
  // it when its content is taller than the gutter.
  const [popover, setPopover] = useState<
    | {
        entry: DiffEntry;
        anchor: { top: number; left: number; height: number };
      }
    | null
  >(null);

  // Recompute bar positions whenever the editor content or the diff list
  // changes. Uses MutationObserver to also catch ProseMirror's internal
  // re-renders (focus, selection, etc.) so bars stay aligned as the user
  // edits inside changed paragraphs.
  useEffect(() => {
    const wrapper = editorWrapperRef.current;
    if (!wrapper) return;
    if (diffEntries.length === 0) {
      setBars([]);
      return;
    }

    // Match-key: plain-text projection of each diff entry's "new" side
    // (or "old" side for removed). Only modified/added entries actually
    // map to a paragraph in the editor — removed entries are gone, so
    // they get no bar (the user can find them via revert-on-modified
    // entries adjacent to where they sat). For added we use newText;
    // modified also uses newText since that's what the editor shows.
    const matchTargets: { plain: string; entry: DiffEntry }[] = [];
    for (const entry of diffEntries) {
      if (entry.kind === "removed") continue;
      const plain = markdownToPlainText(entry.newText);
      if (plain) matchTargets.push({ plain, entry });
    }

    function recompute() {
      const wrapperEl = editorWrapperRef.current;
      if (!wrapperEl) return;
      const proseMirror = wrapperEl.querySelector(".ProseMirror");
      if (!proseMirror) {
        setBars([]);
        return;
      }
      const wrapperRect = wrapperEl.getBoundingClientRect();
      const used = new Set<DiffEntry>();
      const next: typeof bars = [];
      Array.from(proseMirror.children).forEach((child, idx) => {
        const text = markdownToPlainText(child.textContent ?? "");
        if (!text) return;
        // Find the first unused matching entry. Multiple paragraphs with
        // identical text would all get bars in document order, which is
        // the natural reading.
        const match = matchTargets.find(
          (t) => t.plain === text && !used.has(t.entry),
        );
        if (!match) return;
        used.add(match.entry);
        const r = (child as HTMLElement).getBoundingClientRect();
        next.push({
          key: `${idx}-${text.slice(0, 16)}`,
          top: r.top - wrapperRect.top,
          height: r.height,
          entry: match.entry,
        });
      });
      setBars(next);
    }

    recompute();
    const observer = new MutationObserver(recompute);
    observer.observe(wrapper, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.addEventListener("resize", recompute);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [editorContent, diffEntries]);

  // Close the popover when clicking outside or when the user scrolls /
  // resizes the window. The bar's click sets popover state; clicks
  // inside the popover are stopped at the popover root so they don't
  // reach this listener.
  useEffect(() => {
    if (!popover) return;
    function onDocClick(e: MouseEvent) {
      const wrapper = editorWrapperRef.current;
      const target = e.target as Node | null;
      // Hits on the gutter/editor go through this same handler. Ignore
      // them so the user can click another bar to switch popovers.
      if (wrapper && target && wrapper.contains(target)) return;
      setPopover(null);
    }
    function onScrollOrResize() {
      // Cheaper than re-anchoring the popover to the bar on every frame.
      // Real-world editors don't scroll while the popover is open often,
      // so closing is acceptable UX.
      setPopover(null);
    }
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [popover]);

  function barColor(entry: DiffEntry): string {
    if (entry.kind === "modified") return "bg-amber-500";
    if (entry.kind === "added") return "bg-emerald-500";
    return "bg-rose-500";
  }

  return (
    <div className="flex" ref={editorWrapperRef}>
      {/* Gutter — fixed-width column to the left of the editor. Bars are
          absolutely positioned within it at the y-offsets we measured. */}
      <div
        className="relative w-3 shrink-0 border-r border-border/40"
        aria-hidden={bars.length === 0}
      >
        {bars.map((bar) => {
          const isActive = popover?.entry === bar.entry;
          return (
            <button
              key={bar.key}
              type="button"
              onClick={(e) => {
                if (isActive) {
                  setPopover(null);
                  return;
                }
                const rect = (
                  e.currentTarget as HTMLButtonElement
                ).getBoundingClientRect();
                setPopover({
                  entry: bar.entry,
                  anchor: {
                    top: rect.top,
                    left: rect.right,
                    height: rect.height,
                  },
                });
              }}
              className={cn(
                "absolute left-1 w-1 rounded-sm transition-opacity hover:opacity-100",
                barColor(bar.entry),
                isActive ? "opacity-100" : "opacity-70",
              )}
              style={{ top: bar.top, height: bar.height }}
              title="View previous text and revert"
              aria-label="View previous text and revert"
            />
          );
        })}
      </div>
      <div className="flex-1 min-w-0">
        <RichFieldEditor
          value={editorContent}
          onChange={setEditorContent}
          placeholder={placeholder}
          disabled={disabled}
        />
      </div>
      {popover && (
        <RevertPopover
          entry={popover.entry}
          anchor={popover.anchor}
          onRevert={() => {
            onRevertEntry(popover.entry);
            setPopover(null);
          }}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}

function RevertPopover({
  entry,
  anchor,
  onRevert,
  onClose,
}: {
  entry: DiffEntry;
  /** Bar's bounding rect (viewport-relative). The popover positions
   *  itself just to the right of the bar and is clamped inside the
   *  visible viewport so a tall popover next to a paragraph near the
   *  bottom of the screen flips upward instead of running off-screen. */
  anchor: { top: number; left: number; height: number };
  onRevert: () => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  // Computed position. Initially placed near the anchor; after layout we
  // measure the popover and adjust to stay on-screen.
  const [pos, setPos] = useState<{ top: number; left: number }>(() => ({
    top: anchor.top,
    left: anchor.left + 8,
  }));

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    // Horizontal: prefer right of the bar. If the popover would overflow
    // the viewport's right edge, shift it left of the bar instead.
    let left = anchor.left + 8;
    if (left + rect.width + margin > vw) {
      left = Math.max(margin, anchor.left - rect.width - 8);
    }
    // Vertical: top-align with the bar. If too tall to fit below, anchor
    // its bottom to the viewport's bottom edge so the whole popover
    // stays visible.
    let top = anchor.top;
    if (top + rect.height + margin > vh) {
      top = Math.max(margin, vh - rect.height - margin);
    }
    setPos({ top, left });
    // anchor is captured at click time and stable for the lifetime of
    // this popover instance — re-running on its identity is correct.
  }, [anchor]);

  const kindLabel =
    entry.kind === "modified"
      ? "Modified paragraph"
      : entry.kind === "added"
        ? "Added paragraph"
        : "Removed paragraph";

  return createPortal(
    <div
      ref={popRef}
      className="fixed z-50 w-80 max-w-[calc(100vw-1rem)] rounded-md border bg-popover shadow-lg"
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
        <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
          {kindLabel}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1 -mr-1"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      <div className="px-3 py-2 space-y-2 max-h-[60vh] overflow-y-auto">
        {entry.kind !== "added" && entry.oldText && (
          <div className="rounded-sm border-l-2 border-rose-400/60 bg-rose-50/60 dark:bg-rose-950/20 px-2 py-1">
            <p className="text-[10px] text-rose-700 dark:text-rose-400 mb-0.5 uppercase tracking-wide">
              Before
            </p>
            <p className="text-xs whitespace-pre-wrap break-words text-foreground/90 line-through decoration-rose-400/60">
              {entry.oldText}
            </p>
          </div>
        )}
        {entry.kind !== "removed" && entry.newText && (
          <div className="rounded-sm border-l-2 border-emerald-400/60 bg-emerald-50/60 dark:bg-emerald-950/20 px-2 py-1">
            <p className="text-[10px] text-emerald-700 dark:text-emerald-400 mb-0.5 uppercase tracking-wide">
              After (now in field)
            </p>
            <p className="text-xs whitespace-pre-wrap break-words text-foreground/90">
              {entry.newText}
            </p>
          </div>
        )}
      </div>
      <div className="flex justify-end px-3 py-2 border-t">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs gap-1"
          onClick={onRevert}
        >
          <Undo2 className="h-3 w-3" />
          Revert
        </Button>
      </div>
    </div>,
    document.body,
  );
}


// ── Ticket summary card ───────────────────────────────────────────────────────

function TicketSummaryCard({
  issue,
  analyzed,
  analyzing,
  onAnalyze,
  claudeAvailable,
}: {
  issue: JiraIssue;
  analyzed: boolean;
  analyzing: boolean;
  onAnalyze: () => void;
  claudeAvailable: boolean;
}) {
  // Primary AI button label switches based on whether we've analysed yet,
  // so the user knows the AI hasn't already silently kicked off when they
  // first open a ticket.
  const analyseLabel = analyzing
    ? "Analysing…"
    : analyzed
      ? "Re-analyse"
      : "Start analysis";
  return (
    <Card className="shrink-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <JiraTicketLink ticketKey={issue.key} url={issue.url} />
              <Badge variant="outline" className="text-xs">{issue.issueType}</Badge>
              {issue.storyPoints != null && <Badge variant="secondary" className="text-xs">{issue.storyPoints} pts</Badge>}
              {issue.priority && <Badge variant="outline" className="text-xs">{issue.priority}</Badge>}
            </div>
            <CardTitle className="text-base leading-snug">{issue.summary}</CardTitle>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant={analyzed ? "outline" : "default"}
              size="sm"
              onClick={onAnalyze}
              disabled={analyzing || !claudeAvailable}
              title={
                !claudeAvailable
                  ? "AI provider not configured — see Settings"
                  : analyzed
                    ? "Run the AI grooming agent again"
                    : "Run the AI grooming agent on this ticket"
              }
            >
              {analyzing ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1" />
              )}
              {analyseLabel}
            </Button>
            <Button variant="outline" size="sm" onClick={() => issue.url && openUrl(issue.url)} title="Open in JIRA">
              <ExternalLink className="h-3.5 w-3.5 mr-1" /> JIRA
            </Button>
          </div>
        </div>
        {issue.epicSummary && <p className="text-xs text-muted-foreground mt-1">Epic: {issue.epicSummary}</p>}
      </CardHeader>
      <CardContent className="pt-0 border-t">
        <FieldDiagnostics issue={issue} />
      </CardContent>
    </Card>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: GroomChatMessage }) {
  const isAssistant = msg.role === "assistant";
  return (
    <div className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${isAssistant ? "bg-muted text-foreground rounded-tl-sm" : "bg-primary text-primary-foreground rounded-tr-sm"}`}>
        {msg.content}
      </div>
    </div>
  );
}

// ── Chat panel ────────────────────────────────────────────────────────────────

function ChatPanel({
  messages,
  thinking,
  probeStatus,
  onSend,
  commands,
  onCollapse,
}: {
  messages: GroomChatMessage[];
  thinking: boolean;
  probeStatus: string;
  onSend: (text: string) => void;
  commands: SlashCommand[];
  /** When provided, renders a collapse button in the header so the user
   *  can hide the chat pane to give the middle column more room. */
  onCollapse?: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, thinking]);

  return (
    <Card className="flex flex-col min-h-0 flex-1">
      <CardHeader className="pb-2 shrink-0 border-b">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">Grooming Assistant</CardTitle>
            <p className="text-xs text-muted-foreground">Ask questions or request field changes — e.g. "update the AC to…"</p>
          </div>
          {onCollapse && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={onCollapse}
              title="Hide chat"
              aria-label="Hide chat"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col flex-1 min-h-0 pt-3">
        <div className="flex-1 overflow-y-auto space-y-3 pr-1 min-h-0">
          {messages.length === 0 && !thinking && (
            <p className="text-xs text-muted-foreground text-center pt-4 leading-relaxed">
              The assistant will appear here after the initial analysis.<br />
              You can ask it to refine any draft field.
            </p>
          )}
          {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}
          {thinking && (
            <div className="flex justify-start">
              <div className="bg-muted text-muted-foreground px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {probeStatus || "Thinking…"}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="pt-3 border-t shrink-0">
          <SlashCommandInput
            value={value}
            onChange={setValue}
            onSend={(text) => onSend(text)}
            commands={commands}
            busy={thinking}
            placeholder='Ask a question or say "update the AC to…". Enter to send. / for commands.'
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Draft field row ───────────────────────────────────────────────────────────

function DraftFieldRow({ draft, issue, highlighted, onApprove, onDecline, onEditSuggested }: {
  draft: DraftChange; issue: JiraIssue; highlighted?: boolean;
  onApprove: (id: string) => void; onDecline: (id: string) => void;
  onEditSuggested: (id: string, value: string) => void;
}) {
  const [showFull, setShowFull] = useState(false);
  const cannotResolve = resolveJiraFieldId(draft.field, issue) === null;

  const statusBadge =
    draft.status === "approved"
      ? <Badge className="text-xs bg-green-600 hover:bg-green-600 text-white">{draft.applyResult === "ok" ? "Applied ✓" : "Approved"}</Badge>
      : draft.status === "declined"
      ? <Badge variant="outline" className="text-xs text-muted-foreground">Declined</Badge>
      : <Badge variant="secondary" className="text-xs">Pending</Badge>;

  const borderClass = highlighted
    ? "border-primary/70 bg-primary/5 dark:bg-primary/10"
    : draft.status === "approved"
    ? "border-green-200 dark:border-green-900 bg-green-50/30 dark:bg-green-950/20"
    : "";

  return (
    <div className={`border rounded-lg p-3 space-y-2 transition-colors duration-700 ${borderClass} ${draft.status === "declined" ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{draft.section}</span>
        {statusBadge}
      </div>
      {draft.userEdited && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0" /> You've edited this — AI may have updated its suggestion separately
        </p>
      )}
      {cannotResolve && draft.status !== "declined" && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0" /> Field ID not auto-discovered — cannot apply to JIRA
        </p>
      )}
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-0.5">Current</p>
        {draft.current
          ? <div className="relative">
              <p className={`text-xs text-muted-foreground leading-relaxed ${showFull ? "" : "line-clamp-3"}`}>{draft.current}</p>
              {draft.current.length > 200 && <button className="text-xs text-primary mt-0.5" onClick={() => setShowFull((v) => !v)}>{showFull ? "Show less" : "Show more"}</button>}
            </div>
          : <p className="text-xs text-muted-foreground italic">(none)</p>}
      </div>
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-0.5">Proposed</p>
        <Textarea value={draft.editedSuggested} onChange={(e) => onEditSuggested(draft.id, e.target.value)} rows={4} className="text-xs resize-y" disabled={draft.status === "declined"} />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{draft.reasoning}</p>
      {draft.applyResult === "error" && draft.applyError && (
        <p className="text-xs text-destructive leading-relaxed">{draft.applyError}</p>
      )}
      <div className="flex gap-2">
        {draft.status === "pending" && <>
          <Button size="sm" variant="default" className="h-7 text-xs" onClick={() => onApprove(draft.id)} disabled={cannotResolve}>Approve</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onDecline(draft.id)}>Decline</Button>
        </>}
        {draft.status === "approved" && draft.applyResult !== "ok" && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onDecline(draft.id)}>Decline</Button>
        )}
        {draft.status === "declined" && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onApprove(draft.id)} disabled={cannotResolve}>Re-approve</Button>
        )}
      </div>
    </div>
  );
}

// ── Draft changes panel ───────────────────────────────────────────────────────

function DraftChangesPanel({ drafts, issue, applying, highlightedIds, onApprove, onDecline, onEditSuggested, onApply }: {
  drafts: DraftChange[]; issue: JiraIssue; applying: boolean; highlightedIds: Set<string>;
  onApprove: (id: string) => void; onDecline: (id: string) => void;
  onEditSuggested: (id: string, value: string) => void; onApply: () => void;
}) {
  const approved = drafts.filter((d) => d.status === "approved");
  const pending = drafts.filter((d) => d.status === "pending");
  const declined = drafts.filter((d) => d.status === "declined");

  return (
    <Card className="shrink-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-semibold">Draft Changes</CardTitle>
          <Button size="sm" onClick={onApply} disabled={approved.length === 0 || applying} className="h-7 text-xs gap-1.5">
            {applying ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying…</> : <>Apply {approved.length > 0 ? `${approved.length} ` : ""}changes to JIRA</>}
          </Button>
        </div>
        {drafts.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">{approved.length} approved · {pending.length} pending · {declined.length} declined</p>
        )}
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {drafts.length === 0
          ? <p className="text-sm text-muted-foreground italic text-center py-4">No changes proposed yet</p>
          : drafts.map((draft) => (
              <DraftFieldRow key={draft.id} draft={draft} issue={issue} highlighted={highlightedIds.has(draft.id)} onApprove={onApprove} onDecline={onDecline} onEditSuggested={onEditSuggested} />
            ))}
      </CardContent>
    </Card>
  );
}

// ── Ticket selector ───────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = {
  highest: 0, critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4, trivial: 4,
};

function priorityRank(p: string | null): number {
  return p != null ? (PRIORITY_ORDER[p.toLowerCase()] ?? 2) : 2;
}

function priorityColor(p: string | null): string {
  switch (p?.toLowerCase()) {
    case "highest": case "critical": return "text-red-600 dark:text-red-400";
    case "high":    return "text-orange-500 dark:text-orange-400";
    case "medium":  return "text-yellow-500 dark:text-yellow-400";
    case "low":     return "text-blue-500 dark:text-blue-400";
    case "lowest":  case "trivial": return "text-muted-foreground";
    default:        return "text-muted-foreground";
  }
}

function issueKeyNumber(key: string): number {
  const m = key.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

type SortField = "priority" | "key";
type SortDir   = "asc" | "desc";

function sortIssues(issues: JiraIssue[], field: SortField, dir: SortDir): JiraIssue[] {
  return [...issues].sort((a, b) => {
    const cmp = field === "priority"
      ? priorityRank(a.priority) - priorityRank(b.priority)
      : issueKeyNumber(a.key) - issueKeyNumber(b.key);
    return dir === "asc" ? cmp : -cmp;
  });
}

function SortButton({ label, field, current, dir, onClick }: {
  label: string; field: SortField; current: SortField; dir: SortDir;
  onClick: (f: SortField) => void;
}) {
  const active = current === field;
  const Icon = active ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button onClick={() => onClick(field)}
      className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${active ? "border-primary text-primary bg-primary/5" : "border-input text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}>
      <Icon className="h-3 w-3" />{label}
    </button>
  );
}

function TicketSelector({ sprints, selectedSprintId, onSelectSprint, sprintIssues, loadingIssues, selected, onSelect }: {
  sprints: JiraSprint[]; selectedSprintId: number | null;
  onSelectSprint: (sprint: JiraSprint) => void;
  sprintIssues: JiraIssue[]; loadingIssues: boolean;
  selected: JiraIssue | null; onSelect: (issue: JiraIssue) => void;
}) {
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<JiraIssue[]>([]);
  const [searching, setSearching] = useState(false);
  const [sortField, setSortField] = useState<SortField>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const q = search.trim();

  function handleSortClick(field: SortField) {
    if (sortField === field) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  }

  useEffect(() => {
    if (!q) { setSearchResults([]); return; }
    const isKey = /^[A-Z]+-\d+$/i.test(q);
    const jql = isKey ? `key = "${q.toUpperCase()}"` : `text ~ "${q}" ORDER BY updated DESC`;
    const timer = setTimeout(async () => {
      setSearching(true);
      try { setSearchResults(await searchJiraIssues(jql, 20)); }
      catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 500);
    return () => clearTimeout(timer);
  }, [q]);

  const rawList = useMemo(() => {
    if (!q) return sprintIssues;
    return fuzzyFilterIssues(q, mergeIssuesById(sprintIssues, searchResults));
  }, [q, sprintIssues, searchResults]);
  const displayList = sortIssues(rawList, sortField, sortDir);
  const showLoading = q ? searching && rawList.length === 0 : loadingIssues;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {sprints.length > 0 && (
        <div className="shrink-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Calendar className="h-3 w-3" /> Sprint</p>
          <select value={selectedSprintId ?? ""} onChange={(e) => { const s = sprints.find((sp) => sp.id === Number(e.target.value)); if (s) onSelectSprint(s); }}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
            {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === "future" ? " · upcoming" : ""}</option>)}
          </select>
        </div>
      )}
      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input placeholder="Fuzzy search tickets or enter key (e.g. PROJ-123)…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Sort:</span>
        <SortButton label="Priority" field="priority" current={sortField} dir={sortDir} onClick={handleSortClick} />
        <SortButton label="Key" field="key" current={sortField} dir={sortDir} onClick={handleSortClick} />
      </div>
      <div className="flex-1 min-h-0 space-y-1 overflow-y-auto pr-1">
        {showLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />{q ? "Searching…" : "Loading sprint tickets…"}
          </div>
        )}
        {!showLoading && displayList.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">{q ? "No tickets found." : "No tickets in this sprint."}</p>
        )}
        {!showLoading && displayList.map((issue) => {
          const isSelected = selected?.id === issue.id;
          return (
            <button key={issue.id} onClick={() => onSelect(issue)}
              className={`w-full text-left px-3 py-2.5 rounded-md border transition-colors hover:bg-muted/60 ${isSelected ? "border-primary bg-primary/5" : "border-transparent"}`}>
              <div className="flex items-center gap-2">
                <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                <Badge variant="outline" className="text-xs py-0 h-5">{issue.issueType}</Badge>
                {issue.storyPoints != null && <span className="ml-auto text-xs text-muted-foreground shrink-0">{issue.storyPoints}pt</span>}
              </div>
              <p className="text-sm mt-0.5 leading-snug line-clamp-2">{issue.summary}</p>
              <div className="flex items-center gap-2 mt-1">
                {issue.priority && (
                  <span className={`text-xs font-medium ${priorityColor(issue.priority)}`}>{issue.priority}</span>
                )}
                {issue.priority && <span className="text-xs text-muted-foreground">·</span>}
                <span className="text-xs text-muted-foreground">{issue.status}</span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs text-muted-foreground">{statusAge(issue)}</span>
              </div>
            </button>
          );
        })}
      </div>
      {!q && !loadingIssues && sprintIssues.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">{sprintIssues.length} tickets · Search to find any backlog ticket</p>
      )}
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function TicketQualityScreen({ credStatus, onBack }: TicketQualityScreenProps) {
  const [sprints, setSprints] = useState<JiraSprint[]>([]);
  const [selectedSprintId, setSelectedSprintId] = useState<number | null>(null);
  const [sprintIssues, setSprintIssues] = useState<JiraIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(true);
  const [session, setSession] = useState<GroomSession | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(new Set());
  const recentlyUpdatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Resizable pane widths ─────────────────────────────────────────────────
  const [leftWidth, setLeftWidth] = useState(340);
  const [chatWidth, setChatWidth] = useState(360);
  // When collapsed, the left pane shrinks to a slim icon-only strip so the
  // middle/right panes get the screen back. Resize and pane content are
  // hidden until the user expands again. Stored as a separate flag (rather
  // than just leftWidth = 0) so we can restore the user's last sized
  // width when they expand. Same pattern for the chat pane on the right.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartValRef = useRef(0);

  const makeDragHandler = useCallback(
    (setter: (w: number) => void, min: number, max: number, inverted = false) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        isDraggingRef.current = true;
        dragStartXRef.current = e.clientX;
        dragStartValRef.current = inverted ? chatWidth : leftWidth;
        const onMouseMove = (ev: MouseEvent) => {
          if (!isDraggingRef.current) return;
          const delta = inverted
            ? dragStartXRef.current - ev.clientX
            : ev.clientX - dragStartXRef.current;
          setter(Math.min(max, Math.max(min, dragStartValRef.current + delta)));
        };
        const onMouseUp = () => {
          isDraggingRef.current = false;
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("mouseup", onMouseUp);
        };
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      },
    [leftWidth, chatWidth]
  );

  const onLeftDividerMouseDown = makeDragHandler(setLeftWidth, 240, 520);
  const onChatDividerMouseDown = makeDragHandler(setChatWidth, 280, 600, true);

  const claudeAvailable = aiProviderComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  useEffect(() => {
    if (!jiraAvailable) { setLoadingIssues(false); return; }
    Promise.all([
      getAllActiveSprints().catch(() => [] as JiraSprint[]),
      getFutureSprints(5).catch(() => [] as JiraSprint[]),
    ]).then(([active, future]) => {
      const all = [...active, ...future];
      setSprints(all);
      if (all.length > 0) setSelectedSprintId(all[0].id);
    });
  }, [jiraAvailable]);

  useEffect(() => {
    if (selectedSprintId === null) { setSprintIssues([]); setLoadingIssues(false); return; }
    setLoadingIssues(true);
    getSprintIssues(selectedSprintId).then(setSprintIssues).catch(() => setSprintIssues([])).finally(() => setLoadingIssues(false));
  }, [selectedSprintId]);

  const selectSprint = useCallback((sprint: JiraSprint) => {
    setSelectedSprintId(sprint.id);
    setSession(null);
    setInitError(null);
  }, []);

  /**
   * Pull a fresh copy of the issue from JIRA and seed the session with it.
   * Crucially does NOT call the AI grooming agent — `analyzeTicket()` does
   * that, and it's gated behind an explicit user click so opening a ticket
   * never burns model tokens unprompted.
   */
  async function loadTicket(issue: JiraIssue) {
    setInitError(null);
    let freshIssue: JiraIssue;
    try {
      freshIssue = await getIssue(issue.key);
    } catch (e) {
      console.warn("[Meridian] getIssue failed, using sprint-list snapshot:", e);
      freshIssue = issue;
    }
    setSession({
      issue: freshIssue,
      chat: [],
      drafts: [],
      thinking: false,
      applying: false,
      probeStatus: "",
      analyzed: false,
    });
  }

  /** Run the AI grooming agent against the currently-loaded ticket. */
  async function analyzeTicket() {
    if (!session) return;
    const sessionKey = session.issue.key;
    const freshIssue = session.issue;
    setInitError(null);
    setSession((prev) =>
      prev?.issue.key === sessionKey
        ? { ...prev, thinking: true, chat: [], drafts: [] }
        : prev,
    );
    try {
      const ticketText = compileTicketText(freshIssue);

      // Pull latest on the grooming worktree, then probe for relevant files
      let fileContentsBlock = "";
      let worktreeContext = "";
      try {
        await syncGroomingWorktree();
        const worktreeInfo = await validateGroomingWorktree();
        worktreeContext = `\n\n=== CODEBASE CONTEXT ===\nWorktree: ${worktreeInfo.path}\nBranch: ${worktreeInfo.branch}`;
        const ticketWithContext = ticketText + worktreeContext;

        setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: "Identifying relevant files…" } : prev);
        const probeRaw = await runGroomingFileProbe(ticketWithContext);
        const probe = parseAgentJson<{ files: string[]; grep_patterns: string[] }>(probeRaw);
        if (probe) {
          const MAX_TOTAL = 40 * 1024;
          let totalSize = 0;
          const parts: string[] = [];
          for (const filePath of (probe.files ?? []).slice(0, 12)) {
            try {
              setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: `Reading ${filePath}…` } : prev);
              const content = await readGroomingFile(filePath);
              const chunk = `--- ${filePath} ---\n${content}\n`;
              if (totalSize + chunk.length > MAX_TOTAL) break;
              parts.push(chunk);
              totalSize += chunk.length;
            } catch { /* skip missing files */ }
          }
          for (const pattern of (probe.grep_patterns ?? []).slice(0, 6)) {
            try {
              setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: `Searching for "${pattern}"…` } : prev);
              const lines = await grepGroomingFiles(pattern);
              if (lines.length === 0) continue;
              const chunk = `--- grep: ${pattern} ---\n${lines.join("\n")}\n`;
              if (totalSize + chunk.length > MAX_TOTAL) break;
              parts.push(chunk);
              totalSize += chunk.length;
            } catch { /* skip */ }
          }
          if (parts.length > 0) fileContentsBlock = parts.join("\n");
        }
      } catch { /* no worktree configured — proceed without codebase context */ }

      setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: "" } : prev);
      const ticketWithContext = ticketText + worktreeContext;
      const raw = await runGroomingAgent(ticketWithContext, fileContentsBlock);
      const output = parseAgentJson<GroomingOutput>(raw);
      if (!output) throw new Error("Could not parse grooming response.");
      const drafts = suggestedEditsToDraftChanges(output.suggested_edits, freshIssue);
      const openingMsg = buildOpeningMessage(freshIssue, output);
      setSession((prev) =>
        prev?.issue.key === sessionKey
          ? {
              ...prev,
              drafts,
              chat: [{ role: "assistant", content: openingMsg }],
              thinking: false,
              analyzed: true,
            }
          : prev,
      );
    } catch (e) {
      setInitError(String(e));
      setSession((prev) => (prev?.issue.key === sessionKey ? { ...prev, thinking: false } : prev));
    }
  }

  const selectTicket = useCallback((issue: JiraIssue) => {
    const hasUnapplied = session?.drafts.some((d) => d.status === "approved" && d.applyResult !== "ok");
    if (hasUnapplied && !confirm("You have approved changes not yet applied to JIRA. Leave anyway?")) return;
    void loadTicket(issue);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function sendChatMessage(text: string) {
    if (!session) return;
    const issueKey = session.issue.key;
    const userMsg: GroomChatMessage = { role: "user", content: text };
    setSession((prev) => prev ? { ...prev, chat: [...prev.chat, userMsg], thinking: true } : prev);
    try {
      const ticketText = compileTicketText(session.issue);
      const contextText = `=== TICKET ===\n${ticketText}\n\n=== CURRENT DRAFT CHANGES ===\n${JSON.stringify(session.drafts)}`;
      const historyJson = JSON.stringify([...session.chat, userMsg]);
      const raw = await runGroomingChatTurn(contextText, historyJson);
      const response = parseAgentJson<GroomingChatResponse>(raw);
      if (!response) {
        // Model returned prose instead of JSON — show it directly as the assistant reply
        setSession((prev) => {
          if (!prev || prev.issue.key !== issueKey) return prev;
          return { ...prev, chat: [...prev.chat, { role: "assistant", content: raw.trim() }], thinking: false };
        });
        return;
      }
      setSession((prev) => {
        // Discard if the user switched tickets while this request was in-flight
        if (!prev || prev.issue.key !== issueKey) return prev;
        let drafts = [...prev.drafts];
        const touchedIds: string[] = [];
        for (const updated of response.updated_edits) {
          const idx = drafts.findIndex((d) => d.id === updated.id);
          if (idx >= 0) {
            const existing = drafts[idx];
            drafts[idx] = { ...existing, suggested: updated.suggested, editedSuggested: existing.userEdited ? existing.editedSuggested : updated.suggested, reasoning: updated.reasoning };
          } else {
            drafts.push({
              id: updated.id, field: updated.field, section: updated.section,
              current: updated.current ?? getCurrentFieldValue(updated.field, prev.issue),
              suggested: updated.suggested, editedSuggested: updated.suggested,
              userEdited: false, reasoning: updated.reasoning, status: "pending",
            });
          }
          touchedIds.push(updated.id);
        }
        if (touchedIds.length > 0) {
          setRecentlyUpdated(new Set(touchedIds));
          if (recentlyUpdatedTimerRef.current) clearTimeout(recentlyUpdatedTimerRef.current);
          recentlyUpdatedTimerRef.current = setTimeout(() => setRecentlyUpdated(new Set()), 2500);
        }
        return { ...prev, drafts, chat: [...prev.chat, { role: "assistant", content: response.message }], thinking: false };
      });
    } catch (e) {
      setSession((prev) => {
        if (!prev || prev.issue.key !== issueKey) return prev;
        return { ...prev, chat: [...prev.chat, { role: "assistant", content: `Sorry, something went wrong: ${String(e)}` }], thinking: false };
      });
    }
  }

  function approveDraft(id: string) {
    setSession((prev) => prev ? { ...prev, drafts: prev.drafts.map((d) => d.id === id ? { ...d, status: "approved", applyResult: undefined, applyError: undefined } : d) } : prev);
  }
  function declineDraft(id: string) {
    setSession((prev) => prev ? { ...prev, drafts: prev.drafts.map((d) => d.id === id ? { ...d, status: "declined" } : d) } : prev);
  }
  function editSuggested(id: string, value: string) {
    setSession((prev) => prev ? { ...prev, drafts: prev.drafts.map((d) => d.id === id ? { ...d, editedSuggested: value, userEdited: value !== d.suggested } : d) } : prev);
  }

  /**
   * Mark an inline AI suggestion as accepted in session state. The actual
   * loading of the suggestion text into the editor happens locally inside
   * FieldEditor — accepting does NOT push to JIRA. The user must click
   * Save on the field afterwards to submit the change.
   */
  function acceptSuggestion(draftId: string) {
    setSession((prev) =>
      prev
        ? {
            ...prev,
            drafts: prev.drafts.map((d) =>
              d.id === draftId ? { ...d, status: "approved" } : d,
            ),
          }
        : prev,
    );
  }

  /**
   * Persist a single edited field back to JIRA, then refetch so the panel
   * reflects whatever JIRA actually stored (round-trips can lose ADF
   * formatting when we send plain text). Throws on failure so the caller
   * can surface the error inline; doesn't touch session state on success
   * other than swapping in the fresh issue.
   */
  async function saveFieldEdit(field: SuggestedEditField, newValue: string) {
    if (!session) return;
    const fieldId = resolveJiraFieldId(field, session.issue);
    if (!fieldId) {
      throw new Error(
        `JIRA field ID for "${field}" hasn't been discovered yet — open the AI analysis once to populate it.`,
      );
    }
    await updateJiraFields(
      session.issue.key,
      JSON.stringify({ [fieldId]: newValue }),
    );
    const fresh = await getIssue(session.issue.key).catch(() => session.issue);
    setSession((prev) => (prev ? { ...prev, issue: fresh } : prev));
  }

  async function applyChanges() {
    if (!session) return;
    const toApply = session.drafts.filter((d) => d.status === "approved" && d.applyResult !== "ok");
    if (toApply.length === 0) return;
    setSession((prev) => (prev ? { ...prev, applying: true } : prev));
    const results: Record<string, { ok: boolean; error?: string }> = {};
    for (const draft of toApply) {
      const fieldId = resolveJiraFieldId(draft.field, session.issue);
      if (!fieldId) { results[draft.id] = { ok: false, error: "Field ID not auto-discovered." }; continue; }
      try {
        // Same image-preservation safety net as the inline confirm path:
        // images in the original field that the AI's suggestion dropped
        // get re-appended so applying the draft never silently strips
        // attachments from the JIRA ticket.
        const original =
          draft.current ?? getCurrentFieldValue(draft.field, session.issue);
        const valueToSave = preserveImagesFromOriginal(
          original,
          draft.editedSuggested,
        );
        await updateJiraFields(session.issue.key, JSON.stringify({ [fieldId]: valueToSave }));
        results[draft.id] = { ok: true };
      } catch (e) {
        results[draft.id] = { ok: false, error: String(e) };
      }
    }
    const freshIssue = await getIssue(session.issue.key).catch(() => session.issue);
    setSession((prev) => prev ? {
      ...prev, issue: freshIssue, applying: false,
      drafts: prev.drafts.map((d) => {
        const r = results[d.id];
        if (!r) return d;
        return { ...d, applyResult: r.ok ? "ok" : "error", applyError: r.error, current: r.ok ? d.editedSuggested : d.current };
      }),
    } : prev);
  }

  const selectedSprint = sprints.find((s) => s.id === selectedSprintId) ?? null;

  const groomingCommands: SlashCommand[] = useMemo(() => {
    const history = session?.chat ?? [];
    return [
      ...createGlobalCommands({
        history,
        clearHistory: () => {
          setSession((prev) => (prev ? { ...prev, chat: [] } : prev));
        },
        sendMessage: (text: string) => sendChatMessage(text),
        removeLastAssistantMessage: () => {
          setSession((prev) => {
            if (!prev) return prev;
            const chat = prev.chat;
            if (chat.length === 0 || chat[chat.length - 1].role !== "assistant") return prev;
            return { ...prev, chat: chat.slice(0, -1) };
          });
        },
      }),
      {
        name: "blockers",
        description: "Show grooming blockers the assistant flagged",
        execute: ({ toast: t }) => {
          if (!session) { t.info("No session active"); return; }
          const blockers = session.drafts
            .filter((d) => d.reasoning?.toLowerCase().includes("block"))
            .map((d) => `• ${d.field}: ${d.reasoning}`);
          if (blockers.length === 0) {
            t.info("No blockers flagged in the current session");
            return;
          }
          t("Blockers", { description: blockers.join("\n") });
        },
      },
      {
        name: "ac",
        description: "Show the current acceptance criteria",
        execute: async () => {
          await sendChatMessage("Show me the current acceptance criteria verbatim.");
        },
      },
      {
        name: "revise",
        description: "Ask the assistant to revise a specific field",
        args: "<field>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a field name, e.g. /revise acceptance-criteria");
            return;
          }
          await sendChatMessage(`Please revise the ${args.trim()} field and surface a new suggested value.`);
        },
      },
      {
        name: "apply",
        description: "Push all approved field revisions to JIRA",
        execute: async ({ toast: t }) => {
          if (!session) { t.info("No session active"); return; }
          const toApply = session.drafts.filter((d) => d.status === "approved" && d.applyResult !== "ok");
          if (toApply.length === 0) {
            t.info("Nothing to apply — approve some changes first");
            return;
          }
          await applyChanges();
          t.success(`Applied ${toApply.length} change${toApply.length === 1 ? "" : "s"}`);
        },
      },
      {
        name: "template",
        description: "Remind the assistant of the grooming format template",
        execute: async () => {
          await sendChatMessage(
            "What's the active grooming format template you're working against?",
          );
        },
      },
    ];
    // sendChatMessage + applyChanges close over `session`, so we tie the
    // memo to that. They're stable otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <WorkflowPanelHeader
        panel="ticket_quality"
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
            <div className="min-w-0">
              <h1 className={`${APP_HEADER_TITLE} leading-none`}>Groom Tickets</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {selectedSprint ? `${selectedSprint.name}${selectedSprint.state === "future" ? " · upcoming" : ""}` : "AI-assisted ticket grooming with JIRA write-back"}
              </p>
            </div>
          </>
        }
      />

      {/* Credential warnings */}
      {(!jiraAvailable || !claudeAvailable) && (
        <div className="shrink-0 px-4 pt-3 space-y-2">
          {!jiraAvailable && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              JIRA credentials not configured — ticket search unavailable.
            </div>
          )}
          {!claudeAvailable && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              No AI provider configured — grooming assistant unavailable.
            </div>
          )}
        </div>
      )}

      {/* Three-pane resizable layout — flush edge to edge */}
      <div className="flex-1 min-h-0 flex flex-row overflow-hidden">

        {/* ── Left pane: ticket selector ──
            When collapsed, the pane shrinks to a slim strip with just an
            expand button so the middle/right panes get more room. Drag
            divider hides in that mode (resize would be meaningless). */}
        {leftCollapsed ? (
          <div
            className="flex flex-col min-h-0 py-4 pl-4 pr-2"
            style={{ width: 44, minWidth: 44, maxWidth: 44 }}
          >
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setLeftCollapsed(false)}
              title="Show ticket list"
              aria-label="Show ticket list"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-col min-h-0 p-4 pr-0" style={{ width: leftWidth, minWidth: leftWidth, maxWidth: leftWidth }}>
              <Card className="flex flex-col flex-1 min-h-0">
                <CardHeader className="pb-3 shrink-0">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-semibold">Select a Ticket</CardTitle>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 -mr-1"
                      onClick={() => setLeftCollapsed(true)}
                      title="Hide ticket list"
                      aria-label="Hide ticket list"
                    >
                      <PanelLeftClose className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 flex flex-col flex-1 min-h-0">
                  <TicketSelector
                    sprints={sprints} selectedSprintId={selectedSprintId} onSelectSprint={selectSprint}
                    sprintIssues={sprintIssues} loadingIssues={loadingIssues}
                    selected={session?.issue ?? null} onSelect={selectTicket}
                  />
                </CardContent>
              </Card>
            </div>

            {/* ── Drag handle 1 (left ↔ middle) ── */}
            <div
              onMouseDown={onLeftDividerMouseDown}
              className="w-1.5 shrink-0 mx-2 rounded-full cursor-col-resize hover:bg-muted-foreground/30 active:bg-muted-foreground/50 transition-colors self-stretch mt-4 mb-4"
              title="Drag to resize"
            />
          </>
        )}

        {/* ── Middle pane: ticket summary + draft changes (scrollable) ── */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto py-4 gap-4 pr-0">
          {!session && !initError && (
            <div className="flex items-center justify-center rounded-lg border border-dashed h-48 text-muted-foreground text-sm mx-2">
              Select a ticket to start an AI grooming session
            </div>
          )}

          {session && (
            <>
              <div className="mx-2">
                <TicketSummaryCard
                  issue={session.issue}
                  analyzed={session.analyzed}
                  analyzing={session.thinking}
                  onAnalyze={analyzeTicket}
                  claudeAvailable={claudeAvailable}
                />
              </div>

              {initError && !session.thinking && (
                <Card className="border-destructive/50 shrink-0 mx-2">
                  <CardContent className="pt-4 space-y-3">
                    <p className="text-sm text-destructive">{initError}</p>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={analyzeTicket}>
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </Button>
                  </CardContent>
                </Card>
              )}

              <div className="mx-2">
                <TicketFieldsPanel
                  issue={session.issue}
                  drafts={session.drafts}
                  onSaveField={saveFieldEdit}
                  onAcceptSuggestion={acceptSuggestion}
                  onDeclineSuggestion={declineDraft}
                />
              </div>

              {/* DraftChangesPanel still surfaces drafts whose target field
                  isn't rendered inline above (e.g. summary, future custom
                  fields). Hidden when every pending draft has an inline
                  home so the panel doesn't show empty chrome. */}
              {session.analyzed && hasOrphanDrafts(session.drafts, session.issue) && (
                <div className="mx-2">
                  <DraftChangesPanel
                    drafts={session.drafts.filter((d) =>
                      isOrphanDraft(d, session.issue),
                    )}
                    issue={session.issue}
                    applying={session.applying}
                    highlightedIds={recentlyUpdated}
                    onApprove={approveDraft} onDecline={declineDraft} onEditSuggested={editSuggested}
                    onApply={applyChanges}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Right pane: grooming assistant ──
            Mirror of the left collapse: collapsed mode shrinks to a slim
            strip with an expand button so the middle column reclaims the
            screen, and the resize divider hides because resize is a no-op
            in that mode. */}
        {chatCollapsed ? (
          <div
            className="flex flex-col min-h-0 py-4 pl-2 pr-4"
            style={{ width: 44, minWidth: 44, maxWidth: 44 }}
          >
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setChatCollapsed(false)}
              title="Show chat"
              aria-label="Show chat"
            >
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            {/* ── Drag handle 2 (middle ↔ chat) ── */}
            <div
              onMouseDown={onChatDividerMouseDown}
              className="w-1.5 shrink-0 mx-2 rounded-full cursor-col-resize hover:bg-muted-foreground/30 active:bg-muted-foreground/50 transition-colors self-stretch mt-4 mb-4"
              title="Drag to resize"
            />

            <div className="flex flex-col min-h-0 py-4 pl-0 pr-4" style={{ width: chatWidth, minWidth: chatWidth, maxWidth: chatWidth }}>
              {session ? (
                <ChatPanel
                  messages={session.chat}
                  thinking={session.thinking}
                  probeStatus={session.probeStatus}
                  onSend={sendChatMessage}
                  commands={groomingCommands}
                  onCollapse={() => setChatCollapsed(true)}
                />
              ) : (
                <Card className="flex flex-col flex-1 min-h-0">
                  <CardHeader className="pb-2 shrink-0 border-b">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="text-sm font-semibold">Grooming Assistant</CardTitle>
                        <p className="text-xs text-muted-foreground">Ask questions or request field changes</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => setChatCollapsed(true)}
                        title="Hide chat"
                        aria-label="Hide chat"
                      >
                        <PanelRightClose className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 flex items-center justify-center">
                    <p className="text-xs text-muted-foreground text-center leading-relaxed">
                      Select a ticket to start<br />a grooming session
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </>
        )}

      </div>
    </div>
  );
}
