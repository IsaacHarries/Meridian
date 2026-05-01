/**
 * Filter rules for the right-hand Tasks panel's "From PRs" section.
 *
 * Bitbucket Cloud projects often ship with default PR-tasks (e.g. a
 * "verify deploy passes" or a teammate-owned QA checklist). The author
 * doesn't tick those off — someone else does — so they just sit in the
 * Meridian sidebar as noise. These rules let the user exclude them.
 *
 * A task is hidden when ANY enabled rule matches its content. Rules are
 * persisted under the `pr_task_filters` preference key as JSON.
 */

import { getPreferences, setPreference } from "@/lib/preferences";

export type PrTaskFilterMode =
  | "substring"
  | "starts_with"
  | "ends_with"
  | "regex";

export interface PrTaskFilter {
  /** Stable id for React keys + edit operations. */
  id: string;
  pattern: string;
  mode: PrTaskFilterMode;
  /** Match case-insensitively. Default true — most rules people write
   *  are descriptive English, where case usually doesn't matter. */
  caseInsensitive: boolean;
  /** When false, the rule is preserved but inactive — useful for
   *  toggling a rule off without losing its pattern. */
  enabled: boolean;
}

const PR_TASK_FILTERS_KEY = "pr_task_filters";

export async function getPrTaskFilters(): Promise<PrTaskFilter[]> {
  try {
    const prefs = await getPreferences();
    const raw = prefs[PR_TASK_FILTERS_KEY];
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidFilter);
  } catch {
    return [];
  }
}

export async function setPrTaskFilters(filters: PrTaskFilter[]): Promise<void> {
  await setPreference(PR_TASK_FILTERS_KEY, JSON.stringify(filters));
}

function isValidFilter(v: unknown): v is PrTaskFilter {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<PrTaskFilter>;
  return (
    typeof f.id === "string" &&
    typeof f.pattern === "string" &&
    (f.mode === "substring" ||
      f.mode === "starts_with" ||
      f.mode === "ends_with" ||
      f.mode === "regex") &&
    typeof f.caseInsensitive === "boolean" &&
    typeof f.enabled === "boolean"
  );
}

/**
 * Test whether `text` matches `filter`. Empty patterns never match —
 * a half-typed rule shouldn't accidentally hide everything. Invalid
 * regexes also never match (and don't throw) so a typo in the editor
 * doesn't crash the panel.
 */
export function matchesFilter(text: string, filter: PrTaskFilter): boolean {
  if (!filter.enabled) return false;
  const pattern = filter.pattern;
  if (!pattern) return false;
  const haystack = filter.caseInsensitive ? text.toLowerCase() : text;
  const needle = filter.caseInsensitive ? pattern.toLowerCase() : pattern;
  switch (filter.mode) {
    case "substring":
      return haystack.includes(needle);
    case "starts_with":
      return haystack.startsWith(needle);
    case "ends_with":
      return haystack.endsWith(needle);
    case "regex":
      try {
        const flags = filter.caseInsensitive ? "i" : "";
        // Use the original (non-lowercased) text for regex so the
        // pattern's own case-class semantics aren't doubled up.
        return new RegExp(filter.pattern, flags).test(text);
      } catch {
        return false;
      }
  }
}

/** Returns true when ANY of the enabled rules matches. */
export function matchesAnyFilter(
  text: string,
  filters: PrTaskFilter[],
): boolean {
  for (const f of filters) {
    if (matchesFilter(text, f)) return true;
  }
  return false;
}

/**
 * Generate a short, URL-safe-ish id for a new filter row. Doesn't need
 * to be cryptographically unique — these are stored in a single user's
 * preference file and only need to disambiguate within that array.
 */
export function newFilterId(): string {
  return `flt_${Math.random().toString(36).slice(2, 10)}`;
}
