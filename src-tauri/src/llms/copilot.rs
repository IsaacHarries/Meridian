use reqwest::{Client, StatusCode};
use std::time::Duration;

use crate::http::make_corporate_client;
use crate::storage::credentials::{get_credential, store_credential};

// ── Constants ────────────────────────────────────────────────────────────────

/// VS Code's public OAuth client ID — distributed openly and used by every
/// open-source Copilot integration (Zed, copilot.lua, avante.nvim, opencode).
/// Not a secret.
pub const COPILOT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";

/// Device Flow endpoints.
// const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
// const DEVICE_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

/// Exchange endpoint: GitHub OAuth token → short-lived Copilot token.
const COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";

/// Chat completions endpoint.
const COPILOT_API_BASE: &str = "https://api.githubcopilot.com";

/// Scope requested during device flow. Copilot access is tied to the account,
/// so `read:user` is sufficient — do not ask for more.
// const COPILOT_SCOPE: &str = "read:user";

/// Refresh 5 minutes before the Copilot token actually expires.
const COPILOT_REFRESH_BUFFER_MS: u64 = 5 * 60 * 1000;

/// Identity headers required by api.githubcopilot.com. Mirror VS Code
/// Copilot Chat so the backend accepts the request. These are non-sensitive.
const COPILOT_INTEGRATION_ID: &str = "vscode-chat";
const COPILOT_EDITOR_VERSION: &str = "vscode/1.95.0";
const COPILOT_EDITOR_PLUGIN_VERSION: &str = "copilot-chat/0.22.0";
const COPILOT_USER_AGENT: &str = "GitHubCopilotChat/0.22.0";

// ── Token exchange & refresh ──────────────────────────────────────────────────

/// Exchange a long-lived GitHub OAuth token for a short-lived Copilot token.
/// Copilot tokens expire every ~30 minutes, so this is called by
/// `refresh_copilot_token_if_needed` whenever the cached one is near expiry.
pub(crate) async fn exchange_github_token_for_copilot(
    client: &Client,
    github_token: &str,
) -> Result<(String, u64), String> {
    let resp = client
        .get(COPILOT_TOKEN_URL)
        .header("Authorization", format!("token {github_token}"))
        .header("Accept", "application/json")
        .header("User-Agent", COPILOT_USER_AGENT)
        .header("Editor-Version", COPILOT_EDITOR_VERSION)
        .header("Editor-Plugin-Version", COPILOT_EDITOR_PLUGIN_VERSION)
        .send()
        .await
        .map_err(|e| format!("Copilot token exchange request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Copilot token exchange failed (HTTP {status}). \
             Ensure your GitHub account has an active Copilot subscription.\n{body}"
        ));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Copilot token response: {e}"))?;

    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or("Missing `token` in Copilot token response")?
        .to_string();
    // `expires_at` is Unix seconds.
    let expires_at_s = data
        .get("expires_at")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() + 1500)
                .unwrap_or(0)
        });
    Ok((token, expires_at_s * 1000))
}

/// If the cached Copilot token is within the refresh buffer of expiry, mint
/// a new one from the stored GitHub OAuth token and silently update the
/// credential store. No-op if `copilot_oauth_json` is not set.
pub async fn refresh_copilot_token_if_needed(client: &Client) -> Result<(), String> {
    let oauth_str = match get_credential("copilot_oauth_json") {
        Some(s) => s,
        None => return Ok(()),
    };

    let oauth_data: serde_json::Value = serde_json::from_str(&oauth_str)
        .map_err(|e| format!("Failed to parse stored Copilot OAuth data: {e}"))?;

    let expires_at = oauth_data
        .get("expiresAt")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("System time error: {e}"))?
        .as_millis() as u64;

    if expires_at > now_ms + COPILOT_REFRESH_BUFFER_MS {
        return Ok(());
    }

    let github_token = oauth_data
        .get("githubToken")
        .and_then(|v| v.as_str())
        .ok_or(
            "GitHub token missing — re-authenticate in Settings to re-link \
             your Copilot subscription.",
        )?;

    let (new_token, new_expires_at) =
        exchange_github_token_for_copilot(client, github_token).await?;

    let mut updated = oauth_data.clone();
    let obj = updated
        .as_object_mut()
        .ok_or("Stored Copilot OAuth data is not a JSON object")?;
    obj.insert(
        "copilotToken".to_string(),
        serde_json::Value::String(new_token.clone()),
    );
    obj.insert(
        "expiresAt".to_string(),
        serde_json::Value::Number(serde_json::Number::from(new_expires_at)),
    );

    store_credential("copilot_api_key", &new_token)?;
    store_credential("copilot_oauth_json", &updated.to_string())?;
    Ok(())
}

