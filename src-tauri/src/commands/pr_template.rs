use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

/// The PR description template lives at `<app_data_dir>/templates/pr_description.md`.
/// This is a sibling of the `sprint_reports/` directory, not inside it, because
/// the template is an input for the agent rather than a generated artifact.
fn template_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    let dir = base.join("templates");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create templates dir '{}': {e}", dir.display()))?;
    Ok(dir)
}

fn template_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(template_dir(app)?.join("pr_description.md"))
}

/// Internal helper: read the template if it exists and is non-empty, otherwise
/// return None. Used by the PR Description agent.
pub fn read_pr_template(app: &tauri::AppHandle) -> Option<String> {
    let path = template_path(app).ok()?;
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

/// Load the PR description template. Returns an empty string if the file has
/// not been created yet — the frontend treats this as "no template set".
#[tauri::command]
pub fn load_pr_template(app: tauri::AppHandle) -> Result<String, String> {
    let path = template_path(&app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read PR template file '{}': {e}", path.display()))
}

/// Save the PR description template. Empty/whitespace content deletes the
/// file so `read_pr_template` cleanly reports "no template".
#[tauri::command]
pub fn save_pr_template(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let path = template_path(&app)?;
    if content.trim().is_empty() {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Cannot delete PR template file: {e}"))?;
        }
        return Ok(());
    }
    fs::write(&path, content)
        .map_err(|e| format!("Cannot write PR template file '{}': {e}", path.display()))
}

/// Return the absolute path to the PR template file (for display in Settings).
#[tauri::command]
pub fn get_pr_template_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(template_path(&app)?.to_string_lossy().into_owned())
}

/// Open the containing folder in the OS file manager so the user can edit the
/// template externally. macOS-only (`open` command) — matches the rest of the
/// codebase.
#[tauri::command]
pub fn reveal_pr_template_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = template_dir(&app)?;
    Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {e}"))?;
    Ok(())
}
