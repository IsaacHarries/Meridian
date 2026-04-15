/**
 * Lightweight store that tracks whether any team member is overloaded.
 *
 * Uses the same classification logic as WorkloadBalancerScreen:
 *   - Classify each developer's remaining ticket count relative to the team average
 *   - Anyone with >140% of the team average remaining tickets is "overloaded"
 *
 * Polled on app launch and every POLL_INTERVAL_MS thereafter.
 * Results are held in module-level state so callers can read without re-fetching.
 */

import { create } from "zustand";
import { getAllActiveSprintIssues, getOpenPrs, type JiraIssue, type BitbucketPr } from "@/lib/tauri";
import { getIgnoredDevs } from "@/lib/preferences";
import { classifyWorkloads } from "@/lib/workloadClassifier";

export const POLL_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

// ── Workload classification (mirrors WorkloadBalancerScreen) ──────────────────

function isDone(issue: JiraIssue): boolean {
  return issue.statusCategory === "Done";
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface WorkloadAlertState {
  /** Names of developers currently classified as overloaded. Empty = none. */
  overloadedDevs: string[];
  /** Names of developers currently classified as under-utilised. Empty = none. */
  underutilisedDevs: string[];
  /** ISO timestamp of the last successful check, or null if never run. */
  lastCheckedAt: string | null;
  /** True while a check is in progress. */
  checking: boolean;
  /** Error message from the last check, if any. */
  checkError: string | null;

  /**
   * Fetch the current sprint workload and update overloadedDevs / underutilisedDevs.
   * Returns the list of overloaded developer names (may be empty).
   * Silently no-ops if JIRA/Bitbucket are unavailable.
   */
  checkWorkload: () => Promise<string[]>;
}

export const useWorkloadAlertStore = create<WorkloadAlertState>()((set, get) => ({
  overloadedDevs: [],
  underutilisedDevs: [],
  lastCheckedAt: null,
  checking: false,
  checkError: null,

  checkWorkload: async () => {
    if (get().checking) return get().overloadedDevs;
    set({ checking: true, checkError: null });
    try {
      const [sprintPairs, openPrs, ignoredDevs] = await Promise.all([
        getAllActiveSprintIssues(),
        getOpenPrs().catch(() => [] as BitbucketPr[]),
        getIgnoredDevs().catch(() => new Set<string>()),
      ]);

      // Classify per-sprint (matching how WorkloadBalancerScreen works — it shows
      // one sprint at a time). A dev is overloaded/underutilised if they are
      // classified that way in ANY of the filtered sprints.
      const overloadedSet = new Set<string>();
      const underutilisedSet = new Set<string>();

      for (const [, sprintIssues] of sprintPairs) {
        const workloads = classifyWorkloads(sprintIssues, openPrs);
        for (const d of workloads) {
          if (d.loadStatus === "overloaded") overloadedSet.add(d.name);
          if (d.loadStatus === "underutilised") underutilisedSet.add(d.name);
        }
      }

      // A dev overloaded in one sprint shouldn't also appear as underutilised
      for (const name of overloadedSet) underutilisedSet.delete(name);
      // Remove ignored developers from both sets
      for (const name of ignoredDevs) {
        overloadedSet.delete(name);
        underutilisedSet.delete(name);
      }

      const overloaded = [...overloadedSet];
      const underutilised = [...underutilisedSet];
      set({
        overloadedDevs: overloaded,
        underutilisedDevs: underutilised,
        lastCheckedAt: new Date().toISOString(),
        checking: false,
      });
      return overloaded;
    } catch (e) {
      set({ checking: false, checkError: String(e) });
      return get().overloadedDevs;
    }
  },
}));










