import { type JiraIssue } from "@/lib/tauri/jira";
import { type GroomingOutput, type SuggestedEditField } from "@/lib/tauri/workflows";
import { diffArrays } from "diff";

// ── State model ───────────────────────────────────────────────────────────────

export interface GroomChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface DraftChange {
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

export interface GroomSession {
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

export function statusAge(issue: JiraIssue): string {
  const days = Math.floor((Date.now() - new Date(issue.updated).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function resolveJiraFieldId(field: SuggestedEditField, issue: JiraIssue): string | null {
  if (field === "summary") return "summary";
  if (field === "description") return "description";
  return issue.discoveredFieldIds?.[field] ?? null;
}

export const FIELD_GETTERS: Record<SuggestedEditField, (issue: JiraIssue) => string | null> = {
  acceptance_criteria: (i) => i.acceptanceCriteria ?? null,
  steps_to_reproduce:  (i) => i.stepsToReproduce ?? null,
  observed_behavior:   (i) => i.observedBehavior ?? null,
  expected_behavior:   (i) => i.expectedBehavior ?? null,
  description:         (i) => i.description ?? null,
  summary:             (i) => i.summary ?? null,
};

export function getCurrentFieldValue(field: SuggestedEditField, issue: JiraIssue): string | null {
  return FIELD_GETTERS[field](issue);
}

export function suggestedEditsToDraftChanges(edits: GroomingOutput["suggested_edits"], issue: JiraIssue): DraftChange[] {
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
export function isInlineField(field: SuggestedEditField, issue: JiraIssue): boolean {
  if (field === "summary") return true;
  if (field === "description" || field === "acceptance_criteria") return true;
  const isBug = issue.issueType.toLowerCase() === "bug";
  if (!isBug) return false;
  return (
    field === "steps_to_reproduce" ||
    field === "observed_behavior" ||
    field === "expected_behavior"
  );
}

// ── Title case ────────────────────────────────────────────────────────────────
//
// Used on the ticket summary so titles land in JIRA looking like "Add Dark
// Mode Support to Settings" regardless of how the user typed them or what
// the AI emitted. Only applied to the `summary` field — descriptions / AC
// stay verbatim because forcing title case on prose is wrong.
//
// The transformation has to be conservative on technical strings — engineer-
// authored ticket titles routinely contain things like `GET /users/:id`,
// `HS256`, `N+1`, `Sidekiq::Job`, version numbers, file paths. A naive
// "lowercase then capitalise first letter of each word" mangles every one
// of those. The rules here:
//   - Words containing a digit, slash, dot, plus, or colon pass through
//     unchanged (treated as code/identifier-shaped).
//   - Words that already mix upper and lower case (e.g. `iOS`, `gRPC`,
//     `JWT`, `JSON`) pass through unchanged — the user / AI deliberately
//     cased them that way.
//   - Words in the small-word list (articles, conjunctions, short
//     prepositions) are lowercased — except the first or last word, which
//     are always capitalised.
//   - Everything else is Capitalised.

const TITLE_CASE_SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "vs",
  "with",
]);

const TECHNICAL_WORD_RE = /[\d/.+:_]/;

function isTechnicalWord(word: string): boolean {
  return TECHNICAL_WORD_RE.test(word);
}

function isMixedCase(word: string): boolean {
  // True when the word has at least one uppercase AND one lowercase letter
  // somewhere other than just the leading character — that's the signal
  // for an intentional casing like `iOS`, `gRPC`, `OAuth`. Single-letter
  // words and ALL-CAPS acronyms (e.g. `JWT`) are NOT mixed case under
  // this definition; the small-word + acronym handling below covers them.
  let hasUpper = false;
  let hasLower = false;
  for (let i = 1; i < word.length; i++) {
    const c = word[i];
    if (c >= "A" && c <= "Z") hasUpper = true;
    else if (c >= "a" && c <= "z") hasLower = true;
    if (hasUpper && hasLower) return true;
  }
  return false;
}

function capitaliseFirst(word: string): string {
  if (word.length === 0) return word;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/** Synthesise a fallback `summary` draft when the AI agent didn't emit
 *  one and the existing title isn't already in title case. The result
 *  surfaces in the same UI as the agent's suggestions — TicketSummaryCard
 *  shows the strip, the user clicks Accept to load it into the editor,
 *  Save commits to JIRA. Returns null when:
 *   - the agent already emitted a summary edit (don't fight it),
 *   - the title is empty,
 *   - the title's already title-cased (toTitleCase would be a no-op).
 *  Stable id keyed on the ticket so re-analysing the same ticket
 *  produces the same draft id, which keeps the dedup contract in
 *  `suggestedEditsToDraftChanges` happy if this synthesis ever ends up
 *  on the same merging path. */
export function synthesizeTitleCaseDraft(
  issue: JiraIssue,
  agentDrafts: DraftChange[],
): DraftChange | null {
  if (agentDrafts.some((d) => d.field === "summary")) return null;
  const original = issue.summary?.trim() ?? "";
  if (!original) return null;
  const cased = toTitleCase(original);
  if (cased === original) return null;
  return {
    id: `local-title-case-${issue.key}`,
    field: "summary",
    section: "Title",
    current: original,
    suggested: cased,
    editedSuggested: cased,
    userEdited: false,
    reasoning:
      "Title-case fix — capitalise content words and lowercase short articles / prepositions per the grooming convention. Generated locally because the AI agent didn't propose a content revision.",
    status: "pending",
  };
}

/**
 * Title-case a ticket summary. See module-level notes for the full rules
 * — short version: code/identifier-shaped words and intentionally
 * mixed-case words pass through, articles / short prepositions are
 * lowercased except at the start or end, everything else is Capitalised.
 *
 * Operates token-by-token while preserving the original whitespace
 * separators so multi-space / tab inputs aren't collapsed.
 */
export function toTitleCase(input: string): string {
  if (!input.trim()) return input;
  // Split on whitespace boundaries while preserving the separators so we
  // can reassemble the original spacing exactly.
  const parts = input.split(/(\s+)/);
  // Word-token indices (skip the captured whitespace runs) — used to
  // identify the first and last word for the always-cap rule.
  const wordIndices: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] && !/^\s+$/.test(parts[i])) wordIndices.push(i);
  }
  const firstIdx = wordIndices[0];
  const lastIdx = wordIndices[wordIndices.length - 1];

  const out = parts.map((part, idx) => {
    if (!part || /^\s+$/.test(part)) return part;
    if (isTechnicalWord(part)) return part;
    if (isMixedCase(part)) return part;
    const lower = part.toLowerCase();
    const isEdge = idx === firstIdx || idx === lastIdx;
    if (!isEdge && TITLE_CASE_SMALL_WORDS.has(lower)) return lower;
    return capitaliseFirst(part);
  });
  return out.join("");
}

/** Draft whose target field doesn't have an inline home — e.g. summary,
 *  or a bug-only field on a non-bug ticket. These still need to surface
 *  somewhere, so we keep the legacy DraftChangesPanel for them. */
export function isOrphanDraft(draft: DraftChange, issue: JiraIssue): boolean {
  return !isInlineField(draft.field, issue);
}

export function hasOrphanDrafts(drafts: DraftChange[], issue: JiraIssue): boolean {
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
export function buildStreamingPreview(partial: Partial<GroomingOutput>): string {
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

export function buildOpeningMessage(issue: JiraIssue, output: GroomingOutput): string {
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
export function effectiveDescription(issue: JiraIssue): string | null {
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

// ── Field labels ──────────────────────────────────────────────────────────────

export const FIELD_LABELS: Record<SuggestedEditField, string> = {
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
export function preserveImagesFromOriginal(
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
export interface UnifiedDiffEntry {
  kind: "modified" | "added" | "removed" | "unchanged";
  oldText: string;
  newText: string;
}

export function splitParagraphs(text: string): string[] {
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
export function composeFromDecisions(
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
export function computeUnifiedDiff(
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
export function joinDescriptionSections(issue: JiraIssue): string {
  if (issue.descriptionSections && issue.descriptionSections.length > 0) {
    return issue.descriptionSections
      .map((s) => (s.heading ? `## ${s.heading}\n\n${s.content}` : s.content))
      .join("\n\n")
      .trim();
  }
  return issue.description ?? "";
}
