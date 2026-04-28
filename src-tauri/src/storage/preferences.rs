use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
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
                .join("com.meridian.desktop")
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
/// All user-generated files (sprint reports, templates, skills, meetings)
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

/// Tauri command: true when the given directory exists and contains at least
/// one entry. Used by the Settings UI to decide whether to prompt the user
/// about migrating data when they pick a new directory.
#[tauri::command]
pub fn data_directory_has_content(path: String) -> bool {
    let p = Path::new(&path);
    fs::read_dir(p)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
}

/// User-data items rooted at `resolve_data_dir`. Anything outside this list
/// — `preferences.json`, `credentials.bin`, `store_cache/` — is rooted at
/// `app_data_dir` directly and must NOT migrate, otherwise the next launch
/// finds an empty preferences file (and an empty credential store) and
/// re-initialises as if the app had never been opened. The previous
/// implementation moved every entry in the source folder, then removed the
/// folder itself, which deleted those files. Keep this list in sync with
/// every `resolve_data_dir(app)?.join(...)` call site in the backend.
const MIGRATABLE_ITEMS: &[&str] = &[
    "time_tracking.json",
    "tasks.json",
    "skills.json",
    "templates",
    "sprint_reports",
    "trend_analyses",
    "meetings",
    "models",
    "speakers",
];

/// Tauri command: move only the user-data items in `MIGRATABLE_ITEMS` from
/// `from` into `to`. Files that already exist at the destination are left in
/// place (the user's existing files win). The source folder itself is left
/// behind — it is the OS app-data directory, which still hosts the app's
/// preferences and credentials.
#[tauri::command]
pub fn move_data_directory(from: String, to: String) -> Result<(), String> {
    let from = PathBuf::from(from);
    let to = PathBuf::from(to);
    if from == to {
        return Ok(());
    }
    if !from.exists() {
        return Ok(());
    }
    fs::create_dir_all(&to).map_err(|e| format!("Create {}: {e}", to.display()))?;
    for name in MIGRATABLE_ITEMS {
        let src = from.join(name);
        if !src.exists() {
            continue;
        }
        let dst = to.join(name);
        let ft = fs::symlink_metadata(&src)
            .map_err(|e| format!("metadata {}: {e}", src.display()))?
            .file_type();
        if ft.is_dir() {
            fs::create_dir_all(&dst)
                .map_err(|e| format!("Create {}: {e}", dst.display()))?;
            move_dir_contents(&src, &dst)?;
            // Best-effort: remove the now-empty subdir. Failure here just
            // means the user has stray empty folders in the old location;
            // not worth surfacing as an error.
            let _ = fs::remove_dir(&src);
        } else if !dst.exists() {
            // Fast rename, falling back to copy+remove for cross-volume moves.
            if fs::rename(&src, &dst).is_err() {
                fs::copy(&src, &dst)
                    .map_err(|e| format!("Copy {} → {}: {e}", src.display(), dst.display()))?;
                let _ = fs::remove_file(&src);
            }
        }
        // If `dst` exists for a file, we leave both copies in place —
        // overwriting silently could destroy data the user actively wanted
        // in the new location.
    }
    Ok(())
}

fn move_dir_contents(from: &Path, to: &Path) -> Result<(), String> {
    for entry in fs::read_dir(from).map_err(|e| format!("read_dir {}: {e}", from.display()))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let ft = entry
            .file_type()
            .map_err(|e| format!("file_type {}: {e}", src.display()))?;
        if ft.is_dir() {
            fs::create_dir_all(&dst).map_err(|e| format!("Create {}: {e}", dst.display()))?;
            move_dir_contents(&src, &dst)?;
            let _ = fs::remove_dir(&src);
        } else {
            if dst.exists() {
                continue;
            }
            // Try a fast rename first; fall back to copy+remove for cross-volume
            // moves (different filesystems can't be linked atomically).
            if fs::rename(&src, &dst).is_err() {
                fs::copy(&src, &dst)
                    .map_err(|e| format!("Copy {} → {}: {e}", src.display(), dst.display()))?;
                let _ = fs::remove_file(&src);
            }
        }
    }
    Ok(())
}

/// Tauri command: terminate and relaunch the app. Used after the user
/// changes the data directory so cached state is flushed cleanly.
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}
