// Subscribe to a sidecar workflow's `stream` events and surface the
// accumulating text to a Zustand store as it arrives.
//
// Usage:
//   const stream = subscribeWorkflowStream("meeting-chat-workflow-event",
//     (text) => store._setChatStream(meetingId, text),
//     {
//       onUsage: (usage) => useTokenUsageStore
//         .getState()
//         .setCurrentCallUsage("meetings", usage, modelKey),
//     });
//   try { await chatMeeting(...) } finally { stream.dispose(); }
//
// The helper throttles updates to avoid flooding React when a fast model
// produces tokens at >100Hz, accumulating deltas in memory and flushing
// the latest accumulated text to the callback at most once per 80ms.
//
// The optional `onUsage` callback fires whenever the sidecar emits a
// `progress` event with `data.usagePartial` so panels can update the
// header TokenUsageBadge live as a streaming workflow runs.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WorkflowStreamHandle {
  /** Tear down the listener and flush any pending throttled update. */
  dispose: () => Promise<void>;
}

interface WorkflowStreamPayload {
  kind?: string;
  delta?: string;
  data?: {
    usagePartial?: { inputTokens?: number; outputTokens?: number };
  };
}

export interface UsagePartial {
  inputTokens: number;
  outputTokens: number;
}

export interface SubscribeOptions {
  flushMs?: number;
  /** Fired whenever the sidecar emits a `progress` event with
   *  `data.usagePartial`. Pass-through to the panel's tokenUsageStore so
   *  the header TokenUsageBadge climbs live during streaming. Not
   *  throttled — usagePartial events are already rate-limited by the
   *  sidecar's streaming helper, and the consumer's setCurrentCallUsage
   *  is a cheap zustand setter. */
  onUsage?: (usage: UsagePartial) => void;
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
  options: SubscribeOptions = {},
): Promise<WorkflowStreamHandle> {
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
  const onUsage = options.onUsage;
  let acc = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    onText(acc);
  };

  const unlisten: UnlistenFn = await listen<WorkflowStreamPayload>(
    eventName,
    (event) => {
      const payload = event.payload;
      if (payload.kind === "stream" && payload.delta) {
        acc += payload.delta;
        if (flushTimer === null) {
          flushTimer = setTimeout(flush, flushMs);
        }
        return;
      }
      if (payload.kind === "progress" && onUsage) {
        const usage = payload.data?.usagePartial;
        if (usage && typeof usage === "object") {
          onUsage({
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          });
        }
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
