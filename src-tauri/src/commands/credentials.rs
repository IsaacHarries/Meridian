use crate::storage::credentials;
use serde::Serialize;
use std::collections::HashMap;

// ── Allowed keys ───────────────────────────────────────────────────────────────

const ALLOWED_KEYS: &[&str] = &[
    "anthropic_api_key",
    "claude_oauth_json",
    "claude_auth_method",
    "gemini_api_key",
    "gemini_auth_method",
    "gemini_oauth_json",
    "gemini_project_id",
    "ai_provider_order",
    "local_llm_url",
    "local_llm_api_key",
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
    "gemini_auth_method",
    "ai_provider_order",
    "local_llm_url",
    "jira_base_url",
    "jira_email",
    "jira_account_id",
    "bitbucket_workspace",
    "bitbucket_email",
    "bitbucket_username",
];

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
    pub fn anthropic_complete(&self) -> bool {
        self.anthropic_api_key
    }
    pub fn gemini_complete(&self) -> bool {
        self.gemini_api_key
    }
    pub fn local_llm_complete(&self) -> bool {
        self.local_llm_url
    }
    pub fn jira_complete(&self) -> bool {
        self.jira_base_url && self.jira_email && self.jira_api_token && self.jira_board_id
    }
    pub fn bitbucket_complete(&self) -> bool {
        self.bitbucket_workspace
            && self.bitbucket_email
            && self.bitbucket_access_token
            && self.bitbucket_repo_slug
    }
    pub fn all_complete(&self) -> bool {
        self.jira_complete() && self.bitbucket_complete()
    }
}

#[tauri::command]
pub fn credential_status() -> Result<CredentialStatus, String> {
    use crate::storage::preferences::get_pref;
    let has = |k: &str| credentials::cred_get(k).is_some();
    let has_config = |k: &str| get_pref(k).is_some() || credentials::cred_get(k).is_some();
    Ok(CredentialStatus {
        anthropic_api_key: has("anthropic_api_key"),
        gemini_api_key: has("gemini_api_key"),
        local_llm_url: has("local_llm_url"),
        jira_base_url: has("jira_base_url"),
        jira_email: has("jira_email"),
        jira_api_token: has("jira_api_token"),
        jira_board_id: has_config("jira_board_id"),
        bitbucket_workspace: has("bitbucket_workspace"),
        bitbucket_email: has("bitbucket_email"),
        bitbucket_access_token: has("bitbucket_access_token"),
        bitbucket_repo_slug: has_config("bitbucket_repo_slug"),
    })
}

/// Return only non-secret stored values so the UI can pre-populate display fields.
/// Secret keys (API keys, tokens, passwords) are never included.
/// This merges non-secret keys from the credential store with all preference keys.
#[tauri::command]
pub fn get_non_secret_config() -> Result<HashMap<String, String>, String> {
    use super::preferences::get_preferences;
    let cred_map = credentials::load_map();
    let mut out: HashMap<String, String> = NON_SECRET_KEYS
        .iter()
        .filter_map(|&k| {
            cred_map
                .get(k)
                .filter(|v| !v.trim().is_empty())
                .map(|v| (k.to_string(), v.clone()))
        })
        .collect();

    if let Ok(prefs) = get_preferences() {
        out.extend(prefs);
    }

    Ok(out)
}

#[tauri::command]
pub fn save_credential(key: String, value: String) -> Result<(), String> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("Unknown credential key.".to_string());
    }
    credentials::cred_set(&key, &value)
}

#[tauri::command]
pub fn delete_credential(key: String) -> Result<(), String> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("Unknown credential key.".to_string());
    }
    credentials::cred_delete(&key)
}