// ── Chat completion helpers ───────────────────────────────────────────────────

fn copilot_request_headers(
    builder: reqwest::RequestBuilder,
    token: &str,
) -> reqwest::RequestBuilder {
    builder
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Copilot-Integration-Id", COPILOT_INTEGRATION_ID)
        .header("Editor-Version", COPILOT_EDITOR_VERSION)
        .header("Editor-Plugin-Version", COPILOT_EDITOR_PLUGIN_VERSION)
        .header("User-Agent", COPILOT_USER_AGENT)
}

fn history_to_copilot_messages(
    system: &str,
    history: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    if !system.trim().is_empty() {
        out.push(serde_json::json!({ "role": "system", "content": system }));
    }
    for msg in history {
        let role = match msg.get("role").and_then(|r| r.as_str()) {
            Some("assistant") => "assistant",
            _ => "user",
        };
        let content = msg
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        out.push(serde_json::json!({ "role": role, "content": content }));
    }
    out
}

pub async fn complete_copilot_for_ping(
    client: &Client,
    token: &str,
    model: &str,
) -> Result<String, String> {
    complete_copilot(client, token, model, "", "Say hello.", 32).await
}

pub async fn complete_copilot(
    client: &Client,
    token: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let messages = history_to_copilot_messages(
        system,
        &[serde_json::json!({ "role": "user", "content": user })],
    );
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": false,
    });

    let url = format!("{COPILOT_API_BASE}/chat/completions");
    let req = copilot_request_headers(client.post(&url), token);
    let resp = req.json(&body).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "Could not reach api.githubcopilot.com.".to_string()
        } else {
            format!("Copilot request failed: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Copilot API error {status}: {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Copilot response: {e}"))?;

    json["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from Copilot API.".to_string())
}

pub async fn complete_multi_copilot(
    client: &Client,
    token: &str,
    model: &str,
    system: &str,
    history: &[serde_json::Value],
    max_tokens: u32,
) -> Result<String, String> {
    let messages = history_to_copilot_messages(system, history);
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": false,
    });

    let url = format!("{COPILOT_API_BASE}/chat/completions");
    let req = copilot_request_headers(client.post(&url), token);
    let resp = req.json(&body).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "Could not reach api.githubcopilot.com.".to_string()
        } else {
            format!("Copilot request failed: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Copilot API error {status}: {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Copilot response: {e}"))?;

    json["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from Copilot API.".to_string())
}

pub async fn complete_multi_copilot_streaming(
    app: &tauri::AppHandle,
    client: &Client,
    token: &str,
    model: &str,
    system: &str,
    history: &[serde_json::Value],
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let messages = history_to_copilot_messages(system, history);
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": true,
    });

    let url = format!("{COPILOT_API_BASE}/chat/completions");
    let req =
        copilot_request_headers(client.post(&url), token).header("Accept", "text/event-stream");
    let resp = req.json(&body).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "Could not reach api.githubcopilot.com.".to_string()
        } else {
            format!("Copilot request failed: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("Copilot API error {status}: {body_text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut full = String::new();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer = buffer[nl + 1..].to_string();
            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line["data: ".len()..];
            if data == "[DONE]" {
                return Ok(full);
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = json["choices"][0]["delta"]["content"].as_str() {
                    if !delta.is_empty() {
                        full.push_str(delta);
                        let _ = app.emit(stream_event, serde_json::json!({ "delta": delta }));
                    }
                }
            }
        }
    }

    if full.is_empty() {
        return Err("Copilot returned an empty streaming response.".to_string());
    }
    Ok(full)
}

