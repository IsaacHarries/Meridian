// Sidecar → Rust IPC for refreshing provider credentials mid-workflow.
//
// Long-running tool-loop nodes (implementation iterating per file, test_gen,
// code_review) can outlive an OAuth access token's TTL — Gemini's CodeAssist
// tokens expire after ~1 hour, and a complex implementation stage with many
// files can comfortably exceed that. Each per-file iteration calls
// `refreshCredentials` before constructing its model so the embedded access
// token is always fresh.
//
// Rust answers via the existing tool-callback IPC channel, calling its
// `resolve_credentials` (which already handles OAuth refresh + re-onboarding
// the Gemini CodeAssist project as needed).

import type {
  ModelSelection,
  OutboundEvent,
  Provider,
  ProviderCredentials,
} from "../protocol.js";
import { requestToolCallback } from "./bridge.js";

export async function refreshCredentials(args: {
  workflowId: string;
  provider: Provider;
  emit: (event: OutboundEvent) => void;
}): Promise<ProviderCredentials> {
  const result = await requestToolCallback({
    workflowId: args.workflowId,
    tool: "refresh_credentials",
    input: { provider: args.provider },
    emit: args.emit,
    timeoutMs: 30_000,
  });
  return result as ProviderCredentials;
}

/** Re-resolve the entire `ModelSelection` (provider + model name + fresh
 *  credentials) for a given panel/stage context. Picks up changes the user
 *  has made to the header dropdown / Settings since the workflow started, so
 *  switching models mid-pipeline works without restarting. */
export async function resolveModelSelection(args: {
  workflowId: string;
  panel: string;
  stage?: string;
  emit: (event: OutboundEvent) => void;
}): Promise<ModelSelection> {
  const result = await requestToolCallback({
    workflowId: args.workflowId,
    tool: "refresh_model",
    input: { panel: args.panel, stage: args.stage },
    emit: args.emit,
    timeoutMs: 30_000,
  });
  return result as ModelSelection;
}
