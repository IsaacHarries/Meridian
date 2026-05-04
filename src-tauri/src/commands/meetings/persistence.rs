// CRUD-shaped Tauri commands for saved meetings. Reads and writes the JSON
// records under {data_dir}/meetings/, plus a few thin wrappers around the
// storage::meeting_index module so the UI can reindex / wipe embeddings /
// inspect index status without reaching into storage directly.

use std::fs;

use super::_shared::{
    meeting_path, meetings_dir, new_meeting_id, now_iso, write_meeting, ACTIVE,
};
use super::types::{MeetingKind, MeetingRecord};

#[tauri::command]
pub fn save_meeting(app: tauri::AppHandle, record: MeetingRecord) -> Result<(), String> {
    write_meeting(&app, &record)
}

/// Create a new "notes mode" meeting — no audio, no transcript. The user types
/// freeform text into the notes field after creation. Returns the freshly
/// written record so the UI can select it immediately.
#[tauri::command]
pub fn create_notes_meeting(
    app: tauri::AppHandle,
    title: String,
    tags: Vec<String>,
) -> Result<MeetingRecord, String> {
    let record = MeetingRecord {
        id: new_meeting_id(),
        title,
        started_at: now_iso(),
        ended_at: None,
        duration_sec: 0,
        mic_device_name: String::new(),
        model: String::new(),
        tags,
        segments: Vec::new(),
        summary: None,
        action_items: Vec::new(),
        decisions: Vec::new(),
        per_person: Vec::new(),
        suggested_title: None,
        suggested_tags: Vec::new(),
        chat_history: Vec::new(),
        speakers: Vec::new(),
        kind: MeetingKind::Notes,
        notes: Some(String::new()),
    };
    write_meeting(&app, &record)?;
    Ok(record)
}

/// Save freeform notes text for a notes-mode meeting. Returns the updated
/// record so the caller can refresh state. Loading-then-writing keeps the rest
/// of the on-disk record (tags, summary, etc.) untouched.
#[tauri::command]
pub fn update_meeting_notes(
    app: tauri::AppHandle,
    meeting_id: String,
    notes: String,
) -> Result<MeetingRecord, String> {
    let path = meeting_path(&app, &meeting_id)?;
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Read {}: {e}", path.display()))?;
    let mut record: MeetingRecord = serde_json::from_str(&content)
        .map_err(|e| format!("Parse {}: {e}", path.display()))?;
    record.notes = Some(notes);
    write_meeting(&app, &record)?;
    Ok(record)
}

#[tauri::command]
pub fn load_meeting(app: tauri::AppHandle, id: String) -> Result<MeetingRecord, String> {
    let path = meeting_path(&app, &id)?;
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Read {}: {e}", path.display()))?;
    serde_json::from_str(&content).map_err(|e| format!("Parse {}: {e}", path.display()))
}

#[tauri::command]
pub fn list_meetings(app: tauri::AppHandle) -> Result<Vec<MeetingRecord>, String> {
    let dir = meetings_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if !s.ends_with(".json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(entry.path()) {
            if let Ok(record) = serde_json::from_str::<MeetingRecord>(&content) {
                out.push(record);
            }
        }
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

#[tauri::command]
pub fn delete_meeting(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = meeting_path(&app, &id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    if let Err(e) = crate::storage::meeting_index::delete_meeting_from_index(&id) {
        eprintln!("[meeting-index] failed to remove {id} from index: {e}");
    }
    Ok(())
}

/// Drop and rebuild the entire search index from the on-disk JSON
/// meetings. Settings → Meetings exposes this as a button — useful
/// after switching embedding model (existing embeddings get cleared
/// here as a side-effect of re-indexing) or recovering from a
/// corrupted index file.
#[tauri::command]
pub fn reindex_all_meetings(app: tauri::AppHandle) -> Result<i64, String> {
    let dir = meetings_dir(&app)?;
    let mut count: i64 = 0;
    for entry in fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if !s.ends_with(".json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(entry.path()) {
            if let Ok(record) = serde_json::from_str::<MeetingRecord>(&content) {
                if let Err(e) = crate::storage::meeting_index::index_meeting(&record) {
                    eprintln!(
                        "[meeting-index] reindex failed for {}: {e}",
                        record.id
                    );
                    continue;
                }
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Read the current index status — total / embedded segment counts.
/// Settings polls this so the user can watch the backfill progress.
#[tauri::command]
pub fn meetings_index_status() -> Result<crate::storage::meeting_index::IndexStatus, String> {
    crate::storage::meeting_index::index_status()
}

/// Wipe every embedding (but keep keyword index intact). Triggered
/// when the user changes the embedding-model preference — embeddings
/// from different models live in different vector spaces and can't
/// be mixed.
#[tauri::command]
pub fn clear_meetings_embeddings() -> Result<(), String> {
    crate::storage::meeting_index::clear_all_embeddings()
}

#[tauri::command]
pub fn get_meetings_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(meetings_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn active_meeting_id() -> Result<Option<String>, String> {
    let guard = ACTIVE.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    Ok(guard.as_ref().map(|s| s.meeting_id.clone()))
}
