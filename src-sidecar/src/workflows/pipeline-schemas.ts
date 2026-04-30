// Zod schemas for the implementation pipeline.
//
// These mirror the TypeScript interfaces in src/lib/tauri.ts so the sidecar
// validates each agent's structured output before handing off to the next.
// Each stage's output is exported individually so 3b can refine them as the
// agents are ported one at a time.

import { z } from "zod";

// ── Grooming (Phase 1 — already shipped) ─────────────────────────────────────
// Re-exported from grooming.ts to keep the pipeline schema self-contained.
export {
  GroomingOutputSchema,
  type GroomingOutput,
  SuggestedEditSchema,
} from "./grooming.js";

// ── Impact analysis ───────────────────────────────────────────────────────────

export const ImpactOutputSchema = z.object({
  risk_level: z.enum(["low", "medium", "high"]),
  risk_justification: z.string(),
  affected_areas: z.array(z.string()),
  potential_regressions: z.array(z.string()),
  cross_cutting_concerns: z.array(z.string()),
  files_needing_consistent_updates: z.array(z.string()),
  recommendations: z.string(),
});

export type ImpactOutput = z.infer<typeof ImpactOutputSchema>;

// ── Triage (iterative planning conversation) ─────────────────────────────────

export const TriageMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const TriageTurnOutputSchema = z.object({
  message: z.string(),
  proposal: z.string(),
  questions: z.array(z.string()),
});

export type TriageTurnOutput = z.infer<typeof TriageTurnOutputSchema>;

// ── Implementation plan (finalised triage output) ────────────────────────────

export const PlanFileSchema = z.object({
  path: z.string(),
  action: z.enum(["create", "modify", "delete"]),
  description: z.string(),
});

export const ImplementationPlanSchema = z.object({
  summary: z.string(),
  files: z.array(PlanFileSchema),
  order_of_operations: z.array(z.string()),
  edge_cases: z.array(z.string()),
  do_not_change: z.array(z.string()),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
});

export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;

// ── Implementation guidance (pre-implementation step-by-step plan) ───────────

export const GuidanceStepSchema = z.object({
  step: z.number(),
  title: z.string(),
  file: z.string(),
  action: z.string(),
  details: z.string(),
  code_hints: z.string(),
});

export const GuidanceOutputSchema = z.object({
  steps: z.array(GuidanceStepSchema),
  patterns_to_follow: z.array(z.string()),
  common_pitfalls: z.array(z.string()),
  definition_of_done: z.array(z.string()),
});

export type GuidanceOutput = z.infer<typeof GuidanceOutputSchema>;

// ── Implementation output (what the implementation agent actually wrote) ─────

export const ImplementationFileResultSchema = z.object({
  path: z.string(),
  action: z.enum(["created", "modified", "deleted"]),
  summary: z.string(),
});

export type ImplementationFileResult = z.infer<typeof ImplementationFileResultSchema>;

export const ImplementationOutputSchema = z.object({
  summary: z.string(),
  files_changed: z.array(ImplementationFileResultSchema),
  deviations: z.array(z.string()),
  skipped: z.array(z.string()),
});

export type ImplementationOutput = z.infer<typeof ImplementationOutputSchema>;

// ── Test plan (proposal stage — runs before tests are written) ───────────────

export const TestPlanFileSchema = z.object({
  path: z.string(),
  framework: z.string().optional(),
  description: z.string(),
  cases: z.array(z.string()),
});

export const TestPlanSchema = z.object({
  summary: z.string(),
  files: z.array(TestPlanFileSchema),
  edge_cases_covered: z.array(z.string()).optional().default([]),
  coverage_notes: z.string().optional().default(""),
});

export type TestPlan = z.infer<typeof TestPlanSchema>;

// ── Test generation (writes the approved plan) ───────────────────────────────

export const TestFileWrittenSchema = z.object({
  path: z.string(),
  description: z.string(),
});

export const TestOutputSchema = z.object({
  summary: z.string(),
  files_written: z.array(TestFileWrittenSchema),
  edge_cases_covered: z.array(z.string()),
  coverage_notes: z.string(),
});

export type TestOutput = z.infer<typeof TestOutputSchema>;

// ── Code review (in-pipeline review of the implementation) ───────────────────

export const PlanReviewFindingSchema = z.object({
  severity: z.enum(["blocking", "non_blocking", "suggestion"]),
  area: z.string(),
  feedback: z.string(),
});

