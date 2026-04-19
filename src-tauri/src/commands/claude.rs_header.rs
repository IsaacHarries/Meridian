use reqwest::Client;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::credentials::{get_credential, store_credential};
use super::skills::get_skill;
use crate::http::make_corporate_client;

// ── Review cancellation flag ─────────────────────────────────────────────────
// Set to true by `cancel_review`; polled in the chunk loop so the review stops
// cleanly between chunks without interrupting an in-flight HTTP request.

static REVIEW_CANCELLED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn cancel_review() {
    REVIEW_CANCELLED.store(true, Ordering::Relaxed);
}

// ── Claude OAuth token refresh ────────────────────────────────────────────────

const OAUTH_REFRESH_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Refresh 5 minutes before the token actually expires.
const OAUTH_REFRESH_BUFFER_MS: u64 = 5 * 60 * 1000;

/// If the stored OAuth access token is within 5 minutes of expiry, exchange the
/// refresh token for a new one and update the credential store silently.
/// No-op when the user authenticates with a plain API key (no OAuth JSON stored).
pub async fn refresh_oauth_if_needed(client: &Client) -> Result<(), String> {
    let oauth_str = match get_credential("claude_oauth_json") {
        Some(s) => s,
        None => return Ok(()),
    };

    let oauth_data: serde_json::Value = serde_json::from_str(&oauth_str)
        .map_err(|e| format!("Failed to parse stored OAuth data: {e}"))?;

    let claude_oauth = oauth_data
        .get("claudeAiOauth")
        .ok_or("Missing claudeAiOauth in stored OAuth data")?;

    let expires_at = claude_oauth
        .get("expiresAt")
        .and_then(|v| v.as_u64())
        .ok_or("Missing expiresAt in OAuth data")?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("System time error: {e}"))?
        .as_millis() as u64;

    // Token still valid for longer than the buffer — nothing to do.
    if expires_at > now_ms + OAUTH_REFRESH_BUFFER_MS {
        return Ok(());
    }

    let refresh_token = claude_oauth
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .ok_or(
            "Refresh token missing — your Claude Pro session has expired. \
             Re-import your credentials in Settings.",
        )?;

    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": OAUTH_CLIENT_ID,
    });

    let resp = client
        .post(OAUTH_REFRESH_URL)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "OAuth token refresh failed (HTTP {status}). \
             Your Claude Pro session may have expired — re-import your credentials in Settings.\n\
             {body_text}"
        ));
    }

    let new_tokens: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token refresh response: {e}"))?;

    let new_access = new_tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("Missing access_token in refresh response")?;

    let expires_in_secs = new_tokens
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);

    let new_expires_at = now_ms + expires_in_secs * 1000;

    // Build updated OAuth JSON with the new tokens and expiry.
    let mut updated = oauth_data.clone();
    let inner = updated["claudeAiOauth"]
        .as_object_mut()
        .ok_or("claudeAiOauth is not a JSON object")?;
    inner.insert(
        "accessToken".to_string(),
        serde_json::Value::String(new_access.to_string()),
    );
    inner.insert(
        "expiresAt".to_string(),
        serde_json::Value::Number(serde_json::Number::from(new_expires_at)),
    );
    if let Some(new_refresh) = new_tokens.get("refresh_token").and_then(|v| v.as_str()) {
        inner.insert(
            "refreshToken".to_string(),
            serde_json::Value::String(new_refresh.to_string()),
        );
    }

    store_credential("anthropic_api_key", new_access)?;
    store_credential("claude_oauth_json", &updated.to_string())?;

    Ok(())
}

// ── Gemini OAuth token refresh ────────────────────────────────────────────────

const GEMINI_REFRESH_URL: &str = "https://oauth2.googleapis.com/token";
const GEMINI_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";

pub async fn refresh_gemini_oauth_if_needed(client: &Client) -> Result<(), String> {
    let oauth_str = match get_credential("gemini_oauth_json") {
        Some(s) => s,
        None => return Ok(()),
    };

    let oauth_data: serde_json::Value = serde_json::from_str(&oauth_str)
        .map_err(|e| format!("Failed to parse stored Gemini OAuth data: {e}"))?;

    let expires_at = oauth_data
        .get("expiresAt")
        .and_then(|v| v.as_u64())
        .ok_or("Missing expiresAt in Gemini OAuth data")?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("System time error: {e}"))?
        .as_millis() as u64;

    // Token still valid for longer than the buffer (5 mins) — nothing to do.
    if expires_at > now_ms + OAUTH_REFRESH_BUFFER_MS {
        return Ok(());
    }

    let refresh_token = oauth_data
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .ok_or(
            "Refresh token missing — your Gemini session has expired. Re-authenticate in Settings.",
        )?;

    let resp = client
        .post(GEMINI_REFRESH_URL)
        .form(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": GEMINI_CLIENT_ID,
        }))
        .send()
        .await
        .map_err(|e| format!("Gemini token refresh request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Gemini OAuth token refresh failed (HTTP {status}). \
             Your session may have expired — re-authenticate in Settings.\n\
             {body_text}"
        ));
    }

    let new_tokens: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gemini refresh response: {e}"))?;

    let new_access = new_tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("Missing access_token in refresh response")?;

    let expires_in_secs = new_tokens
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);

    let new_expires_at = now_ms + expires_in_secs * 1000;

    // Build updated OAuth JSON
    let mut updated = oauth_data.clone();
    updated["accessToken"] = serde_json::Value::String(new_access.to_string());
    updated["expiresAt"] = serde_json::Value::Number(serde_json::Number::from(new_expires_at));
    if let Some(new_refresh) = new_tokens.get("refresh_token").and_then(|v| v.as_str()) {
        updated["refreshToken"] = serde_json::Value::String(new_refresh.to_string());
    }

    store_credential("gemini_api_key", new_access)?;
    store_credential("gemini_oauth_json", &updated.to_string())?;

    Ok(())
}
