import { describe, expect, it } from "vitest";
import { CHUNK_SYSTEM, SYNTHESIS_SYSTEM } from "./pr-review-prompts.js";

describe("pr-review prompts", () => {
  it("CHUNK_SYSTEM asks for a flat JSON array of any-lens findings", () => {
    expect(CHUNK_SYSTEM).toMatch(/JSON array of findings/);
    // The lens field must be present so synthesis can dispatch findings to
    // the right lens bucket in the final report.
    expect(CHUNK_SYSTEM).toContain('"lens"');
    // Common rule blocks
    expect(CHUNK_SYSTEM).toContain("=== REVIEW POSTURE ===");
    expect(CHUNK_SYSTEM).toContain("=== SEVERITY ===");
    expect(CHUNK_SYSTEM).toContain("=== LENS RULES ===");
    expect(CHUNK_SYSTEM).toContain("=== LINE NUMBERS ===");
    expect(CHUNK_SYSTEM).toContain("=== SELF-CHECK");
  });

  it("CHUNK_SYSTEM contains rules for all five lenses", () => {
    for (const block of ["LOGIC:", "QUALITY:", "TESTING:", "SECURITY:", "ACCEPTANCE CRITERIA:"]) {
      expect(CHUNK_SYSTEM).toContain(block);
    }
  });

  it("SYNTHESIS_SYSTEM requires the full lensed report shape and includes calibration rules", () => {
    expect(SYNTHESIS_SYSTEM).toContain('"overall"');
    expect(SYNTHESIS_SYSTEM).toContain('"acceptance_criteria"');
    expect(SYNTHESIS_SYSTEM).toContain('"security"');
    expect(SYNTHESIS_SYSTEM).toContain('"logic"');
    expect(SYNTHESIS_SYSTEM).toContain('"testing"');
    expect(SYNTHESIS_SYSTEM).toContain('"quality"');
    expect(SYNTHESIS_SYSTEM).toContain("SEVERITY CALIBRATION");
    expect(SYNTHESIS_SYSTEM).toContain("DEDUPLICATION");
    expect(SYNTHESIS_SYSTEM).toContain("VERIFICATION PASS");
  });

  it("SYNTHESIS_SYSTEM acknowledges both single-chunk and multi-chunk modes", () => {
    expect(SYNTHESIS_SYSTEM).toContain("Single-chunk mode");
    expect(SYNTHESIS_SYSTEM).toContain("Multi-chunk mode");
  });

  // ── Acceptance Criteria lens hardening ─────────────────────────────────────
  // Regression guard: the AC lens used to be two bullets and the model would
  // return vague "all criteria addressed" verdicts even when explicit demands
  // (e.g. "create integration tests") had no corresponding diff changes. The
  // current prompts force a per-criterion enumeration with evidence and a
  // dedicated test-demand check.

  it("CHUNK_SYSTEM: AC lens forces per-criterion judgement and test-demand check", () => {
    // The chunk-level rules must require walking each bulleted criterion
    // (not punting to synthesis) and must explicitly check for missing
    // tests when criteria demand them.
    expect(CHUNK_SYSTEM).toMatch(/walk the bulleted list under "Acceptance Criteria/);
    expect(CHUNK_SYSTEM).toContain("TEST DEMAND CHECK");
    expect(CHUNK_SYSTEM).toMatch(/met \/ unmet \/ partial/);
    // Vague-approval suppression
    expect(CHUNK_SYSTEM).toMatch(/all criteria addressed/);
  });

  it("SYNTHESIS_SYSTEM: AC assessment must be a per-criterion table, not free-form prose", () => {
    expect(SYNTHESIS_SYSTEM).toContain("per-criterion table");
    expect(SYNTHESIS_SYSTEM).toContain("REQUIRED");
    expect(SYNTHESIS_SYSTEM).toMatch(/met \| unmet \| partial \| unverifiable/);
    // The dedicated test-demand check must appear (model-agnostic guard
    // against the agent declaring criteria like "create integration tests"
    // satisfied by a diff with no test files).
    expect(SYNTHESIS_SYSTEM).toContain("TEST DEMAND CHECK");
    // The banned-phrasing rule must appear so the model can't fall back
    // to a generic approval.
    expect(SYNTHESIS_SYSTEM).toMatch(/All listed acceptance criteria were addressed.*banned/);
  });
});
