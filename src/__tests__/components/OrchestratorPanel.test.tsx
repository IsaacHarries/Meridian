import {
    groupOrchestratorThreadByStage,
    OrchestratorEntry,
    ProposalCard,
    proposalCardTitle,
    renderPlanEditOp,
} from "@/components/OrchestratorPanel";
import { type OrchestratorMessage, type OrchestratorPendingProposal, type PlanEditOp } from "@/lib/tauri/orchestrator";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// MarkdownBlock pulls in remark-gfm + markdown plugins which are heavy;
// stub it for these tests so we can assert text without parsing markdown.
vi.mock("@/components/MarkdownBlock", () => ({
  MarkdownBlock: ({ text }: { text: string }) => (
    <div data-testid="markdown">{text}</div>
  ),
}));

// ── proposalCardTitle ────────────────────────────────────────────────────────

describe("proposalCardTitle", () => {
  it("formats proceed by action", () => {
    expect(
      proposalCardTitle({
        kind: "proceed",
        rationale: "x",
        action: "approve",
      }),
    ).toBe("Proposed: approve");
  });

  it("formats rewind with the target stage", () => {
    expect(
      proposalCardTitle({ kind: "rewind", rationale: "x", toStage: "grooming" }),
    ).toBe("Proposed: rewind to grooming");
  });

  it("formats reply with a fixed phrase", () => {
    expect(
      proposalCardTitle({ kind: "reply", rationale: "x", message: "hi" }),
    ).toBe("Proposed: send triage reply");
  });

  it("formats edit_plan with a count and singular/plural", () => {
    expect(
      proposalCardTitle({
        kind: "edit_plan",
        rationale: "x",
        edits: [{ op: "set_summary", summary: "y" }],
      }),
    ).toBe("Proposed: 1 plan edit");
    expect(
      proposalCardTitle({
        kind: "edit_plan",
        rationale: "x",
        edits: [
          { op: "set_summary", summary: "y" },
          { op: "remove_file", path: "a.ts" },
        ],
      }),
    ).toBe("Proposed: 2 plan edits");
  });

  it("formats accept_grooming_edit by status", () => {
    expect(
      proposalCardTitle({
        kind: "accept_grooming_edit",
        rationale: "x",
        editId: "e1",
        newStatus: "approved",
      }),
    ).toBe("Proposed: approved grooming edit");
  });
});

// ── renderPlanEditOp ─────────────────────────────────────────────────────────

describe("renderPlanEditOp", () => {
  it("formats add_file with action, path, description", () => {
    expect(
      renderPlanEditOp({
        op: "add_file",
        file: { path: "src/x.ts", action: "create", description: "new" },
      }),
    ).toBe("+ add create src/x.ts — new");
  });

  it("formats remove_file with a minus and path", () => {
    expect(renderPlanEditOp({ op: "remove_file", path: "src/x.ts" })).toBe(
      "− remove src/x.ts",
    );
  });

  it("formats update_file with key=value pairs", () => {
    expect(
      renderPlanEditOp({
        op: "update_file",
        path: "x.ts",
        fields: { action: "delete", description: "drop it" },
      }),
    ).toBe("~ update x.ts (action=delete, description=drop it)");
  });

  it("formats set_summary in quotes", () => {
    expect(renderPlanEditOp({ op: "set_summary", summary: "short" })).toBe(
      'summary ← "short"',
    );
  });

  it("truncates long set_summary at 60 chars", () => {
    const long = "x".repeat(100);
    const out = renderPlanEditOp({ op: "set_summary", summary: long });
    expect(out).toMatch(/^summary ← "x{60}…"$/);
  });

  it("formats add_assumption and add_open_question with prefixes", () => {
    expect(renderPlanEditOp({ op: "add_assumption", text: "one" })).toBe(
      "+ assumption: one",
    );
    expect(renderPlanEditOp({ op: "add_open_question", text: "two" })).toBe(
      "+ open question: two",
    );
  });
});

