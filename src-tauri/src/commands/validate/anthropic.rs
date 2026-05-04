use reqwest::StatusCode;
use std::time::Duration;

use super::_shared::{
    generate_random_base64url, make_client, percent_encode, sha256_base64url,
    wait_for_oauth_callback,
};
use crate::storage::credentials::{get_credential, store_credential};

// ── OAuth PKCE constants ──────────────────────────────────────────────────────

const OAUTH_AUTH_URL: &str = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPE: &str = "org:create_api_key user:profile user:inference \
     user:sessions:claude_code user:mcp_servers user:file_upload";

/// Validate an Anthropic API key. Saves the key immediately, then tests
/// connectivity. If api.anthropic.com is blocked by a corporate firewall,
/// returns a warning (not an error) so the user can still proceed.
#[tauri::command]
pub async fn validate_anthropic(api_key: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty.".to_string());
    }
    store_credential("anthropic_api_key", api_key.trim())?;
    store_credential("claude_auth_method", "api_key")?;
    test_anthropic_connectivity(api_key.trim(), true).await
}

/// Send a real "hello" message to the Anthropic Messages API and verify a response
/// comes back. This tests the full inference path — auth, model access, and rate limits —
/// not just connectivity.
#[tauri::command]
pub async fn ping_anthropic() -> Result<String, String> {
    use crate::http::make_corporate_client;
    use crate::llms::claude::{build_messages_body, refresh_oauth_if_needed};
    use crate::storage::credentials::get_credential;

    let api_key = get_credential("anthropic_api_key")
        .ok_or("No Claude credentials found. Authenticate in Settings first.")?;
    if api_key.trim().is_empty() {
        return Err("No Claude credentials found. Authenticate in Settings first.".to_string());
    }

    let auth_method = get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
    let client = make_corporate_client(Duration::from_secs(30), false)?;

    if auth_method == "oauth" {
        refresh_oauth_if_needed(&client).await?;
    }

    let api_key = get_credential("anthropic_api_key").unwrap_or_default();
    let model = crate::storage::preferences::get_pref("claude_model")
        .or_else(|| get_credential("claude_model"))
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "claude-sonnet-4-6".to_string());

    let body = build_messages_body(
        &api_key,
        &model,
        "",
        serde_json::json!([{ "role": "user", "content": "Say hello." }]),
        32,
        false,
        None,
    );

    let req = client
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");

    let req = if api_key.starts_with("sk-ant-api") {
        req.header("x-api-key", &api_key)
    } else {
        req.header("Authorization", format!("Bearer {api_key}"))
            .header(
                "anthropic-beta",
                "oauth-2025-04-20,claude-code-20250219,files-api-2025-04-14",
            )
            .header("anthropic-client-platform", "claude_code_cli")
    };

    let resp = req.json(&body).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "Could not reach api.anthropic.com. Check your internet connection.".to_string()
        } else {
            format!("Request failed: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("Claude API error {status}: {body_text}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    let reply = json["content"][0]["text"]
        .as_str()
        .unwrap_or("(no text in response)");

    Ok(format!(
        "Message sent successfully. Claude replied: \"{reply}\""
    ))
}

/// Read the Claude Code CLI's OAuth token from the macOS Keychain
/// (`Claude Code-credentials`) and store it as Meridian's active credential.
/// This gives Meridian the same `rateLimitTier: default_claude_ai` token that
/// the CLI uses, bypassing the lower-limit API-tier tokens from a fresh PKCE flow.
#[tauri::command]
pub async fn import_claude_code_token() -> Result<String, String> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .map_err(|e| format!("Failed to run security command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Claude Code credentials not found in Keychain. \
             Sign in via the Claude Code CLI first (`claude auth login --claudeai`). \
             Details: {stderr}"
        ));
    }

    let raw = String::from_utf8(output.stdout)
        .map_err(|e| format!("Credential data is not valid UTF-8: {e}"))?;
    let raw = raw.trim();

    let json: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Failed to parse credential JSON: {e}"))?;

    let oauth = json
        .get("claudeAiOauth")
        .ok_or("Missing claudeAiOauth in Claude Code credential")?;

    let access_token = oauth["accessToken"]
        .as_str()
        .ok_or("Missing accessToken in Claude Code credential")?;
    let refresh_token = oauth["refreshToken"]
        .as_str()
        .ok_or("Missing refreshToken in Claude Code credential")?;
    let expires_at = oauth["expiresAt"]
        .as_u64()
        .ok_or("Missing expiresAt in Claude Code credential")?;

    use crate::storage::credentials::store_credential;
    store_credential("anthropic_api_key", access_token)?;
    store_credential("claude_auth_method", "oauth")?;
    store_credential(
        "claude_oauth_json",
        &serde_json::json!({
            "claudeAiOauth": {
                "accessToken": access_token,
                "refreshToken": refresh_token,
                "expiresAt": expires_at,
            }
        })
        .to_string(),
    )?;

    Ok("Imported Claude Code credentials. Meridian will use your Claude.ai subscription rate limits.".to_string())
}

