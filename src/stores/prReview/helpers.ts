import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type JiraIssue } from "@/lib/tauri/jira";

// ── Pure helper: build the review text sent to the AI ────────────────────────

const MAX_DIFF_CHARS = 120_000;

function isGeneratedFile(filePath: string): boolean {
  const GENERATED_NAMES = new Set(["generated", "_generated"]);
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts.some((part) => {
    const stem = part.includes(".") ? part.slice(0, part.lastIndexOf(".")) : part;
    return GENERATED_NAMES.has(stem.toLowerCase());
  });
}

/** Returns true if the file is a test/spec file that should be excluded from the Security lens. */
function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const filename = normalized.split("/").pop() ?? normalized;
  // Match filenames containing "test" or "spec" as a word boundary segment
  // e.g. foo.test.ts, foo.spec.ts, test_foo.py, foo_test.go, FooSpec.kt
  return /(?:^|\.|_|-|\/)(?:test|spec)(?:\.|_|-|$)/.test(filename) ||
    /(?:^|\.|_|-|\/)(?:test|spec)s?(?:\.|_|-|$)/.test(filename);
}

function filterGeneratedFilesFromDiff(diff: string): { filtered: string; excluded: string[] } {
  const sections = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  const excluded: string[] = [];

  for (const section of sections) {
    if (!section.startsWith("diff --git ")) {
      kept.push(section);
      continue;
    }
    const match = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    const filePath = match ? match[1].trim() : "";
    if (filePath && isGeneratedFile(filePath)) {
      excluded.push(filePath);
    } else {
      kept.push(section);
    }
  }

  return { filtered: kept.join(""), excluded };
}


/** Extract the list of test/spec file paths from a diff string. */
function extractTestFilesFromDiff(diff: string): string[] {
  const testFiles: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = line.match(/b\/(.+)$/);
    if (match) {
      const filePath = match[1].trim();
      if (isTestFile(filePath)) testFiles.push(filePath);
    }
  }
  return testFiles;
}

export function buildReviewText(
  pr: BitbucketPr,
  diff: string,
  issue: JiraIssue | null
): string {
  const lines: string[] = [];

  lines.push("=== PULL REQUEST ===");
  lines.push(`PR #${pr.id}: ${pr.title}`);
  lines.push(`Author: ${pr.author.displayName}`);
  lines.push(`Branch: ${pr.sourceBranch} → ${pr.destinationBranch}`);
  lines.push(`Created: ${pr.createdOn.slice(0, 10)} | Updated: ${pr.updatedOn.slice(0, 10)}`);
  if (pr.description) {
    lines.push("", "Description:", pr.description);
  }

  if (issue) {
    lines.push("", "=== LINKED JIRA TICKET ===");
    lines.push(`${issue.key}: ${issue.summary}`);
    lines.push(`Type: ${issue.issueType}`);
    if (issue.description) lines.push(issue.description);
    if (issue.acceptanceCriteria) {
      // For Story-type tickets, acceptanceCriteria may have been extracted from
      // the Requirements column of the description table (User Story | Requirements
      // layout) rather than a dedicated custom field.
      const acLabel =
        issue.issueType.toLowerCase() === "story"
          ? "Acceptance Criteria (derived from Requirements column of description table)"
          : "Acceptance Criteria";
      lines.push("", `${acLabel}:`, issue.acceptanceCriteria);
    } else {
      lines.push("", "Acceptance Criteria: [NONE PROVIDED — this ticket has no acceptance criteria defined]");
    }
  } else {
    lines.push("", "=== LINKED JIRA TICKET ===");
    lines.push("[No linked JIRA ticket — acceptance criteria unavailable]");
  }

  const { filtered: filteredDiff, excluded } = filterGeneratedFilesFromDiff(diff);
  if (excluded.length > 0) {
    lines.push("", "=== EXCLUDED FROM REVIEW (auto-generated files — do not review) ===");
    for (const f of excluded) lines.push(`  ${f}`);
    lines.push("These files are machine-generated and must not be reviewed or commented on.");
  }

  // Test/spec files must be excluded from the Security lens.
  // They may still appear in the diff for the testing and quality lenses.
  const testFiles = extractTestFilesFromDiff(filteredDiff);
  if (testFiles.length > 0) {
    lines.push("", "=== TEST / SPEC FILES IN THIS DIFF ===");
    for (const f of testFiles) lines.push(`  ${f}`);
    lines.push(
      "SECURITY LENS INSTRUCTION: Do NOT raise any security findings for the test/spec files " +
      "listed above. Test files are not production code and are explicitly excluded from the " +
      "Security review lens. They may still be reviewed under the Testing and Quality lenses."
    );
  }

  lines.push("", "=== DIFF ===");
  lines.push(
    "The diff is in standard unified format. The backend annotates each line: " +
    "[Lnnn] = added/context line at new-file line number nnn (present in the new code), " +
    "[del] = deleted line (removed, no longer exists in the new code). " +
    "Only [Lnnn] and bare context lines reflect the current state of the file."
  );
  const trimmedDiff =
    filteredDiff.length > MAX_DIFF_CHARS
      ? filteredDiff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated — showing first 120k characters]"
      : filteredDiff;
  lines.push(trimmedDiff);

  return lines.join("\n");
}