export const PlanReviewOutputSchema = z.object({
  confidence: z.enum(["ready", "needs_attention", "requires_rework"]),
  summary: z.string(),
  findings: z.array(PlanReviewFindingSchema),
  things_to_address: z.array(z.string()),
  things_to_watch: z.array(z.string()),
});

export type PlanReviewOutput = z.infer<typeof PlanReviewOutputSchema>;

// ── PR description ────────────────────────────────────────────────────────────

export const PrDescriptionOutputSchema = z.object({
  title: z.string(),
  description: z.string(),
});

export type PrDescriptionOutput = z.infer<typeof PrDescriptionOutputSchema>;

// ── Retrospective ─────────────────────────────────────────────────────────────

const SkillTypeSchema = z.enum([
  "grooming",
  "implementation",
  "review",
  "testing",
  "documentation",
  "general",
]);

export const RetroSkillSuggestionSchema = z.object({
  skill: SkillTypeSchema,
  suggestion: z.string(),
});

export const RetrospectiveOutputSchema = z.object({
  what_went_well: z.array(z.string()),
  what_could_improve: z.array(z.string()),
  patterns_identified: z.array(z.string()),
  agent_skill_suggestions: z.array(RetroSkillSuggestionSchema),
  summary: z.string(),
});

export type RetrospectiveOutput = z.infer<typeof RetrospectiveOutputSchema>;

// ── Build status (used for the Implementation/TestGen retry loop) ────────────

export const BuildStatusSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});

export type BuildStatus = z.infer<typeof BuildStatusSchema>;

// ── Build-check sub-loop (Phase 3c) ──────────────────────────────────────────

export const BuildAttemptSchema = z.object({
  attempt: z.number().int(),
  exit_code: z.number().int(),
  output: z.string(),
  /** True when this attempt was a fix iteration (i.e. came after a failure). */
  fixed: z.boolean(),
  /** Files written by the fix agent during this attempt. Empty for the first
   *  attempt and for any pure build-only attempt that didn't run a fix. */
  files_written: z.array(z.string()),
});

export const BuildCheckResultSchema = z.object({
  build_command: z.string(),
  build_passed: z.boolean(),
  attempts: z.array(BuildAttemptSchema),
});

export type BuildAttempt = z.infer<typeof BuildAttemptSchema>;
export type BuildCheckResult = z.infer<typeof BuildCheckResultSchema>;

// ── Per-file verification (post-write check) ─────────────────────────────────
//
// After the implementation agent finishes a per-file iteration, the node
// stat()s the file on disk and compares the post-state to the action it was
// supposed to perform. This is the source of truth for "did the agent
// actually do the thing it claimed to do" — `writtenPaths` from the tool loop
// is not enough because the model can lie / fail mid-tool-call without the
// loop noticing.
export const FileVerificationOutcomeSchema = z.enum([
  "ok",
  "missing",
  "empty",
  "unchanged",
  "still_present",
  "read_error",
]);

export const FileVerificationSchema = z.object({
  path: z.string(),
  expected_action: z.enum(["create", "modify", "delete"]),
  outcome: FileVerificationOutcomeSchema,
  detail: z.string().optional(),
});

export type FileVerification = z.infer<typeof FileVerificationSchema>;

// ── Plan revision context (build/verify failure → do_plan loop) ──────────────
//
// Populated by the `replan_check` checkpoint when the user opts to revise
// the plan after verification or build failures. `planNode` reads this on its
// next run and prepends a "REVISE" preamble to its prompt; it then clears
// this field in its return so a fresh plan run starts clean.
export const PlanRevisionReasonSchema = z.enum([
  "verification_failed",
  "build_failed",
  "user_requested",
]);

export const PlanRevisionContextSchema = z.object({
  prior_plan: ImplementationPlanSchema,
  verification_failures: z.array(FileVerificationSchema).default([]),
  build_attempts: z.array(BuildAttemptSchema).default([]),
  reason: PlanRevisionReasonSchema,
});

export type PlanRevisionContext = z.infer<typeof PlanRevisionContextSchema>;

// ── Pipeline stage names ──────────────────────────────────────────────────────

export const PIPELINE_STAGES = [
  "grooming",
  "impact",
  "triage",
  "implementation",
  "replan",
  "test_plan",
  "test_gen",
  "code_review",
  "pr_description",
  "retrospective",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
