import { describe, expect, it, vi } from "vitest";
import {
  PlanEditOpSchema,
  PendingProposalSchema,
  OrchestratorMessageSchema,
  applyPlanEditOp,
  threadReducer,
  stageSummariesReducer,
  maybeCompressStageOnTransition,
  type PlanEditOp,
  type PlanShape,
  type OrchestratorMessage,
} from "./orchestrator.js";

// ── PlanEditOpSchema ─────────────────────────────────────────────────────────

describe("PlanEditOpSchema", () => {
  it("parses add_file with a complete PlanFile payload", () => {
    const r = PlanEditOpSchema.safeParse({
      op: "add_file",
      file: { path: "src/x.ts", action: "create", description: "new file" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects add_file when file fields are missing", () => {
    const r = PlanEditOpSchema.safeParse({
      op: "add_file",
      file: { path: "src/x.ts" },
    });
    expect(r.success).toBe(false);
  });

  it("parses remove_file with a path", () => {
    const r = PlanEditOpSchema.safeParse({ op: "remove_file", path: "a.ts" });
    expect(r.success).toBe(true);
  });

  it("parses update_file with at least one field", () => {
    const r = PlanEditOpSchema.safeParse({
      op: "update_file",
      path: "a.ts",
      fields: { description: "new desc" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects update_file with an empty fields object (refine)", () => {
    const r = PlanEditOpSchema.safeParse({
      op: "update_file",
      path: "a.ts",
      fields: {},
    });
    expect(r.success).toBe(false);
  });

  it("parses set_summary, add_assumption, add_open_question variants", () => {
    expect(PlanEditOpSchema.safeParse({ op: "set_summary", summary: "x" }).success).toBe(true);
    expect(PlanEditOpSchema.safeParse({ op: "add_assumption", text: "y" }).success).toBe(true);
    expect(PlanEditOpSchema.safeParse({ op: "add_open_question", text: "z" }).success).toBe(true);
  });

  it("rejects set_summary with empty string", () => {
    expect(PlanEditOpSchema.safeParse({ op: "set_summary", summary: "" }).success).toBe(false);
  });

  it("rejects unknown op variants", () => {
    expect(PlanEditOpSchema.safeParse({ op: "rename_file", path: "a.ts" }).success).toBe(false);
  });
});

// ── applyPlanEditOp ──────────────────────────────────────────────────────────

function makePlan(overrides: Partial<PlanShape> = {}): PlanShape {
  return {
    summary: "initial",
    files: [
      { path: "a.ts", action: "create", description: "first" },
      { path: "b.ts", action: "modify", description: "second" },
    ],
    order_of_operations: [],
    edge_cases: [],
    do_not_change: [],
    assumptions: ["a1"],
    open_questions: [],
    ...overrides,
  };
}

describe("applyPlanEditOp", () => {
  it("add_file appends a new file entry", () => {
    const out = applyPlanEditOp(makePlan(), {
      op: "add_file",
      file: { path: "c.ts", action: "create", description: "third" },
    });
    expect(out.files).toHaveLength(3);
    expect(out.files[2].path).toBe("c.ts");
  });

  it("add_file rejects a duplicate path", () => {
    expect(() =>
      applyPlanEditOp(makePlan(), {
        op: "add_file",
        file: { path: "a.ts", action: "create", description: "dup" },
      }),
    ).toThrow(/already in the plan/);
  });

  it("remove_file drops the matching path", () => {
    const out = applyPlanEditOp(makePlan(), { op: "remove_file", path: "a.ts" });
    expect(out.files.map((f) => f.path)).toEqual(["b.ts"]);
  });

  it("remove_file rejects an unknown path", () => {
    expect(() =>
      applyPlanEditOp(makePlan(), { op: "remove_file", path: "nope.ts" }),
    ).toThrow(/not in the plan/);
  });

  it("update_file merges only the supplied fields", () => {
    const out = applyPlanEditOp(makePlan(), {
      op: "update_file",
      path: "a.ts",
      fields: { description: "updated" },
    });
    expect(out.files[0].description).toBe("updated");
    expect(out.files[0].action).toBe("create"); // unchanged
  });

  it("update_file can change action without touching description", () => {
    const out = applyPlanEditOp(makePlan(), {
      op: "update_file",
      path: "b.ts",
      fields: { action: "delete" },
    });
    expect(out.files[1].action).toBe("delete");
    expect(out.files[1].description).toBe("second");
  });

  it("update_file rejects an unknown path", () => {
    expect(() =>
      applyPlanEditOp(makePlan(), {
        op: "update_file",
        path: "nope.ts",
        fields: { description: "x" },
      }),
    ).toThrow(/not in the plan/);
  });

  it("set_summary replaces the top-level summary", () => {
    const out = applyPlanEditOp(makePlan(), { op: "set_summary", summary: "new" });
    expect(out.summary).toBe("new");
    expect(out.files).toHaveLength(2); // files preserved
  });

  it("add_assumption appends to assumptions", () => {
    const out = applyPlanEditOp(makePlan(), {
      op: "add_assumption",
      text: "a2",
    });
    expect(out.assumptions).toEqual(["a1", "a2"]);
  });

  it("add_open_question appends to open_questions", () => {
    const out = applyPlanEditOp(makePlan(), {
      op: "add_open_question",
      text: "q1",
    });
    expect(out.open_questions).toEqual(["q1"]);
  });

  it("does not mutate the input plan", () => {
    const plan = makePlan();
    const snapshot = JSON.stringify(plan);
    applyPlanEditOp(plan, { op: "remove_file", path: "a.ts" });
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});

// ── PendingProposalSchema ────────────────────────────────────────────────────

describe("PendingProposalSchema", () => {
  it("parses proceed proposal", () => {
    const r = PendingProposalSchema.safeParse({
      kind: "proceed",
      rationale: "looks good",
      action: "approve",
    });
    expect(r.success).toBe(true);
  });

  it("parses proceed proposal with abort + reason", () => {
    const r = PendingProposalSchema.safeParse({
      kind: "proceed",
      rationale: "bad",
      action: "abort",
      reason: "user halt",
    });
    expect(r.success).toBe(true);
  });

  it("rejects proceed with an invalid action enum value", () => {
    const r = PendingProposalSchema.safeParse({
      kind: "proceed",
      rationale: "x",
      action: "skip",
    });
    expect(r.success).toBe(false);
  });

  it("parses rewind proposal", () => {
    const r = PendingProposalSchema.safeParse({
      kind: "rewind",
      rationale: "x",
      toStage: "grooming",
    });
    expect(r.success).toBe(true);
  });

  it("parses reply proposal", () => {
    const r = PendingProposalSchema.safeParse({
      kind: "reply",
      rationale: "x",
      message: "hi",
    });
    expect(r.success).toBe(true);
  });

  it("parses edit_plan with at least one op", () => {
    const r = PendingProposalSchema.safeParse({
      kind: "edit_plan",
      rationale: "x",
      edits: [{ op: "set_summary", summary: "new" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects edit_plan with an empty edits array", () => {
    const r = PendingProposalSchema.safeParse({
      kind: "edit_plan",
      rationale: "x",
      edits: [],
    });
    expect(r.success).toBe(false);
  });

  it("parses accept_grooming_edit with each newStatus enum value", () => {
    expect(
      PendingProposalSchema.safeParse({
        kind: "accept_grooming_edit",
        rationale: "x",
        editId: "e1",
        newStatus: "approved",
      }).success,
    ).toBe(true);
    expect(
      PendingProposalSchema.safeParse({
        kind: "accept_grooming_edit",
        rationale: "x",
        editId: "e1",
        newStatus: "declined",
      }).success,
    ).toBe(true);
  });

  it("rejects accept_grooming_edit with an invalid newStatus", () => {
    const r = PendingProposalSchema.safeParse({
      kind: "accept_grooming_edit",
      rationale: "x",
      editId: "e1",
      newStatus: "maybe",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown discriminator", () => {
    const r = PendingProposalSchema.safeParse({ kind: "noop", rationale: "x" });
    expect(r.success).toBe(false);
  });
});

// ── OrchestratorMessageSchema ────────────────────────────────────────────────

describe("OrchestratorMessageSchema", () => {
  it("parses each kind with stage tag preserved", () => {
    const cases: OrchestratorMessage[] = [
      { kind: "user", content: "hi", ts: 1, stage: "impact" },
      { kind: "assistant", content: "ok", ts: 2, stage: "impact" },
      {
        kind: "tool_call",
        name: "read_repo_file",
        args: { path: "a.ts" },
        resultSummary: "abc",
        ts: 3,
        stage: "implementation",
      },
      { kind: "system_note", content: "moved on", ts: 4, stage: "impact" },
    ];
    for (const c of cases) {
      const r = OrchestratorMessageSchema.safeParse(c);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.stage).toBe(c.stage);
    }
  });

  it("parses each kind without optional stage", () => {
    expect(
      OrchestratorMessageSchema.safeParse({ kind: "user", content: "hi", ts: 1 }).success,
    ).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(
      OrchestratorMessageSchema.safeParse({ kind: "ghost", content: "hi", ts: 1 }).success,
    ).toBe(false);
  });

  it("preserves tool_call.error when set", () => {
    const r = OrchestratorMessageSchema.safeParse({
      kind: "tool_call",
      name: "x",
      args: {},
      error: "boom",
      ts: 1,
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === "tool_call") {
      expect(r.data.error).toBe("boom");
    }
  });
});

// ── threadReducer ────────────────────────────────────────────────────────────

describe("threadReducer", () => {
  it("appends new entries", () => {
    const a: OrchestratorMessage[] = [{ kind: "user", content: "1", ts: 1 }];
    const b: OrchestratorMessage[] = [{ kind: "assistant", content: "2", ts: 2 }];
    expect(threadReducer(a, b)).toEqual([...a, ...b]);
  });

  it("preserves stage tags on append", () => {
    const a: OrchestratorMessage[] = [
      { kind: "user", content: "1", ts: 1, stage: "impact" },
    ];
    const b: OrchestratorMessage[] = [
      { kind: "assistant", content: "2", ts: 2, stage: "implementation" },
    ];
    const out = threadReducer(a, b);
    expect(out[0].stage).toBe("impact");
    expect(out[1].stage).toBe("implementation");
  });

  it("does not mutate the inputs", () => {
    const a: OrchestratorMessage[] = [{ kind: "user", content: "1", ts: 1 }];
    const b: OrchestratorMessage[] = [{ kind: "assistant", content: "2", ts: 2 }];
    threadReducer(a, b);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

// ── stageSummariesReducer ────────────────────────────────────────────────────

describe("stageSummariesReducer", () => {
  it("adds new keys", () => {
    expect(stageSummariesReducer({}, { impact: "summary-1" })).toEqual({
      impact: "summary-1",
    });
  });

  it("overwrites existing keys with new string values", () => {
    expect(
      stageSummariesReducer({ impact: "old" }, { impact: "new" }),
    ).toEqual({ impact: "new" });
  });

  it("deletes keys when the update value is undefined", () => {
    expect(
      stageSummariesReducer(
        { impact: "x", implementation: "y" },
        { impact: undefined },
      ),
    ).toEqual({ implementation: "y" });
  });

  it("can add and delete in the same update", () => {
    expect(
      stageSummariesReducer(
        { impact: "x", implementation: "y" },
        { impact: undefined, review: "z" },
      ),
    ).toEqual({ implementation: "y", review: "z" });
  });

  it("ignores delete signal for keys that don't exist", () => {
    expect(stageSummariesReducer({ impact: "x" }, { ghost: undefined })).toEqual({
      impact: "x",
    });
  });

  it("does not mutate the input", () => {
    const before = { impact: "x" };
    stageSummariesReducer(before, { impact: undefined });
    expect(before).toEqual({ impact: "x" });
  });
});

// ── maybeCompressStageOnTransition ───────────────────────────────────────────

// We mock buildModel via vi.mock so summariseStageTurns doesn't try a real
// LLM call. The mock returns a model whose `invoke` produces a fixed
// summary string.
vi.mock("../models/factory.js", () => ({
  buildModel: () => ({
    invoke: async () => ({ content: "MOCK_SUMMARY" }),
  }),
}));

describe("maybeCompressStageOnTransition", () => {
  const fakeModel = { provider: "anthropic", model: "x", credentials: {} as never } as never;

  it("returns undefined when there is no priorStage", async () => {
    expect(
      await maybeCompressStageOnTransition({
        model: fakeModel,
        priorStage: undefined,
        incomingStage: "impact",
        thread: [],
        existingSummaries: {},
      }),
    ).toBeUndefined();
  });

  it("returns undefined when there is no incomingStage", async () => {
    expect(
      await maybeCompressStageOnTransition({
        model: fakeModel,
        priorStage: "impact",
        incomingStage: undefined,
        thread: [],
        existingSummaries: {},
      }),
    ).toBeUndefined();
  });

  it("returns undefined when prior === incoming (same stage)", async () => {
    expect(
      await maybeCompressStageOnTransition({
        model: fakeModel,
        priorStage: "impact",
        incomingStage: "impact",
        thread: [{ kind: "user", content: "x", ts: 1, stage: "impact" }],
        existingSummaries: {},
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the prior stage already has a summary", async () => {
    expect(
      await maybeCompressStageOnTransition({
        model: fakeModel,
        priorStage: "impact",
        incomingStage: "implementation",
        thread: [{ kind: "user", content: "x", ts: 1, stage: "impact" }],
        existingSummaries: { impact: "already done" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no thread entries match the prior stage", async () => {
    expect(
      await maybeCompressStageOnTransition({
        model: fakeModel,
        priorStage: "impact",
        incomingStage: "implementation",
        thread: [{ kind: "user", content: "x", ts: 1, stage: "implementation" }],
        existingSummaries: {},
      }),
    ).toBeUndefined();
  });

  it("writes a summary keyed by priorStage on a real transition", async () => {
    const result = await maybeCompressStageOnTransition({
      model: fakeModel,
      priorStage: "impact",
      incomingStage: "implementation",
      thread: [
        { kind: "user", content: "concerned about backward compat", ts: 1, stage: "impact" },
        { kind: "assistant", content: "noted", ts: 2, stage: "impact" },
      ],
      existingSummaries: {},
    });
    expect(result).toBeDefined();
    expect(result?.stageSummaries).toEqual({ impact: "MOCK_SUMMARY" });
  });
});
