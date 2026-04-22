use crate::storage::preferences::get_pref;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// Returns the sprint reports directory — user-configured or defaults to
/// `app_data_dir/sprint_reports/`.
fn reports_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = if let Some(custom) = get_pref("sprint_reports_dir") {
        let p = PathBuf::from(custom.trim());
        if p.as_os_str().is_empty() {
            default_dir(app)?
        } else {
            p
        }
    } else {
        default_dir(app)?
    };
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create sprint reports dir '{}': {e}", dir.display()))?;
    Ok(dir)
}

fn default_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    Ok(base.join("sprint_reports"))
}

/// Persist a sprint report to disk. `data_json` is the serialised SprintData
/// from the frontend (issues + prs + cachedAt).
#[tauri::command]
pub fn save_sprint_report(
    app: tauri::AppHandle,
    sprint_id: i64,
    data_json: String,
) -> Result<(), String> {
    let path = reports_dir(&app)?.join(format!("{sprint_id}.json"));
    fs::write(&path, data_json)
        .map_err(|e| format!("Cannot write sprint report for {sprint_id}: {e}"))
}

/// Load a previously cached sprint report. Returns None when no file exists.
#[tauri::command]
pub fn load_sprint_report(
    app: tauri::AppHandle,
    sprint_id: i64,
) -> Result<Option<String>, String> {
    let path = reports_dir(&app)?.join(format!("{sprint_id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read sprint report for {sprint_id}: {e}"))?;
    Ok(Some(content))
}

/// List all sprint IDs that have a cached report on disk.
#[tauri::command]
pub fn list_cached_sprint_ids(app: tauri::AppHandle) -> Result<Vec<i64>, String> {
    let dir = reports_dir(&app)?;
    let mut ids: Vec<i64> = Vec::new();
    for entry in fs::read_dir(&dir)
        .map_err(|e| format!("Cannot read sprint reports dir: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Dir read error: {e}"))?;
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if let Some(stem) = s.strip_suffix(".json") {
            if let Ok(id) = stem.parse::<i64>() {
                ids.push(id);
            }
        }
    }
    ids.sort_unstable();
    Ok(ids)
}

/// Return the resolved sprint reports directory path (for display in Settings).
#[tauri::command]
pub fn get_sprint_reports_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(reports_dir(&app)?.to_string_lossy().into_owned())
}
