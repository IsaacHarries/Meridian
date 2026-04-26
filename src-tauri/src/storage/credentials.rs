use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::storage::crypto;

// Domain separator for the credential store's derived key. Must not
// change — existing on-disk credentials are encrypted under this domain.
const DOMAIN: &str = "meridian-credential-store-v1:";

// ── Storage file path ─────────────────────────────────────────────────────────

static STORE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Called once from the Tauri setup hook to record the app data directory.
pub fn init_store_path(app: &tauri::AppHandle) {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .expect("cannot resolve app data dir");
    let _ = std::fs::create_dir_all(&dir);
    let mut guard = STORE_PATH.lock().expect("store path mutex poisoned");
    *guard = Some(dir.join("credentials.bin"));
}

fn store_path() -> PathBuf {
    STORE_PATH
        .lock()
        .expect("store path mutex poisoned")
        .clone()
        .unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("com.meridian.desktop")
                .join("credentials.bin")
        })
}

// ── Read / write the credential map ──────────────────────────────────────────

pub fn load_map() -> HashMap<String, String> {
    let data = match std::fs::read(store_path()) {
        Ok(d) => d,
        Err(_) => return HashMap::new(),
    };
    let plain = match crypto::decrypt(DOMAIN, &data) {
        Some(p) => p,
        None => return HashMap::new(),
    };
    serde_json::from_slice(&plain).unwrap_or_default()
}

pub fn save_map(map: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_vec(map).map_err(|e| format!("Serialisation error: {e}"))?;
    let enc = crypto::encrypt(DOMAIN, &json);
    std::fs::write(store_path(), enc).map_err(|e| format!("Failed to write credential store: {e}"))
}

// ── Low-level CRUD ────────────────────────────────────────────────────────────

pub fn cred_get(key: &str) -> Option<String> {
    load_map().remove(key).filter(|v| !v.trim().is_empty())
}

pub fn cred_set(key: &str, value: &str) -> Result<(), String> {
    let mut map = load_map();
    map.insert(key.to_string(), value.to_string());
    save_map(&map)
}

pub fn cred_delete(key: &str) -> Result<(), String> {
    let mut map = load_map();
    map.remove(key);
    save_map(&map)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

pub fn get_credential(key: &str) -> Option<String> {
    cred_get(key)
}

pub fn store_credential(key: &str, value: &str) -> Result<(), String> {
    cred_set(key, value)
}
