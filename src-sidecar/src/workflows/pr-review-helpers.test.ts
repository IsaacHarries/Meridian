import { describe, expect, it } from "vitest";
import {
  annotateDiffWithLineNumbers,
  buildSinglePassReviewText,
  capFindingsBySeverity,
  sanitiseBareLineRanges,
  splitReviewIntoChunks,
  stripJsonFences,
} from "./pr-review-helpers.js";

describe("annotateDiffWithLineNumbers", () => {
  it("labels added and context lines with the new-file line number", () => {
    const diff = [
      "@@ -1,3 +10,4 @@",
      " context line",
      "+added line",
      "-deleted line",
      " more context",
    ].join("\n");
    const annotated = annotateDiffWithLineNumbers(diff);
    expect(annotated).toContain("[L10] context line");
    expect(annotated).toContain("[L11] added line");
    expect(annotated).toContain("[del] deleted line");
    expect(annotated).toContain("[L12] more context");
  });

  it("does not advance line numbers across deleted lines", () => {
    const diff = ["@@ -1,3 +5,2 @@", "-removed", " kept"].join("\n");
    const annotated = annotateDiffWithLineNumbers(diff);
    expect(annotated).toContain("[del] removed");
    expect(annotated).toContain("[L5] kept");
  });

  it("leaves diff/index headers alone", () => {
    const diff = "diff --git a/foo b/foo\nindex abcd..efgh 100644\n--- a/foo\n+++ b/foo\n";
    const annotated = annotateDiffWithLineNumbers(diff);
    expect(annotated).toContain("diff --git a/foo b/foo");
    expect(annotated).toContain("--- a/foo");
    expect(annotated).toContain("+++ b/foo");
  });
});

describe("splitReviewIntoChunks", () => {
  it("returns the original text when there is no === DIFF === marker", () => {
    const text = "no diff marker here";
    expect(splitReviewIntoChunks(text, 100)).toEqual([text]);
  });

  it("returns one chunk when total fits within the budget", () => {
    const text = `header\n=== DIFF ===\ndiff --git a/a b/a\n@@ -1,1 +1,1 @@\n+line\n`;
    const chunks = splitReviewIntoChunks(text, 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("=== DIFF ===");
    expect(chunks[0]).toContain("[L1] line");
  });

  it("splits on diff --git boundaries when the total exceeds the budget", () => {
    const fileA = "diff --git a/a b/a\n@@ -1,1 +1,1 @@\n+aaaa\n".repeat(3);
    const fileB = "diff --git a/b b/b\n@@ -1,1 +1,1 @@\n+bbbb\n".repeat(3);
    const text = `header\n=== DIFF ===\n${fileA}${fileB}`;
    const chunks = splitReviewIntoChunks(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c).toContain("=== DIFF ===");
    }
  });
});

describe("buildSinglePassReviewText", () => {
  it("preserves header verbatim and annotates the diff body", () => {
    const text = "PR title\n=== DIFF ===\n@@ -1,1 +5,1 @@\n+hello\n";
    const out = buildSinglePassReviewText(text);
    expect(out.startsWith("PR title\n=== DIFF ===")).toBe(true);
    expect(out).toContain("[L5] hello");
  });

  it("returns text unchanged when there is no === DIFF === marker", () => {
    expect(buildSinglePassReviewText("just text")).toBe("just text");
  });
});

describe("capFindingsBySeverity", () => {
  it("orders blocking before non_blocking before nitpick", () => {
    const findings = [
      { severity: "nitpick", title: "n" },
      { severity: "blocking", title: "b" },
      { severity: "non_blocking", title: "nb" },
    ];
    const { json, dropped } = capFindingsBySeverity(findings, 10_000);
    expect(dropped).toBe(0);
    const parsed = JSON.parse(json) as Array<{ severity: string }>;
    expect(parsed.map((f) => f.severity)).toEqual([
      "blocking",
      "non_blocking",
      "nitpick",
    ]);
  });

  it("drops lower-severity findings first when over budget", () => {
    const findings = [
      { severity: "blocking", title: "b1", description: "x".repeat(80) },
      { severity: "blocking", title: "b2", description: "x".repeat(80) },
      { severity: "nitpick", title: "n", description: "x".repeat(80) },
    ];
    // Budget that fits two ~130-char findings but not three.
    const { json, dropped } = capFindingsBySeverity(findings, 280);
    expect(dropped).toBe(1);
    const parsed = JSON.parse(json) as Array<{ severity: string }>;
    expect(parsed.every((f) => f.severity === "blocking")).toBe(true);
  });
});

describe("stripJsonFences", () => {
  it("removes ```json fences", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("removes plain ``` fences", () => {
    expect(stripJsonFences('```\n[1,2]\n```')).toBe("[1,2]");
  });
  it("leaves un-fenced text alone", () => {
    expect(stripJsonFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("sanitiseBareLineRanges", () => {
  it("quotes bare line_range identifiers", () => {
    const input = '{"file":"x","line_range": L12-L34}';
    expect(sanitiseBareLineRanges(input)).toBe(
      '{"file":"x","line_range": "L12-L34"}',
    );
  });
  it("leaves null and quoted values alone", () => {
    expect(sanitiseBareLineRanges('"line_range": null')).toBe('"line_range": null');
    expect(sanitiseBareLineRanges('"line_range": "L1"')).toBe('"line_range": "L1"');
  });
});
