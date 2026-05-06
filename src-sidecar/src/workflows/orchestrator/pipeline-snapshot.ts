// Read-only access to the sibling implementation-pipeline workflow's
// checkpointed state, plus the orchestrator's own snapshot helper.

import { makeRepoTools } from "../../tools/repo-tools.js";
import { buildPipelineGraph } from "../pipeline.js";
import { buildOrchestratorGraph } from "./graph.js";
import type { OrchestratorNodeContext, OrchestratorState } from "./types.js";

/** Slim representation of the pipeline checkpoint state — what the
 *  orchestrator needs to ground decisions without forcing the model to
 *  parse the full LangGraph state blob. */
export interface PipelineSnapshot {
  currentStage: string | undefined;
  pendingNode: string | undefined;
  hasPlan: boolean;
  planFileCount: number;
  implementationFileCount: number | undefined;
  verificationFailures: number;
  /** Whether the post-implementation verification pass landed clean
   *  (typecheck/test/build all green and no unresolved issues). Undefined
   *  before verification has run. */
  verificationClean: boolean | undefined;
  /** Number of shell commands the verification agent ran. */
  verificationStepCount: number;
  planRevisions: number;
}

/** Read the pipeline workflow's checkpointed state for a given thread.
 *  Returns undefined if no state exists yet (pipeline hasn't run). The
 *  pipeline graph is rebuilt with no-op tool callbacks because we're only
 *  reading state, not executing nodes. */
export async function readPipelineSnapshot(
  pipelineThreadId: string,
): Promise<PipelineSnapshot | undefined> {
  // Stub tools/emit because getState() does not invoke nodes.
  const noopEmit = () => undefined;
  const tools = makeRepoTools({ workflowId: "orchestrator-readonly", emit: noopEmit });
  const graph = buildPipelineGraph({
    tools,
    workflowId: "orchestrator-readonly",
    emit: noopEmit,
  });
  const snapshot = await graph.getState({
    configurable: { thread_id: pipelineThreadId },
  });
  if (!snapshot.values || Object.keys(snapshot.values).length === 0) {
    return undefined;
  }
  // Cast: the pipeline state shape is internal to pipeline.ts. We only
  // touch fields that have been stable for a while.
  const v = snapshot.values as {
    currentStage?: string;
    plan?: { files: unknown[] } | undefined;
    implementationOutput?: { files_changed?: unknown[] } | undefined;
    verificationFailures?: unknown[];
    verificationOutput?: { clean?: boolean; steps?: unknown[] } | undefined;
    planRevisions?: number;
  };
  const next = (snapshot.next ?? []) as readonly string[];
  return {
    currentStage: v.currentStage,
    pendingNode: next[0],
    hasPlan: !!v.plan,
    planFileCount: v.plan?.files?.length ?? 0,
    implementationFileCount: v.implementationOutput?.files_changed?.length,
    verificationFailures: v.verificationFailures?.length ?? 0,
    verificationClean: v.verificationOutput?.clean,
    verificationStepCount: v.verificationOutput?.steps?.length ?? 0,
    planRevisions: v.planRevisions ?? 0,
  };
}

// ── Snapshot helper ───────────────────────────────────────────────────────────

/** Return the persisted state for a given orchestrator thread. Used by the
 *  Tauri layer when the frontend wants to render existing thread history
 *  (e.g. on app reopen) without sending a new user message. */
export async function getOrchestratorSnapshot(
  threadId: string,
  ctx: OrchestratorNodeContext,
): Promise<OrchestratorState | undefined> {
  const graph = buildOrchestratorGraph(ctx);
  const snapshot = await graph.getState({
    configurable: { thread_id: threadId },
  });
  if (!snapshot.values || Object.keys(snapshot.values).length === 0) {
    return undefined;
  }
  return snapshot.values as OrchestratorState;
}
