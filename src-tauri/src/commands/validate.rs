use base64::Engine as _;
use reqwest::{Client, StatusCode};
use std::time::Duration;

use super::credentials::{get_credential, store_credential};
use crate::http::make_corporate_client;

fn make_client() -> Result<Client, String> {
    make_corporate_client(Duration::from_secs(10))
}

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
    use super::claude::{build_messages_body, refresh_oauth_if_needed};
    use super::credentials::get_credential;
    use crate::http::make_corporate_client;

    let api_key = get_credential("anthropic_api_key")
        .ok_or("No Claude credentials found. Authenticate in Settings first.")?;
    if api_key.trim().is_empty() {
        return Err("No Claude credentials found. Authenticate in Settings first.".to_string());
    }

    let auth_method = get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
    let client = make_corporate_client(Duration::from_secs(30))?;

    if auth_method == "oauth" {
        refresh_oauth_if_needed(&client).await?;
    }

    let api_key = get_credential("anthropic_api_key").unwrap_or_default();
    let model = get_credential("claude_model")
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

/// End-to-end ping: actually generate a reply from Gemini using the stored
/// credentials (API key or OAuth → Code Assist). Mirrors `ping_anthropic`.
#[tauri::command]
pub async fn ping_gemini() -> Result<String, String> {
    use super::credentials::get_credential;
    use crate::http::make_corporate_client;

    let key = get_credential("gemini_api_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or("No Gemini credentials found. Authenticate in Settings first.")?;

    let model = get_credential("gemini_model")
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "gemini-2.5-flash".to_string());

    let client = make_corporate_client(Duration::from_secs(30))?;

    let reply = super::claude::complete_gemini_for_ping(&client, &key, &model).await?;
    Ok(format!(
        "Message sent successfully. Gemini replied: \"{reply}\""
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

    use super::credentials::store_credential;
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

// ── OAuth PKCE constants ──────────────────────────────────────────────────────

const OAUTH_AUTH_URL: &str = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPE: &str = "org:create_api_key user:profile user:inference \
     user:sessions:claude_code user:mcp_servers user:file_upload";

// ── OAuth PKCE helpers ────────────────────────────────────────────────────────

fn generate_random_base64url(byte_len: usize) -> Result<String, String> {
    use std::io::Read;
    let mut bytes = vec![0u8; byte_len];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("Failed to generate random bytes: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes))
}

fn sha256_base64url(input: &str) -> String {
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(input.as_bytes()))
}

fn percent_encode(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => {
                vec![c as u8]
            }
            c => format!("%{:02X}", c as u32).bytes().collect(),
        })
        .map(|b| b as char)
        .collect()
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte as char);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

async fn wait_for_oauth_callback(
    listener: tokio::net::TcpListener,
    expected_state: &str,
    provider_label: &str,
) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("Local server accept error: {e}"))?;

        let mut buf = [0u8; 8192];
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| format!("Read error: {e}"))?;

        let request = String::from_utf8_lossy(&buf[..n]);
        let first_line = request.lines().next().unwrap_or("").to_string();

        match parse_callback(&request, expected_state) {
            CallbackResult::Code(code) => {
                let html = format!(
                    "<html><head><meta charset=utf-8><title>Meridian — Connected</title>\
                    <style>body{{font-family:system-ui;display:flex;align-items:center;\
                    justify-content:center;min-height:100vh;margin:0;background:#0f0f0f;color:#fff}}\
                    .card{{background:#1a1a1a;padding:2rem;border-radius:12px;text-align:center;max-width:380px}}\
                    h2{{margin:0 0 .5rem}}p{{color:#aaa;margin:.5rem 0 0;font-size:.9rem}}</style>\
                    </head><body><div class=card><h2>✓ Connected to {provider_label}</h2>\
                    <p>You can close this window and return to Meridian.</p></div></body></html>"
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = stream.write_all(response.as_bytes()).await;
                return Ok(code);
            }
            CallbackResult::OAuthError(msg) => {
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                    .await;
                return Err(format!("Authorization server returned an error: {msg}"));
            }
            CallbackResult::NotCallback => {
                // Not our redirect — send a minimal response and keep waiting.
                eprintln!("[meridian oauth] ignored request: {first_line}");
                let _ = stream
                    .write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
                    .await;
            }
        }
    }
}

enum CallbackResult {
    Code(String),
    OAuthError(String),
    NotCallback,
}

