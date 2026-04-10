use std::collections::HashMap;
use std::fs;
use tauri::Manager;

/// Valid skill type keys.
const SKILL_TYPES: &[&str] = &["grooming", "patterns", "implementation", "review"];

fn skills_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create data dir: {e}"))?;
    Ok(dir.join("skills.json"))
}

fn read_skills(app: &tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let path = skills_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Cannot read skills file: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Cannot parse skills file: {e}"))
}

fn write_skills(app: &tauri::AppHandle, skills: &HashMap<String, String>) -> Result<(), String> {
    let path = skills_path(app)?;
    let content = serde_json::to_string_pretty(skills)
        .map_err(|e| format!("Cannot serialise skills: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("Cannot write skills file: {e}"))
}

/// Load all agent skills. Returns a map of skill_type → content.
#[tauri::command]
pub fn load_agent_skills(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    read_skills(&app)
}

/// Save one agent skill. skill_type must be one of: grooming, patterns, implementation, review.
#[tauri::command]
pub fn save_agent_skill(
    app: tauri::AppHandle,
    skill_type: String,
    content: String,
) -> Result<(), String> {
    if !SKILL_TYPES.contains(&skill_type.as_str()) {
        return Err(format!("Unknown skill type: {skill_type}"));
    }
    let mut skills = read_skills(&app)?;
    skills.insert(skill_type, content);
    write_skills(&app, &skills)
}

/// Delete one agent skill.
#[tauri::command]
pub fn delete_agent_skill(app: tauri::AppHandle, skill_type: String) -> Result<(), String> {
    let mut skills = read_skills(&app)?;
    skills.remove(&skill_type);
    write_skills(&app, &skills)
}
