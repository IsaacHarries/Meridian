/**
 * Per-panel chat history that survives screen navigation within a
 * single app session. Several panels (Sprint Dashboard sprint chat,
 * Ticket Quality grooming chat, Address PR Comments chat) used to keep
 * their conversation in `useState`, which meant a quick navigation
 * away — even via the header tabs — wiped the running conversation.
 *
 * This store keeps the committed conversation turns keyed by panel +
 * a per-panel "context key" (issue key, sprint id, PR id, …) so the
 * thread is preserved when the user comes back to the same context.
 * Switching context within a panel intentionally swaps the thread —
 * the user is talking about a different ticket / sprint / PR now.
 *
 * Streaming text, busy state, and any other ephemeral state stays in
 * the screen's local state — only committed turns belong here.
 */

import { create } from "zustand";
import type { PanelKey } from "@/stores/tokenUsageStore";

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

interface ChatHistoryState {
  /** panel → contextKey → committed turns. Empty maps for unused
   *  panels; we lazily populate as turns are appended. */
  histories: Partial<Record<PanelKey, Record<string, ChatTurn[]>>>;

  /** Read the turns for a panel/context, or `[]` when nothing has
   *  been recorded yet. The returned array is the live store
   *  reference — do not mutate it; use the setter actions. */
  getHistory: (panel: PanelKey, key: string) => ChatTurn[];
  /** Replace the turns for a panel/context. Pass an empty array to
   *  clear without losing the entry. */
  setHistory: (panel: PanelKey, key: string, turns: ChatTurn[]) => void;
  /** Append a single turn — convenience wrapper around setHistory. */
  appendTurn: (panel: PanelKey, key: string, turn: ChatTurn) => void;
  /** Drop the turns for a panel/context. Equivalent to setting an
   *  empty array; provided for clarity at call sites that mean "wipe". */
  clear: (panel: PanelKey, key: string) => void;
}

export const useChatHistoryStore = create<ChatHistoryState>()((set, get) => ({
  histories: {},

  getHistory: (panel, key) => get().histories[panel]?.[key] ?? [],

  setHistory: (panel, key, turns) =>
    set((s) => ({
      histories: {
        ...s.histories,
        [panel]: { ...(s.histories[panel] ?? {}), [key]: turns },
      },
    })),

  appendTurn: (panel, key, turn) =>
    set((s) => {
      const prior = s.histories[panel]?.[key] ?? [];
      return {
        histories: {
          ...s.histories,
          [panel]: { ...(s.histories[panel] ?? {}), [key]: [...prior, turn] },
        },
      };
    }),

  clear: (panel, key) =>
    set((s) => ({
      histories: {
        ...s.histories,
        [panel]: { ...(s.histories[panel] ?? {}), [key]: [] },
      },
    })),
}));
