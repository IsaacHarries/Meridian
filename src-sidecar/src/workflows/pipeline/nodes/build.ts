// Verification node — runs after the per-file implementation pass and gives
// the agent shell access (exec_in_worktree) so it can typecheck, run tests,
// build, and fix any failures before the implementation checkpoint surfaces
// to the user. Replaces the older build_check / build_fix sub-loop, which
// was gated behind a Settings toggle and a hardcoded build command; this
// runs every time and lets the agent infer commands from project files.

import { z } from "zod";
import { buildModel } from "../../../models/factory.js";
import { VERIFICATION_SYSTEM } from "../../pipeline-prompts.js";
import {
  appendSkill,
  extractText,
  parseStructuredResponse,
} from "../helpers.js";
import { runToolLoop } from "../tool-loop.js";
import type { PipelineGraphContext, PipelineState } from "../state.js";
import type { VerificationOutput } from "../../pipeline-schemas.js";

/** Cap on plan revisions before the user has to step in via the implementation
 *  checkpoint. Distinct from the verification tool-loop iteration cap below —
 *  this only governs how many times we'll loop the planner on per-file
 *  post-write verification failures (files missing/empty/etc on disk after
 *  the implementation iteration). */
export const PLAN_REVISION_MAX = 2;

/** Hard cap on how many tool-loop iterations the verification agent gets.
 *  Higher than the default because each verification cycle takes multiple
 *  exec/read/write calls (run typecheck → see error → read file → fix →
 *  re-run typecheck → run tests → …). 30 is generous but bounded — the
 *  agent will surface unresolved failures rather than spin forever. */
export const VERIFICATION_MAX_ITERATIONS = 30;

const VerificationStepSchema = z.object({
  command: z.string(),
  passed: z.boolean(),
  notes: z.string().optional().default(""),
});

const VerificationResponseSchema = z.object({
  summary: z.string().optional().default(""),
  steps: z.array(VerificationStepSchema).optional().default([]),
  files_written: z.array(z.string()).optional().default([]),
  unresolved: z.array(z.string()).optional().default([]),
});

export function makeVerificationNode(ctx: PipelineGraphContext) {
  const { tools, workflowId, emit } = ctx;
  return async function verificationNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const system = appendSkill(
      VERIFICATION_SYSTEM,
      state.input.skills?.implementation,
      "IMPLEMENTATION CONVENTIONS",
    );

    const filesChanged = state.implementationOutput?.files_changed ?? [];
    const userPrompt =
      `The implementation agent has finished writing the planned files. Verify the change works end-to-end (typecheck → tests → build), fix any failures, and report the result.\n\n` +
      `=== FILES CHANGED IN THIS RUN ===\n${
        filesChanged.length > 0
          ? filesChanged
              .map((f) => `- ${f.action} ${f.path}: ${f.summary}`)
              .join("\n")
          : "(no files reported by implementation — get_repo_diff to see what's actually on disk)"
      }\n\n` +
      `=== PLAN SUMMARY ===\n${state.plan?.summary ?? "(no plan summary)"}\n\n` +
      `Begin by inspecting the project's manifests to find the right typecheck/test/build commands. Then verify in order, fixing as you go. Return the JSON summary when done.`;

    const result = await runToolLoop(
      buildModel(state.model),
      tools,
      system,
      userPrompt,
      { emit, workflowId, nodeName: "verification" },
      VERIFICATION_MAX_ITERATIONS,
    );

    const raw = extractText(result.finalMessage.content) || result.finalMessage.text;
    let parsed: VerificationOutput;
    try {
      const json = parseStructuredResponse(raw);
      const r = VerificationResponseSchema.parse(json);
      parsed = {
        summary: r.summary,
        steps: r.steps,
        files_written: Array.from(
          new Set([...r.files_written, ...result.writtenPaths]),
        ),
        unresolved: r.unresolved,
        clean: r.unresolved.length === 0 && r.steps.every((s) => s.passed),
      };
    } catch {
      // Fall back to whatever signal we got from the tool loop. If files were
      // written but the model couldn't produce clean JSON, treat it as
      // unresolved so the user reviews it.
      parsed = {
        summary:
          "Verification ran but the model did not return a clean structured summary.",
        steps: [],
        files_written: result.writtenPaths,
        unresolved: [
          "Verification agent did not produce a parseable summary — review the diff manually before merging.",
        ],
        clean: false,
      };
    }

    return { verificationOutput: parsed, usage: result.usage };
  };
}

/** Conditional edge after `implementation`. Two branches:
 *  - per-file post-write verification flagged unrecoverable failures (file
 *    missing, empty, unchanged, etc) AND we still have plan-revision budget
 *    → `replan_check`
 *  - otherwise → `verification` (always; no toggle, no opt-out)
 *
 *  The replan branch is gated by `PLAN_REVISION_MAX` so we can't ping-pong
 *  forever; once the cap is hit, we fall through to verification anyway and
 *  let the user decide at the implementation checkpoint. */
export function routeAfterImplementation(
  state: PipelineState,
): "verification" | "replan_check" {
  const hasVerificationFailures = (state.verificationFailures ?? []).length > 0;
  const canReplan = state.planRevisions < PLAN_REVISION_MAX;
  if (hasVerificationFailures && canReplan) return "replan_check";
  return "verification";
}
