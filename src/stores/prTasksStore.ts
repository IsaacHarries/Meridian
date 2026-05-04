/**
 * Zustand store that mirrors the Bitbucket "tasks" attached to PRs the
 * authenticated user has filed. The Tasks panel renders them in a "From
 * PRs" section grouped by PR title, so the user can tick them off
 * without leaving Meridian.
 *
 * Sync model:
 *   - Polled on app launch and every PR_TASKS_POLL_INTERVAL_MS (kicked
 *     off from `App.tsx` once Bitbucket credentials are present).
 *   - When the user checks a task off in the panel we call
 *     `resolvePrTask` and optimistically drop it from the entries list;
 *     the next poll re-confirms server-side state.
 *   - When the user checks a task off directly in Bitbucket, the next
 *     poll observes the new RESOLVED state and removes it from here.
 *
 * Only *unresolved* tasks are surfaced — resolved ones drop out of the
 * panel as soon as we observe them, mirroring how the manual tasks
 * store treats `completed`.
 */

import { getAppPreferences } from "@/lib/appPreferences";
import {
    type PrTaskFilter,
    getPrTaskFilters,
    matchesAnyFilter,
} from "@/lib/prTaskFilters";
import { type BitbucketPr, type BitbucketTask, getMyOpenPrs, getPrTasks, resolvePrTask } from "@/lib/tauri/bitbucket";
import { toast } from "sonner";
import { create } from "zustand";

export const PR_TASKS_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** One entry per PR the user has open. `tasks` only contains unresolved
 *  tasks — resolved ones are filtered out at fetch time. */
export interface PrTaskGroup {
  pr: BitbucketPr;
  tasks: BitbucketTask[];
}

interface PrTasksState {
  /** Visible list, with user-defined filters applied. */
  entries: PrTaskGroup[];
  /** Unfiltered fetch result — kept so we can re-apply filters
   *  in-place (e.g. when the user edits a filter rule in Settings)
   *  without re-hitting Bitbucket. */
  rawEntries: PrTaskGroup[];
  /** Active filter rules. Hidden tasks are dropped from `entries`. */
  filters: PrTaskFilter[];
  loading: boolean;
  /** ISO timestamp of the last successful refresh, or null. */
  lastFetchedAt: string | null;
  /** Error message from the last refresh, if any (otherwise null). */
  error: string | null;

  /** Fetch my open PRs and their unresolved tasks. Silently no-ops when
   *  another refresh is already running. */
  refresh: () => Promise<void>;
  /** Resolve a single task on a PR. Optimistically removes it from
   *  `entries`; on Bitbucket failure the next poll will re-add it. */
  resolveTask: (prId: number, taskId: number) => Promise<void>;
  /** Replace the active filter rules and re-apply them to the cached
   *  raw entries. Persisting to preferences is the caller's
   *  responsibility — typically the Settings UI. */
  setFilters: (filters: PrTaskFilter[]) => void;
  /** Hydrate filters from preferences. Call once on app startup. */
  hydrateFilters: () => Promise<void>;
}

function applyFilters(
  raw: PrTaskGroup[],
  filters: PrTaskFilter[],
): PrTaskGroup[] {
  if (filters.length === 0) return raw;
  return raw
    .map((g) => ({
      pr: g.pr,
      tasks: g.tasks.filter((t) => !matchesAnyFilter(t.content, filters)),
    }))
    .filter((g) => g.tasks.length > 0);
}

export const usePrTasksStore = create<PrTasksState>()((set, get) => ({
  entries: [],
  rawEntries: [],
  filters: [],
  loading: false,
  lastFetchedAt: null,
  error: null,

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const prs = await getMyOpenPrs();
      // Fetch tasks for every PR in parallel — Bitbucket has no batch
      // endpoint and there are usually only a handful of in-flight PRs
      // per author at a time. Skip PRs whose taskCount is zero so the
      // common case ("no tasks on most PRs") doesn't burn an HTTP call.
      const groups = await Promise.all(
        prs.map(async (pr) => {
          if (pr.taskCount === 0) return { pr, tasks: [] as BitbucketTask[] };
          try {
            const tasks = await getPrTasks(pr.id);
            return {
              pr,
              tasks: tasks.filter((t) => !t.resolved),
            };
          } catch (e) {
            console.warn(`[prTasks] getPrTasks failed for PR #${pr.id}:`, e);
            return { pr, tasks: [] as BitbucketTask[] };
          }
        }),
      );
      // Drop PRs with no unresolved tasks — they'd just render as empty
      // category headers in the sidebar.
      const rawEntries = groups
        .filter((g) => g.tasks.length > 0)
        // Newest PRs first — "what just landed in review" is usually
        // what the user wants to see at the top.
        .sort((a, b) => b.pr.updatedOn.localeCompare(a.pr.updatedOn));
      const filters = get().filters;
      // Detect newly-arrived task ids so we can fire a toast when the
      // user has opted in. Compared against the prior raw fetch — by
      // task id, scoped per PR — so re-polls don't spam.
      const priorIds = new Set<string>();
      for (const g of get().rawEntries) {
        for (const t of g.tasks) priorIds.add(`${g.pr.id}:${t.id}`);
      }
      const newTaskCount = rawEntries.reduce((sum, g) => {
        return (
          sum + g.tasks.filter((t) => !priorIds.has(`${g.pr.id}:${t.id}`)).length
        );
      }, 0);
      // Only toast when there was a prior fetch — otherwise the very
      // first refresh after launch would announce every existing task.
      if (newTaskCount > 0 && get().lastFetchedAt !== null) {
        try {
          const appPrefs = await getAppPreferences();
          if (appPrefs.notifyPrTaskAdded) {
            toast.message(
              newTaskCount === 1
                ? "1 new PR task"
                : `${newTaskCount} new PR tasks`,
              {
                description:
                  "From PRs you authored — check the Tasks panel.",
              },
            );
          }
        } catch {
          // Pref read failure shouldn't break the refresh path.
        }
      }
      set({
        rawEntries,
        entries: applyFilters(rawEntries, filters),
        loading: false,
        lastFetchedAt: new Date().toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[prTasks] refresh failed:", msg);
      set({ loading: false, error: msg });
    }
  },

  resolveTask: async (prId, taskId) => {
    // Optimistic remove — the panel hides the row immediately. If the
    // server call fails we restore the prior entries; the next poll
    // will reconcile regardless. We mutate both `entries` (visible)
    // and `rawEntries` (cached fetch) so the row doesn't reappear when
    // the user edits a filter rule in Settings before the next poll.
    const priorEntries = get().entries;
    const priorRaw = get().rawEntries;
    const stripTask = (groups: PrTaskGroup[]) =>
      groups
        .map((g) =>
          g.pr.id === prId
            ? { ...g, tasks: g.tasks.filter((t) => t.id !== taskId) }
            : g,
        )
        .filter((g) => g.tasks.length > 0);
    set({
      entries: stripTask(priorEntries),
      rawEntries: stripTask(priorRaw),
    });
    try {
      await resolvePrTask(prId, taskId, true);
    } catch (e) {
      console.warn(`[prTasks] resolvePrTask failed:`, e);
      set({ entries: priorEntries, rawEntries: priorRaw });
      throw e;
    }
  },

  setFilters: (filters) => {
    set({
      filters,
      entries: applyFilters(get().rawEntries, filters),
    });
  },

  hydrateFilters: async () => {
    const filters = await getPrTaskFilters();
    set({
      filters,
      entries: applyFilters(get().rawEntries, filters),
    });
  },
}));
