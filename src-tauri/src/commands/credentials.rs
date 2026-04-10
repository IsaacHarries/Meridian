use std::collections::HashMap;
use std::fs;
use std::sync::OnceLock;
use serde::Serialize;

static CREDS_FILE: OnceLock<std::path::PathBuf> = OnceLock::new();

/// Call once from the Tauri setup hook before any commands run.
pub fn init_credentials_path(app: &tauri::AppHandle) {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .expect("cannot resolve app data dir");
    fs::create_dir_all(&dir).expect("cannot create app data dir");
    let _ = CREDS_FILE.set(dir.join("credentials.json"));
}

fn creds_file() -> &'static std::path::PathBuf {
    CREDS_FILE.get().expect("credentials path not initialised — call init_credentials_path first")
}

fn read_all() -> HashMap<String, String> {
    let path = creds_file();
    if !path.exists() {
        return HashMap::new();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_all(creds: &HashMap<String, String>) -> Result<(), String> {
    let content = serde_json::to_string_pretty(creds)
        .map_err(|e| format!("Cannot serialise credentials: {e}"))?;
    fs::write(creds_file(), content)
        .map_err(|e| format!("Cannot write credentials file: {e}"))
}

const ALLOWED_KEYS: &[&str] = &[
    "anthropic_api_key",
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
    "jira_base_url",
    "jira_email",
    "jira_board_id",
    "jira_account_id",
    "bitbucket_workspace",
    "bitbucket_email",
    "bitbucket_repo_slug",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub anthropic_api_key: bool,
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
    pub fn jira_complete(&self) -> bool {
        self.jira_base_url && self.jira_email && self.jira_api_token && self.jira_board_id
    }
    pub fn bitbucket_complete(&self) -> bool {
        self.bitbucket_workspace && self.bitbucket_email && self.bitbucket_access_token && self.bitbucket_repo_slug
    }
    pub fn all_complete(&self) -> bool {
        self.anthropic_complete() && self.jira_complete() && self.bitbucket_complete()
    }
}

/// Retrieve a credential for internal backend use only.
/// Never return this value to the frontend.
pub fn get_credential(key: &str) -> Option<String> {
    read_all().remove(key)
}

/// Store a credential. Called by validate commands and save_credential.
pub fn store_credential(key: &str, value: &str) -> Result<(), String> {
    let mut creds = read_all();
    creds.insert(key.to_string(), value.to_string());
    write_all(&creds)
}

#[tauri::command]
pub fn credential_status() -> Result<CredentialStatus, String> {
    let creds = read_all();
    let has = |k: &str| creds.get(k).map(|v| !v.trim().is_empty()).unwrap_or(false);
    Ok(CredentialStatus {
        anthropic_api_key: has("anthropic_api_key"),
        jira_base_url: has("jira_base_url"),
        jira_email: has("jira_email"),
        jira_api_token: has("jira_api_token"),
        jira_board_id: has("jira_board_id"),
        bitbucket_workspace: has("bitbucket_workspace"),
        bitbucket_email: has("bitbucket_email"),
        bitbucket_access_token: has("bitbucket_access_token"),
        bitbucket_repo_slug: has("bitbucket_repo_slug"),
    })
}

/// Return only non-secret stored values so the UI can pre-populate display fields.
/// Secret keys (api keys, tokens, passwords) are never included.
#[tauri::command]
pub fn get_non_secret_config() -> Result<HashMap<String, String>, String> {
    let creds = read_all();
    let result = NON_SECRET_KEYS
        .iter()
        .filter_map(|&k| {
            creds.get(k)
                .filter(|v| !v.trim().is_empty())
                .map(|v| (k.to_string(), v.clone()))
        })
        .collect();
    Ok(result)
}

#[tauri::command]
pub fn save_credential(key: String, value: String) -> Result<(), String> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("Unknown credential key.".to_string());
    }
    store_credential(&key, &value)
}

#[tauri::command]
pub fn delete_credential(key: String) -> Result<(), String> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("Unknown credential key.".to_string());
    }
    let mut creds = read_all();
    creds.remove(&key);
    write_all(&creds)
}