// ── Model catalogue, validation, test commands ───────────────────────────────

const COPILOT_BUILTIN_MODELS: &[(&str, &str)] = &[
    ("gpt-4o", "GPT-4o"),
    ("gpt-4o-mini", "GPT-4o Mini"),
    ("o3-mini", "o3 Mini"),
    ("claude-sonnet-4", "Claude Sonnet 4 (via Copilot)"),
    ("claude-3.5-sonnet", "Claude 3.5 Sonnet (via Copilot)"),
    ("gemini-2.5-pro", "Gemini 2.5 Pro (via Copilot)"),
];

const COPILOT_CUSTOM_MODELS_PREF: &str = "copilot_custom_models";

fn load_custom_copilot_models() -> Vec<String> {
    let Some(raw) = crate::storage::preferences::load_map()
        .get(COPILOT_CUSTOM_MODELS_PREF)
        .cloned()
    else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
}

fn save_custom_copilot_models(models: &[String]) -> Result<(), String> {
    let mut map = crate::storage::preferences::load_map();
    if models.is_empty() {
        map.remove(COPILOT_CUSTOM_MODELS_PREF);
    } else {
        let json = serde_json::to_string(models)
            .map_err(|e| format!("Failed to serialise custom models: {e}"))?;
        map.insert(COPILOT_CUSTOM_MODELS_PREF.to_string(), json);
    }
    crate::storage::preferences::save_map(&map)
}