fn parse_callback(request: &str, expected_state: &str) -> CallbackResult {
    let line = match request.lines().next() {
        Some(l) => l,
        None => return CallbackResult::NotCallback,
    };
    let after_get = match line.strip_prefix("GET ") {
        Some(s) => s,
        None => return CallbackResult::NotCallback,
    };
    let path = match after_get.split_whitespace().next() {
        Some(s) => s,
        None => return CallbackResult::NotCallback,
    };
    let query = match path.strip_prefix("/callback?") {
        Some(q) => q,
        None => return CallbackResult::NotCallback,
    };

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    let mut error_description: Option<String> = None;

    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            let decoded = percent_decode(v);
            match k {
                "code" => code = Some(decoded),
                "state" => state = Some(decoded),
                "error" => error = Some(decoded),
                "error_description" => error_description = Some(decoded),
                _ => {}
            }
        }
    }

    // If the server redirected with an error, surface it immediately.
    if let Some(err) = error {
        let desc = error_description.unwrap_or_default();
        return CallbackResult::OAuthError(format!("{err}: {desc}"));
    }

    // Verify CSRF state.
    if state.as_deref() != Some(expected_state) {
        eprintln!(
            "[meridian oauth] state mismatch: got {:?}, expected {expected_state}",
            state
        );
        return CallbackResult::NotCallback;
    }

    match code {
        Some(c) => CallbackResult::Code(c),
        None => CallbackResult::NotCallback,
    }
}

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
    super::claude::ensure_gemini_codeassist_project(&client, access_token).await?;

    Ok(
        "Connected to Google Account successfully. Meridian will use your Gemini subscription."
            .to_string(),
    )
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

/// Test JIRA connectivity using the provided credentials.
/// Credentials are saved separately via save_credential.
#[tauri::command]
pub async fn validate_jira(
    base_url: String,
    email: String,
    api_token: String,
) -> Result<String, String> {
    if base_url.trim().is_empty() || email.trim().is_empty() || api_token.trim().is_empty() {
        return Err("All JIRA fields are required.".to_string());
    }
    test_jira_connection(&base_url, &email, &api_token).await
}

/// Test the already-stored JIRA credentials without accepting secrets from the frontend.
#[tauri::command]
pub async fn test_jira_stored() -> Result<String, String> {
    let base_url =
        get_credential("jira_base_url").ok_or("No JIRA URL is stored. Save credentials first.")?;
    let email =
        get_credential("jira_email").ok_or("No JIRA email is stored. Save credentials first.")?;
    let api_token = get_credential("jira_api_token")
        .ok_or("No JIRA API token is stored. Save credentials first.")?;
    test_jira_connection(&base_url, &email, &api_token).await
}

async fn test_jira_connection(
    base_url: &str,
    email: &str,
    api_token: &str,
) -> Result<String, String> {
    let base_url_trimmed = base_url.trim().trim_end_matches('/');
    let email_trimmed = email.trim();
    let token_trimmed = api_token.trim();

    // Use a client that does NOT follow redirects — a redirect to an OAuth/SAML login page
    // would otherwise be silently followed and produce a confusing error from the login page.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .use_native_tls()
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // /rest/api/3/myself always requires authentication and returns the user's profile.
    let url = format!("{base_url_trimmed}/rest/api/3/myself");

    let resp = client
        .get(&url)
        .basic_auth(email_trimmed, Some(token_trimmed))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                format!(
                    "Could not reach {base_url_trimmed}. \
                     Check your workspace URL and internet connection."
                )
            } else {
                format!("Request failed: {e}")
            }
        })?;

    let status = resp.status();
    let www_auth = resp
        .headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let location = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.unwrap_or_default();
    // Trim body to first 400 chars so error messages are readable.
    let body_excerpt = if body.len() > 400 {
        &body[..400]
    } else {
        &body
    };

    match status {
        StatusCode::OK => {
            let parsed = serde_json::from_str::<serde_json::Value>(&body).ok();
            let display_name = parsed
                .as_ref()
                .and_then(|v| v["displayName"].as_str().map(str::to_string))
                .unwrap_or_else(|| email_trimmed.to_string());
            // Store the accountId so other parts of the app can use it
            // (e.g. filtering Bitbucket reviewer lists by account identity).
            if let Some(account_id) = parsed.as_ref().and_then(|v| v["accountId"].as_str()) {
                let _ = store_credential("jira_account_id", account_id);
            }
            Ok(format!("Connected to JIRA as {display_name}."))
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            // Surface every diagnostic detail so the user (and developer) can see
            // exactly what Atlassian returned, rather than guessing.
            let detail = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v["message"]
                        .as_str()
                        .or_else(|| v["errorMessages"].get(0).and_then(|m| m.as_str()))
                        .map(str::to_string)
                });

            let mut parts: Vec<String> = vec![format!("JIRA returned HTTP {status} for {url}.")];
            if !www_auth.is_empty() {
                parts.push(format!("WWW-Authenticate: {www_auth}"));
            }
            if let Some(d) = detail {
                parts.push(format!("JIRA message: \"{d}\""));
            } else if !body_excerpt.is_empty() {
                parts.push(format!("Response body: {body_excerpt}"));
            }
            parts.push(
                "Check your email and API token at id.atlassian.com → Security → API tokens."
                    .to_string(),
            );
            Err(parts.join("\n"))
        }
        s if s.is_redirection() => Err(format!(
            "JIRA redirected the request (HTTP {s}) — this usually means your workspace URL \
                 is incorrect, or your organisation requires a different login flow.\n\
                 Redirect location: {location}\n\
                 Check your workspace URL in Settings (e.g. https://yourcompany.atlassian.net)."
        )),
        StatusCode::NOT_FOUND => Err(format!(
            "JIRA workspace not found at {base_url_trimmed} (404). \
             Check your workspace URL in Settings."
        )),
        s => Err(format!(
            "Unexpected response from JIRA (HTTP {s}).\nBody: {body_excerpt}"
        )),
    }
}

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

