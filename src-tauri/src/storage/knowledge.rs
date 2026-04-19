use serde::{Deserialize, Serialize};
use std::fs;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEntry {
    pub id: String,
    /// "decision" | "pattern" | "learning"
    pub entry_type: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub linked_jira_key: Option<String>,
    pub linked_pr_id: Option<u64>,
}

pub fn data_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create data dir: {e}"))?;
    Ok(dir.join("knowledge.json"))
}

pub fn read_entries(app: &tauri::AppHandle) -> Result<Vec<KnowledgeEntry>, String> {
    let path = data_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Cannot read knowledge file: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Cannot parse knowledge file: {e}"))
}

pub fn write_entries(app: &tauri::AppHandle, entries: &[KnowledgeEntry]) -> Result<(), String> {
    let path = data_path(app)?;
    let content = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("Cannot serialise entries: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("Cannot write knowledge file: {e}"))
}
