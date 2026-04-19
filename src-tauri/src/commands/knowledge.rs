use crate::storage::knowledge::{self, KnowledgeEntry};

#[tauri::command]
pub fn load_knowledge_entries(app: tauri::AppHandle) -> Result<Vec<KnowledgeEntry>, String> {
    knowledge::read_entries(&app)
}

#[tauri::command]
pub fn save_knowledge_entry(app: tauri::AppHandle, entry: KnowledgeEntry) -> Result<(), String> {
    let mut entries = knowledge::read_entries(&app)?;
    match entries.iter().position(|e| e.id == entry.id) {
        Some(pos) => entries[pos] = entry,
        None => entries.push(entry),
    }
    // Keep most-recently-updated first
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    knowledge::write_entries(&app, &entries)
}

#[tauri::command]
pub fn delete_knowledge_entry(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut entries = knowledge::read_entries(&app)?;
    entries.retain(|e| e.id != id);
    knowledge::write_entries(&app, &entries)
}

#[tauri::command]
pub fn export_knowledge_markdown(
    app: tauri::AppHandle,
    ids: Option<Vec<String>>,
) -> Result<String, String> {
    let entries = knowledge::read_entries(&app)?;
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
