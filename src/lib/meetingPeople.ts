import { type MeetingRecord } from "@/lib/tauri/meetings";
import { extractMentionLabels } from "@/lib/tiptapText";

/**
 * Participant labels for a single meeting — the canonical strings the
 * `@name` matcher checks via case-insensitive substring.
 */
export function participantsForMeeting(record: MeetingRecord): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sp of record.speakers ?? []) {
    const label = sp.displayName?.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  for (const label of extractMentionLabels(record.notes)) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * Sorted, case-insensitively-deduped pool of every participant name
 * that appears anywhere in the meetings list. Used as the autocomplete
 * data source for the `@` popover in the notes editor and the search
 * inputs.
 */
export function gatherNamePool(meetings: readonly MeetingRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of meetings) {
    for (const label of participantsForMeeting(m)) {
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(label);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * Sorted, deduped tag pool across the meetings list — companion to
 * the name pool, fed to the `#` autocomplete popover. Reads from each
 * meeting's `tags` directly (already canonicalised at write-time by
 * `normalizeTag`).
 */
export function gatherTagPool(meetings: readonly MeetingRecord[]): string[] {
  const seen = new Set<string>();
  for (const m of meetings) {
    for (const t of m.tags ?? []) {
      const key = t.toLowerCase();
      if (!seen.has(key)) seen.add(key);
    }
  }
  return Array.from(seen).sort();
}
