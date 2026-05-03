import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  useTokenUsageStore,
  modelKey,
  type RateLimitSnapshot,
} from "@/stores/tokenUsageStore";
import { useAiSelectionStore } from "@/stores/aiSelectionStore";
import { useChatHistoryStore } from "@/stores/chatHistoryStore";
import { compileTicketText } from "@/stores/implementTicketStore";
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
  Pencil,
} from "lucide-react";
import { diffArrays } from "diff";
import { MarkdownBlock } from "@/components/MarkdownBlock";
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
  runGroomingWorkflow,
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
  /**
   * Partially-parsed JSON streamed back from the sidecar's grooming agent
   * while it's still emitting. Cleared once the final parsed output lands
   * on `drafts` / `chat`. Surfaced live so the assistant panel and draft
   * preview update token-by-token instead of sitting blank for the whole
   * model call.
   */
  partialOutput: Partial<GroomingOutput> | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// `compileTicketText` is imported from the implement-ticket store so the
// grooming agent sees the same ticket shape regardless of which panel
// triggered it. The previous in-file copy didn't handle JIRA's modern
// `descriptionSections` payload, so tickets with structured Atlassian
// document content (e.g. DEMO-2) reached the agent as
// "Description: (none)" even when the app rendered the body fine.

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

/**
 * Render a human-readable preview of the partially-parsed grooming JSON so
 * the chat panel updates token-by-token while the model is still emitting.
 * Reads only the fields that fill in earliest in the schema's order
 * (ticket_summary first, then suggested_edits as the bulk of the response).
 * Returns an empty string when nothing useful is available yet so the caller
 * can fall back to the static "Thinking…" indicator.
 */