async fn fetch_copilot_models_live(
    client: &Client,
    token: &str,
) -> Result<Vec<(String, String)>, String> {
    let url = format!("{COPILOT_API_BASE}/models");
    let req = copilot_request_headers(client.get(&url), token);
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Models request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Models API returned HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {e}"))?;
    let data = json["data"]
        .as_array()
        .ok_or("Unexpected models response shape")?;
    let mut out: Vec<(String, String)> = Vec::new();
    for m in data {
        let id = match m["id"].as_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let label = m["name"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| id.clone());
        out.push((id, label));
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_copilot_models() -> Result<Vec<(String, String)>, String> {
    let token = get_credential("copilot_api_key")
        .filter(|t| !t.trim().is_empty())
        .ok_or("Copilot credentials are not configured.")?;

    if let Ok(client) = make_corporate_client(Duration::from_secs(10)) {
        // Silently refresh first so the list reflects the current subscription.
        let _ = refresh_copilot_token_if_needed(&client).await;
        let fresh = get_credential("copilot_api_key").unwrap_or(token);
        if let Ok(models) = fetch_copilot_models_live(&client, &fresh).await {
            if !models.is_empty() {
                let mut out = models;
                for id in load_custom_copilot_models() {
                    if !out.iter().any(|(existing, _)| existing == &id) {
                        out.push((id.clone(), format!("{id} (custom)")));
                    }
                }
                return Ok(out);
            }
        }
    }

    let mut out: Vec<(String, String)> = COPILOT_BUILTIN_MODELS
        .iter()
        .map(|(id, name)| (id.to_string(), name.to_string()))
        .collect();
    for id in load_custom_copilot_models() {
        if !out.iter().any(|(existing, _)| existing == &id) {
            out.push((id.clone(), format!("{id} (custom)")));
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn get_custom_copilot_models() -> Result<Vec<String>, String> {
    Ok(load_custom_copilot_models())
}

#[tauri::command]
pub fn add_custom_copilot_model(model_id: String) -> Result<Vec<String>, String> {
    let id = model_id.trim().to_string();
    if id.is_empty() {
        return Err("Model ID cannot be empty.".to_string());
    }
    if COPILOT_BUILTIN_MODELS.iter().any(|(m, _)| *m == id) {
        return Err(format!("\"{id}\" is already a built-in model."));
    }
    let mut list = load_custom_copilot_models();
    if !list.contains(&id) {
        list.push(id);
    }
    save_custom_copilot_models(&list)?;
    Ok(list)
}

#[tauri::command]
pub fn remove_custom_copilot_model(model_id: String) -> Result<Vec<String>, String> {
    let id = model_id.trim();
    let mut list = load_custom_copilot_models();
    list.retain(|m| m != id);
    save_custom_copilot_models(&list)?;
    Ok(list)
}

/// Accept a user-provided GitHub OAuth token, exchange it for a Copilot
/// token, and store both. Used by the "API key" flow in Settings.
#[tauri::command]
pub async fn validate_copilot(api_key: String) -> Result<String, String> {
    let github_token = api_key.trim();
    if github_token.is_empty() {
        return Err("GitHub OAuth token cannot be empty.".to_string());
    }

    let client = make_corporate_client(Duration::from_secs(10))
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let (copilot_token, expires_at) =
        exchange_github_token_for_copilot(&client, github_token).await?;

    store_credential("copilot_api_key", &copilot_token)?;
    store_credential("copilot_auth_method", "api_key")?;
    store_credential(
        "copilot_oauth_json",
        &serde_json::json!({
            "githubToken": github_token,
            "copilotToken": copilot_token,
            "expiresAt": expires_at,
        })
        .to_string(),
    )?;

    Ok("Connected to GitHub Copilot successfully.".to_string())
}

#[tauri::command]
pub async fn test_copilot_stored() -> Result<String, String> {
    let _token = get_credential("copilot_api_key")
        .filter(|t| !t.trim().is_empty())
        .ok_or("Copilot credentials are not configured.")?;

    let client = make_corporate_client(Duration::from_secs(10))
        .map_err(|e| format!("HTTP client error: {e}"))?;

    refresh_copilot_token_if_needed(&client).await?;
    let token = get_credential("copilot_api_key").unwrap_or_default();

    let url = format!("{COPILOT_API_BASE}/models");
    let req = copilot_request_headers(client.get(&url), &token);
    let resp = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "Could not reach api.githubcopilot.com. Check your internet connection.".to_string()
        } else {
            format!("Request failed: {e}")
        }
    })?;

    match resp.status() {
        s if s.is_success() => Ok("Connected to GitHub Copilot successfully.".to_string()),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            Err("GitHub Copilot rejected the token. Re-authenticate in Settings.".to_string())
        }
        s => {
            let body = resp.text().await.unwrap_or_default();
            Err(format!(
                "Unexpected response from Copilot (HTTP {s}). {body}"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_history_to_copilot_messages_empty() {
        let msgs = history_to_copilot_messages("", &[]);
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_history_to_copilot_messages_system_only() {
        let msgs = history_to_copilot_messages("System instruction", &[]);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0], json!({ "role": "system", "content": "System instruction" }));
    }

    #[test]
    fn test_history_to_copilot_messages_mixed() {
        let history = vec![
            json!({ "role": "user", "content": "Hello" }),
            json!({ "role": "assistant", "content": "Hi there!" }),
            json!({ "role": "user", "content": "How are you?" }),
        ];
        let msgs = history_to_copilot_messages("You are helpful.", &history);
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0], json!({ "role": "system", "content": "You are helpful." }));
        assert_eq!(msgs[1], json!({ "role": "user", "content": "Hello" }));
        assert_eq!(msgs[2], json!({ "role": "assistant", "content": "Hi there!" }));
        assert_eq!(msgs[3], json!({ "role": "user", "content": "How are you?" }));
    }
}
