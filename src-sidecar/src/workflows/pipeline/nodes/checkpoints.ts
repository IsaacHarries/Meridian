// Human-in-the-loop checkpoint nodes. Each one calls `interrupt(...)` so the
// runner surfaces the agent's structured output to the frontend, then resumes
// based on the user's decision (approve / abort / reply / revise).

import { Command, interrupt } from "@langchain/langgraph";
import type {
  PipelineStage,
  PlanRevisionContext,
} from "../../pipeline-schemas.js";
import { BUILD_CHECK_MAX_ATTEMPTS, PLAN_REVISION_MAX } from "./build.js";
import type { PipelineState } from "../state.js";

export type CheckpointResume =
  | { action: "approve" }
  | { action: "abort"; reason?: string }
  | { action: "reply"; message: string }
  // Only used by the `replan_check` node — the user opted to revise the plan
  // after verification or build failures rather than accept the partial work.
  | { action: "revise" };

export function checkpointNode(
  stage: PipelineStage,
  payloadSelector: (s: PipelineState) => unknown,
) {
  return async function (state: PipelineState): Promise<Partial<PipelineState>> {
    const decision = interrupt({
      stage,
      payload: payloadSelector(state),
    }) as CheckpointResume;
    if (decision.action === "abort") {
      throw new Error(`Pipeline aborted at ${stage}: ${decision.reason ?? "(no reason given)"}`);
    }
    if (decision.action === "reply") {
      throw new Error(
        `Stage ${stage} received a 'reply' resume; only the triage stage handles replies.`,
      );
    }
    return {};
  };
}

/** Checkpoint surfaced when implementation verification or build verification
 *  has exhausted its in-stage budget and the user must decide whether to
 *  revise the plan or accept the partial work. Resume actions:
 *   - `revise` → loop back to `do_plan` with `planRevisionContext` populated
 *   - `approve` → continue to `checkpoint_implementation` (accept as-is)
 *   - `abort` → throw
 *  Capped by `PLAN_REVISION_MAX`; the routing edges already gate entry. */
export async function replanCheckpointNode(state: PipelineState): Promise<Command> {
  const buildAttempts = state.buildVerification?.attempts ?? [];
  const maxAttempts =
    state.input.buildCheckMaxAttempts ?? BUILD_CHECK_MAX_ATTEMPTS;
  const buildExhausted =
    buildAttempts.length >= maxAttempts && !state.buildVerification?.build_passed;
  const verificationFailures = state.verificationFailures ?? [];
  const reason: PlanRevisionContext["reason"] = buildExhausted
    ? "build_failed"
    : verificationFailures.length > 0
      ? "verification_failed"
      : "user_requested";

  const previouslyWritten = (state.implementationOutput?.files_changed ?? []).map(
    (f) => f.path,
  );

  const decision = interrupt({
    stage: "replan" as PipelineStage,
    payload: {
      reason,
      verification_failures: verificationFailures,
      build_attempts: buildAttempts,
      prior_plan: state.plan,
      previously_written_files: previouslyWritten,
      revisions_used: state.planRevisions,
      revisions_remaining: Math.max(0, PLAN_REVISION_MAX - state.planRevisions),
    },
  }) as CheckpointResume;

  if (decision.action === "abort") {
    throw new Error(`Pipeline aborted at replan: ${decision.reason ?? "(no reason given)"}`);
  }
  if (decision.action === "reply") {
    throw new Error(`Stage replan received a 'reply' resume; only triage handles replies.`);
  }
  if (decision.action === "revise") {
    if (!state.plan) {
      throw new Error("Cannot revise: no prior plan in state.");
    }
    const ctx: PlanRevisionContext = {
      prior_plan: state.plan,
      verification_failures: verificationFailures,
      build_attempts: buildAttempts,
      reason,
    };
    return new Command({
      goto: "do_plan",
      update: { planRevisionContext: ctx },
    });
  }
  // approve → user accepts the partial implementation as-is
  return new Command({ goto: "checkpoint_implementation" });
}

export async function triageCheckpointNode(state: PipelineState): Promise<Command> {
  const decision = interrupt({
    stage: "triage" as PipelineStage,
    payload: state.triageLastTurn,
  }) as CheckpointResume;
  if (decision.action === "abort") {
    throw new Error(`Pipeline aborted at triage: ${decision.reason ?? "(no reason given)"}`);
  }
  if (decision.action === "reply") {
    return new Command({
      goto: "triage",
      update: {
        triageHistory: [{ role: "user" as const, content: decision.message }],
      },
    });
  }
  return new Command({
    goto: "do_plan",
    update: { currentStage: "implementation" as PipelineStage },
  });
}
