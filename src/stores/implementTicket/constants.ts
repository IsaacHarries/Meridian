/**
 * Constants and lookup tables for the Implement-a-Ticket store.
 *
 * Split out from the original `implementTicketStore.ts` so types,
 * helpers, and actions can share these without circular imports.
 */

import type { ImplementTicketState, Stage } from "./types";

/** Linear order of user-facing stages — used to mark all prior stages
 *  complete whenever a downstream interrupt fires (some stages like
 *  `plan` run silently inside the workflow without an interrupt). */
export const STAGE_ORDER: Stage[] = [
  "grooming",
  "impact",
  "triage",
  "plan",
  "implementation",
  "tests_plan",
  "tests",
  "review",
  "pr",
  "retro",
];

/** Map a sidecar pipeline node name to the user-facing Stage in this store. */
export const NODE_TO_STAGE: Record<string, Stage> = {
  grooming: "grooming",
  impact: "impact",
  triage: "triage",
  do_plan: "plan",
  do_guidance: "implementation",
  implementation: "implementation",
  replan: "replan",
  test_plan: "tests_plan",
  test_gen: "tests",
  code_review: "review",
  pr_description: "pr",
  do_retrospective: "retro",
};

/** Map a user-facing Stage to the next visible stage when the user clicks
 *  Proceed at that stage's checkpoint. Used to advance viewingStage
 *  optimistically — the moment Proceed is clicked the screen jumps to
 *  the next stage's panel and the partial-output stream starts filling
 *  it in, instead of leaving the user staring at the prior panel for
 *  the duration of the workflow round-trip. */
export const NEXT_STAGE_AFTER_PROCEED: Partial<Record<Stage, Exclude<Stage, "select">>> = {
  grooming: "impact",
  impact: "triage",
  // Triage on approve runs do_plan → do_guidance → implementation. Land
  // on `plan` so the plan-finalising panel shows the partial plan
  // streaming in before implementation kicks off.
  triage: "plan",
  // Plan stage isn't checkpointed independently — the proceed comes
  // from triage. Listed for completeness in case the flow ever changes.
  plan: "implementation",
  implementation: "tests_plan",
  tests_plan: "tests",
  tests: "review",
  review: "pr",
  pr: "retro",
  retro: "complete",
};

/** Map a user-facing Stage to the sidecar node we need to rewind to in
 *  order to re-run just that stage. */
export const STAGE_TO_REWIND_NODE: Partial<Record<Stage, string>> = {
  grooming: "grooming",
  impact: "impact",
  triage: "triage",
  plan: "do_plan",
  implementation: "implementation",
  tests_plan: "test_plan",
  tests: "test_gen",
  review: "code_review",
  pr: "pr_description",
  retro: "do_retrospective",
};

/** Per-node stream text field — populated as the agent streams its output
 *  so the user sees live progress instead of waiting for the interrupt. */
export const NODE_TO_STREAM_FIELD: Record<string, keyof ImplementTicketState> = {
  grooming: "groomingStreamText",
  impact: "impactStreamText",
  triage: "triageStreamText",
  do_plan: "planStreamText",
  do_guidance: "planStreamText",
  implementation: "implementationStreamText",
  test_plan: "testsStreamText",
  test_gen: "testsStreamText",
  code_review: "reviewStreamText",
  pr_description: "prStreamText",
  do_retrospective: "retroStreamText",
};

/** Per-node partial-output field — populated by `streamLLMJson` `progress`
 *  events with `data.partial`. The screen prefers the partial over the
 *  final output while the stage is still streaming so the structured
 *  panel renders incrementally instead of all at once on completion. */
export const NODE_TO_PARTIAL_FIELD: Record<string, keyof ImplementTicketState> = {
  grooming: "partialGrooming",
  impact: "partialImpact",
  triage: "partialTriageTurn",
  do_plan: "partialPlan",
  do_guidance: "partialGuidance",
  code_review: "partialReview",
  pr_description: "partialPrDescription",
  do_retrospective: "partialRetrospective",
};

// ── Persistence key ──────────────────────────────────────────────────────────
// v2: orchestrator landed; the old shape held `checkpointChats` and other
// fields the new code doesn't read. Bumping the key abandons the stale
// blob so we don't hydrate ghost state into the new schema.
export const IMPLEMENT_STORE_KEY = "meridian-implement-store-v2";
