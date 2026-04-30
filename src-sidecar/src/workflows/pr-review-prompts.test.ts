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
});
