use std::time::Duration;

use super::_shared::make_client;
use crate::http::make_corporate_client;
use crate::llms::copilot::{self, COPILOT_CLIENT_ID};
use crate::storage::credentials::get_credential;

// ── GitHub Copilot OAuth (Device Flow) ───────────────────────────────────────

const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_DEVICE_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const COPILOT_SCOPE: &str = "read:user";

#[tauri::command]
pub async fn start_copilot_oauth(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let client = make_client()?;

    // Step 1: request a device + user code.
    let device_resp = client
        .post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&serde_json::json!({
            "client_id": COPILOT_CLIENT_ID,
            "scope": COPILOT_SCOPE,
        }))
        .send()
        .await
        .map_err(|e| format!("Device code request failed: {e}"))?;

    if !device_resp.status().is_success() {
        let status = device_resp.status();
        let body = device_resp.text().await.unwrap_or_default();
        return Err(format!(
            "Device code request failed (HTTP {status}).\n{body}"
        ));
    }

    let device: serde_json::Value = device_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse device code response: {e}"))?;

    let device_code = device["device_code"]
        .as_str()
        .ok_or("Missing device_code in response")?
        .to_string();
    let user_code = device["user_code"]
        .as_str()
        .ok_or("Missing user_code in response")?
        .to_string();
    let verification_uri = device["verification_uri"]
        .as_str()
        .unwrap_or("https://github.com/login/device")
        .to_string();
    let interval_secs = device["interval"].as_u64().unwrap_or(5);
    let expires_in_secs = device["expires_in"].as_u64().unwrap_or(900);

    let _ = app.emit(
        "copilot-oauth-code",
        serde_json::json!({
            "userCode": user_code,
            "verificationUri": verification_uri
        }),
    );

    // Step 2: copy user_code to clipboard (best-effort) and open the browser.
    // GitHub shows the code-entry page at `verification_uri`. The user still
    // has to paste the code — we prefill it in the pasteboard.
    let _ = std::process::Command::new("pbcopy")
        .arg(&user_code)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut c| {
            use std::io::Write;
            if let Some(mut s) = c.stdin.take() {
                let _ = s.write_all(user_code.as_bytes());
            }
            c.wait()
        });
    let _ = std::process::Command::new("open")
        .arg(&verification_uri)
        .spawn();

    // Step 3: poll for the GitHub OAuth token.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(expires_in_secs);
    let mut interval = std::time::Duration::from_secs(interval_secs);

    let github_token = loop {
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "Device flow timed out after {expires_in_secs}s. User code was {user_code}."
            ));
        }
        tokio::time::sleep(interval).await;

        let poll_resp = client
            .post(GITHUB_DEVICE_TOKEN_URL)
            .header("Accept", "application/json")
            .form(&serde_json::json!({
                "client_id": COPILOT_CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            }))
            .send()
            .await
            .map_err(|e| format!("Device poll request failed: {e}"))?;

        let body: serde_json::Value = poll_resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse poll response: {e}"))?;

        if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
            break token.to_string();
        }

        match body.get("error").and_then(|v| v.as_str()) {
            Some("authorization_pending") => { /* keep polling */ }
            Some("slow_down") => {
                interval = std::time::Duration::from_secs(interval.as_secs() + 5);
            }
            Some("expired_token") => {
                return Err("Device code expired before user completed authorization.".to_string());
            }
            Some("access_denied") => {
                return Err("User cancelled the GitHub authorization.".to_string());
            }
            Some(other) => {
                return Err(format!("GitHub device flow error: {other}"));
            }
            None => {
                return Err("Unexpected GitHub device flow response.".to_string());
            }
        }
    };

    // Step 4: exchange for a Copilot token, store both.
    let (copilot_token, expires_at) =
        copilot::exchange_github_token_for_copilot(&client, &github_token).await?;

    crate::storage::credentials::store_credential("copilot_api_key", &copilot_token)?;
    crate::storage::credentials::store_credential("copilot_auth_method", "oauth")?;
    crate::storage::credentials::store_credential(
        "copilot_oauth_json",
        &serde_json::json!({
            "githubToken": github_token,
            "copilotToken": copilot_token,
            "expiresAt": expires_at,
        })
        .to_string(),
    )?;

    Ok(format!(
        "Connected to GitHub Copilot. User code used: {user_code}. \
         Meridian will use your Copilot subscription for AI features."
    ))
}

#[tauri::command]
pub async fn ping_copilot() -> Result<String, String> {
    let _token = get_credential("copilot_api_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or("No Copilot credentials. Authenticate in Settings first.")?;
    let model = crate::storage::preferences::get_pref("copilot_model")
        .or_else(|| get_credential("copilot_model"))
        .filter(|m| !m.trim().is_empty())
        .ok_or("No Copilot model selected. Please select a model in Settings first.")?;

    let client = make_corporate_client(Duration::from_secs(30), false)?;
    copilot::refresh_copilot_token_if_needed(&client).await?;
    let token = get_credential("copilot_api_key").unwrap_or_default();

    let reply = copilot::complete_copilot_for_ping(&client, &token, &model).await?;
    Ok(format!(
        "Message sent successfully. Copilot replied: \"{reply}\""
    ))
}
