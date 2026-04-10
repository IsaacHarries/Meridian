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

fn data_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create data dir: {e}"))?;
    Ok(dir.join("knowledge.json"))
}

fn read_entries(app: &tauri::AppHandle) -> Result<Vec<KnowledgeEntry>, String> {
    let path = data_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Cannot read knowledge file: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Cannot parse knowledge file: {e}"))
}

fn write_entries(app: &tauri::AppHandle, entries: &[KnowledgeEntry]) -> Result<(), String> {
    let path = data_path(app)?;
    let content =
        serde_json::to_string_pretty(entries).map_err(|e| format!("Cannot serialise entries: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("Cannot write knowledge file: {e}"))
}

#[tauri::command]
pub fn load_knowledge_entries(app: tauri::AppHandle) -> Result<Vec<KnowledgeEntry>, String> {
    read_entries(&app)
}

#[tauri::command]
pub fn save_knowledge_entry(app: tauri::AppHandle, entry: KnowledgeEntry) -> Result<(), String> {
    let mut entries = read_entries(&app)?;
    match entries.iter().position(|e| e.id == entry.id) {
        Some(pos) => entries[pos] = entry,
        None => entries.push(entry),
    }
    // Keep most-recently-updated first
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    write_entries(&app, &entries)
}

#[tauri::command]
pub fn delete_knowledge_entry(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut entries = read_entries(&app)?;
    entries.retain(|e| e.id != id);
    write_entries(&app, &entries)
}

#[tauri::command]
pub fn export_knowledge_markdown(
    app: tauri::AppHandle,
    ids: Option<Vec<String>>,
) -> Result<String, String> {
    let entries = read_entries(&app)?;
    let selected: Vec<&KnowledgeEntry> = match &ids {
        Some(id_list) => entries.iter().filter(|e| id_list.contains(&e.id)).collect(),
        None => entries.iter().collect(),
    };

    let mut md = String::from("# Knowledge Base Export\n\n");
    for entry in selected {
        md.push_str(&format!("## {}\n\n", entry.title));
        md.push_str(&format!("**Type**: {}  \n", entry.entry_type));
        if !entry.tags.is_empty() {
            md.push_str(&format!("**Tags**: {}  \n", entry.tags.join(", ")));
        }
        if let Some(key) = &entry.linked_jira_key {
            md.push_str(&format!("**JIRA**: {}  \n", key));
        }
        if let Some(pr) = entry.linked_pr_id {
            md.push_str(&format!("**PR**: #{}  \n", pr));
        }
        md.push_str(&format!("**Created**: {}  \n\n", entry.created_at));
        md.push_str(&entry.body);
        md.push_str("\n\n---\n\n");
    }
    Ok(md)
}