/// Full diagnostic sweep of every JIRA endpoint Meridian uses.
/// Returns a plain-text report regardless of success/failure so the frontend
/// can display it verbatim. Never returns Err — errors are embedded in the report.
#[tauri::command]
pub async fn debug_jira_endpoints() -> Result<String, String> {
    let base_url =
        get_credential("jira_base_url").ok_or("No JIRA URL stored. Save credentials first.")?;
    let email =
        get_credential("jira_email").ok_or("No JIRA email stored. Save credentials first.")?;
    let token = get_credential("jira_api_token")
        .ok_or("No JIRA API token stored. Save credentials first.")?;
    let board_id = get_credential("jira_board_id").unwrap_or_else(|| "(not set)".into());

    let base = base_url.trim().trim_end_matches('/');
    let email = email.trim();
    let token = token.trim();

    // Build clients: one following redirects (default), one not.
    let client_follow = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .use_native_tls()
        .build()
        .map_err(|e| format!("client error: {e}"))?;
    let client_nofollow = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .use_native_tls()
        .build()
        .map_err(|e| format!("client error: {e}"))?;

    let mut report = format!(
        "JIRA Endpoint Diagnostic\n\
         ========================\n\
         Base URL : {base}\n\
         Email    : {email}\n\
         Token    : {}...{} (len {})\n\
         Board ID : {board_id}\n\n",
        &token[..8.min(token.len())],
        &token[token.len().saturating_sub(4)..],
        token.len(),
    );

    // List of (label, url, use_nofollow_client, send_accept_json, send_basic_auth)
    let endpoints: &[(&str, String, bool, bool, bool)] = &[
        (
            "GET /rest/api/3/myself [no-redirect, Accept:json, Basic auth]",
            format!("{base}/rest/api/3/myself"),
            true,
            true,
            true,
        ),
        (
            "GET /rest/api/3/myself [follow-redirect, Accept:json, Basic auth]",
            format!("{base}/rest/api/3/myself"),
            false,
            true,
            true,
        ),
        (
            "GET /rest/api/3/myself [no-redirect, NO Accept header, Basic auth]",
            format!("{base}/rest/api/3/myself"),
            true,
            false,
            true,
        ),
        (
            "GET /rest/api/3/myself [no-redirect, Accept:json, NO auth]",
            format!("{base}/rest/api/3/myself"),
            true,
            true,
            false,
        ),
        (
            "GET /rest/api/3/serverInfo [no-redirect, Accept:json, Basic auth]",
            format!("{base}/rest/api/3/serverInfo"),
            true,
            true,
            true,
        ),
        (
            "GET /rest/agile/1.0/board [no-redirect, Accept:json, Basic auth]",
            format!("{base}/rest/agile/1.0/board"),
            true,
            true,
            true,
        ),
        (
            "GET /rest/agile/1.0/board/{board_id}/sprint?state=active [no-redirect]",
            format!("{base}/rest/agile/1.0/board/{board_id}/sprint?state=active"),
            true,
            true,
            true,
        ),
    ];

    for (label, url, nofollow, accept_json, with_auth) in endpoints {
        let client = if *nofollow {
            &client_nofollow
        } else {
            &client_follow
        };
        let mut req = client.get(url.as_str());
        if *with_auth {
            req = req.basic_auth(email, Some(token));
        }
        if *accept_json {
            req = req.header("Accept", "application/json");
        }

        report.push_str(&format!("\n── {label}\n   URL: {url}\n"));

        match req.send().await {
            Err(e) => {
                report.push_str(&format!("   ERROR: {e}\n"));
            }
            Ok(resp) => {
                let status = resp.status();
                let headers_of_interest: Vec<String> = [
                    "www-authenticate",
                    "location",
                    "content-type",
                    "x-seraph-loginreason",
                ]
                .iter()
                .filter_map(|h| {
                    resp.headers()
                        .get(*h)
                        .and_then(|v| v.to_str().ok())
                        .map(|v| format!("   {h}: {v}"))
                })
                .collect();
                let body = resp.text().await.unwrap_or_default();
                let body_preview = body
                    .chars()
                    .take(300)
                    .collect::<String>()
                    .replace('\n', " ")
                    .replace('\r', "");

                report.push_str(&format!("   Status : {status}\n"));
                for h in &headers_of_interest {
                    report.push_str(&format!("{h}\n"));
                }
                report.push_str(&format!("   Body   : {body_preview}\n"));
            }
        }
    }

    Ok(report)
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

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── generate_random_base64url ─────────────────────────────────────────────

    #[test]
    fn random_base64url_32_bytes_gives_43_chars() {
        let s = generate_random_base64url(32).unwrap();
        assert_eq!(s.len(), 43, "32 bytes → 43 base64url chars (no padding)");
    }

    #[test]
    fn random_base64url_16_bytes_gives_22_chars() {
        let s = generate_random_base64url(16).unwrap();
        assert_eq!(s.len(), 22, "16 bytes → 22 base64url chars (no padding)");
    }

    #[test]
    fn random_base64url_contains_only_url_safe_chars() {
        let s = generate_random_base64url(32).unwrap();
        assert!(
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "Output should only contain A-Z a-z 0-9 - _; got: {s}"
        );
    }

    #[test]
    fn random_base64url_two_calls_differ() {
        let a = generate_random_base64url(32).unwrap();
        let b = generate_random_base64url(32).unwrap();
        assert_ne!(a, b, "Two calls should produce different values");
    }

    // ── sha256_base64url ──────────────────────────────────────────────────────

    #[test]
    fn sha256_base64url_known_input() {
        // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        // base64url (no pad) = LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ
        let result = sha256_base64url("hello");
        assert_eq!(result, "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
    }

    #[test]
    fn sha256_base64url_output_is_43_chars() {
        let result = sha256_base64url("any input");
        assert_eq!(result.len(), 43, "SHA-256 → 32 bytes → 43 base64url chars");
    }

    // ── percent_encode ────────────────────────────────────────────────────────

    #[test]
    fn percent_encode_space() {
        assert_eq!(percent_encode("hello world"), "hello%20world");
    }

    #[test]
    fn percent_encode_slash() {
        assert_eq!(percent_encode("a/b"), "a%2Fb");
    }

    #[test]
    fn percent_encode_colon() {
        assert_eq!(percent_encode("a:b"), "a%3Ab");
    }

    #[test]
    fn percent_encode_leaves_unreserved_chars() {
        let unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
        assert_eq!(percent_encode(unreserved), unreserved);
    }

    #[test]
    fn percent_encode_scope_string() {
        let scope = "user:profile user:inference";
        let encoded = percent_encode(scope);
        assert!(encoded.contains("%3A"), "colons encoded");
        assert!(encoded.contains("%20"), "spaces encoded");
    }

    // ── percent_decode ────────────────────────────────────────────────────────

    #[test]
    fn percent_decode_space() {
        assert_eq!(percent_decode("%20"), " ");
    }

    #[test]
    fn percent_decode_colon() {
        assert_eq!(percent_decode("%3A"), ":");
    }

    #[test]
    fn percent_decode_plus_as_space() {
        assert_eq!(percent_decode("hello+world"), "hello world");
    }

    #[test]
    fn percent_decode_unchanged_for_plain_text() {
        assert_eq!(percent_decode("hello"), "hello");
    }

    #[test]
    fn percent_encode_decode_round_trip() {
        let original = "user:profile user:inference org:create_api_key";
        let encoded = percent_encode(original);
        let decoded = percent_decode(&encoded);
        assert_eq!(decoded, original);
    }
}
