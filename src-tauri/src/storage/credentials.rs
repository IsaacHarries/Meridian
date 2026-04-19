use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};

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
                .join("com.meridian.app")
                .join("credentials.bin")
        })
}

// ── Encryption ────────────────────────────────────────────────────────────────

fn machine_key() -> [u8; 32] {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    *KEY.get_or_init(|| {
        let uuid = machine_uuid();
        let mut h = Sha256::new();
        h.update(b"meridian-credential-store-v1:");
        h.update(uuid.as_bytes());
        h.finalize().into()
    })
}

fn machine_uuid() -> String {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        if let Ok(out) = Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if line.contains("IOPlatformUUID") {
                    let parts: Vec<&str> = line.splitn(2, '=').collect();
                    if let Some(rhs) = parts.get(1) {
                        let uuid = rhs.trim().trim_matches('"').trim().to_string();
                        if !uuid.is_empty() {
                            return uuid;
                        }
                    }
                }
            }
        }
    }
    std::process::Command::new("hostname")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "meridian-default-host".to_string())
}

fn encrypt(plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(&machine_key()).expect("key is 32 bytes");
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut ct = cipher.encrypt(nonce, plaintext).expect("encryption failed");
    let mut out = nonce_bytes.to_vec();
    out.append(&mut ct);
    out
}

fn decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 12 {
        return None;
    }
    let (nonce_bytes, ct) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(&machine_key()).ok()?;
    cipher.decrypt(Nonce::from_slice(nonce_bytes), ct).ok()
}

// ── Read / write the credential map ──────────────────────────────────────────

pub fn load_map() -> HashMap<String, String> {
    let data = match std::fs::read(store_path()) {
        Ok(d) => d,
        Err(_) => return HashMap::new(),
    };
    let plain = match decrypt(&data) {
        Some(p) => p,
        None => return HashMap::new(),
    };
    serde_json::from_slice(&plain).unwrap_or_default()
}

pub fn save_map(map: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_vec(map).map_err(|e| format!("Serialisation error: {e}"))?;
    let enc = encrypt(&json);
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
