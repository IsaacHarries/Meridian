import { describe, expect, it } from "vitest";
import { isTransientModelError } from "./pipeline/helpers.js";
import { PLAN_REVISION_MAX, routeAfterImplementation } from "./pipeline/nodes/build.js";
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
    } as PipelineState["input"],
    model: {} as PipelineState["model"],
    currentStage: "implementation",
    triageHistory: [],
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

  it("falls through past replan_check to verification when revision budget is exhausted", () => {
    expect(
      routeAfterImplementation(
        makeState({
          verificationFailures: [
            { path: "a.ts", expected_action: "create", outcome: "missing" },
          ],
          planRevisions: PLAN_REVISION_MAX,
        }),
      ),
    ).toBe("verification");
  });

  it("routes to verification by default — verification always runs after implementation", () => {
    expect(routeAfterImplementation(makeState())).toBe("verification");
  });

  it("verification failures take priority over the verification node — replan first", () => {
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
