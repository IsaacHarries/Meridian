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
 */

import { create } from "zustand";
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
  /** Append a new traffic event. Drops the tail if over MAX_EVENTS. */
  pushEvent: (e: AiTrafficEvent) => void;
  /** Wipe the captured buffer. Doesn't change the enabled flag — the
   *  panel exposes a Clear button for when the buffer gets noisy. */
  clear: () => void;
  setEnabled: (value: boolean) => Promise<void>;
  setDockMode: (mode: AiDebugDockMode) => Promise<void>;
  setPanelSize: (px: number) => void;
}

export const useAiDebugStore = create<AiDebugState>()((set) => ({
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
      const next = [event, ...s.events];
      if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
      return { events: next };
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
}));

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
