use reqwest::StatusCode;

use super::_shared::make_client;
use crate::storage::credentials::get_credential;

/// Test Bitbucket connectivity using the provided credentials.
/// Credentials are saved separately via save_credential.
#[tauri::command]
pub async fn validate_bitbucket(
    workspace: String,
    email: String,
    access_token: String,
) -> Result<String, String> {
    if workspace.trim().is_empty() || email.trim().is_empty() || access_token.trim().is_empty() {
        return Err("Workspace, email, and access token are required.".to_string());
    }
    test_bitbucket_connection(&workspace, &email, &access_token).await
}

/// Test the already-stored Bitbucket credentials without accepting secrets from the frontend.
#[tauri::command]
pub async fn test_bitbucket_stored() -> Result<String, String> {
    let workspace = get_credential("bitbucket_workspace")
        .ok_or("No Bitbucket workspace is stored. Save credentials first.")?;
    let email = get_credential("bitbucket_email")
        .ok_or("No Bitbucket email is stored. Save credentials first.")?;
    let access_token = get_credential("bitbucket_access_token")
        .ok_or("No Bitbucket access token is stored. Save credentials first.")?;
    test_bitbucket_connection(&workspace, &email, &access_token).await
}

async fn test_bitbucket_connection(
    workspace: &str,
    email: &str,
    access_token: &str,
) -> Result<String, String> {
    let workspace_trimmed = workspace.trim();
    let email_trimmed = email.trim();
    let token_trimmed = access_token.trim();

    let client = make_client()?;

    let url = format!("https://api.bitbucket.org/2.0/repositories/{workspace_trimmed}?pagelen=1");

    let resp = client
        .get(&url)
        .basic_auth(email_trimmed, Some(token_trimmed))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach api.bitbucket.org. Check your internet connection.".to_string()
            } else {
                format!("Request failed: {e}")
            }
        })?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();

    match status {
        StatusCode::OK => {
            let count = serde_json::from_str::<serde_json::Value>(&body_text)
                .ok()
                .and_then(|v| v["size"].as_u64())
                .map(|n| format!(" ({n} repositories found)"))
                .unwrap_or_default();
            Ok(format!("Connected to Bitbucket workspace '{workspace_trimmed}'{count}."))
        }
        StatusCode::UNAUTHORIZED => Err(
            "Bitbucket rejected the credentials. Check your email and that the token has read:repository:bitbucket scope.".to_string()
        ),
        StatusCode::FORBIDDEN => Err(format!(
            "Bitbucket access denied — your token may not have access to workspace '{workspace_trimmed}'. Ensure the token was created in the correct workspace."
        )),
        StatusCode::NOT_FOUND => Err(format!(
            "Bitbucket workspace '{workspace_trimmed}' not found. Check the workspace slug in your Bitbucket URL."
        )),
        s => Err(format!("Unexpected response from Bitbucket (HTTP {s}).")),
    }
}
