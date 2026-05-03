import { describe, expect, it } from "vitest";
import {
  meetingMatchesNames,
  meetingMatchesTags,
  parseTaggedQuery,
} from "./taggedQuery";

describe("parseTaggedQuery", () => {
  it("returns no tags or names and the trimmed text for plain queries", () => {
    expect(parseTaggedQuery("snapshot testing")).toEqual({
      tags: [],
      names: [],
      residual: "snapshot testing",
    });
  });

  it("extracts a leading tag", () => {
    expect(parseTaggedQuery("#capstone snapshot testing")).toEqual({
      tags: ["capstone"],
      names: [],
      residual: "snapshot testing",
    });
  });

  it("extracts a trailing tag", () => {
    expect(parseTaggedQuery("snapshot testing #capstone")).toEqual({
      tags: ["capstone"],
      names: [],
      residual: "snapshot testing",
    });
  });

  it("extracts a mid-query tag and stitches the residual", () => {
    expect(parseTaggedQuery("snapshot #capstone testing")).toEqual({
      tags: ["capstone"],
      names: [],
      residual: "snapshot testing",
    });
  });

  it("extracts multiple tags AND-style", () => {
    expect(parseTaggedQuery("#capstone #urgent broken auth")).toEqual({
      tags: ["capstone", "urgent"],
      names: [],
      residual: "broken auth",
    });
  });

  it("dedupes repeated tags", () => {
    expect(parseTaggedQuery("#a foo #a bar")).toEqual({
      tags: ["a"],
      names: [],
      residual: "foo bar",
    });
  });

  it("normalises tag case to lowercase", () => {
    expect(parseTaggedQuery("foo #StandUp bar")).toEqual({
      tags: ["standup"],
      names: [],
      residual: "foo bar",
    });
  });

  it("returns empty residual when only a tag is provided", () => {
    expect(parseTaggedQuery("#capstone")).toEqual({
      tags: ["capstone"],
      names: [],
      residual: "",
    });
  });

  it("ignores `#` not preceded by whitespace (e.g. URL fragments)", () => {
    // `path/to/file#anchor` is plain text — the # is mid-token.
    expect(parseTaggedQuery("path/to/file#anchor")).toEqual({
      tags: [],
      names: [],
      residual: "path/to/file#anchor",
    });
  });

  it("collapses extra whitespace left by stripping tags", () => {
    expect(parseTaggedQuery("  #a   broken    #b  auth  ")).toEqual({
      tags: ["a", "b"],
      names: [],
      residual: "broken auth",
    });
  });

  it("ignores a lone `#` with no body", () => {
    expect(parseTaggedQuery("foo # bar")).toEqual({
      tags: [],
      names: [],
      residual: "foo # bar",
    });
  });

  it("extracts an @name token", () => {
    expect(parseTaggedQuery("snapshot testing @alice")).toEqual({
      tags: [],
      names: ["alice"],
      residual: "snapshot testing",
    });
  });

  it("extracts both #tag and @name tokens together", () => {
    expect(parseTaggedQuery("#standup @bob blockers")).toEqual({
      tags: ["standup"],
      names: ["bob"],
      residual: "blockers",
    });
  });

  it("ignores `@` not preceded by whitespace (email addresses)", () => {
    expect(parseTaggedQuery("user@example.com signup flow")).toEqual({
      tags: [],
      names: [],
      residual: "user@example.com signup flow",
    });
  });

  it("dedupes and lowercases repeated @name tokens", () => {
    expect(parseTaggedQuery("@Alice talked to @alice about @ALICE")).toEqual({
      tags: [],
      names: ["alice"],
      residual: "talked to about",
    });
  });
});

describe("meetingMatchesNames", () => {
  it("matches everything when no names are required", () => {
    expect(meetingMatchesNames(["Alice", "Bob"], [])).toBe(true);
    expect(meetingMatchesNames([], [])).toBe(true);
  });

  it("matches a single substring against participant labels", () => {
    expect(meetingMatchesNames(["Isaac Harries"], ["isaac"])).toBe(true);
    expect(meetingMatchesNames(["Isaac H"], ["harries"])).toBe(false);
  });

  it("requires every required name (AND across tokens)", () => {
    expect(meetingMatchesNames(["Alice Smith", "Bob"], ["alice", "bob"])).toBe(true);
    expect(meetingMatchesNames(["Alice Smith"], ["alice", "bob"])).toBe(false);
  });

  it("treats name comparison as case-insensitive", () => {
    expect(meetingMatchesNames(["Bob"], ["BOB"])).toBe(true);
    expect(meetingMatchesNames(["BOB"], ["bob"])).toBe(true);
  });

  it("returns false when the meeting has no participants but a name is required", () => {
    expect(meetingMatchesNames([], ["alice"])).toBe(false);
  });
});

describe("meetingMatchesTags", () => {
  it("matches everything when no tags are required", () => {
    expect(meetingMatchesTags(["a", "b"], [])).toBe(true);
    expect(meetingMatchesTags([], [])).toBe(true);
  });

  it("requires every required tag to be present (AND)", () => {
    expect(meetingMatchesTags(["standup", "urgent"], ["standup"])).toBe(true);
    expect(meetingMatchesTags(["standup", "urgent"], ["standup", "urgent"])).toBe(
      true,
    );
    expect(meetingMatchesTags(["standup"], ["standup", "urgent"])).toBe(false);
  });

  it("compares case-insensitively on both sides", () => {
    expect(meetingMatchesTags(["StandUp"], ["standup"])).toBe(true);
    expect(meetingMatchesTags(["standup"], ["STANDUP"])).toBe(true);
  });

  it("returns false when the meeting has no tags but tags are required", () => {
    expect(meetingMatchesTags([], ["standup"])).toBe(false);
  });
});
