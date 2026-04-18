/// User preferences store — plain JSON, not encrypted.
///
/// Distinct from the credential store (encrypted, for secrets) and the Zustand
/// store cache (clearable, for ephemeral UI state). Preferences are non-secret
/// configuration values the user sets explicitly and expects to persist across
/// cache clears (e.g. worktree paths, board ID, terminal preference).
///
/// Stored as a single `preferences.json` file in the app data directory.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

// ── Path cache (set once during Tauri setup) ──────────────────────────────────

static PREFS_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Called once from the Tauri setup hook, alongside `credentials::init_store_path`.
pub fn init_prefs_path(app: &tauri::AppHandle) {
    let dir = app.path().app_data_dir().expect("cannot resolve app data dir");
    let _ = fs::create_dir_all(&dir);
    let mut guard = PREFS_PATH.lock().expect("prefs path mutex poisoned");
    *guard = Some(dir.join("preferences.json"));
}

fn prefs_path() -> PathBuf {
    PREFS_PATH
        .lock()
        .expect("prefs path mutex poisoned")
        .clone()
        .unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("com.meridian.app")
                .join("preferences.json")
        })
}

// ── Read / write ──────────────────────────────────────────────────────────────

fn load_map() -> HashMap<String, String> {
    let path = prefs_path();
    if !path.exists() {
        return HashMap::new();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_map(map: &HashMap<String, String>) -> Result<(), String> {
    let path = prefs_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create prefs dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(map)
        .map_err(|e| format!("Cannot serialise preferences: {e}"))?;
    fs::write(&path, json.as_bytes())
        .map_err(|e| format!("Cannot write preferences: {e}"))
}

// ── Internal helper ───────────────────────────────────────────────────────────

/// Read a single preference key. Returns `None` if absent or file unreadable.
/// No AppHandle needed — uses the cached path set during setup.
pub fn get_pref(key: &str) -> Option<String> {
    load_map().get(key).filter(|v| !v.trim().is_empty()).cloned()
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Return all preferences as a key→value map.
#[tauri::command]
pub fn get_preferences() -> Result<HashMap<String, String>, String> {
    Ok(load_map())
}

/// Set a single preference key. Passing an empty string removes the key.
#[tauri::command]
pub fn set_preference(key: String, value: String) -> Result<(), String> {
    let mut map = load_map();
    if value.is_empty() {
        map.remove(&key);
    } else {
        map.insert(key, value);
    }
    save_map(&map)
}

/// Delete a single preference key. No-op if it doesn't exist.
#[tauri::command]
pub fn delete_preference(key: String) -> Result<(), String> {
    let mut map = load_map();
    map.remove(&key);
    save_map(&map)
}
