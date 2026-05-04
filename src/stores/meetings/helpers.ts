import { type MeetingRecord } from "@/lib/tauri/meetings";
import { extractTiptapPlainText } from "@/lib/tiptapText";

/**
 * Coerce a raw user-entered tag into the canonical form: lowercase,
 * trimmed, internal whitespace stripped (everything from the first
 * whitespace onwards is dropped). Returns the empty string when the
 * input collapses to nothing — callers should guard with a no-op.
 *
 * Tags are restricted to single tokens so `#tag` query syntax can
 * use a simple `\S+` parser without ambiguity around where the tag
 * ends and the rest of the query begins.
 */
export function normalizeTag(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const firstWhitespace = trimmed.search(/\s/);
  return firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
}

export function buildTranscriptText(record: MeetingRecord): string {
  if (record.segments.length === 0) return "(no transcript available)";

  // Resolve speaker id → user-assigned name so the AI agent sees real names
  // instead of anonymous "SPEAKER_00" labels. Falls back to the raw cluster
  // id when no name has been assigned yet, and omits the prefix entirely
  // for segments that were never diarized.
  const nameById = new Map<string, string>();
  for (const sp of record.speakers ?? []) {
    nameById.set(sp.id, sp.displayName?.trim() || sp.id);
  }

  return record.segments
    .map((s) => {
      const t = formatTimestamp(s.startSec);
      const speaker = s.speakerId ? nameById.get(s.speakerId) ?? s.speakerId : null;
      return speaker ? `[${t}] ${speaker}: ${s.text}` : `[${t}] ${s.text}`;
    })
    .join("\n");
}

// The text we feed to the summarize / chat agents. For transcript-mode meetings
// this is the joined segment text; for notes-mode it's the rich-editor
// document flattened to markdown-ish plain text (TipTap stores JSON, but the
// agents speak text — see extractTiptapPlainText). Either may be empty
// (caller should guard).
export function buildAgentInputText(record: MeetingRecord): string {
  if (record.kind === "notes") {
    return extractTiptapPlainText(record.notes);
  }
  return buildTranscriptText(record);
}

export function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function replaceOrInsert(
  list: MeetingRecord[],
  record: MeetingRecord,
): MeetingRecord[] {
  const idx = list.findIndex((m) => m.id === record.id);
  if (idx === -1) {
    return [record, ...list].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
  }
  const next = list.slice();
  next[idx] = record;
  return next;
}
