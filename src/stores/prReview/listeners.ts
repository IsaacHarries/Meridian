/**
 * File-backed persistence + hydration for the PR Review store.
 *
 * Subscribes to store changes and writes the serialised state to the file
 * cache, and exposes a `hydratePrReviewStore` function that the app calls
 * once on startup to restore state from disk.
 */

import { loadCache, saveCache } from "@/lib/storeCache";
import { usePrReviewStore } from "./store";
import { PR_REVIEW_STORE_KEY, emptySession } from "./constants";
import type { PrReviewState, PrSession } from "./types";

// ── File-backed persistence ────────────────────────────────────────────────────

/**
 * Fields that are transient and must NOT be persisted across app restarts.
 */
function serializableState(s: PrReviewState) {
  return {
    ...s,
    loadingPrs: false,
    sessions: new Map(
      [...s.sessions.entries()].map(([id, session]) => [
        id,
        {
          ...session,
          loadingDetails: false,
          checkingForUpdates: false,
          reviewing: false,
          reviewProgress: "",
          reviewStreamText: "",
          reviewChatStreamText: "",
          partialReport: null,
          // Always reset checkout status on persist — the branch is re-checked-out
          // at the start of each review run, so a stale "error" or "ready" status
          // from a previous session should never be restored.
          checkoutStatus: "idle" as const,
          checkoutError: "",
          worktreeBranch: null,
        },
      ])
    ),
  };
}

/**
 * Hydrate the PR review store from the file cache.
 * Call this once on app startup.
 */
export async function hydratePrReviewStore(): Promise<void> {
  const cached = await loadCache<PrReviewState>(PR_REVIEW_STORE_KEY);
  if (!cached) return;
  const rawSessions =
    cached.sessions instanceof Map
      ? cached.sessions
      : new Map(Object.entries((cached.sessions ?? {}) as Record<string, PrSession>).map(([k, v]) => [Number(k), v]));

  // Merge every loaded session against emptySession() defaults so that fields
  // added in newer versions of the app are always present, even when loading a
  // cache file written by an older version that didn't have those fields.
  const sessions = new Map<number, PrSession>();
  for (const [id, session] of rawSessions) {
    sessions.set(id, {
      ...emptySession(),
      ...session,
      // Always clear transient fetch state on hydration
      checkingForUpdates: false,
      loadingDetails: false,
      // Always reset checkout status on hydration — the branch is re-checked-out
      // at the start of each review run, so a stale "error" or "ready" status
      // from a previous session should never be restored.
      checkoutStatus: "idle",
      checkoutError: "",
      worktreeBranch: null,
      // Always clear comments and tasks on hydration — they are re-fetched fresh
      // when the PR is opened, so stale cached data (e.g. missing author names)
      // never persists across app restarts.
      comments: [],
      tasks: [],
      partialReport: null,
      commentCountAtFetch: 0,
      commentsLastFetchedAt: null,
      hasNewComments: false,
    });
  }
  usePrReviewStore.setState({
    ...cached,
    sessions,
    // Always open at the PR list on app restart — per-PR session data (diff,
    // report, chat) is preserved in `sessions` so reopening a PR is instant,
    // but the user should consciously choose which PR to review each session.
    selectedPr: null,
    isSessionActive: false,
    // Reset transient flags
    loadingPrs: false,
  });
}

// Subscribe and save on every state change (debounced).
usePrReviewStore.subscribe((state) => {
  saveCache(PR_REVIEW_STORE_KEY, serializableState(state));
});