// ── groupOrchestratorThreadByStage ───────────────────────────────────────────

describe("groupOrchestratorThreadByStage", () => {
  it("returns an empty array for an empty thread", () => {
    expect(groupOrchestratorThreadByStage([])).toEqual([]);
  });

  it("groups consecutive entries with the same stage tag", () => {
    const thread: OrchestratorMessage[] = [
      { kind: "user", content: "1", ts: 1, stage: "impact" },
      { kind: "assistant", content: "2", ts: 2, stage: "impact" },
      { kind: "user", content: "3", ts: 3, stage: "implementation" },
    ];
    const result = groupOrchestratorThreadByStage(thread);
    expect(result).toHaveLength(2);
    expect(result[0].stage).toBe("impact");
    expect(result[0].entries).toHaveLength(2);
    expect(result[1].stage).toBe("implementation");
    expect(result[1].entries).toHaveLength(1);
  });

  it("opens a new group when the stage changes back (no merging across)", () => {
    const thread: OrchestratorMessage[] = [
      { kind: "user", content: "1", ts: 1, stage: "impact" },
      { kind: "user", content: "2", ts: 2, stage: "implementation" },
      { kind: "user", content: "3", ts: 3, stage: "impact" },
    ];
    const result = groupOrchestratorThreadByStage(thread);
    expect(result).toHaveLength(3);
    expect(result.map((g) => g.stage)).toEqual([
      "impact",
      "implementation",
      "impact",
    ]);
  });

  it("preserves entries with undefined stage tag in their own group", () => {
    const thread: OrchestratorMessage[] = [
      { kind: "user", content: "1", ts: 1 },
      { kind: "assistant", content: "2", ts: 2 },
      { kind: "user", content: "3", ts: 3, stage: "impact" },
    ];
    const result = groupOrchestratorThreadByStage(thread);
    expect(result).toHaveLength(2);
    expect(result[0].stage).toBeUndefined();
    expect(result[0].entries).toHaveLength(2);
    expect(result[1].stage).toBe("impact");
  });

  it("does not mutate the input thread", () => {
    const thread: OrchestratorMessage[] = [
      { kind: "user", content: "1", ts: 1, stage: "impact" },
    ];
    const before = JSON.stringify(thread);
    groupOrchestratorThreadByStage(thread);
    expect(JSON.stringify(thread)).toBe(before);
  });
});

// ── OrchestratorEntry ────────────────────────────────────────────────────────

describe("OrchestratorEntry", () => {
  it("renders user content as a right-aligned bubble", () => {
    const { container } = render(
      <OrchestratorEntry
        entry={{ kind: "user", content: "hello", ts: 1 }}
      />,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(container.querySelector(".justify-end")).toBeInTheDocument();
  });

  it("renders assistant content via MarkdownBlock", () => {
    render(
      <OrchestratorEntry
        entry={{ kind: "assistant", content: "**bold** reply", ts: 1 }}
      />,
    );
    const md = screen.getByTestId("markdown");
    expect(md.textContent).toBe("**bold** reply");
  });

  it("renders tool_call with name and short args", () => {
    render(
      <OrchestratorEntry
        entry={{
          kind: "tool_call",
          name: "read_repo_file",
          args: { path: "src/x.ts" },
          ts: 1,
        }}
      />,
    );
    expect(screen.getByTestId("orchestrator-tool-call")).toBeInTheDocument();
    expect(screen.getByText("read_repo_file")).toBeInTheDocument();
    expect(screen.getByText(/path.*src\/x\.ts/)).toBeInTheDocument();
  });

  it("truncates long tool_call args with an ellipsis", () => {
    const longArgs = { data: "x".repeat(200) };
    render(
      <OrchestratorEntry
        entry={{ kind: "tool_call", name: "x", args: longArgs, ts: 1 }}
      />,
    );
    const node = screen.getByTestId("orchestrator-tool-call");
    expect(node.textContent).toMatch(/…\)$/);
  });

  it("shows an error indicator on tool_call errors", () => {
    render(
      <OrchestratorEntry
        entry={{
          kind: "tool_call",
          name: "read_repo_file",
          args: {},
          error: "EACCES: permission denied",
          ts: 1,
        }}
      />,
    );
    expect(screen.getByText(/⚠ EACCES/)).toBeInTheDocument();
  });

  it("renders system_note as a centred italic divider", () => {
    render(
      <OrchestratorEntry
        entry={{ kind: "system_note", content: "Moved to Impact Analysis", ts: 1 }}
      />,
    );
    const note = screen.getByTestId("orchestrator-system-note");
    expect(note).toBeInTheDocument();
    expect(note.textContent).toContain("Moved to Impact Analysis");
  });
});

