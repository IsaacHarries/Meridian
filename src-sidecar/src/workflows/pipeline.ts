// Implementation pipeline workflow — 8-stage LangGraph with `interrupt()`
// after each agent node so the user can approve, request changes, or abort
// before the next stage runs.
//
// Tool-loop nodes (Implementation, TestGen) and the diff-aware Code Review
// node depend on a per-run `RepoTools` set passed into `buildPipelineGraph`.
// The runner constructs tools (capturing the workflow id + emit closure for
// the IPC callback bridge) and threads them through.
//
// Stage flow:
//   START → grooming → checkpoint → impact → checkpoint →
//     triage → triage_checkpoint → (loop / plan →
//     implementation → checkpoint → test_gen → checkpoint →
//     code_review → checkpoint → pr_description → checkpoint →
//     retrospective → END)
//
// Approve at every checkpoint to advance. Triage's checkpoint accepts a
// `reply` action that loops back to triage with the engineer's message
// appended.
//
// This file owns `buildPipelineGraph`. Schemas, helpers, node factories, and
// tool-loop machinery live in `./pipeline/`. Consumers should import each
// non-builder symbol straight from its defining submodule — no convenience
// re-exports.

import { END, START, StateGraph } from "@langchain/langgraph";
import { getCheckpointer } from "../checkpointer.js";

import { type PipelineGraphContext, PipelineStateAnnotation } from "./pipeline/state.js";
import { makeGroomingNode } from "./pipeline/nodes/grooming.js";
import { makeImpactNode } from "./pipeline/nodes/impact.js";
import { makeTriageNode } from "./pipeline/nodes/triage.js";
import { makePlanNode } from "./pipeline/nodes/plan.js";
import { makeImplementationNode } from "./pipeline/nodes/implementation.js";
import {
  makeBuildCheckNode,
  makeBuildFixNode,
  routeAfterBuildCheck,
  routeAfterImplementation,
} from "./pipeline/nodes/build.js";
import { makeTestPlanNode } from "./pipeline/nodes/test-plan.js";
import { makeTestGenNode } from "./pipeline/nodes/test-gen.js";
import { makeCodeReviewNode } from "./pipeline/nodes/review.js";
import { makePrDescriptionNode } from "./pipeline/nodes/pr.js";
import { makeRetrospectiveNode } from "./pipeline/nodes/retro.js";
import {
  checkpointNode,
  replanCheckpointNode,
  triageCheckpointNode,
} from "./pipeline/nodes/checkpoints.js";

// ── Graph builder ─────────────────────────────────────────────────────────────

export function buildPipelineGraph(ctx: PipelineGraphContext) {
  const { tools } = ctx;
  return new StateGraph(PipelineStateAnnotation)
    .addNode("grooming", makeGroomingNode(ctx))
    .addNode("impact", makeImpactNode(ctx))
    .addNode("triage", makeTriageNode(ctx))
    // Node names use a `do_` prefix for plan/retrospective because
    // LangGraph forbids node names that collide with state-channel names —
    // and we already have `plan` and `retrospective` as state fields
    // holding each agent's output.
    .addNode("do_plan", makePlanNode(ctx))
    .addNode("implementation", makeImplementationNode(ctx))
    // Phase 3c — optional build verification sub-loop. Skipped entirely when
    // the user hasn't enabled it in Settings.
    .addNode("build_check", makeBuildCheckNode(ctx))
    .addNode("build_fix", makeBuildFixNode(ctx))
    .addNode("test_plan", makeTestPlanNode(tools))
    .addNode("test_gen", makeTestGenNode(tools))
    .addNode("code_review", makeCodeReviewNode(ctx))
    .addNode("pr_description", makePrDescriptionNode(ctx))
    .addNode("do_retrospective", makeRetrospectiveNode(ctx))
    .addNode("checkpoint_grooming", checkpointNode("grooming", (s) => s.groomingOutput))
    .addNode("checkpoint_impact", checkpointNode("impact", (s) => s.impactOutput))
    .addNode("checkpoint_triage", triageCheckpointNode, {
      ends: ["triage", "do_plan"],
    })
    .addNode(
      "checkpoint_implementation",
      checkpointNode("implementation", (s) => s.implementationOutput),
    )
    // Plan-revision checkpoint: surfaced after verification or build failures
    // exhaust their in-stage budgets. Lets the user choose to revise the plan
    // (loops back to do_plan) or accept the partial work.
    .addNode("replan_check", replanCheckpointNode, {
      ends: ["do_plan", "checkpoint_implementation"],
    })
    .addNode("checkpoint_test_plan", checkpointNode("test_plan", (s) => s.testPlan))
    .addNode("checkpoint_test_gen", checkpointNode("test_gen", (s) => s.testOutput))
    .addNode(
      "checkpoint_code_review",
      checkpointNode("code_review", (s) => s.reviewOutput),
    )
    .addNode(
      "checkpoint_pr_description",
      checkpointNode("pr_description", (s) => s.prDescription),
    )
    .addEdge(START, "grooming")
    .addEdge("grooming", "checkpoint_grooming")
    .addEdge("checkpoint_grooming", "impact")
    .addEdge("impact", "checkpoint_impact")
    .addEdge("checkpoint_impact", "triage")
    .addEdge("triage", "checkpoint_triage")
    // Plan → implementation directly. The intermediate Guidance node was
    // dropped after profiling: it produced a 9–10K-token per-file walk-
    // through that the per-file Implementation tool loop then re-derived
    // anyway, doubling output cost AND inflating every Implementation
    // iteration's input. The Plan's structured `files` list + per-file
    // `read_repo_file` is enough context for Implementation to act.
    .addEdge("do_plan", "implementation")
    // implementation → (replan_check on verification failures, build_check
    //                   when build verification is enabled, else checkpoint).
    // build_check     → (build_fix while we have fix budget,
    //                   replan_check once that budget is exhausted and we
    //                   still have plan-revision budget,
    //                   else checkpoint_implementation).
    .addConditionalEdges("implementation", routeAfterImplementation, [
      "build_check",
      "replan_check",
      "checkpoint_implementation",
    ])
    .addConditionalEdges("build_check", routeAfterBuildCheck, [
      "build_fix",
      "checkpoint_implementation",
    ])
    .addEdge("build_fix", "build_check")
    .addEdge("checkpoint_implementation", "test_plan")
    .addEdge("test_plan", "checkpoint_test_plan")
    .addEdge("checkpoint_test_plan", "test_gen")
    .addEdge("test_gen", "checkpoint_test_gen")
    .addEdge("checkpoint_test_gen", "code_review")
    .addEdge("code_review", "checkpoint_code_review")
    .addEdge("checkpoint_code_review", "pr_description")
    .addEdge("pr_description", "checkpoint_pr_description")
    .addEdge("checkpoint_pr_description", "do_retrospective")
    .addEdge("do_retrospective", END)
    .compile({ checkpointer: getCheckpointer() });
}
