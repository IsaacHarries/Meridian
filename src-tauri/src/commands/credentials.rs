use std::collections::HashMap;
use std::process::Command;
use serde::Serialize;

/// macOS keychain service name for all Meridian credentials.
const KEYCHAIN_SERVICE: &str = "com.meridian.app";

// ── Low-level keychain helpers ─────────────────────────────────────────────────
//
// All credential I/O goes through the macOS `security` CLI — the same mechanism
// used to read Claude Code's credentials — so tokens are encrypted at rest by the
// OS and never written to disk in plaintext.

fn keychain_get(key: &str) -> Option<String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-a", key, "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if out.status.success() {
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if v.is_empty() { None } else { Some(v) }
    } else {
        None
    }
}

fn keychain_set(key: &str, value: &str) -> Result<(), String> {
    // -U: update the item if it already exists, otherwise create it.
    let out = Command::new("security")
        .args([
            "add-generic-password",
            "-a", key,
            "-s", KEYCHAIN_SERVICE,
            "-w", value,
            "-U",
        ])
        .output()
        .map_err(|e| format!("security command unavailable: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(format!("Keychain write error for '{key}': {stderr}"))
    }
}

fn keychain_delete(key: &str) -> Result<(), String> {
    let out = Command::new("security")
        .args([
            "delete-generic-password",
            "-a", key,
            "-s", KEYCHAIN_SERVICE,
        ])
        .output()
        .map_err(|e| format!("security command unavailable: {e}"))?;

    // Exit code 44 means "item not found" — treat that as success.
    if out.status.success() || out.status.code() == Some(44) {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(format!("Keychain delete error for '{key}': {stderr}"))
    }
}

// ── Allowed keys ───────────────────────────────────────────────────────────────

const ALLOWED_KEYS: &[&str] = &[
    "anthropic_api_key",
    "claude_oauth_json",
    "claude_model",
    "gemini_api_key",
    "gemini_model",
    "ai_provider",
    "ai_provider_order",
    "local_llm_url",
    "local_llm_api_key",
    "local_llm_model",
    "jira_base_url",
    "jira_email",
    "jira_api_token",
    "jira_board_id",
    "jira_account_id",
    "bitbucket_workspace",
    "bitbucket_email",
    "bitbucket_access_token",
    "bitbucket_username",
    "bitbucket_repo_slug",
];

/// Keys whose values may be returned to the frontend (not secrets).
const NON_SECRET_KEYS: &[&str] = &[
    "claude_model",
    "gemini_model",
    "ai_provider",
    "ai_provider_order",
    "local_llm_url",
    "local_llm_model",
    "jira_base_url",
    "jira_email",
    "jira_board_id",
    "jira_account_id",
    "bitbucket_workspace",
    "bitbucket_email",
    "bitbucket_repo_slug",
];

// ── One-time migration ─────────────────────────────────────────────────────────

/// Called once from the Tauri setup hook. If a legacy `credentials.json` file
/// exists in the app data directory, its contents are migrated into the keychain
/// and the file is renamed so the migration only runs once.
pub fn init_credentials_path(app: &tauri::AppHandle) {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .expect("cannot resolve app data dir");
    let _ = std::fs::create_dir_all(&dir);

    let json_path = dir.join("credentials.json");
    if !json_path.exists() {
        return;
    }

    // Best-effort migration: read each key from the JSON file and write it to
    // the keychain. Silently skip any key that fails — the user can re-enter it.
    if let Ok(content) = std::fs::read_to_string(&json_path) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&content) {
            for (key, value) in &map {
                if ALLOWED_KEYS.contains(&key.as_str()) && !value.trim().is_empty() {
                    let _ = keychain_set(key, value);
                }
            }
        }
    }

    // Rename so we don't re-migrate on the next launch.
    let _ = std::fs::rename(&json_path, dir.join("credentials.json.migrated"));
}

// ── Internal helpers (used by other backend modules) ──────────────────────────

/// Retrieve a credential for internal backend use only.
/// Never return this value to the frontend.
pub fn get_credential(key: &str) -> Option<String> {
    keychain_get(key)
}

/// Store a credential. Called by validate commands and save_credential.
pub fn store_credential(key: &str, value: &str) -> Result<(), String> {
    keychain_set(key, value)
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
        self.anthropic_complete() && self.jira_complete() && self.bitbucket_complete()
    }
}

#[tauri::command]
pub fn credential_status() -> Result<CredentialStatus, String> {
    let has = |k: &str| keychain_get(k).map(|v| !v.trim().is_empty()).unwrap_or(false);
    Ok(CredentialStatus {
        anthropic_api_key: has("anthropic_api_key"),
        gemini_api_key:    has("gemini_api_key"),
        local_llm_url:     has("local_llm_url"),
        jira_base_url:     has("jira_base_url"),
        jira_email:        has("jira_email"),
        jira_api_token:    has("jira_api_token"),
        jira_board_id:     has("jira_board_id"),
        bitbucket_workspace:    has("bitbucket_workspace"),
        bitbucket_email:        has("bitbucket_email"),
        bitbucket_access_token: has("bitbucket_access_token"),
        bitbucket_repo_slug:    has("bitbucket_repo_slug"),
    })
}

/// Return only non-secret stored values so the UI can pre-populate display fields.
/// Secret keys (API keys, tokens, passwords) are never included.
#[tauri::command]
pub fn get_non_secret_config() -> Result<HashMap<String, String>, String> {
    let result = NON_SECRET_KEYS
        .iter()
        .filter_map(|&k| {
            keychain_get(k)
                .filter(|v| !v.trim().is_empty())
                .map(|v| (k.to_string(), v))
        })
        .collect();
    Ok(result)
}

#[tauri::command]
pub fn save_credential(key: String, value: String) -> Result<(), String> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("Unknown credential key.".to_string());
    }
    keychain_set(&key, &value)
}

#[tauri::command]
pub fn delete_credential(key: String) -> Result<(), String> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("Unknown credential key.".to_string());
    }
    keychain_delete(&key)
}
