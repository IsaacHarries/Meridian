// Subscribe to a sidecar workflow's `stream` events and surface the
// accumulating text to a Zustand store as it arrives.
//
// Usage:
//   const stream = subscribeWorkflowStream("meeting-chat-workflow-event",
//     (text) => store._setChatStream(meetingId, text));
//   try { await chatMeeting(...) } finally { stream.dispose(); }
//
// The helper throttles updates to avoid flooding React when a fast model
// produces tokens at >100Hz, accumulating deltas in memory and flushing
// the latest accumulated text to the callback at most once per 80ms.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WorkflowStreamHandle {
  /** Tear down the listener and flush any pending throttled update. */
  dispose: () => Promise<void>;
}

interface WorkflowStreamPayload {
  kind?: string;
  delta?: string;
}

const DEFAULT_FLUSH_MS = 80;

/**
 * Subscribe to a Tauri workflow event channel, accumulate `stream` deltas,
 * and call `onText` with the running total. Returns a handle whose
 * `dispose()` should be awaited in a `finally` block to ensure the listener
 * tears down even when the workflow throws.
 */
export async function subscribeWorkflowStream(
  eventName: string,
  onText: (text: string) => void,
  options: { flushMs?: number } = {},
): Promise<WorkflowStreamHandle> {
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
  let acc = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    onText(acc);
  };

  const unlisten: UnlistenFn = await listen<WorkflowStreamPayload>(
    eventName,
    (event) => {
      if (event.payload.kind !== "stream" || !event.payload.delta) return;
      acc += event.payload.delta;
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, flushMs);
      }
    },
  );

  return {
    dispose: async () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      unlisten();
    },
  };
}
