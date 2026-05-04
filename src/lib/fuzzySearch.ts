import { type JiraIssue } from "@/lib/tauri/jira";

/**
 * Score how well `query` fuzzy-matches `target`. Returns null when not all
 * query characters appear in order. Higher is better.
 *
 * Scoring: exact substring beats subsequence; matches at the start of the
 * string or a word boundary, and consecutive runs, all earn bonuses.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  if (!target) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const idx = t.indexOf(q);
  if (idx !== -1) {
    let score = 1000 - idx;
    if (idx === 0) score += 200;
    else if (isBoundary(t, idx)) score += 100;
    return score - (t.length - q.length) * 0.05;
  }

  let score = 0;
  let qi = 0;
  let prevMatched = false;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      let bonus = 1;
      if (prevMatched) bonus += 5;
      if (isBoundary(t, ti)) bonus += 3;
      if (ti === 0) bonus += 5;
      score += bonus;
      qi++;
      prevMatched = true;
    } else {
      prevMatched = false;
    }
  }
  if (qi < q.length) return null;
  return score - (t.length - q.length) * 0.05;
}

function isBoundary(s: string, i: number): boolean {
  if (i === 0) return true;
  return /[\s\-_/.:]/.test(s[i - 1]);
}

/**
 * Fuzzy-filter and rank issues by `query` against their key and summary.
 * Returns the original list unchanged when query is empty.
 */
export function fuzzyFilterIssues<T extends Pick<JiraIssue, "key" | "summary">>(
  query: string,
  issues: T[],
): T[] {
  const q = query.trim();
  if (!q) return issues;

  const scored: { issue: T; score: number }[] = [];
  for (const issue of issues) {
    const keyScore = fuzzyScore(q, issue.key);
    const summaryScore = fuzzyScore(q, issue.summary);
    const best = Math.max(keyScore ?? -Infinity, summaryScore ?? -Infinity);
    if (best > -Infinity) scored.push({ issue, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.issue);
}

/** Merge two issue lists, deduplicated by id. Order from `primary` is preserved. */
export function mergeIssuesById(primary: JiraIssue[], secondary: JiraIssue[]): JiraIssue[] {
  const seen = new Set<string>();
  const merged: JiraIssue[] = [];
  for (const i of primary) {
    if (!seen.has(i.id)) { seen.add(i.id); merged.push(i); }
  }
  for (const i of secondary) {
    if (!seen.has(i.id)) { seen.add(i.id); merged.push(i); }
  }
  return merged;
}
