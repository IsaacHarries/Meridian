import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./analyze-pr-comments.js";

// Regression guard: the SYSTEM_PROMPT used to define confidence levels with
// no calibration ("High / Medium / Needs human judgment" — three labels, no
// rule for picking one). Now each level is concretely defined and a SELF-CHECK
// block forces verification that the model isn't fabricating file content
// for files that were not supplied in the input.

describe("analyze-pr-comments SYSTEM_PROMPT", () => {
  it("calibrates each confidence level with a concrete rule", () => {
    expect(SYSTEM_PROMPT).toContain("CONFIDENCE CALIBRATION");
    expect(SYSTEM_PROMPT).toMatch(/"High" — single localised edit/);
    expect(SYSTEM_PROMPT).toMatch(/"Medium"/);
    expect(SYSTEM_PROMPT).toMatch(/"Needs human judgment"/);
  });

  it("requires confirming the affected file content was supplied before producing newContent", () => {
    expect(SYSTEM_PROMPT).toMatch(/confirm the affected file's content was supplied/);
    expect(SYSTEM_PROMPT).toMatch(/do not fabricate file content/);
  });

  it("includes the SELF-CHECK block that gates against hallucinated ids/lines/files", () => {
    expect(SYSTEM_PROMPT).toContain("=== SELF-CHECK");
    expect(SYSTEM_PROMPT).toMatch(/commentId in my output appear in the input/);
    expect(SYSTEM_PROMPT).toMatch(/file paths and line numbers copied verbatim/);
  });
});
