// Manual outstanding tasks — small JSON-backed list separate from meetings.
// Each entry is one TODO the user added directly via the Tasks panel. Tasks
// extracted from meeting notes (TipTap taskItem nodes) live inside their
// source meeting and are NOT persisted here; the panel pulls them lazily.

use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub text: String,
    pub completed: bool,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    /// Optional grouping label (e.g. "Work", "Personal"). `None` means
    /// uncategorised. We derive the picker's vocabulary from whatever
    /// strings appear here across all tasks (including completed ones), so
    /// categorising the last task in a group then completing it doesn't
    /// erase the category from the dropdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

pub fn data_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::storage::preferences::resolve_data_dir(app)?.join("tasks.json"))
}

pub fn read_tasks(app: &tauri::AppHandle) -> Result<Vec<TaskRecord>, String> {
    let path = data_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Cannot read tasks file: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Cannot parse tasks file: {e}"))
}

pub fn write_tasks(app: &tauri::AppHandle, tasks: &[TaskRecord]) -> Result<(), String> {
    let path = data_path(app)?;
    let content = serde_json::to_string_pretty(tasks)
        .map_err(|e| format!("Cannot serialise tasks: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("Cannot write tasks file: {e}"))
}
