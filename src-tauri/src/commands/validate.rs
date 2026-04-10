use reqwest::{Client, StatusCode};
use std::time::Duration;

use super::credentials::store_credential;

fn make_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Validate an Anthropic API key by calling /v1/models.
/// If valid, saves it to the OS keychain and returns a success message.
/// Error messages never contain the key value.
#[tauri::command]
pub async fn validate_anthropic(api_key: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty.".to_string());
    }

    let client = make_client()?;
    let resp = client
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach api.anthropic.com. Check your internet connection.".to_string()
            } else {
                format!("Request failed: {e}")
            }
        })?;

    match resp.status() {
        StatusCode::OK => {
            store_credential("anthropic_api_key", &api_key)?;
            Ok("Connected to Anthropic API successfully.".to_string())
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(
            "Invalid API key. Copy it from platform.claude.com → API Keys.".to_string(),
        ),
        s => Err(format!(
            "Unexpected response from Anthropic ({s}). Please try again."
        )),
    }
}

/// Validate JIRA credentials by calling /rest/api/3/myself.
/// If valid, saves all three values and returns a success message.
#[tauri::command]
pub async fn validate_jira(
    base_url: String,
    email: String,
    api_token: String,
) -> Result<String, String> {
    if base_url.trim().is_empty() || email.trim().is_empty() || api_token.trim().is_empty() {
        return Err("All JIRA fields are required.".to_string());
    }

    let base_url = base_url.trim_end_matches('/').to_string();
    let url = format!("{base_url}/rest/api/3/myself");

    let client = make_client()?;
    let resp = client
        .get(&url)
        .basic_auth(&email, Some(&api_token))
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                format!("Could not reach {base_url}. Check your workspace URL and internet connection.")
            } else {
                format!("Request failed: {e}")
            }
        })?;

    match resp.status() {
        StatusCode::OK => {
            store_credential("jira_base_url", &base_url)?;
            store_credential("jira_email", &email)?;
            store_credential("jira_api_token", &api_token)?;
            Ok("Connected to JIRA successfully.".to_string())
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(
            "Invalid credentials. Check your email and API token at id.atlassian.com/manage-profile/security/api-tokens.".to_string(),
        ),
        StatusCode::NOT_FOUND => Err(
            "JIRA workspace not found. Check your URL (e.g. https://yourcompany.atlassian.net).".to_string(),
        ),
        s => Err(format!(
            "Unexpected response from JIRA ({s}). Please try again."
        )),
    }
}

/// Validate a Bitbucket HTTP access token by calling /2.0/user.
/// If valid, saves the workspace and token. Also auto-saves the username
/// (nickname) fetched from the API — used for PR-for-review filtering.
#[tauri::command]
pub async fn validate_bitbucket(
    workspace: String,
    access_token: String,
) -> Result<String, String> {
    if workspace.trim().is_empty() || access_token.trim().is_empty() {
        return Err("Workspace and access token are required.".to_string());
    }

    let client = make_client()?;
    let resp = client
        .get("https://api.bitbucket.org/2.0/user")
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach api.bitbucket.org. Check your internet connection.".to_string()
            } else {
                format!("Request failed: {e}")
            }
        })?;

    match resp.status() {
        StatusCode::OK => {
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {e}"))?;
            store_credential("bitbucket_workspace", workspace.trim())?;
            store_credential("bitbucket_access_token", access_token.trim())?;
            // Auto-save username (nickname) for PR reviewer filtering.
            if let Some(nickname) = body["nickname"].as_str() {
                let _ = store_credential("bitbucket_username", nickname);
            }
            let display = body["display_name"].as_str().unwrap_or("unknown");
            Ok(format!("Connected to Bitbucket as {display}."))
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(
            "Invalid access token. Check the token at bitbucket.org → Workspace settings → Access tokens.".to_string(),
        ),
        s => Err(format!(
            "Unexpected response from Bitbucket ({s}). Please try again."
        )),
    }
}
