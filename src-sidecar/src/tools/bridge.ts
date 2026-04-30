// Tool-callback bridge.
//
// LangGraph tools defined in the sidecar do not touch the filesystem
// directly — every invocation dispatches a `tool.callback.request` event
// to the Rust backend, which executes the operation (sandboxed to the
// configured worktree path) and returns a `tool.callback.response`.
//
// This module manages the pending-callback registry that resolves
// outstanding requests when their responses arrive.

import { randomUUID } from "node:crypto";
import type { OutboundEvent, ToolCallbackResponse } from "../protocol.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const pending = new Map<string, Pending>();

export type CallbackEmitter = (event: OutboundEvent) => void;

export function requestToolCallback(args: {
  workflowId: string;
  tool: string;
  input: unknown;
  emit: CallbackEmitter;
  timeoutMs?: number;
}): Promise<unknown> {
  const callbackId = randomUUID();
  const { workflowId, tool, input, emit, timeoutMs = 60_000 } = args;

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(callbackId);
      reject(new Error(`Tool callback timed out: ${tool} (${timeoutMs}ms)`));
    }, timeoutMs);

    pending.set(callbackId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    emit({
      id: workflowId,
      type: "tool.callback.request",
      callbackId,
      tool,
      input,
    });
  });
}

export function resolveToolCallback(msg: ToolCallbackResponse): void {
  const entry = pending.get(msg.callbackId);
  if (!entry) {
    console.error(`No pending callback for id ${msg.callbackId}`);
    return;
  }
  pending.delete(msg.callbackId);
  if (msg.error) {
    entry.reject(new Error(msg.error));
  } else {
    entry.resolve(msg.result);
  }
}
