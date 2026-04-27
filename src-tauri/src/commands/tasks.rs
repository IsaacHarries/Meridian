// Tauri command surface for the manual-tasks store. Read-modify-write the
// on-disk JSON each time — the list stays small and atomic writes keep the
// format simple.

use crate::storage::tasks::{self, TaskRecord};

#[tauri::command]
pub fn list_tasks(app: tauri::AppHandle) -> Result<Vec<TaskRecord>, String> {
    tasks::read_tasks(&app)
}

#[tauri::command]
pub fn create_task(app: tauri::AppHandle, text: String) -> Result<TaskRecord, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Task text cannot be empty".into());
    }
    let mut entries = tasks::read_tasks(&app)?;
    let record = TaskRecord {
        id: new_task_id(),
        text: trimmed.to_string(),
        completed: false,
        created_at: now_iso(),
        completed_at: None,
    };
    entries.push(record.clone());
    tasks::write_tasks(&app, &entries)?;
    Ok(record)
}

#[tauri::command]
pub fn update_task(app: tauri::AppHandle, record: TaskRecord) -> Result<TaskRecord, String> {
    let mut entries = tasks::read_tasks(&app)?;
    match entries.iter().position(|e| e.id == record.id) {
        Some(pos) => entries[pos] = record.clone(),
        None => return Err(format!("Task {} not found", record.id)),
    }
    tasks::write_tasks(&app, &entries)?;
    Ok(record)
}

#[tauri::command]
pub fn delete_task(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut entries = tasks::read_tasks(&app)?;
    entries.retain(|e| e.id != id);
    tasks::write_tasks(&app, &entries)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn new_task_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("task-{ms}")
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Inline civil-from-days conversion — same algorithm as meetings.rs's
    // now_iso. Avoids pulling chrono just for this one timestamp.
    let z = secs.div_euclid(86_400) + 719_468;
    let h = secs.rem_euclid(86_400) / 3_600;
    let m = (secs.rem_euclid(3_600)) / 60;
    let s = secs.rem_euclid(60);
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, d, h, m, s
    )
}
