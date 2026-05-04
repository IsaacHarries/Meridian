use std::time::Duration;

use super::_shared::{
    generate_random_base64url, make_client, percent_encode, sha256_base64url,
    wait_for_oauth_callback,
};
use crate::llms::gemini;
use crate::storage::credentials::store_credential;

// ── Google Gemini OAuth ──────────────────────────────────────────────────────

const GEMINI_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GEMINI_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GEMINI_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
// Distributed publicly by the open-source Gemini CLI; Google's token endpoint
// requires it for this client even with PKCE. Not actually secret.
const GEMINI_CLIENT_SECRET: &str = "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";
// The Gemini CLI's OAuth client (`681255809395-…`) is registered with the
// `cloud-platform` scope — the older `generative-language` scope is not
// whitelisted on this client and triggers `Error 403: restricted_client`.
// Generative Language API endpoints accept bearer tokens issued with the
// `cloud-platform` scope.
const GEMINI_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform \
    https://www.googleapis.com/auth/userinfo.email \
    https://www.googleapis.com/auth/userinfo.profile \
    openid";

/// End-to-end ping: actually generate a reply from Gemini using the stored
/// credentials (API key or OAuth → Code Assist). Mirrors `ping_anthropic`.
#[tauri::command]
pub async fn ping_gemini() -> Result<String, String> {
    use crate::http::make_corporate_client;
    use crate::storage::credentials::get_credential;

    let key = get_credential("gemini_api_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or("No Gemini credentials found. Authenticate in Settings first.")?;

    let model = crate::storage::preferences::get_pref("gemini_model")
        .or_else(|| get_credential("gemini_model"))
        .filter(|m| !m.trim().is_empty())
        .ok_or("No Gemini model selected. Please select a model in Settings first.")?;

    let client = make_corporate_client(Duration::from_secs(30), false)?;

    let reply = gemini::complete_gemini_for_ping(&client, &key, &model).await?;
    Ok(format!(
        "Message sent successfully. Gemini replied: \"{reply}\""
    ))
}

#[tauri::command]
pub async fn start_gemini_oauth() -> Result<String, String> {
    use tokio::net::TcpListener;

    let code_verifier = generate_random_base64url(32)?;
    let code_challenge = sha256_base64url(&code_verifier);
    let state = generate_random_base64url(32)?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to start local callback server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local port: {e}"))?
        .port();

    let redirect_uri = format!("http://localhost:{port}/callback");

    let auth_url = format!(
        "{}?client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        GEMINI_AUTH_URL,
        GEMINI_CLIENT_ID,
        percent_encode(&redirect_uri),
        percent_encode(GEMINI_SCOPE),
        code_challenge,
        state
    );

    std::process::Command::new("open")
        .arg(&auth_url)
        .spawn()
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    let code = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        wait_for_oauth_callback(listener, &state, "Google"),
    )
    .await
    .map_err(|_| "Authorization timed out after 3 minutes. Please try again.".to_string())??;

    let client = make_client()?;
    let resp = client
        .post(GEMINI_TOKEN_URL)
        .form(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": GEMINI_CLIENT_ID,
            "client_secret": GEMINI_CLIENT_SECRET,
            "code_verifier": code_verifier,
        }))
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed (HTTP {status}).\n\n{body}"));
    }

    let tokens: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {e}"))?;

    let access_token = tokens["access_token"]
        .as_str()
        .ok_or("Missing access_token in token response")?;
    let refresh_token = tokens["refresh_token"].as_str();
    let expires_in = tokens["expires_in"].as_u64().unwrap_or(3600);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let expires_at = now_ms + expires_in * 1000;

    // Store the tokens
    store_credential("gemini_api_key", access_token)?;
    store_credential("gemini_auth_method", "oauth")?;

    let mut oauth_data = serde_json::json!({
        "accessToken": access_token,
        "expiresAt": expires_at,
    });

    if let Some(rt) = refresh_token {
        oauth_data["refreshToken"] = serde_json::Value::String(rt.to_string());
    }

    store_credential("gemini_oauth_json", &oauth_data.to_string())?;

    // Onboard the user to Code Assist so subsequent generation calls have a
    // project ID. Surfaces a clear error if the free-tier signup fails.
    gemini::ensure_gemini_codeassist_project(&client, access_token).await?;

    Ok(
        "Connected to Google Account successfully. Meridian will use your Gemini subscription."
            .to_string(),
    )
}
