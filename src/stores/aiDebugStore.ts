/**
 * In-memory ring buffer of recent AI traffic events captured by the
 * sidecar when the developer toggle "Log AI traffic" is on.
 *
 * The Rust backend forwards every `ai-traffic-event` from the sidecar
 * onto a single Tauri event channel. A boot-time listener wired in
 * `src/lib/aiDebugListener.ts` shoves each event into this store, which
 * the debug panel subscribes to.
 *
 * Capacity is bounded — runaway pipelines could otherwise grow the
 * buffer to thousands of multi-k prompt blobs and choke the renderer.
 * Oldest entries drop first.
 *
 * Persistence: events ride in sessionStorage so they survive Vite's
 * HMR module-replacement during development (which would otherwise
 * recreate the store with an empty events array on any source save)
 * and incidental React re-mounts. sessionStorage was picked deliberately
 * over localStorage so the buffer clears when the app actually closes
 * — matching the contract "never remove entries unless I manually clear
 * or close the app". The `enabled` / `dockMode` / `panelSize` / `lastVisibleDockMode`
 * fields are NOT persisted because they're rehydrated from on-disk
 * preferences on every boot (see App.tsx → hydrate()), and persisting
 * them here would race that flow.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  setAiDebugEnabled,
  setAiDebugDockMode,
  type AiDebugDockMode,
} from "@/lib/appPreferences";

export interface AiTrafficEvent {
  /** Run id assigned by the workflow runner — lets the panel group
   *  multiple round-trips that belong to the same logical workflow. */
  runId: string;
  startedAt: number;
  latencyMs: number;
  provider: string;
  model: string;
  workflow: string;
  node?: string;
  messages: Array<{ role: string; content: string }>;
  response: string;
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
}

const MAX_EVENTS = 200;

interface AiDebugState {
  /** Most-recent-first list of captured traffic events. Bounded by
   *  MAX_EVENTS; older entries fall off the tail. */
  events: AiTrafficEvent[];
  /** Mirror of the on-disk preference. The Settings toggle calls
   *  `setEnabled` which writes through to the pref store; the listener
   *  reads from this and skips capture intake when off. */
  enabled: boolean;
  dockMode: AiDebugDockMode;
  /** Last non-hidden dock mode the user picked. The View → AI Debug
   *  Panel menu toggle restores the panel into this slot when un-
   *  hiding, so Cmd-Shift-D round-trips cleanly between visible and
   *  hidden without dropping the user back to the default. */
  lastVisibleDockMode: Exclude<AiDebugDockMode, "hidden">;
  /** Bottom/right/left dock heights/widths. Persisted only in memory —
   *  defaulting on each launch is fine for a developer-only panel. */
  panelSize: number;
  hydrated: boolean;

  /** Initialise from disk preferences. Idempotent; safe to call on
   *  every app boot. */
  hydrate: (snapshot: { enabled: boolean; dockMode: AiDebugDockMode }) => void;
  /** Append a new traffic event. Drops the tail if over MAX_EVENTS.
   *  Dedupes against existing entries by (runId, startedAt, latencyMs)
   *  so the disk-hydrate flow can call this with already-seen events
   *  without producing duplicates. */
  pushEvent: (e: AiTrafficEvent) => void;
  /** Replace the in-memory buffer with the on-disk JSONL contents
   *  (oldest-first input → most-recent-first store layout). Called by
   *  the panel on mount so the buffer reflects the source of truth even
   *  when live events were missed (popped-out window opened after the
   *  workflow started, app restart, etc.). */
  hydrateFromDisk: (entries: AiTrafficEvent[]) => void;
  /** Wipe the captured buffer. Doesn't change the enabled flag — the
   *  panel exposes a Clear button for when the buffer gets noisy. */
  clear: () => void;
  setEnabled: (value: boolean) => Promise<void>;
  setDockMode: (mode: AiDebugDockMode) => Promise<void>;
  setPanelSize: (px: number) => void;
}

export const useAiDebugStore = create<AiDebugState>()(
  persist(
    (set) => ({
      events: [],
      enabled: false,
      dockMode: "bottom",
      lastVisibleDockMode: "bottom",
      panelSize: 320,
      hydrated: false,

      hydrate: ({ enabled, dockMode }) =>
        set({
          enabled,
          dockMode,
          // Seed lastVisibleDockMode from whatever the user last saved —
          // unless they saved "hidden", in which case fall back to bottom
          // so the menu-toggle still has somewhere meaningful to land.
          lastVisibleDockMode: dockMode === "hidden" ? "bottom" : dockMode,
          hydrated: true,
        }),

      pushEvent: (event) =>
        set((s) => {
          // Dedup: live `ai-traffic-event` and the disk-hydrate flow can
          // race (e.g. the popped-out window mounts mid-workflow, hydrates
          // from disk, then the next `app.emit` arrives for an event we
          // already loaded). Skip if we've seen the same call signature.
          if (
            s.events.some(
              (e) =>
                e.runId === event.runId &&
                e.startedAt === event.startedAt &&
                e.latencyMs === event.latencyMs,
            )
          ) {
            return s;
          }
          const next = [event, ...s.events];
          if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
          return { events: next };
        }),

      hydrateFromDisk: (entries) =>
        set((s) => {
          // entries arrive oldest-first; the store stores most-recent-first.
          // Build a key set from the existing buffer and merge anything we
          // don't already have, capped at MAX_EVENTS most-recent.
          const existing = new Set(
            s.events.map(
              (e) => `${e.runId}|${e.startedAt}|${e.latencyMs}`,
            ),
          );
          const fresh: AiTrafficEvent[] = [];
          for (const e of entries) {
            const key = `${e.runId}|${e.startedAt}|${e.latencyMs}`;
            if (!existing.has(key)) fresh.push(e);
          }
          if (fresh.length === 0) return s;
          const merged = [...fresh.reverse(), ...s.events];
          if (merged.length > MAX_EVENTS) merged.length = MAX_EVENTS;
          return { events: merged };
        }),

      clear: () => set({ events: [] }),

      setEnabled: async (value) => {
        set({ enabled: value });
        await setAiDebugEnabled(value);
      },

      setDockMode: async (mode) => {
        set((s) => ({
          dockMode: mode,
          // Track the last non-hidden mode so the menu toggle can restore
          // the panel to the user's preferred dock side instead of the
          // default. Only updated when transitioning AWAY from hidden.
          lastVisibleDockMode: mode === "hidden" ? s.lastVisibleDockMode : mode,
        }));
        await setAiDebugDockMode(mode);
      },

      setPanelSize: (px) => set({ panelSize: Math.max(160, Math.floor(px)) }),
    }),
    {
      name: "meridian-ai-debug-events",
      // sessionStorage rather than localStorage — the buffer survives
      // page reloads / HMR module-replacements within the same app
      // session but clears when the app actually closes, matching the
      // user contract.
      storage: createJSONStorage(() => sessionStorage),
      // Only persist `events`. `enabled` / `dockMode` / `panelSize` /
      // `lastVisibleDockMode` are owned by on-disk preferences (see
      // App.tsx → hydrate()) so persisting them here would race that
      // flow on every boot.
      partialize: (state) => ({ events: state.events }),
    },
  ),
);

/** Total tokens captured in the buffer — used by the panel header so
 *  the user can see how much traffic they've collected at a glance. */
export function totalCapturedTokens(events: AiTrafficEvent[]): {
  input: number;
  output: number;
} {
  let input = 0;
  let output = 0;
  for (const e of events) {
    input += e.usage.inputTokens;
    output += e.usage.outputTokens;
  }
  return { input, output };
}
