// Type aliases derived from the orchestrator Zod schemas plus the public
// state / context shapes shared across orchestrator submodules.

import { z } from "zod";
import type { ModelSelection, OutboundEvent } from "../../protocol.js";
import type { RepoTools } from "../../tools/repo-tools.js";
import {
  ApplyPlanEditsInputSchema,
  OrchestratorInputSchema,
  OrchestratorMessageSchema,
  PendingProposalSchema,
  PlanEditOpSchema,
} from "./schemas.js";
import type { OrchestratorStateAnnotation } from "./state.js";

export type OrchestratorInput = z.infer<typeof OrchestratorInputSchema>;
export type PlanEditOp = z.infer<typeof PlanEditOpSchema>;
export type PendingProposal = z.infer<typeof PendingProposalSchema>;
export type OrchestratorMessage = z.infer<typeof OrchestratorMessageSchema>;
export type ApplyPlanEditsInput = z.infer<typeof ApplyPlanEditsInputSchema>;

export type OrchestratorState = typeof OrchestratorStateAnnotation.State;

export interface ToolLoopOutcome {
  reply: string;
  toolEvents: Extract<OrchestratorMessage, { kind: "tool_call" }>[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

// LangChain tools have a stable shape — we widen `RepoTools` so the
// orchestrator can pass its combined repo + pipeline-control set without
// fighting the type system.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = { name: string; invoke: (input: unknown) => Promise<unknown> } & any;
export type OrchestratorTools = AnyTool[];

export interface OrchestratorNodeContext {
  workflowId: string;
  model: ModelSelection;
  tools: RepoTools;
  emit: (e: OutboundEvent) => void;
}

export interface PlanShape {
  summary: string;
  files: Array<{
    path: string;
    action: "create" | "modify" | "delete";
    description: string;
  }>;
  order_of_operations: string[];
  edge_cases: string[];
  do_not_change: string[];
  assumptions: string[];
  open_questions: string[];
}
