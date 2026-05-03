/**
 * Helpers for resolving "who participated in a meeting" — used by the
 * `@name` filter syntax and the autocomplete popover.
 *
 * Two sources feed every meeting's participant list:
 *
 *   1. Named diarisation speakers — `speaker.displayName` once the
 *      user has assigned a real name to a cluster id. Anonymous
 *      cluster ids (e.g. `SPEAKER_00`) are skipped because they're
 *      not useful to filter on.
 *
 *   2. `@mention` nodes inside the rich notes editor — extracted by
 *      walking the TipTap doc JSON and pulling each Mention node's
 *      `attrs.label`. Plain-text `@isaac` typed without going through
 *      the autocomplete is intentionally NOT recognised: the user
 *      opted for an explicit-mention model so stray mid-sentence `@`s
 *      don't pollute the pool.
 *
 * Per-meeting labels are deduped (case-insensitive on the keying side,
 * preserving the first-seen casing for display). The cross-meeting
 * pool is the same with one more dedupe pass over every meeting.
 */

import type { MeetingRecord } from "@/lib/tauri";
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
