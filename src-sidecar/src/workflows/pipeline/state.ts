// Pipeline state annotation, input/output types, and the graph context shape
// passed into every node factory.

import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import type { GroomingOutput } from "../grooming.js";
import type { ModelSelection, OutboundEvent } from "../../protocol.js";
import type { RepoTools } from "../../tools/repo-tools.js";
import type {
  BuildCheckResult,
  BuildStatus,
  FileVerification,
  ImpactOutput,
  ImplementationOutput,
  ImplementationPlan,
  PipelineStage,
  PlanRevisionContext,
  PlanReviewOutput,
  PrDescriptionOutput,
  RetrospectiveOutput,
  TestOutput,
  TestPlan,
  TriageTurnOutput,
} from "../pipeline-schemas.js";
import {
  PipelineInputSchema,
  TriageMessageInternalSchema,
} from "./schemas.js";

/** Context passed into node factories that need to perform sidecar→Rust IPC
 *  outside of a tool call (e.g. mid-stage credential refresh). */
export interface PipelineGraphContext {
  tools: RepoTools;
  workflowId: string;
  emit: (event: OutboundEvent) => void;
}

export type PipelineInput = z.infer<typeof PipelineInputSchema>;

export type TriageMessage = z.infer<typeof TriageMessageInternalSchema>;

export const PipelineStateAnnotation = Annotation.Root({
  input: Annotation<PipelineInput>(),
  model: Annotation<ModelSelection>(),

  currentStage: Annotation<PipelineStage>({
    reducer: (_current, update) => update,
    default: () => "grooming" as PipelineStage,
  }),

  groomingOutput: Annotation<GroomingOutput | undefined>(),
  impactOutput: Annotation<ImpactOutput | undefined>(),
  triageHistory: Annotation<TriageMessage[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  triageLastTurn: Annotation<TriageTurnOutput | undefined>(),
  plan: Annotation<ImplementationPlan | undefined>(),
  implementationOutput: Annotation<ImplementationOutput | undefined>(),
  buildVerification: Annotation<BuildCheckResult | undefined>(),
  testPlan: Annotation<TestPlan | undefined>(),
  testOutput: Annotation<TestOutput | undefined>(),
  reviewOutput: Annotation<PlanReviewOutput | undefined>(),
  prDescription: Annotation<PrDescriptionOutput | undefined>(),
  retrospective: Annotation<RetrospectiveOutput | undefined>(),

  buildStatus: Annotation<BuildStatus | undefined>(),
  buildAttempts: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),

  // Per-file post-write verification failures from the implementation node.
  // Cleared when `do_plan` runs a revision so a fresh implementation pass
  // starts with a clean slate.
  verificationFailures: Annotation<FileVerification[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  // Populated by `replan_check` when the user opts to revise the plan; read
  // (and cleared) by `do_plan` on its next run.
  planRevisionContext: Annotation<PlanRevisionContext | undefined>(),
  // How many times the plan has been revised. Capped to bound runaway loops.
  planRevisions: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),

  usage: Annotation<{ inputTokens: number; outputTokens: number }>({
    reducer: (current, update) => ({
      inputTokens: (current?.inputTokens ?? 0) + update.inputTokens,
      outputTokens: (current?.outputTokens ?? 0) + update.outputTokens,
    }),
    default: () => ({ inputTokens: 0, outputTokens: 0 }),
  }),
});

export type PipelineState = typeof PipelineStateAnnotation.State;
