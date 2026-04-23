use std::fs;
use std::path::PathBuf;
use std::process::Command;
use crate::storage::preferences::resolve_data_dir;

fn filename_for(kind: &str) -> Result<&'static str, String> {
    match kind {
        "acceptance_criteria" => Ok("acceptance_criteria.md"),
        "steps_to_reproduce" => Ok("steps_to_reproduce.md"),
        other => Err(format!("Unknown grooming template kind: '{other}'")),
    }
}

fn templates_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_data_dir(app)?.join("templates");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create templates dir '{}': {e}", dir.display()))?;
    Ok(dir)
}

fn template_path(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    Ok(templates_dir(app)?.join(filename_for(kind)?))
}

/// Internal helper: read a grooming template if it exists and is non-empty,
/// otherwise return None. Used by the Grooming agent when building its system
/// prompt.
pub fn read_grooming_template(app: &tauri::AppHandle, kind: &str) -> Option<String> {
    let path = template_path(app, kind).ok()?;
    if !path.exists() {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(content)
    }
}

#[tauri::command]
pub fn load_grooming_template(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    let path = template_path(&app, &kind)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read grooming template '{}': {e}", path.display()))
}

#[tauri::command]
pub fn save_grooming_template(
    app: tauri::AppHandle,
    kind: String,
    content: String,
) -> Result<(), String> {
    let path = template_path(&app, &kind)?;
    if content.trim().is_empty() {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Cannot delete grooming template: {e}"))?;
        }
        return Ok(());
    }
    fs::write(&path, content)
        .map_err(|e| format!("Cannot write grooming template '{}': {e}", path.display()))
}

#[tauri::command]
pub fn get_grooming_template_path(
    app: tauri::AppHandle,
    kind: String,
) -> Result<String, String> {
    Ok(template_path(&app, &kind)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn reveal_grooming_templates_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = templates_dir(&app)?;
    Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {e}"))?;
    Ok(())
}
