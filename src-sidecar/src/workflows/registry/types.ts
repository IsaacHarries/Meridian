// Shared types for the workflow registry.

import type { ModelSelection, OutboundEvent } from "../../protocol.js";

export type Emitter = (event: OutboundEvent) => void;

export type WorkflowRunner = (args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}) => Promise<void>;
