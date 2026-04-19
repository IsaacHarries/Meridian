use std::collections::HashMap;
use std::fs;
use tauri::Manager;

/// Resolve the cache directory, creating it if needed.
pub fn cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    let dir = base.join("store_cache");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create store cache dir: {e}"))?;
    Ok(dir)
}

/// Sanitise `key` so it is safe to use as a filename.
/// Replaces anything that isn't alphanumeric, `-`, or `_` with `_`.
pub fn safe_filename(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        + ".json"
}

pub fn save_cache(app: &tauri::AppHandle, key: String, json: String) -> Result<(), String> {
    let path = cache_dir(app)?.join(safe_filename(&key));
    fs::write(&path, json.as_bytes()).map_err(|e| format!("Cannot write store cache '{key}': {e}"))
}

pub fn load_cache(app: &tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let path = cache_dir(app)?.join(safe_filename(&key));
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Cannot read store cache '{key}': {e}"))?;
    Ok(Some(content))
}

pub fn delete_cache(app: &tauri::AppHandle, key: String) -> Result<(), String> {
    let path = cache_dir(app)?.join(safe_filename(&key));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Cannot delete store cache '{key}': {e}"))?;
    }
    Ok(())
}

pub fn get_info(app: &tauri::AppHandle) -> Result<HashMap<String, u64>, String> {
    let dir = cache_dir(app)?;
    let mut info: HashMap<String, u64> = HashMap::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(info), // directory might not exist yet
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(meta) = fs::metadata(&path) {
            let key = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            info.insert(key, meta.len());
        }
    }
    Ok(info)
}

pub fn clear_all(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = cache_dir(app)?;
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(()), // nothing to clear
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            fs::remove_file(&path)
                .map_err(|e| format!("Cannot delete cache file {:?}: {e}", path))?;
        }
    }
    Ok(())
}
