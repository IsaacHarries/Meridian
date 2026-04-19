use crate::storage::preferences;
use std::collections::HashMap;

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Return all preferences as a key→value map.
#[tauri::command]
pub fn get_preferences() -> Result<HashMap<String, String>, String> {
    Ok(preferences::load_map())
}

/// Set a single preference key. Passing an empty string removes the key.
#[tauri::command]
pub fn set_preference(key: String, value: String) -> Result<(), String> {
    let mut map = preferences::load_map();
    if value.is_empty() {
        map.remove(&key);
    } else {
        map.insert(key, value);
    }
    preferences::save_map(&map)
}

/// Delete a single preference key. No-op if it doesn't exist.
#[tauri::command]
pub fn delete_preference(key: String) -> Result<(), String> {
    let mut map = preferences::load_map();
    map.remove(&key);
    preferences::save_map(&map)
}
