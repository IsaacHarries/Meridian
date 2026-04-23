use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

// ── Path cache (set once during Tauri setup) ──────────────────────────────────

static PREFS_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Called once from the Tauri setup hook, alongside `credentials::init_store_path`.
pub fn init_prefs_path(app: &tauri::AppHandle) {
    let dir = app
        .path()
        .app_data_dir()
        .expect("cannot resolve app data dir");
    let _ = fs::create_dir_all(&dir);
    let mut guard = PREFS_PATH.lock().expect("prefs path mutex poisoned");
    *guard = Some(dir.join("preferences.json"));
}

pub fn prefs_path() -> PathBuf {
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

pub fn load_map() -> HashMap<String, String> {
    let path = prefs_path();
    if !path.exists() {
        return HashMap::new();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_map(map: &HashMap<String, String>) -> Result<(), String> {
    let path = prefs_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create prefs dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(map)
        .map_err(|e| format!("Cannot serialise preferences: {e}"))?;
    fs::write(&path, json.as_bytes()).map_err(|e| format!("Cannot write preferences: {e}"))
}

// ── Internal helper ───────────────────────────────────────────────────────────

/// Read a single preference key. Returns `None` if absent or file unreadable.
/// No AppHandle needed — uses the cached path set during setup.
pub fn get_pref(key: &str) -> Option<String> {
    load_map()
        .get(key)
        .filter(|v| !v.trim().is_empty())
        .cloned()
}

// ── Data directory ────────────────────────────────────────────────────────────

/// Returns the user-configured data directory, or the app data dir as fallback.
/// All user-generated files (sprint reports, templates, skills, knowledge base)
/// are stored relative to this root.
pub fn resolve_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = get_pref("data_dir") {
        let p = PathBuf::from(custom.trim());
        if !p.as_os_str().is_empty() {
            fs::create_dir_all(&p)
                .map_err(|e| format!("Cannot create data dir '{}': {e}", p.display()))?;
            return Ok(p);
        }
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create app data dir: {e}"))?;
    Ok(dir)
}

/// Tauri command: return the resolved data directory path for display in Settings.
#[tauri::command]
pub fn get_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(resolve_data_dir(&app)?.to_string_lossy().into_owned())
}
