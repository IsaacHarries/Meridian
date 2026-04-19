use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use serde::Serialize;

// ── Storage file path ─────────────────────────────────────────────────────────

static STORE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Called once from the Tauri setup hook to record the app data directory.
pub fn init_store_path(app: &tauri::AppHandle) {
    use tauri::Manager;
    let dir = app.path().app_data_dir().expect("cannot resolve app data dir");
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
//
// Credentials are stored as AES-256-GCM encrypted JSON.
// The key is derived from the machine's hardware UUID (read once via ioreg,
// then cached in a OnceLock) — no keychain, no code-signing requirement.
// File layout: [12-byte random nonce][ciphertext+tag]

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
    // Fallback: hostname
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
    if data.len() < 12 { return None; }
    let (nonce_bytes, ct) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(&machine_key()).ok()?;
    cipher.decrypt(Nonce::from_slice(nonce_bytes), ct).ok()
}

// ── Read / write the credential map ──────────────────────────────────────────

fn load_map() -> HashMap<String, String> {
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

fn save_map(map: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_vec(map).map_err(|e| format!("Serialisation error: {e}"))?;
    let enc = encrypt(&json);
    std::fs::write(store_path(), enc)
        .map_err(|e| format!("Failed to write credential store: {e}"))
}

// ── Low-level CRUD ────────────────────────────────────────────────────────────

fn cred_get(key: &str) -> Option<String> {
    load_map().remove(key).filter(|v| !v.trim().is_empty())
}

fn cred_set(key: &str, value: &str) -> Result<(), String> {
    let mut map = load_map();
    map.insert(key.to_string(), value.to_string());
    save_map(&map)
}

fn cred_delete(key: &str) -> Result<(), String> {
    let mut map = load_map();
    map.remove(key);
    save_map(&map)
}

// ── Allowed keys ───────────────────────────────────────────────────────────────

const ALLOWED_KEYS: &[&str] = &[
    "anthropic_api_key",
    "claude_oauth_json",
    "claude_auth_method",
    "claude_model",
    "gemini_api_key",
    "gemini_model",
    "gemini_auth_method",
    "gemini_oauth_json",
    "gemini_project_id",
    "ai_provider",
    "ai_provider_order",
    "local_llm_url",
    "local_llm_api_key",
    "local_llm_model",
    "jira_base_url",
    "jira_email",
    "jira_api_token",
    "jira_account_id",
    "bitbucket_workspace",
    "bitbucket_email",
    "bitbucket_access_token",
    "bitbucket_username",
];

/// Keys whose values may be returned to the frontend (not secrets).
const NON_SECRET_KEYS: &[&str] = &[
    "claude_auth_method",
    "claude_model",
    "gemini_model",
    "gemini_auth_method",
    "ai_provider",
    "ai_provider_order",
    "local_llm_url",
    "local_llm_model",
    "jira_base_url",
    "jira_email",
    "jira_account_id",
    "bitbucket_workspace",
    "bitbucket_email",
    "bitbucket_username",
];

// ── Internal helpers (used by other backend modules) ──────────────────────────

/// Retrieve a credential for internal backend use only.
/// Never return this value to the frontend.
pub fn get_credential(key: &str) -> Option<String> {
    cred_get(key)
}

/// Store a credential. Called by validate commands and save_credential.
pub fn store_credential(key: &str, value: &str) -> Result<(), String> {
    cred_set(key, value)
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub anthropic_api_key: bool,
    pub gemini_api_key: bool,
    pub local_llm_url: bool,
    pub jira_base_url: bool,
    pub jira_email: bool,
    pub jira_api_token: bool,
    pub jira_board_id: bool,
    pub bitbucket_workspace: bool,
    pub bitbucket_email: bool,
    pub bitbucket_access_token: bool,
    pub bitbucket_repo_slug: bool,
}

impl CredentialStatus {
    pub fn anthropic_complete(&self) -> bool { self.anthropic_api_key }
    pub fn gemini_complete(&self) -> bool { self.gemini_api_key }
    pub fn local_llm_complete(&self) -> bool { self.local_llm_url }
    pub fn jira_complete(&self) -> bool {
        self.jira_base_url && self.jira_email && self.jira_api_token && self.jira_board_id
    }
    pub fn bitbucket_complete(&self) -> bool {
        self.bitbucket_workspace && self.bitbucket_email
            && self.bitbucket_access_token && self.bitbucket_repo_slug
    }
    pub fn all_complete(&self) -> bool {
        self.jira_complete() && self.bitbucket_complete()
    }
}

#[tauri::command]
pub fn credential_status() -> Result<CredentialStatus, String> {
    use super::preferences::get_pref;
    let has = |k: &str| cred_get(k).is_some();
    let has_config = |k: &str| get_pref(k).is_some() || cred_get(k).is_some();
    Ok(CredentialStatus {
        anthropic_api_key: has("anthropic_api_key"),
        gemini_api_key:    has("gemini_api_key"),
        local_llm_url:     has("local_llm_url"),
        jira_base_url:     has("jira_base_url"),
        jira_email:        has("jira_email"),
        jira_api_token:    has("jira_api_token"),
        jira_board_id:     has_config("jira_board_id"),
        bitbucket_workspace:    has("bitbucket_workspace"),
        bitbucket_email:        has("bitbucket_email"),
        bitbucket_access_token: has("bitbucket_access_token"),
        bitbucket_repo_slug:    has_config("bitbucket_repo_slug"),
    })
}

/// Return only non-secret stored values so the UI can pre-populate display fields.
/// Secret keys (API keys, tokens, passwords) are never included.
#[tauri::command]
pub fn get_non_secret_config() -> Result<HashMap<String, String>, String> {
    let map = load_map();
    Ok(NON_SECRET_KEYS
        .iter()
        .filter_map(|&k| {
            map.get(k)
                .filter(|v| !v.trim().is_empty())
                .map(|v| (k.to_string(), v.clone()))
        })
        .collect())
}

#[tauri::command]
pub fn save_credential(key: String, value: String) -> Result<(), String> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("Unknown credential key.".to_string());
    }
    cred_set(&key, &value)
}

#[tauri::command]
pub fn delete_credential(key: String) -> Result<(), String> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("Unknown credential key.".to_string());
    }
    cred_delete(&key)
}
