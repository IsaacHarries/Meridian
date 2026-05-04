import { describe, expect, it } from "vitest";
import { BUILD_OUTPUT_TAIL_CHARS, isTransientModelError, tailBuildOutput } from "./pipeline/helpers.js";
import { BUILD_CHECK_MAX_ATTEMPTS, PLAN_REVISION_MAX, routeAfterBuildCheck, routeAfterImplementation } from "./pipeline/nodes/build.js";
import { classifyVerification } from "./pipeline/nodes/implementation.js";
import { PerFileResponseSchema } from "./pipeline/schemas.js";
import { type PipelineState } from "./pipeline/state.js";

// ── classifyVerification ─────────────────────────────────────────────────────

describe("classifyVerification (verify-after-write classifier)", () => {
  it("delete: returns still_present when file exists post-iteration", () => {
    expect(
      classifyVerification(
        "delete",
        { exists: true, sizeBytes: 100 },
        undefined,
        undefined,
      ),
    ).toEqual({ outcome: "still_present", detail: expect.stringContaining("on disk") });
  });

  it("delete: returns ok when file is absent post-iteration", () => {
    expect(
      classifyVerification(
        "delete",
        { exists: false, sizeBytes: 0 },
        undefined,
        undefined,
      ),
    ).toEqual({ outcome: "ok" });
  });

  it("create: returns missing when file doesn't exist post-iteration", () => {
    expect(
      classifyVerification(
        "create",
        { exists: false, sizeBytes: 0 },
        undefined,
        undefined,
      ).outcome,
    ).toBe("missing");
  });

  it("modify: returns missing when file doesn't exist post-iteration", () => {
    expect(
      classifyVerification(
        "modify",
        { exists: false, sizeBytes: 0 },
        undefined,
        undefined,
      ).outcome,
    ).toBe("missing");
  });

  it("create: returns empty when file is zero bytes", () => {
    expect(
      classifyVerification(
        "create",
        { exists: true, sizeBytes: 0 },
        undefined,
        undefined,
      ).outcome,
    ).toBe("empty");
  });

  it("modify: returns empty when file is zero bytes", () => {
    expect(
      classifyVerification(
        "modify",
        { exists: true, sizeBytes: 0 },
        undefined,
        undefined,
      ).outcome,
    ).toBe("empty");
  });

  it("modify: returns unchanged when pre/post content match exactly", () => {
    expect(
      classifyVerification(
        "modify",
        { exists: true, sizeBytes: 10 },
        "same content",
        "same content",
      ),
    ).toEqual({
      outcome: "unchanged",
      detail: expect.stringContaining("byte-for-byte"),
    });
  });

  it("modify: returns ok when pre/post content differ", () => {
    expect(
      classifyVerification(
        "modify",
        { exists: true, sizeBytes: 10 },
        "before",
        "after",
      ),
    ).toEqual({ outcome: "ok" });
  });

  it("modify: falls back to ok when preContent snapshot is missing", () => {
    expect(
      classifyVerification(
        "modify",
        { exists: true, sizeBytes: 10 },
        undefined,
        "after",
      ),
    ).toEqual({ outcome: "ok" });
  });

  it("modify: falls back to ok when postContent snapshot is missing (read failure)", () => {
    expect(
      classifyVerification(
        "modify",
        { exists: true, sizeBytes: 10 },
        "before",
        undefined,
      ),
    ).toEqual({ outcome: "ok" });
  });

  it("create: returns ok when file exists with non-zero size", () => {
    expect(
      classifyVerification(
        "create",
        { exists: true, sizeBytes: 200 },
        undefined,
        undefined,
      ),
    ).toEqual({ outcome: "ok" });
  });
});

// ── Routing fixtures ─────────────────────────────────────────────────────────

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    input: {
      ticketText: "",
      ticketKey: "TEST-1",
      worktreePath: "/tmp",
      codebaseContext: "",
      buildVerifyEnabled: false,
      buildCheckCommand: "",
    } as PipelineState["input"],
    model: {} as PipelineState["model"],
    currentStage: "implementation",
    triageHistory: [],
    buildAttempts: 0,
    verificationFailures: [],
    planRevisions: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  } as PipelineState;
}

// ── routeAfterImplementation ─────────────────────────────────────────────────

