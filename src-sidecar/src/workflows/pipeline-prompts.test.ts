import { describe, expect, it } from "vitest";
import {
  BAN_FILLER_RULE,
  buildPlanSystem,
  CODE_REVIEW_SYSTEM,
  CONFIDENCE_BLOCK,
  GUIDANCE_SYSTEM,
  IMPACT_SYSTEM,
  IMPLEMENTATION_PER_FILE_SYSTEM,
  SEVERITY_BLOCK,
  TEST_GEN_SYSTEM,
  TEST_PLAN_SYSTEM,
} from "./pipeline-prompts.js";
import { appendSelfCheck } from "./pipeline/helpers.js";

// These tests are regression guards. Each prompt grew from a thin / unguided
// version to a structured one with stage-role clarity, calibrated severity,
// per-item enumeration, banned-filler guard, and a SELF-CHECK appendix.
// If any future edit trims the prompt back to the bad shape, these fail.

describe("appendSelfCheck", () => {
  it("appends a numbered SELF-CHECK block with the standard tail", () => {
    const out = appendSelfCheck("BASE", ["Check A?", "Check B?"]);
    expect(out).toContain("BASE");
    expect(out).toContain("=== SELF-CHECK (apply before outputting) ===");
    expect(out).toContain("1. Check A?");
    expect(out).toContain("2. Check B?");
    expect(out).toContain("If any answer is NO");
  });

  it("returns the base unchanged when the items list is empty", () => {
    expect(appendSelfCheck("BASE", [])).toBe("BASE");
  });
});

describe("shared rule blocks", () => {
  it("SEVERITY_BLOCK calibrates blocking / non_blocking / suggestion concretely", () => {
    expect(SEVERITY_BLOCK).toContain("blocking:");
    expect(SEVERITY_BLOCK).toContain("non_blocking:");
    expect(SEVERITY_BLOCK).toMatch(/concrete failure mode/);
    expect(SEVERITY_BLOCK).toMatch(/Inflating severity/);
  });

  it("CONFIDENCE_BLOCK ties verdicts to the AC + plan walks (not vibes)", () => {
    expect(CONFIDENCE_BLOCK).toMatch(/zero blocking findings AND zero unmet acceptance criteria/);
    expect(CONFIDENCE_BLOCK).toContain("requires_rework");
    expect(CONFIDENCE_BLOCK).toContain("plan file");
  });

  it("BAN_FILLER_RULE forbids vague verdicts and demands per-item evidence", () => {
    expect(BAN_FILLER_RULE).toContain("BANNED");
    expect(BAN_FILLER_RULE).toContain("looks good");
    expect(BAN_FILLER_RULE).toContain("all criteria met");
    expect(BAN_FILLER_RULE).toContain("per-item evidence");
  });
});

describe("IMPACT_SYSTEM", () => {
  it("calibrates risk levels concretely (defends against always-medium)", () => {
    expect(IMPACT_SYSTEM).toContain("RISK LEVEL CALIBRATION");
    expect(IMPACT_SYSTEM).toMatch(/low:/);
    expect(IMPACT_SYSTEM).toMatch(/medium:/);
    expect(IMPACT_SYSTEM).toMatch(/high:/);
  });

  it("requires per-area mapping back to grooming + concrete regression triggers", () => {
    expect(IMPACT_SYSTEM).toMatch(/map back to grooming/);
    expect(IMPACT_SYSTEM).toMatch(/concrete trigger/);
  });

  it("includes the SELF-CHECK appendix", () => {
    expect(IMPACT_SYSTEM).toContain("=== SELF-CHECK");
  });
});

describe("buildPlanSystem", () => {
  it("requires path discipline, anti-filler assumptions, and specific do_not_change items", () => {
    const out = buildPlanSystem("ctx");
    expect(out).toContain("PATH DISCIPLINE");
    expect(out).toMatch(/either appear in the grooming output.*OR be marked.*new file/s);
    expect(out).toMatch(/Filler assumptions/);
    expect(out).toMatch(/specific files or function names/);
    expect(out).toContain("=== SELF-CHECK");
  });
});

describe("GUIDANCE_SYSTEM", () => {
  it("caps step count and forbids invented identifiers in code_hints", () => {
    expect(GUIDANCE_SYSTEM).toMatch(/One \`steps\` entry per plan file/);
    expect(GUIDANCE_SYSTEM).toMatch(/real identifiers from the plan/);
    expect(GUIDANCE_SYSTEM).toContain("=== SELF-CHECK");
  });
});

describe("IMPLEMENTATION_PER_FILE_SYSTEM", () => {
  it("forbids writing test files (stage-role clarity vs Test Generation)", () => {
    expect(IMPLEMENTATION_PER_FILE_SYSTEM).toMatch(/DO NOT write or modify test files/);
    expect(IMPLEMENTATION_PER_FILE_SYSTEM).toMatch(/Test Generation owns/);
  });

  it("guards against import hallucination and silent skip-without-write", () => {
    expect(IMPLEMENTATION_PER_FILE_SYSTEM).toMatch(/DO NOT invent imports/);
    expect(IMPLEMENTATION_PER_FILE_SYSTEM).toMatch(/disk state is verified/);
  });

  it("includes the SELF-CHECK appendix", () => {
    expect(IMPLEMENTATION_PER_FILE_SYSTEM).toContain("=== SELF-CHECK");
  });
});

describe("TEST_PLAN_SYSTEM", () => {
  it("requires per-implementation-file coverage table to prevent silent drops", () => {
    expect(TEST_PLAN_SYSTEM).toContain("PER-IMPLEMENTATION-FILE COVERAGE");
    expect(TEST_PLAN_SYSTEM).toMatch(/Silently dropping an implementation file.*is a failure/);
  });

  it("includes the SELF-CHECK appendix", () => {
    expect(TEST_PLAN_SYSTEM).toContain("=== SELF-CHECK");
  });
});

describe("TEST_GEN_SYSTEM", () => {
  it("requires files_written to cover every approved plan entry (or explicit skip)", () => {
    expect(TEST_GEN_SYSTEM).toMatch(/files_written MUST list every test file/);
    expect(TEST_GEN_SYSTEM).toMatch(/coverage_notes/);
    expect(TEST_GEN_SYSTEM).toContain("=== SELF-CHECK");
  });
});

describe("CODE_REVIEW_SYSTEM", () => {
  it("requires the per-AC walk and per-plan-file walk in METHODOLOGY order", () => {
    expect(CODE_REVIEW_SYSTEM).toContain("ACCEPTANCE CRITERIA WALK");
    expect(CODE_REVIEW_SYSTEM).toContain("PLAN WALK");
    expect(CODE_REVIEW_SYSTEM).toMatch(/per-criterion table/);
    expect(CODE_REVIEW_SYSTEM).toMatch(/Plan items silently dropped are blocking findings/);
  });

  it("uses the shared SEVERITY, CONFIDENCE, and BAN_FILLER blocks", () => {
    expect(CODE_REVIEW_SYSTEM).toContain(SEVERITY_BLOCK);
    expect(CODE_REVIEW_SYSTEM).toContain(CONFIDENCE_BLOCK);
    expect(CODE_REVIEW_SYSTEM).toContain(BAN_FILLER_RULE);
  });

  it("includes the SELF-CHECK appendix tying confidence to the walks", () => {
    expect(CODE_REVIEW_SYSTEM).toContain("=== SELF-CHECK");
    expect(CODE_REVIEW_SYSTEM).toMatch(/per-AC.*per-plan tables/);
  });
});