/// Test the already-stored Anthropic key without accepting it from the frontend.
/// Unlike validate_anthropic, this returns an error if the network is unreachable —
/// the user explicitly asked to test the connection.
#[tauri::command]
pub async fn test_anthropic_stored() -> Result<String, String> {
    let key = get_credential("anthropic_api_key")
        .ok_or("No Claude credentials found. Use 'Connect with Claude' to authenticate.")?;
    if key.trim().is_empty() {
        return Err(
            "No Claude credentials found. Use 'Connect with Claude' to authenticate.".to_string(),
        );
    }
    let auth_method = get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
    if auth_method == "oauth" {
        return test_anthropic_connectivity(&key, false)
            .await
            .map(|_| "Claude Pro / Max connection verified.".to_string());
    }
    test_anthropic_connectivity(&key, false).await
}

/// Open a browser to Claude.ai, complete the OAuth PKCE flow, and store the
/// resulting tokens. This replaces the old keychain-import approach — no
/// Claude Code CLI required.
#[tauri::command]
pub async fn start_claude_oauth() -> Result<String, String> {
    use tokio::net::TcpListener;

    // Generate PKCE credentials and CSRF state token.
    let code_verifier = generate_random_base64url(32)?;
    let code_challenge = sha256_base64url(&code_verifier);
    let state = generate_random_base64url(32)?;

    // Bind to a random port on loopback.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to start local callback server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local port: {e}"))?
        .port();

    let redirect_uri = format!("http://localhost:{port}/callback");

    // Matches the SDK's OZ8() parameter order exactly — code=true is required first.
    let auth_url = format!(
        "{OAUTH_AUTH_URL}?code=true&client_id={OAUTH_CLIENT_ID}\
         &response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        percent_encode(&redirect_uri),
        percent_encode(OAUTH_SCOPE),
        code_challenge,
        state
    );

    // Open the system browser.
    std::process::Command::new("open")
        .arg(&auth_url)
        .spawn()
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    // Wait up to 3 minutes for the redirect callback.
    let code = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        wait_for_oauth_callback(listener, &state, "Claude"),
    )
    .await
    .map_err(|_| "Authorization timed out after 3 minutes. Please try again.".to_string())??;

    // Exchange the authorization code for tokens.
    // The Claude SDK uses JSON with Content-Type: application/json (not form-encoded),
    // and requires `state` in the body alongside the standard PKCE fields.
    let client = make_client()?;
    let resp = client
        .post(OAUTH_TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": OAUTH_CLIENT_ID,
            "code_verifier": code_verifier,
            "state": state,
        }))
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Token exchange failed (HTTP {status}). Please try connecting again.\n\n{body}"
        ));
    }

    let tokens: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {e}"))?;

    let access_token = tokens["access_token"]
        .as_str()
        .ok_or("Missing access_token in token response")?;
    let refresh_token = tokens["refresh_token"]
        .as_str()
        .ok_or("Missing refresh_token in token response")?;
    let expires_in = tokens["expires_in"].as_u64().unwrap_or(3600);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let expires_at = now_ms + expires_in * 1000;

    // Store the tokens — same format as the existing OAuth refresh code expects.
    store_credential("anthropic_api_key", access_token)?;
    store_credential("claude_auth_method", "oauth")?;
    store_credential(
        "claude_oauth_json",
        &serde_json::json!({
            "claudeAiOauth": {
                "accessToken": access_token,
                "refreshToken": refresh_token,
                "expiresAt": expires_at,
            }
        })
        .to_string(),
    )?;

    Ok(
        "Connected to Claude Pro / Max. Meridian will use your subscription \
         for all AI features."
            .to_string(),
    )
}

/// `tolerant`: if true, network failures return Ok with a warning (used on save).
///             if false, network failures return Err (used by Test Connection button).
async fn test_anthropic_connectivity(api_key: &str, tolerant: bool) -> Result<String, String> {
    let client = make_client()?;
    // API keys (sk-ant-api03-…) use x-api-key.
    // OAuth tokens (sk-ant-oat01-…) use Authorization: Bearer plus the
    // oauth-2025-04-20 beta header required by the Anthropic API.
    let base_req = client
        .get("https://api.anthropic.com/v1/models")
        .header("anthropic-version", "2023-06-01");
    let authed_req = if api_key.starts_with("sk-ant-api") {
        base_req.header("x-api-key", api_key)
    } else {
        base_req
            .header("Authorization", format!("Bearer {api_key}"))
            .header(
                "anthropic-beta",
                "oauth-2025-04-20,claude-code-20250219,files-api-2025-04-14",
            )
            .header("anthropic-client-platform", "claude_code_cli")
    };
    let resp = match authed_req.send().await {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => {
            return if tolerant {
                Ok("API key saved. Note: api.anthropic.com could not be reached from this network — Claude workflows will be attempted at runtime.".to_string())
            } else {
                Err("Could not reach api.anthropic.com. Check your internet connection — your corporate network may be blocking this endpoint.".to_string())
            };
        }
        Err(e) => return Err(format!("Request failed: {e}")),
    };

    match resp.status() {
        StatusCode::OK => Ok("Connected to Anthropic API successfully.".to_string()),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(
            "Anthropic rejected the API key as invalid. Check the key at platform.claude.com → API Keys.".to_string(),
        ),
        s => Err(format!("Unexpected response from Anthropic (HTTP {s}).")),
    }
}