describe("routeAfterImplementation", () => {
  it("routes to replan_check when there are verification failures within revision budget", () => {
    expect(
      routeAfterImplementation(
        makeState({
          verificationFailures: [
            { path: "a.ts", expected_action: "create", outcome: "missing" },
          ],
          planRevisions: 0,
        }),
      ),
    ).toBe("replan_check");
  });

  it("falls through past replan_check when revision budget is exhausted", () => {
    expect(
      routeAfterImplementation(
        makeState({
          verificationFailures: [
            { path: "a.ts", expected_action: "create", outcome: "missing" },
          ],
          planRevisions: PLAN_REVISION_MAX,
        }),
      ),
    ).toBe("checkpoint_implementation");
  });

  it("routes to build_check when build verification is enabled + command is set", () => {
    expect(
      routeAfterImplementation(
        makeState({
          input: {
            ticketText: "",
            ticketKey: "T",
            worktreePath: "/tmp",
            codebaseContext: "",
            buildVerifyEnabled: true,
            buildCheckCommand: "pnpm build",
          } as PipelineState["input"],
        }),
      ),
    ).toBe("build_check");
  });

  it("routes to checkpoint_implementation when build verification is disabled", () => {
    expect(routeAfterImplementation(makeState())).toBe("checkpoint_implementation");
  });

  it("routes to checkpoint_implementation when build is enabled but command is empty", () => {
    expect(
      routeAfterImplementation(
        makeState({
          input: {
            ticketText: "",
            ticketKey: "T",
            worktreePath: "/tmp",
            codebaseContext: "",
            buildVerifyEnabled: true,
            buildCheckCommand: "   ",
          } as PipelineState["input"],
        }),
      ),
    ).toBe("checkpoint_implementation");
  });

  it("verification failures take priority over build_check routing", () => {
    expect(
      routeAfterImplementation(
        makeState({
          verificationFailures: [
            { path: "a.ts", expected_action: "create", outcome: "missing" },
          ],
          planRevisions: 0,
          input: {
            ticketText: "",
            ticketKey: "T",
            worktreePath: "/tmp",
            codebaseContext: "",
            buildVerifyEnabled: true,
            buildCheckCommand: "pnpm build",
          } as PipelineState["input"],
        }),
      ),
    ).toBe("replan_check");
  });
});

// ── routeAfterBuildCheck ─────────────────────────────────────────────────────

describe("routeAfterBuildCheck", () => {
  it("returns checkpoint_implementation when buildVerification is missing", () => {
    expect(routeAfterBuildCheck(makeState())).toBe("checkpoint_implementation");
  });

  it("returns checkpoint_implementation when build passed", () => {
    expect(
      routeAfterBuildCheck(
        makeState({
          buildVerification: {
            build_command: "pnpm build",
            build_passed: true,
            attempts: [
              { attempt: 1, exit_code: 0, output: "ok", fixed: false, files_written: [] },
            ],
          },
        }),
      ),
    ).toBe("checkpoint_implementation");
  });

  it("returns build_fix while attempts < BUILD_CHECK_MAX_ATTEMPTS and build is failing", () => {
    expect(
      routeAfterBuildCheck(
        makeState({
          buildVerification: {
            build_command: "pnpm build",
            build_passed: false,
            attempts: [
              { attempt: 1, exit_code: 1, output: "boom", fixed: false, files_written: [] },
            ],
          },
        }),
      ),
    ).toBe("build_fix");
  });

  it("returns checkpoint_implementation once attempts are exhausted (does NOT trigger a full plan rewrite)", () => {
    // Build failures used to bubble out to a full re-plan + re-implement
    // when the build_fix budget ran out. That was wildly out of proportion
    // to a tsc / test failure — replans wipe and rewrite every file. Now
    // the route always lands on the implementation checkpoint so the user
    // can read the build output and decide whether to retry, edit, or
    // abandon the run on their own terms.
    expect(
      routeAfterBuildCheck(
        makeState({
          planRevisions: 0,
          buildVerification: {
            build_command: "pnpm build",
            build_passed: false,
            attempts: Array.from({ length: BUILD_CHECK_MAX_ATTEMPTS }, (_, i) => ({
              attempt: i + 1,
              exit_code: 1,
              output: "boom",
              fixed: false,
              files_written: [],
            })),
          },
        }),
      ),
    ).toBe("checkpoint_implementation");
  });

  it("returns checkpoint_implementation once both budgets are exhausted", () => {
    expect(
      routeAfterBuildCheck(
        makeState({
          planRevisions: PLAN_REVISION_MAX,
          buildVerification: {
            build_command: "pnpm build",
            build_passed: false,
            attempts: Array.from({ length: BUILD_CHECK_MAX_ATTEMPTS }, (_, i) => ({
              attempt: i + 1,
              exit_code: 1,
              output: "boom",
              fixed: false,
              files_written: [],
            })),
          },
        }),
      ),
    ).toBe("checkpoint_implementation");
  });

  it("build-passed short-circuits to checkpoint regardless of attempt count", () => {
    expect(
      routeAfterBuildCheck(
        makeState({
          planRevisions: 0,
          buildVerification: {
            build_command: "pnpm build",
            build_passed: true,
            attempts: Array.from({ length: BUILD_CHECK_MAX_ATTEMPTS }, (_, i) => ({
              attempt: i + 1,
              exit_code: 0,
              output: "",
              fixed: false,
              files_written: [],
            })),
          },
        }),
      ),
    ).toBe("checkpoint_implementation");
  });
});

