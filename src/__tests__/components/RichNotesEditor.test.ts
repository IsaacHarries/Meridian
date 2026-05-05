import { describe, expect, it } from "vitest";
import { findJiraKeyAtOffset } from "@/components/RichNotesEditor";

describe("findJiraKeyAtOffset", () => {
  it("returns the key when offset is inside the match", () => {
    const text = "See ABC-123 for details";
    // "See " is 4 chars; "ABC-123" spans 4..11
    expect(findJiraKeyAtOffset(text, 5)).toBe("ABC-123");
    expect(findJiraKeyAtOffset(text, 4)).toBe("ABC-123"); // start boundary
    expect(findJiraKeyAtOffset(text, 11)).toBe("ABC-123"); // end boundary
  });

  it("returns null when offset is outside any match", () => {
    const text = "See ABC-123 for details";
    expect(findJiraKeyAtOffset(text, 0)).toBe(null);
    expect(findJiraKeyAtOffset(text, 15)).toBe(null);
  });

  it("returns null when no match exists", () => {
    expect(findJiraKeyAtOffset("plain text without a ticket", 5)).toBe(null);
  });

  it("matches multi-letter project prefixes including digits", () => {
    expect(findJiraKeyAtOffset("MERID42-7 done", 0)).toBe("MERID42-7");
  });

  it("rejects lowercase project prefixes", () => {
    expect(findJiraKeyAtOffset("abc-123 wrong case", 0)).toBe(null);
  });

  it("rejects keys glued to surrounding alphanumerics", () => {
    // "ISO-8601-2" should NOT match (would-be ABC-123 surrounded by digits/dash)
    expect(findJiraKeyAtOffset("ISO-8601-2", 0)).toBe(null);
    // "FOO-1bar" should not match (trailing letter)
    expect(findJiraKeyAtOffset("FOO-1bar", 0)).toBe(null);
    // "xFOO-1" should not match (leading letter)
    expect(findJiraKeyAtOffset("xFOO-1", 5)).toBe(null);
  });

  it("picks the right match when multiple keys are present", () => {
    const text = "Linked to ABC-1 and XYZ-99 today";
    expect(findJiraKeyAtOffset(text, 12)).toBe("ABC-1");
    expect(findJiraKeyAtOffset(text, 22)).toBe("XYZ-99");
    expect(findJiraKeyAtOffset(text, 18)).toBe(null); // "and" word
  });

  it("handles repeated calls without leaking regex lastIndex state", () => {
    // Global regex state can leak across calls if not reset; calling twice
    // in a row with the same input must yield the same result.
    const text = "Fix ABC-123 first";
    expect(findJiraKeyAtOffset(text, 6)).toBe("ABC-123");
    expect(findJiraKeyAtOffset(text, 6)).toBe("ABC-123");
  });

  it("returns null on empty input", () => {
    expect(findJiraKeyAtOffset("", 0)).toBe(null);
  });
});