// ── ProposalCard ─────────────────────────────────────────────────────────────

function renderCard(
  proposal: OrchestratorPendingProposal,
  opts: { disabled?: boolean } = {},
) {
  const onAccept = vi.fn();
  const onReject = vi.fn();
  const utils = render(
    <ProposalCard
      proposal={proposal}
      onAccept={onAccept}
      onReject={onReject}
      disabled={opts.disabled ?? false}
    />,
  );
  return { onAccept, onReject, ...utils };
}

describe("ProposalCard", () => {
  it("renders the title and rationale for proceed", () => {
    renderCard({ kind: "proceed", rationale: "looks good", action: "approve" });
    expect(screen.getByText("Proposed: approve")).toBeInTheDocument();
    expect(screen.getByText("looks good")).toBeInTheDocument();
  });

  it("shows a quoted preview for reply proposals", () => {
    renderCard({
      kind: "reply",
      rationale: "needed clarification",
      message: "Please confirm the approach.",
    });
    const preview = screen.getByTestId("proposal-reply-message");
    expect(preview.textContent).toBe("Please confirm the approach.");
  });

  it("renders one list item per edit_plan op, in order", () => {
    const edits: PlanEditOp[] = [
      { op: "set_summary", summary: "tighten" },
      { op: "remove_file", path: "src/old.ts" },
      {
        op: "add_file",
        file: { path: "src/new.ts", action: "create", description: "new" },
      },
    ];
    renderCard({ kind: "edit_plan", rationale: "x", edits });
    const items = screen
      .getByTestId("proposal-edit-list")
      .querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toMatch(/summary ← "tighten"/);
    expect(items[1].textContent).toMatch(/remove src\/old\.ts/);
    expect(items[2].textContent).toMatch(/add create src\/new\.ts/);
  });

  it("shows the editId and newStatus for grooming-edit proposals", () => {
    renderCard({
      kind: "accept_grooming_edit",
      rationale: "x",
      editId: "edit-42",
      newStatus: "declined",
    });
    expect(screen.getByText("edit-42")).toBeInTheDocument();
    expect(screen.getByText("declined")).toBeInTheDocument();
  });

  it("Accept and Reject are enabled by default", () => {
    renderCard({ kind: "proceed", rationale: "x", action: "approve" });
    expect(screen.getByRole("button", { name: /Accept/ })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /Reject/ })).not.toBeDisabled();
  });

  it("Accept and Reject are disabled when disabled=true", () => {
    renderCard(
      { kind: "proceed", rationale: "x", action: "approve" },
      { disabled: true },
    );
    expect(screen.getByRole("button", { name: /Accept/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeDisabled();
  });

  it("clicking Accept fires onAccept exactly once", () => {
    const { onAccept, onReject } = renderCard({
      kind: "proceed",
      rationale: "x",
      action: "approve",
    });
    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("clicking Reject fires onReject exactly once", () => {
    const { onAccept, onReject } = renderCard({
      kind: "rewind",
      rationale: "x",
      toStage: "grooming",
    });
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });
});
