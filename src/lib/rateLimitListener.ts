/**
 * Boot-time subscriber to the `ai-rate-limit-event` Tauri event.
 *
 * Rate-limit snapshots are parsed from `anthropic-ratelimit-*` response
 * headers in the sidecar's OAuth fetch interceptor and forwarded as
 * `progress` events on whichever workflow channel is currently in
 * flight. The HeaderModelPicker is a global UI element though — a
 * per-workflow store listening only on its own channel (e.g.
 * `implementation-pipeline-event`) misses updates produced by other
 * workflows (orchestrator chat, PR review, ticket quality, …). The
 * Rust side mirrors every rate-limit progress payload onto this
 * dedicated channel; we listen once at boot and pipe updates into the
 * shared tokenUsageStore.
 *
 * Concurrency guard mirrors `aiDebugListener.ts`: stash the in-flight
 * `Promise<UnlistenFn>` synchronously so React 18 StrictMode's double-
 * mount in dev can't race past the guard and register two listeners.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useTokenUsageStore,
  type RateLimitSnapshot,
} from "@/stores/tokenUsageStore";

interface RateLimitEventPayload {
  provider?: string;
  snapshot?: RateLimitSnapshot;
}

let listener: Promise<UnlistenFn> | null = null;

export async function startRateLimitListener(): Promise<void> {
  if (!listener) {
    listener = listen<RateLimitEventPayload>(
      "ai-rate-limit-event",
      (event) => {
        const payload = event.payload;
        if (!payload || typeof payload !== "object") return;
        if (
          !payload.provider ||
          !payload.snapshot ||
          typeof payload.snapshot !== "object"
        ) {
          return;
        }
        useTokenUsageStore
          .getState()
          .setRateLimits(payload.provider, payload.snapshot);
      },
    );
  }
  await listener;
}

export async function stopRateLimitListener(): Promise<void> {
  if (listener) {
    const handle = await listener;
    handle();
    listener = null;
  }
}