function buildStreamingPreview(partial: Partial<GroomingOutput>): string {
  const parts: string[] = [];
  const summary = typeof partial.ticket_summary === "string" ? partial.ticket_summary.trim() : "";
  if (summary) parts.push(summary);

  const editsRaw: unknown[] = Array.isArray(partial.suggested_edits) ? partial.suggested_edits : [];
  const sections: string[] = [];
  for (const e of editsRaw) {
    if (e && typeof e === "object") {
      const section = (e as { section?: unknown }).section;
      if (typeof section === "string" && section.trim().length > 0) {
        sections.push(section.trim());
      }
    }
  }
  if (sections.length > 0) {
    const head = sections.slice(0, 6);
    const more = sections.length > head.length ? `, +${sections.length - head.length} more` : "";
    parts.push(`Drafting ${sections.length} change${sections.length === 1 ? "" : "s"}: ${head.join(", ")}${more}`);
  }

  const questionsRaw: unknown[] = Array.isArray(partial.clarifying_questions)
    ? partial.clarifying_questions
    : [];
  const questions = questionsRaw.filter(
    (q): q is string => typeof q === "string" && q.trim().length > 0,
  );
  if (questions.length > 0) {
    parts.push(`Questions so far:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`);
  }

  return parts.join("\n\n");
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

/** JIRA Cloud v3 returns descriptions either as a flat markdown string
 *  on `description` or as a structured array on `descriptionSections`.
 *  Modern tickets favour sections; the legacy field is left null. We
 *  flatten sections back to a preview string so the Fields-received
 *  diagnostics can treat them as "present" and show a non-empty
 *  preview, instead of falsely reporting the description missing. */
function effectiveDescription(issue: JiraIssue): string | null {
  if (issue.description && issue.description.trim().length > 0) {
    return issue.description;
  }
  if (issue.descriptionSections && issue.descriptionSections.length > 0) {
    return issue.descriptionSections
      .map((s) => (s.heading ? `${s.heading}: ${s.content}` : s.content))
      .join("\n\n");
  }
  return null;
}

function FieldDiagnostics({ issue }: { issue: JiraIssue }) {
  const [open, setOpen] = useState(false);
  // Match the per-ticket-type filter used by TicketFieldsPanel — steps /
  // observed / expected only matter on bugs, so showing them as "missing"
  // on a Story/Task creates noise.
  const isBug = issue.issueType.toLowerCase() === "bug";
  const fields = [
    { label: "Description", value: effectiveDescription(issue) },
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
// can read the whole ticket without first running AI analysis. Fields
// render through MarkdownBlock so headings / bold / lists / code / links
// look the way they do in JIRA. Clicking Edit swaps the rendered view for
// a plain Textarea on the raw markdown source; Save commits via
// `saveFieldEdit` and switches back to the rendered view. The Textarea is
// never mounted unless the user explicitly chose to edit, so opening a
// ticket can't trip the dirty flag (no round-trip on display). Fields the
// user can't edit yet (custom fields whose JIRA IDs haven't been
// auto-discovered) show a read-only badge instead of the Edit button.

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

/** Per-paragraph entry produced by the unified diff used in the
 *  pre-accept inline view. Includes "unchanged" so changed paragraphs
 *  read in context with their unchanged neighbours. */
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

/** Paragraph-level unified diff used by the pre-accept inline view so
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

/** Compose a markdown projection of the description from its sections.
 *  Each heading is rendered as an h2 so MarkdownBlock styles it consistently
 *  with the rest of the ticket prose. Falls back to the plain
 *  `issue.description` if no sections are present. */
function joinDescriptionSections(issue: JiraIssue): string {
  if (issue.descriptionSections && issue.descriptionSections.length > 0) {
    return issue.descriptionSections
      .map((s) => (s.heading ? `## ${s.heading}\n\n${s.content}` : s.content))
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

function DiffEntryActions({
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

function DiffParagraphBlock({
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
  partialOutput,
  onSend,
  commands,
  onCollapse,
}: {
  messages: GroomChatMessage[];
  thinking: boolean;
  probeStatus: string;
  /** Streaming partial output emitted by the grooming agent while it's
   *  still mid-response. When non-null, the "Thinking…" bubble swaps to
   *  a live preview that grows token-by-token instead of sitting blank. */
  partialOutput: Partial<GroomingOutput> | null;
  onSend: (text: string) => void;
  commands: SlashCommand[];
  /** When provided, renders a collapse button in the header so the user
   *  can hide the chat pane to give the middle column more room. */
  onCollapse?: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, partialOutput]);

  const streamingPreview = thinking && partialOutput
    ? buildStreamingPreview(partialOutput)
    : "";

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
          {thinking && !streamingPreview && (
            <div className="flex justify-start">
              <div className="bg-muted text-muted-foreground px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {probeStatus || "Thinking…"}
              </div>
            </div>
          )}
          {thinking && streamingPreview && (
            <div className="flex justify-start">
              <div className="bg-muted text-foreground px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm leading-relaxed whitespace-pre-wrap max-w-[85%]">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Analyzing…
                </div>
                {streamingPreview}
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

  // Mirror the live session chat into the chat-history store so it
  // survives navigating away from this screen. Rehydrated in
  // `loadTicket` when the same ticket is re-opened.
  useEffect(() => {
    if (!session) return;
    useChatHistoryStore
      .getState()
      .setHistory("ticket_quality", session.issue.key, session.chat);
  }, [session]);

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
    // Rehydrate any prior chat for this ticket so navigating away and
    // back doesn't wipe the conversation. The drafts intentionally
    // start fresh — JIRA may have moved on since the user last looked.
    const priorChat = useChatHistoryStore
      .getState()
      .getHistory("ticket_quality", freshIssue.key) as GroomChatMessage[];
    setSession({
      issue: freshIssue,
      chat: priorChat,
      drafts: [],
      thinking: false,
      applying: false,
      probeStatus: "",
      analyzed: false,
      partialOutput: null,
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
        ? { ...prev, thinking: true, chat: [], drafts: [], partialOutput: null }
        : prev,
    );

    // Subscribe to streaming partial-output events from the sidecar so the
    // panel renders fields as the model emits them, instead of waiting for
    // the full reply. Throttled to 80ms to avoid flooding React on token-
    // heavy streams. Mirrors the PR Review streaming wiring.
    let pendingPartial: Partial<GroomingOutput> | null = null;
    let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPartial = () => {
      partialFlushTimer = null;
      if (!pendingPartial) return;
      const next = pendingPartial;
      pendingPartial = null;
      setSession((prev) =>
        prev?.issue.key === sessionKey ? { ...prev, partialOutput: next } : prev,
      );
    };
    const unlistenPartial = await listen<{
      kind?: string;
      node?: string;
      status?: "started" | "completed";
      data?: {
        partial?: Partial<GroomingOutput>;
        usagePartial?: { inputTokens?: number; outputTokens?: number };
        rateLimits?: { provider?: string; snapshot?: RateLimitSnapshot };
      };
    }>("grooming-workflow-event", (event) => {
      if (event.payload.kind !== "progress") return;

      // Live token-usage stream — the standalone grooming workflow
      // uses streamLLMJson in the sidecar which emits these events as
      // input/output tokens accumulate. Routing them through the
      // tokenUsageStore keeps the HeaderModelPicker count climbing
      // while the agent is still talking, instead of jumping in one
      // shot at the end.
      const usagePartial = event.payload.data?.usagePartial;
      if (usagePartial && typeof usagePartial === "object") {
        let mk: string | undefined;
        try {
          const r = useAiSelectionStore.getState().resolve("ticket_quality");
          if (r.model) mk = modelKey(r.provider, r.model);
        } catch {
          /* hydration race — fall back to panel-only bucket */
        }
        useTokenUsageStore.getState().setCurrentCallUsage(
          "ticket_quality",
          {
            inputTokens: usagePartial.inputTokens ?? 0,
            outputTokens: usagePartial.outputTokens ?? 0,
          },
          mk,
        );
        return;
      }

      // Anthropic rate-limit headers from the OAuth fetch interceptor.
      const rateLimits = event.payload.data?.rateLimits;
      if (
        rateLimits?.provider &&
        rateLimits.snapshot &&
        typeof rateLimits.snapshot === "object"
      ) {
        useTokenUsageStore
          .getState()
          .setRateLimits(rateLimits.provider, rateLimits.snapshot);
        return;
      }

      const partial = event.payload.data?.partial;
      if (!partial || typeof partial !== "object") return;
      pendingPartial = partial;
      if (partialFlushTimer === null) {
        partialFlushTimer = setTimeout(flushPartial, 80);
      }
    });

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
      const output = await runGroomingWorkflow(
        ticketWithContext,
        fileContentsBlock,
        freshIssue.issueType,
      );
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
              partialOutput: null,
            }
          : prev,
      );
    } catch (e) {
      setInitError(String(e));
      setSession((prev) => (prev?.issue.key === sessionKey ? { ...prev, thinking: false, partialOutput: null } : prev));
    } finally {
      if (partialFlushTimer !== null) clearTimeout(partialFlushTimer);
      unlistenPartial();
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
          useTokenUsageStore.getState().clearPanelChatLastInput("ticket_quality");
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
                  partialOutput={session.partialOutput}
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
