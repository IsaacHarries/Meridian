/**
 * Zustand store for the right-side Tasks panel.
 *
 * Two concerns:
 *   1. Manual tasks (entries the user adds directly via the panel) — persisted
 *      on disk through the `list_tasks` / `create_task` / `update_task` /
 *      `delete_task` Tauri commands.
 *   2. Panel visibility — a single boolean persisted under a preference key
 *      so the panel remembers whether it was open across sessions.
 *
 * Tasks pulled from meeting notes (TipTap taskItem nodes) are NOT held here —
 * the panel reads them lazily from the meetings store and writes back via
 * the meetings save path.
 */

import { getPreferences, setPreference } from "@/lib/preferences";
import { type TaskRecord, createTask as createTaskCmd, deleteTask as deleteTaskCmd, listTasks, updateTask as updateTaskCmd } from "@/lib/tauri/tasks";
import { create } from "zustand";

const PANEL_OPEN_PREF_KEY = "tasks_panel_open";
const PANEL_WIDTH_PREF_KEY = "tasks_panel_width";

// Constraints for the resizable Tasks panel. Below ~240 the layout starts to
// truncate task text aggressively; above ~640 it eats too much screen on
// non-ultrawide monitors. The default sits comfortably between.
export const MIN_TASKS_PANEL_WIDTH = 240;
export const MAX_TASKS_PANEL_WIDTH = 640;
export const DEFAULT_TASKS_PANEL_WIDTH = 320;

export function clampTasksPanelWidth(w: number): number {
  if (Number.isNaN(w)) return DEFAULT_TASKS_PANEL_WIDTH;
  return Math.max(MIN_TASKS_PANEL_WIDTH, Math.min(MAX_TASKS_PANEL_WIDTH, w));
}

interface TasksState {
  tasks: TaskRecord[];
  loaded: boolean;
  panelOpen: boolean;
  panelWidth: number;

  loadTasks: () => Promise<void>;
  addTask: (text: string, category?: string | null) => Promise<void>;
  setTaskCompleted: (id: string, completed: boolean) => Promise<void>;
  /** Change (or clear with `null`) the category of an existing task. */
  setTaskCategory: (id: string, category: string | null) => Promise<void>;
  removeTask: (id: string) => Promise<void>;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;

  /** Live width update during drag — fast, no disk write. */
  resizePanel: (w: number) => void;
  /** Save the current panelWidth to preferences. Call on mouseup. */
  persistPanelWidth: () => void;
}

export const useTasksStore = create<TasksState>()((set, get) => ({
  tasks: [],
  loaded: false,
  panelOpen: false,
  panelWidth: DEFAULT_TASKS_PANEL_WIDTH,

  loadTasks: async () => {
    try {
      const list = await listTasks();
      set({ tasks: list, loaded: true });
    } catch (e) {
      console.error("[tasks] load failed", e);
      set({ loaded: true });
    }
  },

  addTask: async (text, category) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const record = await createTaskCmd(trimmed, category ?? null);
    set((s) => ({ tasks: [...s.tasks, record] }));
  },

  setTaskCompleted: async (id, completed) => {
    const current = get().tasks.find((t) => t.id === id);
    if (!current) return;
    const updated: TaskRecord = {
      ...current,
      completed,
      completedAt: completed ? new Date().toISOString() : undefined,
    };
    await updateTaskCmd(updated);
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? updated : t)),
    }));
  },

  setTaskCategory: async (id, category) => {
    const current = get().tasks.find((t) => t.id === id);
    if (!current) return;
    const trimmed = category?.trim();
    const next = trimmed ? trimmed : undefined;
    if ((current.category ?? undefined) === next) return;
    const updated: TaskRecord = { ...current, category: next };
    await updateTaskCmd(updated);
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? updated : t)),
    }));
  },

  removeTask: async (id) => {
    await deleteTaskCmd(id);
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  togglePanel: () => {
    const next = !get().panelOpen;
    set({ panelOpen: next });
    void setPreference(PANEL_OPEN_PREF_KEY, next ? "true" : "false");
  },

  setPanelOpen: (open) => {
    set({ panelOpen: open });
    void setPreference(PANEL_OPEN_PREF_KEY, open ? "true" : "false");
  },

  resizePanel: (w) => {
    set({ panelWidth: clampTasksPanelWidth(w) });
  },

  persistPanelWidth: () => {
    void setPreference(PANEL_WIDTH_PREF_KEY, String(get().panelWidth));
  },
}));

export async function hydrateTasksStore(): Promise<void> {
  try {
    const prefs = await getPreferences();
    if (prefs[PANEL_OPEN_PREF_KEY] === "true") {
      useTasksStore.setState({ panelOpen: true });
    }
    const rawWidth = prefs[PANEL_WIDTH_PREF_KEY];
    if (rawWidth) {
      const parsed = Number.parseInt(rawWidth, 10);
      if (Number.isFinite(parsed)) {
        useTasksStore.setState({ panelWidth: clampTasksPanelWidth(parsed) });
      }
    }
  } catch {
    /* ignore */
  }
  // Eagerly fetch the tasks list so the panel renders without a flicker the
  // first time the user opens it.
  void useTasksStore.getState().loadTasks();
}
