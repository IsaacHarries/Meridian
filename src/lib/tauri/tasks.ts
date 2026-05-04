import { invoke } from "@tauri-apps/api/core";

// ── Manual tasks ──────────────────────────────────────────────────────────────

export interface TaskRecord {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  completedAt?: string;
  /** Optional grouping label. Absent / empty = uncategorised. */
  category?: string;
}

export async function listTasks(): Promise<TaskRecord[]> {
  return invoke<TaskRecord[]>("list_tasks");
}

export async function createTask(
  text: string,
  category?: string | null,
): Promise<TaskRecord> {
  return invoke<TaskRecord>("create_task", {
    text,
    // Tauri unwraps `Option<String>` from `null`/missing equivalently; we
    // always send `null` for "uncategorised" so the wire format stays explicit.
    category: category && category.trim() !== "" ? category.trim() : null,
  });
}

export async function updateTask(record: TaskRecord): Promise<TaskRecord> {
  return invoke<TaskRecord>("update_task", { record });
}

export async function deleteTask(id: string): Promise<void> {
  return invoke<void>("delete_task", { id });
}
