// Pure helpers for the PR Review workflow — line-number annotation, diff
// chunking, and finding-budget capping. Ported from review.rs to keep the
// chunked review behaviour identical to the pre-LangGraph implementation.

/** Annotate every line of a unified diff with its actual new-file line number. */
export function annotateDiffWithLineNumbers(diff: string): string {
  const out: string[] = [];
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const plusPos = line.indexOf("+");
      if (plusPos !== -1) {
        const rest = line.slice(plusPos + 1);
        const m = rest.match(/^(\d+)/);
        if (m) {
          newLine = Number(m[1]);
        }
      }
      out.push(line);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      out.push(`[L${newLine}] ${line.slice(1)}`);
      newLine += 1;
    } else if (line.startsWith(" ")) {
      out.push(`[L${newLine}] ${line.slice(1)}`);
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      out.push(`[del] ${line.slice(1)}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Split a review-text string into chunks for sequential per-chunk review.
 * The header (everything up to and including `=== DIFF ===`) is repeated in
 * every chunk so each call has the PR context. The diff body is split on
 * `diff --git` boundaries; oversized single files are truncated with a marker.
 */
export function splitReviewIntoChunks(reviewText: string, chunkChars: number): string[] {
  const marker = "=== DIFF ===";
  const idx = reviewText.indexOf(marker);
  if (idx === -1) return [reviewText];

  const header = reviewText.slice(0, idx + marker.length);
  const diffBody = reviewText.slice(idx + marker.length);
  const annotated = annotateDiffWithLineNumbers(diffBody);

  const fileSections: string[] = [];
  let current = "";
  for (const line of annotated.split("\n")) {
    if (line.startsWith("diff --git") && current.length > 0) {
      fileSections.push(current);
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim().length > 0) {
    fileSections.push(current);
  }
  if (fileSections.length === 0) return [reviewText];

  const chunks: string[] = [];
  let chunkDiff = "";

  for (const section of fileSections) {
    const candidateLen = header.length + 1 + chunkDiff.length + section.length;
    if (candidateLen > chunkChars && chunkDiff.length > 0) {
      chunks.push(`${header}\n${chunkDiff}`);
      chunkDiff = "";
    }
    if (header.length + section.length > chunkChars) {
      const maxSection = Math.max(0, chunkChars - header.length - 100);
      const truncated = section.slice(0, Math.min(maxSection, section.length));
      chunkDiff += truncated + "\n[file diff truncated — too large for one chunk]\n";
    } else {
      chunkDiff += section;
    }
  }
  if (chunkDiff.trim().length > 0) {
    chunks.push(`${header}\n${chunkDiff}`);
  }
  return chunks;
}

/**
 * Build a single-chunk review prompt — header + line-annotated diff. Used in
 * single-pass mode (small PRs) where there's no chunk loop.
 */
export function buildSinglePassReviewText(reviewText: string): string {
  const marker = "=== DIFF ===";
  const idx = reviewText.indexOf(marker);
  if (idx === -1) return reviewText;
  const header = reviewText.slice(0, idx + marker.length);
  const diffBody = reviewText.slice(idx + marker.length);
  return `${header}${annotateDiffWithLineNumbers(diffBody)}`;
}

type Finding = {
  severity?: string;
  [key: string]: unknown;
};

const SEVERITY_RANK: Record<string, number> = {
  blocking: 0,
  non_blocking: 1,
  nitpick: 2,
};

/**
 * Sort findings by severity (blocking → non_blocking → nitpick → unknown) and
 * greedily include them up to `maxChars`. Returns the JSON-serialised array
 * and the count of findings that were dropped.
 */
export function capFindingsBySeverity(
  findings: Finding[],
  maxChars: number,
): { json: string; dropped: number } {
  const sorted = [...findings].sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity ?? ""] ?? 3;
    const rb = SEVERITY_RANK[b.severity ?? ""] ?? 3;
    return ra - rb;
  });

  const kept: Finding[] = [];
  let runningChars = 2; // outer `[` + `]`

  for (const f of sorted) {
    const s = JSON.stringify(f);
    const needed = s.length + (kept.length === 0 ? 0 : 2); // ", " separator
    if (runningChars + needed > maxChars) break;
    runningChars += needed;
    kept.push(f);
  }

  return {
    json: JSON.stringify(kept),
    dropped: findings.length - kept.length,
  };
}

/**
 * Strip a leading "```json" / "```" fence and trailing "```" if present.
 */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  }
  return trimmed;
}

/**
 * Replace bare unquoted line_range values some models emit, e.g.
 *   "line_range": L96-L127  →  "line_range": "L96-L127"
 */
export function sanitiseBareLineRanges(text: string): string {
  return text.replace(
    /"line_range"\s*:\s*(?!null\b|")(L[\w-]+)/g,
    '"line_range": "$1"',
  );
}
