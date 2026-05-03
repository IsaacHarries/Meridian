/**
 * Parse `#tag` and `@name` filters out of a free-form search query.
 *
 * Tags are restricted to single tokens (no whitespace) at the data
 * layer (see `normalizeTag` in stores/meetingsStore), so a `#` followed
 * by non-whitespace characters unambiguously marks the end of the tag
 * — there's no quoting or escape syntax to worry about. Names follow
 * the same single-token rule even though display names can have spaces:
 * the autocomplete UI inserts a single token (e.g. the first word of
 * the picked name) and the matcher does case-insensitive substring on
 * the meeting's full participant labels, so `@isaac` matches "Isaac
 * Harries" without the user typing the whole name.
 *
 * Multiple tokens are AND-combined: `#a #b @alice foo` matches meetings
 * tagged BOTH `a` AND `b` whose participants include "alice" and whose
 * content matches `foo`.
 *
 * The parser strips the matched tokens from the residual query so the
 * downstream search (fuzzy or hybrid retrieval) sees just the prose.
 * Tag and name matches are case-insensitive.
 *
 * Examples:
 *   parseTaggedQuery("snapshot testing #capstone")
 *     → { tags: ["capstone"], names: [], residual: "snapshot testing" }
 *
 *   parseTaggedQuery("@alice broken auth")
 *     → { tags: [], names: ["alice"], residual: "broken auth" }
 *
 *   parseTaggedQuery("#standup @bob blockers")
 *     → { tags: ["standup"], names: ["bob"], residual: "blockers" }
 *
 *   parseTaggedQuery("path/to/file#anchor user@example.com")
 *     → { tags: [], names: [], residual: "path/to/file#anchor user@example.com" }
 */
export interface ParsedTaggedQuery {
  /** Lowercased tag tokens, in the order they appeared, deduped. */
  tags: string[];
  /** Lowercased name tokens, in the order they appeared, deduped. */
  names: string[];
  /** Query text with all `#tag`/`@name` tokens stripped and whitespace collapsed. */
  residual: string;
}

const TAG_TOKEN = /(^|\s)#([^\s#@]+)/g;
const NAME_TOKEN = /(^|\s)@([^\s#@]+)/g;

export function parseTaggedQuery(raw: string): ParsedTaggedQuery {
  const tags: string[] = [];
  const names: string[] = [];
  const seenTags = new Set<string>();
  const seenNames = new Set<string>();
  // Replace every matched token (preceded by start-of-string or whitespace)
  // with a single space so the residual stays well-spaced after stripping.
  // Anything that doesn't match — e.g. `mid#word` or `user@example.com` — is
  // left intact and falls into the residual as plain query text.
  let stripped = raw.replace(TAG_TOKEN, (_match, lead: string, body: string) => {
    const tag = body.toLowerCase();
    if (tag && !seenTags.has(tag)) {
      seenTags.add(tag);
      tags.push(tag);
    }
    return lead;
  });
  stripped = stripped.replace(NAME_TOKEN, (_match, lead: string, body: string) => {
    const name = body.toLowerCase();
    if (name && !seenNames.has(name)) {
      seenNames.add(name);
      names.push(name);
    }
    return lead;
  });
  const residual = stripped.replace(/\s+/g, " ").trim();
  return { tags, names, residual };
}

/**
 * True when `meetingTags` includes every tag in `requiredTags`.
 * Comparison is case-insensitive on both sides; an empty `requiredTags`
 * matches everything.
 */
export function meetingMatchesTags(
  meetingTags: readonly string[],
  requiredTags: readonly string[],
): boolean {
  if (requiredTags.length === 0) return true;
  const have = new Set(meetingTags.map((t) => t.toLowerCase()));
  for (const t of requiredTags) {
    if (!have.has(t.toLowerCase())) return false;
  }
  return true;
}

/**
 * True when every name in `requiredNames` appears (as a case-insensitive
 * substring) in at least one of the meeting's participant labels —
 * named transcribed speakers (`speaker.displayName`) or names mentioned
 * in notes via the `@mention` UI.
 *
 * Substring rather than exact match so the user can type a single
 * token (`@isaac`) and find "Isaac Harries"; the autocomplete pool
 * supplies the long form, and the matcher's leniency makes the typed
 * token forgiving.
 *
 * An empty `requiredNames` matches everything.
 */
export function meetingMatchesNames(
  participantLabels: readonly string[],
  requiredNames: readonly string[],
): boolean {
  if (requiredNames.length === 0) return true;
  const labelsLower = participantLabels.map((p) => p.toLowerCase());
  for (const want of requiredNames) {
    const w = want.toLowerCase();
    if (!labelsLower.some((p) => p.includes(w))) return false;
  }
  return true;
}
