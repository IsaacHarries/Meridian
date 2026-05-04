// Build verification sub-loop (Phase 3c) and the routing edges that decide
// when to enter the sub-loop, when to fix, and when to bail back to the
// implementation checkpoint.

import { buildModel } from "../../../models/factory.js";
import { execInWorktree } from "../../../tools/repo-tools.js";
import type {
  BuildAttempt,
  BuildCheckResult,
} from "../../pipeline-schemas.js";
import { BUILD_FIX_SYSTEM } from "../../pipeline-prompts.js";
import { BuildFixResponseSchema } from "../schemas.js";
import {
  BUILD_OUTPUT_TAIL_CHARS,
  extractText,
  parseStructuredResponse,
  tailBuildOutput,
} from "../helpers.js";
import { runToolLoop } from "../tool-loop.js";
import type { PipelineGraphContext, PipelineState } from "../state.js";

/** Default cap on build+fix attempts before the pipeline gives up.
 *  Overridable per-run via `state.input.buildCheckMaxAttempts` — kept
 *  exported for back-compat with any external import. */
export const BUILD_CHECK_MAX_ATTEMPTS = 3;

// Re-exported for back-compat: callers used to import the truncation cap from
// pipeline.ts directly. The constant lives in helpers.ts now (where the
// `tailBuildOutput` helper that consumes it lives) and is re-exported here so
// the nodes/build.ts module remains the canonical place for build constants.
export { BUILD_OUTPUT_TAIL_CHARS };

export function makeBuildCheckNode(ctx: PipelineGraphContext) {
  const { workflowId, emit } = ctx;
  return async function buildCheckNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const command = state.input.buildCheckCommand?.trim() ?? "";
    if (!command) {
      // Defensive — the conditional edge should already have routed away.
      return {};
    }

    const priorAttempts = state.buildVerification?.attempts ?? [];
    const attemptNumber = priorAttempts.length + 1;

    let exitCode = 1;
    let output = "";
    try {
      const result = await execInWorktree({
        workflowId,
        emit,
        command,
        timeoutSecs: state.input.buildCheckTimeoutSecs ?? 300,
      });
      exitCode = result.exitCode;
      output = result.output;
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
    }

    const attempt: BuildAttempt = {
      attempt: attemptNumber,
      exit_code: exitCode,
      output,
      // The build_check node itself never writes files; the build_fix node
      // does and amends the previous attempt with its file list. So the
      // first attempt's `fixed` is false; subsequent verifications inherit
      // the fixed flag set by the preceding fix turn.
      fixed: false,
      files_written: [],
    };

    const next: BuildCheckResult = {
      build_command: command,
      build_passed: exitCode === 0,
      attempts: [...priorAttempts, attempt],
    };
    return { buildVerification: next };
  };
}

export function makeBuildFixNode(ctx: PipelineGraphContext) {
  const { tools } = ctx;
  return async function buildFixNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    if (!state.buildVerification || state.buildVerification.build_passed) {
      // Should not be reachable via the routing edges, but guard anyway.
      return {};
    }
    const lastAttempt =
      state.buildVerification.attempts[state.buildVerification.attempts.length - 1];

    const model = buildModel(state.model);
    const userPrompt =
      `Implementation plan:\n${JSON.stringify(state.plan, null, 2)}\n\n` +
      `What was implemented:\n${JSON.stringify(state.implementationOutput, null, 2)}\n\n` +
      `Build command: \`${state.buildVerification.build_command}\`\n\n` +
      `=== BUILD OUTPUT (attempt ${lastAttempt.attempt}, exit ${lastAttempt.exit_code}) ===\n` +
      `${tailBuildOutput(lastAttempt.output)}\n\n` +
      `Read the failing files, fix the errors, and write the corrections. Return the structured summary when done.`;

    const { finalMessage, usage, writtenPaths } = await runToolLoop(
      model,
      tools,
      BUILD_FIX_SYSTEM,
      userPrompt,
    );

    const raw = extractText(finalMessage.content) || finalMessage.text;
    let parsed: { summary: string; files_written: string[] };
    try {
      parsed = BuildFixResponseSchema.parse(parseStructuredResponse(raw));
    } catch {
      // Fallback when the model couldn't produce clean JSON: trust the tool
      // calls — if it wrote files, treat that as the fix.
      parsed = {
        summary:
          writtenPaths.length > 0
            ? `Fix applied; structured summary failed to parse — files: ${writtenPaths.join(", ")}.`
            : "Build fix attempted; no structured summary and no files written.",
        files_written: writtenPaths,
      };
    }

    // Record the fix on the most recent attempt and add it to the chain.
    const attempts = [...state.buildVerification.attempts];
    if (attempts.length > 0) {
      const last = attempts[attempts.length - 1];
      attempts[attempts.length - 1] = {
        ...last,
        fixed: true,
        files_written: [...new Set([...last.files_written, ...parsed.files_written, ...writtenPaths])],
      };
    }
    const next: BuildCheckResult = {
      build_command: state.buildVerification.build_command,
      build_passed: false,
      attempts,
    };
    return { buildVerification: next, usage };
  };
}

/** Cap on automatic plan revisions. After this many revisions, the routing
 *  edges stop redirecting back to `do_plan` and let the user decide via the
 *  normal implementation checkpoint. */
export const PLAN_REVISION_MAX = 2;

/** Conditional edge after `implementation`. Three branches:
 *  - per-file verification flagged unrecoverable failures → `replan_check`
 *  - build-verify enabled and command set → `build_check`
 *  - otherwise → `checkpoint_implementation`
 *  The replan branch is gated by `PLAN_REVISION_MAX` so we can't ping-pong
 *  forever; once the cap is hit, we fall through to the normal checkpoint
 *  and let the user decide. */
export function routeAfterImplementation(
  state: PipelineState,
): "build_check" | "replan_check" | "checkpoint_implementation" {
  const hasVerificationFailures = (state.verificationFailures ?? []).length > 0;
  const canReplan = state.planRevisions < PLAN_REVISION_MAX;
  if (hasVerificationFailures && canReplan) return "replan_check";
  const enabled = state.input.buildVerifyEnabled === true;
  const hasCommand = (state.input.buildCheckCommand ?? "").trim().length > 0;
  return enabled && hasCommand ? "build_check" : "checkpoint_implementation";
}

/** Conditional edge after `build_check`. Build passed → continue. Build
 *  failed and we still have fix-loop budget → `build_fix`. Build failed and
 *  the fix-loop is exhausted → surface the failure at the implementation
 *  checkpoint so the user can read the build output and decide what to do.
 *
 *  We deliberately do NOT replan from a build failure: re-running the whole
 *  Plan + Implementation pipeline because `tsc` flagged a type error or
 *  `pnpm test` failed an assertion is wildly out of proportion — it discards
 *  every file the implementation just wrote, replans from scratch, then
 *  rewrites them all. The build_fix sub-loop already has the right scope
 *  (read failing files + write fixes), so we'd rather give it the budget
 *  the user configured and stop there. The user's manual Retry on the
 *  implementation checkpoint can still trigger a replan if they want one. */
export function routeAfterBuildCheck(
  state: PipelineState,
): "checkpoint_implementation" | "build_fix" {
  const v = state.buildVerification;
  if (!v) return "checkpoint_implementation";
  if (v.build_passed) return "checkpoint_implementation";
  const maxAttempts =
    state.input.buildCheckMaxAttempts ?? BUILD_CHECK_MAX_ATTEMPTS;
  if (v.attempts.length < maxAttempts) return "build_fix";
  return "checkpoint_implementation";
}