// ── tailBuildOutput ──────────────────────────────────────────────────────────

describe("tailBuildOutput", () => {
  it("passes through unchanged when below the cap", () => {
    const short = "x".repeat(100);
    expect(tailBuildOutput(short)).toBe(short);
  });

  it("passes through unchanged at exactly the cap", () => {
    const exact = "x".repeat(BUILD_OUTPUT_TAIL_CHARS);
    expect(tailBuildOutput(exact)).toBe(exact);
  });

  it("truncates to the last N chars when over the cap", () => {
    const tail = "tail".repeat(10); // 40 chars
    const head = "head".repeat(BUILD_OUTPUT_TAIL_CHARS); // very long
    const out = tailBuildOutput(head + tail);
    expect(out.endsWith(tail)).toBe(true);
    // The result is prefix + last N chars of input. Length is N + the
    // marker prefix.
    expect(out.length).toBeGreaterThan(BUILD_OUTPUT_TAIL_CHARS);
    expect(out.length).toBeLessThan(BUILD_OUTPUT_TAIL_CHARS + 200);
  });

  it("includes a truncation marker when truncating", () => {
    const huge = "x".repeat(BUILD_OUTPUT_TAIL_CHARS + 1);
    expect(tailBuildOutput(huge)).toContain("truncated");
  });
});

// ── isTransientModelError ────────────────────────────────────────────────────

describe("isTransientModelError", () => {
  it.each([
    ["MALFORMED_FUNCTION_CALL response from Gemini", true],
    ["Quota exceeded: RESOURCE_EXHAUSTED", true],
    ["HTTP 429 Too Many Requests", true],
    ["503 Service Unavailable", true],
    ["ECONNRESET", true],
    ["ETIMEDOUT after 60s", true],
    ["fetch failed", true],
    ["Unexpected CodeAssist response shape — empty candidates", true],
    ["random parse failure", false],
    ["TypeError: cannot read property of undefined", false],
    ["", false],
  ])("returns %s for matching/non-matching message", (msg, expected) => {
    expect(isTransientModelError(new Error(msg))).toBe(expected);
  });

  it("accepts non-Error values via String() coercion", () => {
    expect(isTransientModelError("HTTP 429")).toBe(true);
    expect(isTransientModelError({ message: "x" })).toBe(false);
  });
});

// ── PerFileResponseSchema ────────────────────────────────────────────────────

describe("PerFileResponseSchema", () => {
  it("parses with all fields present", () => {
    const r = PerFileResponseSchema.safeParse({
      summary: "wrote it",
      deviations: ["d1"],
      skipped: false,
    });
    expect(r.success).toBe(true);
  });

  it("defaults summary to empty string when omitted", () => {
    const r = PerFileResponseSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.summary).toBe("");
      expect(r.data.deviations).toEqual([]);
      expect(r.data.skipped).toBe(false);
    }
  });

  it("defaults deviations to empty array when omitted", () => {
    const r = PerFileResponseSchema.safeParse({ summary: "x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.deviations).toEqual([]);
  });

  it("defaults skipped to false when omitted", () => {
    const r = PerFileResponseSchema.safeParse({ summary: "x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.skipped).toBe(false);
  });

  it("rejects non-string summary", () => {
    const r = PerFileResponseSchema.safeParse({ summary: 42 });
    expect(r.success).toBe(false);
  });
});
