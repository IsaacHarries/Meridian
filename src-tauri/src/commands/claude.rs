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

// ── OAuth token refresh ─────────────────────────────────────────────────────

const OAUTH_REFRESH_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Refresh 5 minutes before the token actually expires.
const OAUTH_REFRESH_BUFFER_MS: u64 = 5 * 60 * 1000;

/// If the stored OAuth access token is within 5 minutes of expiry, exchange the
/// refresh token for a new one and update the credential store silently.
/// No-op when the user authenticates with a plain API key (no OAuth JSON stored).
async fn refresh_oauth_if_needed(client: &Client) -> Result<(), String> {
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

// ── Gemini support ─────────────────────────────────────────────────────────────

const GEMINI_DEFAULT_MODEL: &str = "gemini-2.5-flash";
const GEMINI_BASE_URL: &str =
    "https://generativelanguage.googleapis.com/v1beta/models";

pub const AVAILABLE_GEMINI_MODELS: &[(&str, &str)] = &[
    ("gemini-2.5-flash", "Gemini 2.5 Flash — Fast & economical"),
    ("gemini-2.5-pro",   "Gemini 2.5 Pro   — Most capable"),
];

fn get_active_gemini_model() -> String {
    get_credential("gemini_model")
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| GEMINI_DEFAULT_MODEL.to_string())
}

/// "claude" | "gemini" | "local" | "auto"  (default: "auto" = Claude first, Gemini on quota error)
fn get_ai_provider() -> String {
    get_credential("ai_provider")
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "auto".to_string())
}

/// Returns true when an error string indicates the Claude quota / rate limit was
/// exceeded and it is worth trying a Gemini fallback.
fn is_quota_error(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("429")
        || e.contains("rate_limit")
        || e.contains("overloaded")
        || e.contains("you've hit your limit")
        || e.contains("hit your limit")
        || e.contains("exceeded")
        || e.contains("quota")
}

/// Single-turn completion via the Gemini `generateContent` REST API.
async fn complete_gemini(
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let url = format!("{GEMINI_BASE_URL}/{model}:generateContent?key={api_key}");

    let body = serde_json::json!({
        "system_instruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": user }] }],
        "generationConfig": { "maxOutputTokens": max_tokens }
    });

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach generativelanguage.googleapis.com.".to_string()
            } else {
                format!("Gemini request failed: {e}")
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Gemini API error {status}: {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gemini response: {e}"))?;

    json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from Gemini API.".to_string())
}

/// Multi-turn completion via Gemini. Converts Claude-style history
/// (role: "assistant") to Gemini style (role: "model") automatically.
async fn complete_multi_gemini(
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let url = format!("{GEMINI_BASE_URL}/{model}:generateContent?key={api_key}");

    let history: serde_json::Value = serde_json::from_str(history_json)
        .map_err(|e| format!("Invalid history JSON: {e}"))?;

    // Gemini uses "model" where Claude uses "assistant".
    let contents: Vec<serde_json::Value> = history
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|msg| {
            let role = match msg["role"].as_str().unwrap_or("user") {
                "assistant" => "model",
                other => other,
            };
            let text = msg["content"].as_str().unwrap_or("");
            serde_json::json!({ "role": role, "parts": [{ "text": text }] })
        })
        .collect();

    let body = serde_json::json!({
        "system_instruction": { "parts": [{ "text": system }] },
        "contents": contents,
        "generationConfig": { "maxOutputTokens": max_tokens }
    });

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Gemini API error {status}: {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gemini response: {e}"))?;

    json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from Gemini API.".to_string())
}

/// Fetch live Gemini models from the API, filtered to text generation models.
/// Falls back to `AVAILABLE_GEMINI_MODELS` on any error.
#[tauri::command]
pub async fn get_gemini_models() -> Vec<(String, String)> {
    let fallback = || {
        AVAILABLE_GEMINI_MODELS
            .iter()
            .map(|(id, label)| (id.to_string(), label.to_string()))
            .collect::<Vec<_>>()
    };

    let api_key = match get_credential("gemini_api_key") {
        Some(k) => k,
        None => return fallback(),
    };

    let client = match make_corporate_client(Duration::from_secs(8)) {
        Ok(c) => c,
        Err(_) => return fallback(),
    };

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={api_key}&pageSize=50"
    );

    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return fallback(),
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return fallback(),
    };

    let models = match json["models"].as_array() {
        Some(m) => m,
        None => return fallback(),
    };

    let mut result: Vec<(String, String)> = models
        .iter()
        .filter_map(|m| {
            let name = m["name"].as_str()?; // "models/gemini-2.5-pro"
            let id = name.strip_prefix("models/")?;

            // Only text generation models that aren't image/video/embedding/TTS.
            let supported: Vec<&str> = m["supportedGenerationMethods"]
                .as_array()?
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            if !supported.contains(&"generateContent") { return None; }
            if id.contains("imagen") || id.contains("veo") || id.contains("embedding")
                || id.contains("tts") || id.contains("aqa") { return None; }
            // Skip live/preview models for stability.
            if id.contains("live") || id.contains("preview") || id.contains("exp") { return None; }

            let display = m["displayName"].as_str().unwrap_or(id).to_string();
            Some((id.to_string(), display))
        })
        .collect();

    if result.is_empty() {
        return fallback();
    }

    // Sort: Flash before Pro (alphabetically within tiers).
    result.sort_by(|a, b| a.0.cmp(&b.0));
    result
}

/// Validate a Gemini API key by making a lightweight models list request.
#[tauri::command]
pub async fn validate_gemini(api_key: String) -> Result<String, String> {
    use super::credentials::store_credential;

    let key = api_key.trim();
    if key.is_empty() {
        return Err("API key cannot be empty.".to_string());
    }

    let client = make_corporate_client(Duration::from_secs(10))
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=1"
    );

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach generativelanguage.googleapis.com. \
                 Check your internet connection.".to_string()
            } else {
                format!("Request failed: {e}")
            }
        })?;

    match resp.status() {
        s if s.is_success() => {
            store_credential("gemini_api_key", key)?;
            Ok("Connected to Gemini API successfully.".to_string())
        }
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            Err("Gemini rejected the API key. \
                 Check the key at console.cloud.google.com → APIs & Services → Credentials."
                .to_string())
        }
        s => Err(format!("Unexpected response from Gemini API (HTTP {s}).")),
    }
}

/// Test the already-stored Gemini API key without re-saving it.
#[tauri::command]
pub async fn test_gemini_stored() -> Result<String, String> {
    let key = get_credential("gemini_api_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or("Gemini API key is not configured.")?;

    let client = make_corporate_client(Duration::from_secs(10))
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=1"
    );

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach generativelanguage.googleapis.com. \
                 Check your internet connection.".to_string()
            } else {
                format!("Request failed: {e}")
            }
        })?;

    match resp.status() {
        s if s.is_success() => Ok("Connected to Gemini API successfully.".to_string()),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            Err("Gemini rejected the stored API key. \
                 Re-enter it in settings to update it.".to_string())
        }
        s => Err(format!("Unexpected response from Gemini API (HTTP {s}).")),
    }
}

// ── Local LLM support (OpenAI-compatible) ──────────────────────────────────────
//
// Works with Ollama (`http://localhost:11434/v1`), LM Studio
// (`http://localhost:1234/v1`), Jan, llama.cpp server, and any other server
// that exposes the OpenAI `/v1/chat/completions` and `/v1/models` endpoints.

fn get_local_llm_model() -> Option<String> {
    get_credential("local_llm_model").filter(|m| !m.trim().is_empty())
}

fn local_llm_base_url() -> Option<String> {
    get_credential("local_llm_url")
        .map(|u| u.trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
}

/// Build an HTTP client that does NOT enforce HTTPS — local servers run on plain HTTP.
fn make_local_client() -> Result<Client, String> {
    Client::builder()
        // Only time out on the initial connection, not on the response body.
        // Ollama can take many minutes to generate a long review; a total-request
        // timeout would fire mid-stream and produce "error decoding response body".
        .connect_timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(true)  // self-signed certs are common
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

async fn complete_local(
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let client = make_local_client()?;
    let url = format!("{base_url}/chat/completions");

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": user  },
        ],
        "max_tokens": max_tokens,
        "stream": false,
    });

    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);

    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_connect() {
            format!(
                "Could not connect to local LLM at {base_url}. \
                 Make sure Ollama / LM Studio is running."
            )
        } else {
            format!("Local LLM request failed: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("Local LLM error {status}: {body_text}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse local LLM response: {e}"))?;

    json["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from local LLM.".to_string())
}

async fn complete_multi_local(
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let client = make_local_client()?;
    let url = format!("{base_url}/chat/completions");

    let history: serde_json::Value = serde_json::from_str(history_json)
        .map_err(|e| format!("Invalid history JSON: {e}"))?;

    let mut messages: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];

    if let Some(arr) = history.as_array() {
        for msg in arr {
            // Claude uses "assistant"; OpenAI-compatible uses "assistant" too — pass through.
            messages.push(msg.clone());
        }
    }

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": false,
    });

    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);

    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_connect() {
            format!(
                "Could not connect to local LLM at {base_url}. \
                 Make sure Ollama / LM Studio is running."
            )
        } else {
            format!("Local LLM request failed: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("Local LLM error {status}: {body_text}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse local LLM response: {e}"))?;

    json["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from local LLM.".to_string())
}

/// Streaming multi-turn variant for local LLM (OpenAI-compatible /chat/completions).
async fn complete_multi_local_streaming(
    app: &tauri::AppHandle,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let client = make_local_client()?;
    let url = format!("{base_url}/chat/completions");

    let history: serde_json::Value = serde_json::from_str(history_json)
        .map_err(|e| format!("Invalid history JSON: {e}"))?;

    let mut messages: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];

    if let Some(arr) = history.as_array() {
        for msg in arr {
            messages.push(msg.clone());
        }
    }

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": true,
    });

    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);

    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_connect() {
            format!(
                "Could not connect to local LLM at {base_url}. \
                 Make sure Ollama / LM Studio is running."
            )
        } else {
            format!("Local LLM request failed: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        if status.as_u16() == 500 {
            return Err(format!(
                "Local LLM server error (500) — the prompt may be too large for the model. \
                 Raw: {body_text}"
            ));
        }
        return Err(format!("Local LLM error {status}: {body_text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut full_text = String::new();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        if REVIEW_CANCELLED.load(Ordering::Relaxed) {
            return Err("Review cancelled by user.".to_string());
        }
        let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer = buffer[nl + 1..].to_string();

            if !line.starts_with("data: ") { continue; }
            let data = &line["data: ".len()..];
            if data == "[DONE]" { break; }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(text) = json["choices"][0]["delta"]["content"].as_str() {
                    if !text.is_empty() {
                        full_text.push_str(text);
                        let _ = app.emit(stream_event, serde_json::json!({
                            "delta": text,
                        }));
                    }
                }
            }
        }
    }

    if full_text.is_empty() {
        return Err("Local LLM returned an empty streaming response.".to_string());
    }
    Ok(full_text)
}

/// Streaming multi-turn variant for Claude (Anthropic /v1/messages).
async fn complete_multi_claude_streaming(
    app: &tauri::AppHandle,
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let messages: serde_json::Value = serde_json::from_str(history_json)
        .map_err(|e| format!("Invalid history JSON: {e}"))?;

    let body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": true,
        "system": system,
        "messages": messages,
    });

    let req = client
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");

    let req = if api_key.starts_with("sk-ant-api") {
        req.header("x-api-key", api_key)
    } else {
        req.header("Authorization", format!("Bearer {api_key}"))
            .header("anthropic-beta", "oauth-2025-04-20")
    };

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| {
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

    let mut stream = resp.bytes_stream();
    let mut full_text = String::new();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        if REVIEW_CANCELLED.load(Ordering::Relaxed) {
            return Err("Review cancelled by user.".to_string());
        }
        let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer = buffer[nl + 1..].to_string();

            if !line.starts_with("data: ") { continue; }
            let data = &line["data: ".len()..];

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                let event_type = json["type"].as_str().unwrap_or("");
                match event_type {
                    "content_block_delta" => {
                        if json["delta"]["type"].as_str() == Some("text_delta") {
                            if let Some(text) = json["delta"]["text"].as_str() {
                                if !text.is_empty() {
                                    full_text.push_str(text);
                                    let _ = app.emit(stream_event, serde_json::json!({
                                        "delta": text,
                                    }));
                                }
                            }
                        }
                    }
                    "message_stop" => break,
                    "error" => {
                        let msg = json["error"]["message"]
                            .as_str()
                            .unwrap_or("Unknown streaming error");
                        return Err(format!("Claude stream error: {msg}"));
                    }
                    _ => {}
                }
            }
        }
    }

    if full_text.is_empty() {
        return Err("Claude returned an empty streaming response.".to_string());
    }
    Ok(full_text)
}

/// Provider-aware multi-turn streaming dispatch.
async fn dispatch_multi_streaming(
    app: &tauri::AppHandle,
    client: &Client,
    claude_key: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    let provider = get_ai_provider();

    let providers_to_try: Vec<String> = if provider == "auto" {
        get_provider_order()
    } else {
        vec![provider]
    };

    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &providers_to_try {
        let result = match p.as_str() {
            "claude" => {
                let auth_method = get_credential("claude_auth_method")
                    .unwrap_or_else(|| "api_key".to_string());
                if auth_method == "oauth" {
                    use tauri::Manager;
                    let sidecar = app.state::<crate::sidecar::SidecarState>();
                    let cwd = dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned();
                    crate::sidecar::dispatch_sidecar(
                        app, &sidecar, stream_event,
                        system.to_string(),
                        parse_history_to_sidecar_messages(history_json),
                        get_active_model(), cwd, None,
                    ).await.map(|r| r.text)
                } else if claude_key.is_empty() {
                    Err("not configured".to_string())
                } else {
                    complete_multi_claude_streaming(
                        app, client, claude_key, &get_active_model(),
                        system, history_json, max_tokens, stream_event,
                    ).await
                }
            }
            "local" => {
                let base = match local_llm_base_url() {
                    Some(b) => b,
                    None => { failure_reasons.push("Local LLM: not configured".to_string()); continue; }
                };
                let model = match get_local_llm_model() {
                    Some(m) => m,
                    None => { failure_reasons.push("Local LLM: no model selected".to_string()); continue; }
                };
                let key = get_credential("local_llm_api_key");
                complete_multi_local_streaming(
                    app, &base, key.as_deref(), &model,
                    system, history_json, max_tokens, stream_event,
                ).await
            }
            // Gemini and other providers fall back to non-streaming multi-turn
            _ => try_provider_multi(app, p, client, claude_key, system, history_json, max_tokens).await,
        };

        match result {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                failure_reasons.push(format!("{p}: not configured"));
            }
            Err(e) if is_quota_error(&e) => {
                failure_reasons.push(format!("{p}: rate limited / quota exceeded"));
            }
            Err(e) => return Err(e),
        }
    }

    let summary = failure_reasons.join("; ");
    Err(format!("All providers failed — {summary}"))
}

/// Streaming single-turn completion via local LLM (OpenAI SSE format).
/// Emits `{stream_event}` Tauri events for each token chunk received.
async fn complete_local_streaming(
    app: &tauri::AppHandle,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let client = make_local_client()?;
    let url = format!("{base_url}/chat/completions");

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": user  },
        ],
        "max_tokens": max_tokens,
        "stream": true,
    });

    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);

    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_connect() {
            format!(
                "Could not connect to local LLM at {base_url}. \
                 Make sure Ollama / LM Studio is running."
            )
        } else {
            format!("Local LLM request failed: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        // A 500 after a long wait almost always means Ollama hit its generation
        // timeout because the prompt was too large for the model to finish in time.
        if status.as_u16() == 500 {
            return Err(format!(
                "Local LLM server error (500) — the diff is likely too large for the model \
                 to process within its timeout. Try a PR with a smaller diff, or switch to \
                 Claude / Gemini for large PRs in Settings → AI Provider. Raw: {body_text}"
            ));
        }
        return Err(format!("Local LLM error {status}: {body_text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut full_text = String::new();
    let mut buffer = String::new(); // accumulate partial SSE lines

    while let Some(chunk) = stream.next().await {
        if REVIEW_CANCELLED.load(Ordering::Relaxed) {
            return Err("Review cancelled by user.".to_string());
        }
        let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        // SSE lines are separated by newlines; process complete lines only
        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer = buffer[nl + 1..].to_string();

            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line["data: ".len()..];
            if data == "[DONE]" {
                break;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = json["choices"][0]["delta"]["content"].as_str() {
                    if !delta.is_empty() {
                        full_text.push_str(delta);
                        // Emit the accumulated text so far as the progress message
                        let _ = app.emit(stream_event, serde_json::json!({
                            "delta": delta,
                        }));
                    }
                }
                // Check for finish reason
                if json["choices"][0]["finish_reason"].as_str().map_or(false, |r| r != "null" && !r.is_empty() && r != "") {
                    break;
                }
            }
        }
    }

    if full_text.is_empty() {
        return Err("Local LLM returned an empty response.".to_string());
    }

    Ok(full_text)
}

fn parse_history_to_sidecar_messages(history_json: &str) -> Vec<crate::sidecar::Message> {
    let Ok(arr) = serde_json::from_str::<serde_json::Value>(history_json) else {
        return Vec::new();
    };
    let Some(turns) = arr.as_array() else {
        return Vec::new();
    };
    turns.iter().filter_map(|t| {
        let role = t["role"].as_str()?.to_string();
        let content = t["content"].as_str()
            .map(|s| s.to_string())
            .or_else(|| {
                t["content"].as_array().map(|blocks| {
                    blocks.iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
            })?;
        Some(crate::sidecar::Message { role, content })
    }).collect()
}


/// Provider-aware dispatch that streams from the local LLM when it's the active
/// provider, and falls back to the standard (non-streaming) path for Claude/Gemini.
async fn dispatch_streaming(
    app: &tauri::AppHandle,
    client: &Client,
    claude_key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    let provider = get_ai_provider();

    let providers_to_try: Vec<String> = if provider == "auto" {
        get_provider_order()
    } else {
        vec![provider]
    };

    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &providers_to_try {
        let result = match p.as_str() {
            "claude" => {
                let auth_method = get_credential("claude_auth_method")
                    .unwrap_or_else(|| "api_key".to_string());
                if auth_method == "oauth" {
                    use tauri::Manager;
                    let sidecar = app.state::<crate::sidecar::SidecarState>();
                    let cwd = dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned();
                    crate::sidecar::dispatch_sidecar(
                        app, &sidecar, stream_event,
                        system.to_string(),
                        vec![crate::sidecar::Message { role: "user".to_string(), content: user.to_string() }],
                        get_active_model(), cwd, None,
                    ).await.map(|r| r.text)
                } else if claude_key.is_empty() {
                    Err("not configured".to_string())
                } else {
                    complete_claude_streaming(app, client, claude_key, &get_active_model(), system, user, max_tokens, stream_event).await
                }
            }
            "local" => {
                let base = match local_llm_base_url() {
                    Some(b) => b,
                    None => { failure_reasons.push("Local LLM: not configured".to_string()); continue; }
                };
                let model = match get_local_llm_model() {
                    Some(m) => m,
                    None => { failure_reasons.push("Local LLM: no model selected".to_string()); continue; }
                };
                let key = get_credential("local_llm_api_key");
                complete_local_streaming(app, &base, key.as_deref(), &model, system, user, max_tokens, stream_event).await
            }
            p => try_provider_single(app, p, client, claude_key, system, user, max_tokens).await,
        };

        match result {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                failure_reasons.push(format!("{p}: not configured"));
            }
            Err(e) if is_quota_error(&e) => {
                failure_reasons.push(format!("{p}: rate limited / quota exceeded"));
            }
            Err(e) => return Err(e),
        }
    }

    let summary = failure_reasons.join("; ");
    Err(format!("All providers failed — {summary}"))
}

/// Fetch the model list from the local server via the OpenAI-compatible `/v1/models`
/// endpoint, with an Ollama-native `/api/tags` fallback.
#[tauri::command]
pub async fn get_local_models() -> Vec<(String, String)> {
    let base_url = match local_llm_base_url() {
        Some(u) => u,
        None => return vec![],
    };

    let api_key = get_credential("local_llm_api_key");
    let client = match make_local_client() {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    // ── Try OpenAI-compatible /models ─────────────────────────────────────────
    let mut req = client.get(format!("{base_url}/models"));
    if let Some(ref key) = api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
    }

    if let Ok(resp) = req.send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = json["data"].as_array() {
                    let models: Vec<(String, String)> = arr
                        .iter()
                        .filter_map(|m| {
                            let id = m["id"].as_str()?;
                            Some((id.to_string(), id.to_string()))
                        })
                        .collect();
                    if !models.is_empty() {
                        return models;
                    }
                }
            }
        }
    }

    // ── Ollama fallback: try stripping /v1 suffix and hitting /api/tags ───────
    let ollama_base = base_url.trim_end_matches("/v1");
    if let Ok(resp) = client.get(format!("{ollama_base}/api/tags")).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = json["models"].as_array() {
                    let models: Vec<(String, String)> = arr
                        .iter()
                        .filter_map(|m| {
                            let name = m["name"].as_str()?;
                            Some((name.to_string(), name.to_string()))
                        })
                        .collect();
                    if !models.is_empty() {
                        return models;
                    }
                }
            }
        }
    }

    vec![]
}

/// Test connectivity to a local LLM server and save the URL + optional key on success.
#[tauri::command]
pub async fn validate_local_llm(url: String, api_key: String) -> Result<String, String> {
    use super::credentials::store_credential;

    let base = url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Server URL cannot be empty.".to_string());
    }
    // Normalise: ensure it ends with /v1
    let base = if base.ends_with("/v1") {
        base.to_string()
    } else {
        format!("{base}/v1")
    };

    let client = make_local_client()?;
    let key_opt = if api_key.trim().is_empty() { None } else { Some(api_key.trim()) };

    // Try /models first (OpenAI-compatible)
    let mut req = client.get(format!("{base}/models"));
    if let Some(k) = key_opt {
        req = req.header("Authorization", format!("Bearer {k}"));
    }

    let ok = match req.send().await {
        Ok(r) => r.status().is_success() || r.status().as_u16() == 404,
        Err(_) => {
            // Fallback: try Ollama's root endpoint
            let ollama_root = base.trim_end_matches("/v1");
            match client.get(format!("{ollama_root}/api/tags")).send().await {
                Ok(r) => r.status().is_success(),
                Err(e) => {
                    return Err(format!(
                        "Could not connect to {base}. \
                         Is the server running?\n\nError: {e}"
                    ))
                }
            }
        }
    };

    if !ok {
        return Err(format!("Server at {base} responded with an unexpected error."));
    }

    store_credential("local_llm_url", &base)?;
    if let Some(k) = key_opt {
        store_credential("local_llm_api_key", k)?;
    }

    Ok(format!("Connected to local LLM server at {base}."))
}

/// Test the already-stored Local LLM server URL without re-saving it.
#[tauri::command]
pub async fn test_local_llm_stored() -> Result<String, String> {
    let base = local_llm_base_url()
        .ok_or("Local LLM server URL is not configured.")?;
    let key_opt = get_credential("local_llm_api_key")
        .filter(|k| !k.trim().is_empty());

    let client = make_local_client()?;

    let mut req = client.get(format!("{base}/models"));
    if let Some(ref k) = key_opt {
        req = req.header("Authorization", format!("Bearer {k}"));
    }

    let ok = match req.send().await {
        Ok(r) => r.status().is_success() || r.status().as_u16() == 404,
        Err(_) => {
            // Fallback: Ollama /api/tags
            let ollama_root = base.trim_end_matches("/v1");
            match client.get(format!("{ollama_root}/api/tags")).send().await {
                Ok(r) => r.status().is_success(),
                Err(e) => return Err(format!(
                    "Could not connect to {base}. \
                     Is the server running?\n\nError: {e}"
                )),
            }
        }
    };

    if ok {
        Ok(format!("Connected to local LLM server at {base}."))
    } else {
        Err(format!("Server at {base} responded with an unexpected error."))
    }
}

// ── Model catalogue ────────────────────────────────────────────────────────────

pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";

/// Hardcoded fallback used when the Anthropic Models API is unreachable or the
/// user has not yet configured credentials.
pub const AVAILABLE_MODELS: &[(&str, &str)] = &[
    ("claude-haiku-4-5-20251001", "Claude Haiku 4.5  — Fastest"),
    ("claude-sonnet-4-6",         "Claude Sonnet 4.6 — Balanced (recommended)"),
    ("claude-opus-4-6",           "Claude Opus 4.6   — Most capable"),
];

/// Read the user-selected model from the credential store, falling back to the
/// default Sonnet model if none has been saved yet.
fn get_active_model() -> String {
    get_credential("claude_model")
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

/// Derive a human-readable label from a model ID.
/// "claude-sonnet-4-6"        → "Claude Sonnet 4.6"
/// "claude-haiku-4-5-20251001"→ "Claude Haiku 4.5"
fn model_label(id: &str) -> String {
    let tier = if id.contains("opus") {
        "Opus"
    } else if id.contains("sonnet") {
        "Sonnet"
    } else if id.contains("haiku") {
        "Haiku"
    } else {
        return id.to_string();
    };

    // Extract the version number — look for the first digit segment ≥ 3 followed
    // by another digit segment (e.g. "4" then "6" → "4.6").
    let parts: Vec<&str> = id.split('-').collect();
    let version = parts.windows(2).find_map(|w| {
        let major: u32 = w[0].parse().ok()?;
        let minor: u32 = w[1].parse().ok()?;
        if major >= 3 { Some(format!("{major}.{minor}")) } else { None }
    });

    match version {
        Some(v) => format!("Claude {tier} {v}"),
        None => format!("Claude {tier}"),
    }
}

/// Tier sort weight: Haiku < Sonnet < Opus (ascending capability).
fn tier_weight(id: &str) -> u8 {
    if id.contains("haiku") { 0 }
    else if id.contains("sonnet") { 1 }
    else if id.contains("opus") { 2 }
    else { 3 }
}

/// Fetch the live model list from `GET /v1/models`, filter to current Claude
/// 4.x+ models, and return them sorted Haiku → Sonnet → Opus (newest version
/// first within each tier).  Returns `Err` on any network or parse failure so
/// callers can fall back gracefully.
async fn fetch_models_live(client: &Client, api_key: &str) -> Result<Vec<(String, String)>, String> {
    let req = client
        .get("https://api.anthropic.com/v1/models")
        .header("anthropic-version", "2023-06-01");

    let req = if api_key.starts_with("sk-ant-api") {
        req.header("x-api-key", api_key)
    } else {
        req.header("Authorization", format!("Bearer {api_key}"))
            .header("anthropic-beta", "oauth-2025-04-20")
    };

    let resp = req.send().await.map_err(|e| format!("Models API request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Models API returned HTTP {}", resp.status()));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {e}"))?;

    let data = json["data"]
        .as_array()
        .ok_or("Unexpected models API response shape")?;

    // Keep only current-generation Claude models (claude-4.x and newer).
    // Exclude: claude-3* (legacy), claude-instant, aliases ending in -latest,
    // and anything that doesn't look like a versioned model.
    let mut models: Vec<(String, i64, u8)> = data
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            if !id.starts_with("claude-") { return None; }
            if id.contains("claude-3") || id.contains("instant") { return None; }
            if id.ends_with("-latest") || id.contains("preview") { return None; }
            // Require a recognisable tier name so we can label it properly.
            if !id.contains("opus") && !id.contains("sonnet") && !id.contains("haiku") {
                return None;
            }
            // created_at may be an ISO string or a Unix integer.
            let created: i64 = m["created_at"]
                .as_i64()
                .or_else(|| {
                    m["created_at"].as_str().and_then(|s| {
                        // Parse ISO 8601 naively: just extract the year for ordering.
                        s.split('-').next()?.parse::<i64>().ok()
                    })
                })
                .unwrap_or(0);
            Some((id.to_string(), created, tier_weight(id)))
        })
        .collect();

    if models.is_empty() {
        return Err("Models API returned no usable models".to_string());
    }

    // Sort: tier ascending (Haiku first), then created_at descending within tier.
    models.sort_by(|a, b| a.2.cmp(&b.2).then(b.1.cmp(&a.1)));

    Ok(models
        .into_iter()
        .map(|(id, _, _)| {
            let label = model_label(&id);
            (id, label)
        })
        .collect())
}

/// Return the model catalogue for the settings UI.
/// Tries to fetch a live list from the Anthropic Models API (so it stays
/// current as new models launch) and falls back to the hardcoded list if the
/// API is unreachable or no credentials are configured yet.
#[tauri::command]
pub async fn get_claude_models() -> Vec<(String, String)> {
    // Only attempt a live fetch if credentials are already configured.
    if let Some(api_key) = get_credential("anthropic_api_key") {
        if let Ok(client) = make_corporate_client(Duration::from_secs(8)) {
            if let Ok(models) = fetch_models_live(&client, &api_key).await {
                return models;
            }
        }
    }
    // Fall back to hardcoded list.
    AVAILABLE_MODELS
        .iter()
        .map(|(id, label)| (id.to_string(), label.to_string()))
        .collect()
}

/// Builds an HTTP client and returns it with the Anthropic key (if set).
/// Does NOT require an Anthropic key — the dispatch layer picks the right
/// provider (Anthropic, Gemini, or local LLM) based on what's configured.
async fn llm_client() -> Result<(Client, String), String> {
    let client = make_corporate_client(Duration::from_secs(60))?;
    // Use claude_auth_method to decide whether to use the OAuth refresh flow.
    // "oauth" → refresh OAuth token if needed before returning the key.
    // "api_key" (or unset) → use the stored API key directly, no OAuth refresh.
    let auth_method = get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
    if auth_method == "oauth" {
        refresh_oauth_if_needed(&client).await?;
    }
    let api_key = get_credential("anthropic_api_key").unwrap_or_default();
    Ok((client, api_key))
}

// ── Auth-aware request helpers ─────────────────────────────────────────────────
//
// API keys (sk-ant-api03-…) use the x-api-key header.
// OAuth tokens (sk-ant-oat01-…, cact-…, etc.) use Authorization: Bearer
// plus the oauth-2025-04-20 beta header required by the Anthropic API.

async fn complete(
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{ "role": "user", "content": user }]
    });

    let req = client
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");

    let req = if api_key.starts_with("sk-ant-api") {
        req.header("x-api-key", api_key)
    } else {
        req.header("Authorization", format!("Bearer {api_key}"))
            .header("anthropic-beta", "oauth-2025-04-20")
    };

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach api.anthropic.com. Check your internet connection.".to_string()
            } else {
                format!("Request failed: {e}")
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Claude API error {status}: {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Claude response: {e}"))?;

    json["content"][0]["text"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from Claude API.".to_string())
}

/// Streaming single-turn completion via the Anthropic Messages API.
/// Emits `{stream_event}` Tauri events for each text_delta received.
async fn complete_claude_streaming(
    app: &tauri::AppHandle,
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": true,
        "system": system,
        "messages": [{ "role": "user", "content": user }]
    });

    let req = client
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");

    let req = if api_key.starts_with("sk-ant-api") {
        req.header("x-api-key", api_key)
    } else {
        req.header("Authorization", format!("Bearer {api_key}"))
            .header("anthropic-beta", "oauth-2025-04-20")
    };

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| {
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

    let mut stream = resp.bytes_stream();
    let mut full_text = String::new();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        if REVIEW_CANCELLED.load(Ordering::Relaxed) {
            return Err("Review cancelled by user.".to_string());
        }
        let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete SSE lines
        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer = buffer[nl + 1..].to_string();

            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line["data: ".len()..];

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                // Anthropic streaming event types:
                // "content_block_delta" with delta.type == "text_delta" carries text
                let event_type = json["type"].as_str().unwrap_or("");
                match event_type {
                    "content_block_delta" => {
                        if json["delta"]["type"].as_str() == Some("text_delta") {
                            if let Some(text) = json["delta"]["text"].as_str() {
                                if !text.is_empty() {
                                    full_text.push_str(text);
                                    let _ = app.emit(stream_event, serde_json::json!({
                                        "delta": text,
                                    }));
                                }
                            }
                        }
                    }
                    "message_stop" => break,
                    "error" => {
                        let msg = json["error"]["message"]
                            .as_str()
                            .unwrap_or("Unknown streaming error");
                        return Err(format!("Claude stream error: {msg}"));
                    }
                    _ => {}
                }
            }
        }
    }

    if full_text.is_empty() {
        return Err("Claude returned an empty streaming response.".to_string());
    }

    Ok(full_text)
}

/// Multi-turn complete — history_json is a JSON array of {role, content} objects.
async fn complete_multi(
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let messages: serde_json::Value = serde_json::from_str(history_json)
        .map_err(|e| format!("Invalid history JSON: {e}"))?;

    let body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages
    });

    let req = client
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");

    let req = if api_key.starts_with("sk-ant-api") {
        req.header("x-api-key", api_key)
    } else {
        req.header("Authorization", format!("Bearer {api_key}"))
            .header("anthropic-beta", "oauth-2025-04-20")
    };

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach api.anthropic.com. Check your internet connection.".to_string()
            } else {
                format!("Request failed: {e}")
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Claude API error {status}: {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Claude response: {e}"))?;

    json["content"][0]["text"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from Claude API.".to_string())
}

// ── Tool-use loop ──────────────────────────────────────────────────────────────
//
// Conversational agents (triage, grooming chat, checkpoint, PR review chat) run
// inside an agentic loop that allows them to call tools autonomously — up to
// MAX_TOOL_ROUNDS times per user turn.
//
// Supported tools:
//   fetch_url        — fetch any public URL as plain text
//   read_repo_file   — read a file from the configured worktree
//   grep_repo        — search the worktree by regex pattern
//   search_jira      — search JIRA by keyword or JQL
//   get_jira_issue   — fetch a specific JIRA ticket by key
//   get_pr_diff      — fetch a Bitbucket PR diff by ID
//   get_pr_comments  — fetch Bitbucket PR comments by ID
//   git_log          — recent git history (optionally for one file)
//   search_npm       — query npm registry for a package
//   search_crates    — query crates.io for a Rust crate
//   request_tool     — ask the developer to add a new tool to Meridian
//
// Provider strategy:
//   Claude  — native Anthropic tool-use API (tools / tool_use blocks)
//   Gemini / Local — text-based XML-tag protocol injected into system prompt

const MAX_TOOL_ROUNDS: usize = 8;

// ── Tool definitions ──────────────────────────────────────────────────────────

/// All supported tool names as constants.
const TOOL_FETCH_URL:       &str = "fetch_url";
const TOOL_READ_REPO_FILE:  &str = "read_repo_file";
const TOOL_GREP_REPO:       &str = "grep_repo";
const TOOL_SEARCH_JIRA:     &str = "search_jira";
const TOOL_GET_JIRA_ISSUE:  &str = "get_jira_issue";
const TOOL_GET_PR_DIFF:     &str = "get_pr_diff";
const TOOL_GET_PR_COMMENTS: &str = "get_pr_comments";
const TOOL_GIT_LOG:         &str = "git_log";
const TOOL_SEARCH_NPM:      &str = "search_npm";
const TOOL_SEARCH_CRATES:   &str = "search_crates";
const TOOL_REQUEST_TOOL:    &str = "request_tool";

/// The JSON tool definitions sent to Claude on every conversational turn.
fn all_tools_def() -> serde_json::Value {
    serde_json::json!([
        {
            "name": TOOL_FETCH_URL,
            "description": "Fetch the plain-text content of any public URL. \
                Use for API docs, library READMEs, changelogs, GitHub pages, \
                benchmark comparisons, or any live web resource.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Full https:// URL to fetch" }
                },
                "required": ["url"]
            }
        },
        {
            "name": TOOL_READ_REPO_FILE,
            "description": "Read a source file from the configured local git worktree. \
                Use when you need to see more code context beyond what was already provided, \
                e.g. to understand how a function is implemented or what a module exports.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path from the repo root, e.g. 'src/reports/index.ts'" }
                },
                "required": ["path"]
            }
        },
        {
            "name": TOOL_GREP_REPO,
            "description": "Search the codebase for a regex pattern using git grep. \
                Use to find all usages of a function, class, constant, or identifier. \
                Returns up to 200 matching lines with file paths and line numbers.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Extended regex pattern to search for" },
                    "path":    { "type": "string", "description": "Optional subdirectory to restrict the search (e.g. 'src/reports')" }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": TOOL_SEARCH_JIRA,
            "description": "Search JIRA for related tickets by keyword or JQL. \
                Use to find duplicate tickets, dependency tickets, or related work \
                the engineer mentioned. Returns up to 10 matching tickets.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Keyword search string or JQL (e.g. 'upsertReportPage' or 'project = FJP AND summary ~ \"undo\"')" }
                },
                "required": ["query"]
            }
        },
        {
            "name": TOOL_GET_JIRA_ISSUE,
            "description": "Fetch a specific JIRA ticket by its key (e.g. FJP-1234). \
                Use when the engineer references a ticket you need to read for context.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "JIRA issue key, e.g. 'FJP-1234'" }
                },
                "required": ["key"]
            }
        },
        {
            "name": TOOL_GET_PR_DIFF,
            "description": "Fetch the full diff of a Bitbucket pull request by its numeric ID. \
                Use when the engineer mentions a related PR you need to read.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pr_id": { "type": "integer", "description": "Numeric Bitbucket PR ID" }
                },
                "required": ["pr_id"]
            }
        },
        {
            "name": TOOL_GET_PR_COMMENTS,
            "description": "Fetch the comments on a Bitbucket pull request by its numeric ID. \
                Use to read reviewer feedback on a related PR.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pr_id": { "type": "integer", "description": "Numeric Bitbucket PR ID" }
                },
                "required": ["pr_id"]
            }
        },
        {
            "name": TOOL_GIT_LOG,
            "description": "Get recent git commit history from the worktree. \
                Optionally restrict to a specific file to understand when and why it was last changed. \
                Returns the last N commits (default 20, max 50).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file":       { "type": "string",  "description": "Optional relative file path to filter history" },
                    "max_commits": { "type": "integer", "description": "Number of commits to return (default 20)" }
                },
                "required": []
            }
        },
        {
            "name": TOOL_SEARCH_NPM,
            "description": "Search the npm registry for a JavaScript/TypeScript package. \
                Returns the package description, version, weekly downloads, and homepage. \
                Use when brainstorming library choices or checking if a package exists.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "package": { "type": "string", "description": "Package name or search term" }
                },
                "required": ["package"]
            }
        },
        {
            "name": TOOL_SEARCH_CRATES,
            "description": "Search crates.io for a Rust crate. \
                Returns the crate description, version, downloads, and repository link. \
                Use when brainstorming Rust library choices.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Crate name or search term" }
                },
                "required": ["name"]
            }
        },
        {
            "name": TOOL_REQUEST_TOOL,
            "description": "Request that the developer add a new tool to Meridian. \
                Use this when you genuinely need a capability that none of the existing tools \
                provide and you cannot complete your task without it. \
                Be specific: describe exactly what data you need, why no existing tool covers it, \
                and how it would help you right now.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name":        { "type": "string", "description": "Short slug for the proposed tool, e.g. 'get_build_logs'" },
                    "description": { "type": "string", "description": "One sentence: what the tool would do" },
                    "why_needed":  { "type": "string", "description": "Why no existing tool covers this and what context it would unlock" },
                    "example_call":{ "type": "string", "description": "A concrete example of how you would call it, e.g. get_build_logs(branch='task/FJP-1234', last_n=50)" }
                },
                "required": ["name", "description", "why_needed"]
            }
        }
    ])
}

/// Text-based tool protocol injected into the system prompt for Gemini / local LLMs.
/// Each tool is represented as an XML-style self-closing tag.
const TOOL_SYSTEM_SUFFIX: &str = "\n\n\
    === AVAILABLE TOOLS ===\n\
    You have access to the following tools. Use them when they would improve your answer.\n\
    To call a tool, output ONLY the tag on its own line — nothing else on that line.\n\
    The system will run the tool and send you the result before you continue.\n\n\
    fetch_url        — fetch a web page as plain text:\n\
        <fetch_url url=\"https://example.com\"/>\n\n\
    read_repo_file   — read a source file from the codebase:\n\
        <read_repo_file path=\"src/reports/index.ts\"/>\n\n\
    grep_repo        — search codebase by regex (optional path filter):\n\
        <grep_repo pattern=\"upsertReportPage\" path=\"src/reports\"/>\n\n\
    search_jira      — search JIRA by keyword or JQL:\n\
        <search_jira query=\"undo redo reports\"/>\n\n\
    get_jira_issue   — fetch a specific JIRA ticket:\n\
        <get_jira_issue key=\"FJP-1234\"/>\n\n\
    get_pr_diff      — fetch a Bitbucket PR diff:\n\
        <get_pr_diff pr_id=\"456\"/>\n\n\
    get_pr_comments  — fetch comments on a Bitbucket PR:\n\
        <get_pr_comments pr_id=\"456\"/>\n\n\
    git_log          — recent git history (optional file and count):\n\
        <git_log file=\"src/reports/index.ts\" max_commits=\"20\"/>\n\n\
    search_npm       — search npm registry for a JS/TS package:\n\
        <search_npm package=\"zustand\"/>\n\n\
    search_crates    — search crates.io for a Rust crate:\n\
        <search_crates name=\"serde\"/>\n\n\
    request_tool     — ask the developer to add a new Meridian tool:\n\
        <request_tool name=\"get_build_logs\" description=\"Fetch CI build logs for a branch\" why_needed=\"I need to check why the build is failing but have no way to read CI output\" example_call=\"get_build_logs(branch='task/FJP-1234', last_n=50)\"/>\n\n\
    Rules:\n\
    - Call at most one tool per response turn.\n\
    - Stop after outputting the tag — do not continue until you receive the result.\n\
    - If a tool fails, say so and answer from your existing knowledge instead.\n\
    - Do NOT call a tool if you can answer accurately from the context already provided.";

// ── Tool execution ─────────────────────────────────────────────────────────────

/// Execute any supported tool given its name and JSON input, returning the result as a String.
async fn execute_tool(name: &str, input: &serde_json::Value) -> String {
    match name {
        TOOL_FETCH_URL => {
            let url = input["url"].as_str().unwrap_or("");
            if url.is_empty() { return "[fetch_url: missing url]".to_string(); }
            use crate::commands::fetch_url::fetch_url_content;
            match fetch_url_content(url.to_string()).await {
                Ok(c) => c,
                Err(e) => format!("[fetch_url failed: {e}]"),
            }
        }

        TOOL_READ_REPO_FILE => {
            let path = input["path"].as_str().unwrap_or("");
            if path.is_empty() { return "[read_repo_file: missing path]".to_string(); }
            use crate::commands::repo::read_repo_file;
            match read_repo_file(path.to_string()).await {
                Ok(c) => format!("=== {path} ===\n{c}"),
                Err(e) => format!("[read_repo_file failed for '{path}': {e}]"),
            }
        }

        TOOL_GREP_REPO => {
            let pattern = input["pattern"].as_str().unwrap_or("").to_string();
            let path    = input["path"].as_str().map(str::to_string);
            if pattern.is_empty() { return "[grep_repo: missing pattern]".to_string(); }
            use crate::commands::repo::grep_repo_files;
            match grep_repo_files(pattern.clone(), path).await {
                Ok(lines) if lines.is_empty() => format!("[grep_repo: no matches for '{pattern}']"),
                Ok(lines) => {
                    // Cap the tool result at ~12 KB so it never overwhelms the context window.
                    // grep_repo_files already caps at 200 lines but lines can be long.
                    const MAX_GREP_BYTES: usize = 12 * 1024;
                    let joined = lines.join("\n");
                    if joined.len() > MAX_GREP_BYTES {
                        format!(
                            "{}\n\n[… grep output truncated at 12 KB — use a more specific pattern or path to narrow results …]",
                            &joined[..MAX_GREP_BYTES]
                        )
                    } else {
                        joined
                    }
                }
                Err(e) => format!("[grep_repo failed: {e}]"),
            }
        }

        TOOL_SEARCH_JIRA => {
            let query = input["query"].as_str().unwrap_or("").to_string();
            if query.is_empty() { return "[search_jira: missing query]".to_string(); }
            use crate::commands::jira::search_jira_issues;
            match search_jira_issues(query.clone(), 10).await {
                Ok(issues) if issues.is_empty() => format!("[search_jira: no results for '{query}']"),
                Ok(issues) => {
                    let mut out = format!("JIRA search results for '{query}':\n\n");
                    for issue in &issues {
                        out.push_str(&format!(
                            "## {} — {}\nType: {} | Status: {} | Points: {}\n{}\n\n",
                            issue.key,
                            issue.summary,
                            issue.issue_type,
                            issue.status,
                            issue.story_points.map_or("?".to_string(), |p| p.to_string()),
                            issue.description.as_deref().unwrap_or("(no description)"),
                        ));
                    }
                    out
                }
                Err(e) => format!("[search_jira failed: {e}]"),
            }
        }

        TOOL_GET_JIRA_ISSUE => {
            let key = input["key"].as_str().unwrap_or("").to_string();
            if key.is_empty() { return "[get_jira_issue: missing key]".to_string(); }
            use crate::commands::jira::get_issue;
            match get_issue(key.clone()).await {
                Ok(issue) => format!(
                    "## {} — {}\nType: {} | Status: {} | Points: {}\n\nDescription:\n{}\n\nAcceptance Criteria:\n{}",
                    issue.key,
                    issue.summary,
                    issue.issue_type,
                    issue.status,
                    issue.story_points.map_or("?".to_string(), |p| p.to_string()),
                    issue.description.as_deref().unwrap_or("(none)"),
                    issue.acceptance_criteria.as_deref().unwrap_or("(none)"),
                ),
                Err(e) => format!("[get_jira_issue failed for '{key}': {e}]"),
            }
        }

        TOOL_GET_PR_DIFF => {
            let pr_id = match input["pr_id"].as_i64() {
                Some(id) => id,
                None => return "[get_pr_diff: missing or invalid pr_id]".to_string(),
            };
            use crate::commands::bitbucket::get_pr_diff;
            match get_pr_diff(pr_id).await {
                Ok(diff) => {
                    // Cap diff at 80 KB so it doesn't swamp the context
                    const MAX: usize = 80 * 1024;
                    if diff.len() > MAX {
                        format!("{}\n\n[diff truncated at 80 KB]", &diff[..MAX])
                    } else {
                        diff
                    }
                }
                Err(e) => format!("[get_pr_diff failed for PR {pr_id}: {e}]"),
            }
        }

        TOOL_GET_PR_COMMENTS => {
            let pr_id = match input["pr_id"].as_i64() {
                Some(id) => id,
                None => return "[get_pr_comments: missing or invalid pr_id]".to_string(),
            };
            use crate::commands::bitbucket::get_pr_comments;
            match get_pr_comments(pr_id).await {
                Ok(comments) if comments.is_empty() => format!("[No comments on PR {pr_id}]"),
                Ok(comments) => {
                    let mut out = format!("Comments on PR {pr_id}:\n\n");
                    for c in comments.iter().take(50) {
                        let loc = c.inline.as_ref()
                            .map(|i| format!(" ({}{})", i.path, i.to_line.map_or(String::new(), |l| format!(" L{l}"))))
                            .unwrap_or_default();
                        out.push_str(&format!(
                            "[{}{}]: {}\n\n",
                            c.author.display_name,
                            loc,
                            c.content,
                        ));
                    }
                    out
                }
                Err(e) => format!("[get_pr_comments failed for PR {pr_id}: {e}]"),
            }
        }

        TOOL_GIT_LOG => {
            let file = input["file"].as_str();
            let max  = input["max_commits"].as_u64().unwrap_or(20).min(50) as u32;
            use crate::commands::repo::{get_repo_log, get_file_history};
            let result = if let Some(f) = file {
                get_file_history(f.to_string(), max).await
            } else {
                get_repo_log(max).await
            };
            match result {
                Ok(log) => log,
                Err(e) => format!("[git_log failed: {e}]"),
            }
        }

        TOOL_SEARCH_NPM => {
            let package = input["package"].as_str().unwrap_or("").trim().to_string();
            if package.is_empty() { return "[search_npm: missing package name]".to_string(); }
            search_npm_registry(&package).await
        }

        TOOL_SEARCH_CRATES => {
            let name = input["name"].as_str().unwrap_or("").trim().to_string();
            if name.is_empty() { return "[search_crates: missing crate name]".to_string(); }
            search_crates_io(&name).await
        }

        TOOL_REQUEST_TOOL => {
            // No execution — just surface the request as structured JSON so the
            // frontend can render a special card. Return an acknowledgement so the
            // model can write its final reply explaining the situation.
            let name        = input["name"].as_str().unwrap_or("(unnamed)");
            let description = input["description"].as_str().unwrap_or("");
            let why_needed  = input["why_needed"].as_str().unwrap_or("");
            let example     = input["example_call"].as_str().unwrap_or("");
            format!(
                "[tool_request_received]\n\
                 Your request for the '{}' tool has been surfaced to the developer in the UI.\n\
                 Tool: {}\n\
                 Why needed: {}\n\
                 Example: {}\n\
                 Please continue your response explaining what you cannot do without this tool \
                 and what you'll do in the meantime.",
                name, description, why_needed, example
            )
        }

        other => format!("[Unknown tool: {other}]"),
    }
}

// ── Package registry helpers ───────────────────────────────────────────────────

async fn search_npm_registry(package: &str) -> String {
    use crate::http::make_corporate_client;
    let client = match make_corporate_client(std::time::Duration::from_secs(10)) {
        Ok(c) => c,
        Err(e) => return format!("[search_npm: http client error: {e}]"),
    };
    let url = format!("https://registry.npmjs.org/-/v1/search?text={}&size=5",
        urlencoding_simple(package));
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<serde_json::Value>().await {
                Ok(json) => {
                    let objects = json["objects"].as_array()
                        .cloned()
                        .unwrap_or_default();
                    if objects.is_empty() {
                        return format!("[search_npm: no results for '{package}']");
                    }
                    let mut out = format!("npm search results for '{package}':\n\n");
                    for obj in objects.iter().take(5) {
                        let p = &obj["package"];
                        let name    = p["name"].as_str().unwrap_or("?");
                        let version = p["version"].as_str().unwrap_or("?");
                        let desc    = p["description"].as_str().unwrap_or("(no description)");
                        let weekly  = obj["score"]["detail"]["popularity"].as_f64()
                            .map(|v| format!("{:.0}%", v * 100.0))
                            .unwrap_or_else(|| "?".to_string());
                        let links   = p["links"]["npm"].as_str().unwrap_or("");
                        out.push_str(&format!(
                            "**{name}** v{version}\n{desc}\nPopularity: {weekly} | {links}\n\n"
                        ));
                    }
                    out
                }
                Err(e) => format!("[search_npm: parse error: {e}]"),
            }
        }
        Ok(resp) => format!("[search_npm: HTTP {}]", resp.status()),
        Err(e) => format!("[search_npm: request failed: {e}]"),
    }
}

async fn search_crates_io(name: &str) -> String {
    use crate::http::make_corporate_client;
    let client = match make_corporate_client(std::time::Duration::from_secs(10)) {
        Ok(c) => c,
        Err(e) => return format!("[search_crates: http client error: {e}]"),
    };
    let url = format!("https://crates.io/api/v1/crates?q={}&per_page=5",
        urlencoding_simple(name));
    match client
        .get(&url)
        .header("User-Agent", "Meridian/1.0 (https://github.com/meridian-app)")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<serde_json::Value>().await {
                Ok(json) => {
                    let crates = json["crates"].as_array()
                        .cloned()
                        .unwrap_or_default();
                    if crates.is_empty() {
                        return format!("[search_crates: no results for '{name}']");
                    }
                    let mut out = format!("crates.io search results for '{name}':\n\n");
                    for c in crates.iter().take(5) {
                        let cname     = c["name"].as_str().unwrap_or("?");
                        let version   = c["newest_version"].as_str().unwrap_or("?");
                        let desc      = c["description"].as_str().unwrap_or("(no description)");
                        let downloads = c["downloads"].as_u64().unwrap_or(0);
                        let repo      = c["repository"].as_str().unwrap_or("");
                        out.push_str(&format!(
                            "**{cname}** v{version}\n{desc}\nDownloads: {downloads} | {repo}\n\n"
                        ));
                    }
                    out
                }
                Err(e) => format!("[search_crates: parse error: {e}]"),
            }
        }
        Ok(resp) => format!("[search_crates: HTTP {}]", resp.status()),
        Err(e) => format!("[search_crates: request failed: {e}]"),
    }
}

/// Minimal percent-encoding for URL query parameters (encodes spaces and special chars).
fn urlencoding_simple(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        ' ' => "+".to_string(),
        c => format!("%{:02X}", c as u32),
    }).collect()
}

// ── Text-based tool tag extraction (Gemini / local) ───────────────────────────

/// Represents a parsed tool call from text-based protocol output.
struct TextToolCall {
    name: String,
    input: serde_json::Value,
    /// The full tag string to strip from visible output
    tag: String,
}

/// Extract any supported tool tag from a model reply.
/// Returns the first tool call found, or None if the reply is a plain text response.
fn extract_text_tool_call(text: &str) -> Option<TextToolCall> {
    // Helper: extract attribute value from tag string
    fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
        let dq = format!(r#"{}=""#, name);
        let sq = format!(r#"{}='"#, name);
        if let Some(start) = tag.find(&dq) {
            let rest = &tag[start + dq.len()..];
            rest.find('"').map(|end| &rest[..end])
        } else if let Some(start) = tag.find(&sq) {
            let rest = &tag[start + sq.len()..];
            rest.find('\'').map(|end| &rest[..end])
        } else {
            None
        }
    }

    // Find first < ... /> block that looks like one of our tool tags
    let tools = [
        TOOL_FETCH_URL, TOOL_READ_REPO_FILE, TOOL_GREP_REPO,
        TOOL_SEARCH_JIRA, TOOL_GET_JIRA_ISSUE, TOOL_GET_PR_DIFF,
        TOOL_GET_PR_COMMENTS, TOOL_GIT_LOG, TOOL_SEARCH_NPM, TOOL_SEARCH_CRATES,
        TOOL_REQUEST_TOOL,
    ];

    for tool in &tools {
        let open = format!("<{tool}");
        if let Some(start) = text.find(&open) {
            if let Some(rel_end) = text[start..].find("/>") {
                let end = start + rel_end + 2;
                let tag_str = &text[start..end];

                let input = match *tool {
                    TOOL_FETCH_URL => {
                        let url = attr(tag_str, "url").unwrap_or("");
                        serde_json::json!({ "url": url })
                    }
                    TOOL_READ_REPO_FILE => {
                        let path = attr(tag_str, "path").unwrap_or("");
                        serde_json::json!({ "path": path })
                    }
                    TOOL_GREP_REPO => {
                        let pattern = attr(tag_str, "pattern").unwrap_or("");
                        let path    = attr(tag_str, "path");
                        serde_json::json!({ "pattern": pattern, "path": path })
                    }
                    TOOL_SEARCH_JIRA => {
                        let query = attr(tag_str, "query").unwrap_or("");
                        serde_json::json!({ "query": query })
                    }
                    TOOL_GET_JIRA_ISSUE => {
                        let key = attr(tag_str, "key").unwrap_or("");
                        serde_json::json!({ "key": key })
                    }
                    TOOL_GET_PR_DIFF | TOOL_GET_PR_COMMENTS => {
                        let pr_id: i64 = attr(tag_str, "pr_id")
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0);
                        serde_json::json!({ "pr_id": pr_id })
                    }
                    TOOL_GIT_LOG => {
                        let file = attr(tag_str, "file");
                        let max: u64 = attr(tag_str, "max_commits")
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(20);
                        serde_json::json!({ "file": file, "max_commits": max })
                    }
                    TOOL_SEARCH_NPM => {
                        let package = attr(tag_str, "package").unwrap_or("");
                        serde_json::json!({ "package": package })
                    }
                    TOOL_SEARCH_CRATES => {
                        let name = attr(tag_str, "name").unwrap_or("");
                        serde_json::json!({ "name": name })
                    }
                    TOOL_REQUEST_TOOL => {
                        let name        = attr(tag_str, "name").unwrap_or("");
                        let description = attr(tag_str, "description").unwrap_or("");
                        let why_needed  = attr(tag_str, "why_needed").unwrap_or("");
                        let example     = attr(tag_str, "example_call").unwrap_or("");
                        serde_json::json!({
                            "name": name,
                            "description": description,
                            "why_needed": why_needed,
                            "example_call": example
                        })
                    }
                    _ => serde_json::json!({}),
                };

                return Some(TextToolCall {
                    name: tool.to_string(),
                    input,
                    tag: tag_str.to_string(),
                });
            }
        }
    }
    None
}

/// Strip a tool tag from the visible reply.
fn strip_tool_tag(text: &str, tag: &str) -> String {
    // Remove the line containing the tag (and any surrounding blank line)
    text.replace(tag, "").trim().to_string()
}

/// Human-readable label for what a tool call is doing (shown in the stream).
fn tool_progress_label(name: &str, input: &serde_json::Value) -> String {
    match name {
        TOOL_FETCH_URL =>       format!("Fetching {}…", input["url"].as_str().unwrap_or("URL")),
        TOOL_READ_REPO_FILE =>  format!("Reading {}…", input["path"].as_str().unwrap_or("file")),
        TOOL_GREP_REPO =>       format!("Searching codebase for '{}'…", input["pattern"].as_str().unwrap_or("")),
        TOOL_SEARCH_JIRA =>     format!("Searching JIRA for '{}'…", input["query"].as_str().unwrap_or("")),
        TOOL_GET_JIRA_ISSUE =>  format!("Fetching ticket {}…", input["key"].as_str().unwrap_or("")),
        TOOL_GET_PR_DIFF =>     format!("Fetching PR {} diff…", input["pr_id"]),
        TOOL_GET_PR_COMMENTS => format!("Fetching PR {} comments…", input["pr_id"]),
        TOOL_GIT_LOG => {
            match input["file"].as_str() {
                Some(f) => format!("Reading git history for {f}…"),
                None    => "Reading git history…".to_string(),
            }
        }
        TOOL_SEARCH_NPM =>    format!("Searching npm for '{}'…", input["package"].as_str().unwrap_or("")),
        TOOL_SEARCH_CRATES => format!("Searching crates.io for '{}'…", input["name"].as_str().unwrap_or("")),
        TOOL_REQUEST_TOOL =>  format!("Requesting new tool: '{}'…", input["name"].as_str().unwrap_or("")),
        other => format!("Running tool {other}…"),
    }
}

// ── Claude native tool-use streaming agentic loop ─────────────────────────────

/// Streaming multi-turn with Claude's native tool-use API.
/// Runs up to MAX_TOOL_ROUNDS. Each round either produces a final text reply
/// or a tool_use block (execute tool → inject result → next round).
async fn complete_multi_claude_tool_loop(
    app: &tauri::AppHandle,
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let tools_def = all_tools_def();

    let base_messages: serde_json::Value = serde_json::from_str(history_json)
        .map_err(|e| format!("Invalid history JSON: {e}"))?;

    let mut messages: Vec<serde_json::Value> = base_messages
        .as_array()
        .cloned()
        .unwrap_or_default();

    // Accumulates the full visible conversation across all rounds so the stream
    // "text" field (which the frontend displays) always shows the complete
    // history — earlier thinking is never overwritten by later rounds.
    let mut accumulated_text = String::new();
    let mut final_text = String::new();

    for round in 0..MAX_TOOL_ROUNDS {
        let body = serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "stream": true,
            "system": system,
            "messages": messages,
            "tools": tools_def,
        });

        let req = client
            .post("https://api.anthropic.com/v1/messages")
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");

        let req = if api_key.starts_with("sk-ant-api") {
            req.header("x-api-key", api_key)
        } else {
            req.header("Authorization", format!("Bearer {api_key}"))
                .header("anthropic-beta", "oauth-2025-04-20")
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

        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();
        let mut round_text = String::new();

        let mut tool_use_id: Option<String> = None;
        let mut tool_name: Option<String> = None;
        let mut tool_input_json = String::new();
        let mut stop_reason: Option<String> = None;
        let mut tool_block_index: Option<u64> = None;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(nl) = buffer.find('\n') {
                let line = buffer[..nl].trim().to_string();
                buffer = buffer[nl + 1..].to_string();

                if !line.starts_with("data: ") { continue; }
                let data = &line["data: ".len()..];

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    match json["type"].as_str().unwrap_or("") {
                        "message_delta" => {
                            if let Some(reason) = json["delta"]["stop_reason"].as_str() {
                                stop_reason = Some(reason.to_string());
                            }
                        }
                        "content_block_start" => {
                            let block = &json["content_block"];
                            if block["type"].as_str() == Some("tool_use") {
                                tool_use_id = block["id"].as_str().map(str::to_string);
                                tool_name = block["name"].as_str().map(str::to_string);
                                tool_input_json.clear();
                                tool_block_index = json["index"].as_u64();
                            }
                        }
                        "content_block_delta" => {
                            let delta = &json["delta"];
                            match delta["type"].as_str().unwrap_or("") {
                                "text_delta" => {
                                    if let Some(text) = delta["text"].as_str() {
                                        if !text.is_empty() {
                                            round_text.push_str(text);
                                            accumulated_text.push_str(text);
                                            let _ = app.emit(stream_event, serde_json::json!({
                                                "delta": text,
                                                "text": &accumulated_text,
                                            }));
                                        }
                                    }
                                }
                                "input_json_delta" => {
                                    if json["index"].as_u64() == tool_block_index {
                                        if let Some(partial) = delta["partial_json"].as_str() {
                                            tool_input_json.push_str(partial);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                        "message_stop" => {}
                        "error" => {
                            let msg = json["error"]["message"]
                                .as_str()
                                .unwrap_or("Unknown streaming error");
                            return Err(format!("Claude stream error: {msg}"));
                        }
                        _ => {}
                    }
                }
            }
        }

        // ── Determine what to do next ──────────────────────────────────────────
        let used_tool = stop_reason.as_deref() == Some("tool_use") && tool_use_id.is_some();

        if used_tool {
            let name     = tool_name.clone().unwrap_or_default();
            let tool_id  = tool_use_id.clone().unwrap_or_default();
            let input: serde_json::Value = serde_json::from_str(&tool_input_json)
                .unwrap_or(serde_json::json!({}));

            let label = tool_progress_label(&name, &input);
            // Append the tool-running label to the accumulated text so the user
            // can see what the agent is doing without losing the preceding text.
            let tool_separator = format!("\n\n[{}]\n", label);
            accumulated_text.push_str(&tool_separator);
            let _ = app.emit(stream_event, serde_json::json!({
                "delta": &tool_separator,
                "text":  &accumulated_text,
            }));

            let result = execute_tool(&name, &input).await;

            // If the agent requested a new tool, emit a dedicated event so the
            // frontend can render a tool-request card in the chat UI.
            if name == TOOL_REQUEST_TOOL {
                let _ = app.emit("agent-tool-request", serde_json::json!({
                    "name":        input["name"].as_str().unwrap_or(""),
                    "description": input["description"].as_str().unwrap_or(""),
                    "why_needed":  input["why_needed"].as_str().unwrap_or(""),
                    "example_call":input["example_call"].as_str().unwrap_or(""),
                }));
            }

            messages.push(serde_json::json!({
                "role": "assistant",
                "content": [
                    { "type": "text", "text": round_text },
                    { "type": "tool_use", "id": tool_id, "name": name, "input": input }
                ]
            }));
            messages.push(serde_json::json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result,
                }]
            }));

            if round + 1 == MAX_TOOL_ROUNDS {
                final_text = accumulated_text.clone();
                break;
            }
        } else {
            // No tool used — this is the final reply. accumulated_text already
            // contains everything (pre-tool thinking + tool labels + this reply).
            final_text = accumulated_text.clone();
            break;
        }
    }

    if final_text.is_empty() {
        return Err("Claude returned an empty streaming response.".to_string());
    }
    Ok(final_text)
}

// ── Text-based tool protocol for Gemini / local LLMs ─────────────────────────

/// Multi-turn streaming with text-based tool tag detection.
/// Works with Gemini and local LLMs via the TOOL_SYSTEM_SUFFIX protocol.
async fn complete_multi_text_tool_loop(
    app: &tauri::AppHandle,
    client: &Client,
    claude_key: &str,
    provider: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    use tauri::Emitter;

    let augmented_system = format!("{system}{TOOL_SYSTEM_SUFFIX}");
    let mut current_history = history_json.to_string();
    // Accumulates visible text across all rounds so earlier thinking is never
    // lost when the agent calls a tool and continues in a new round.
    let mut accumulated_text = String::new();
    let mut final_text = String::new();

    for round in 0..MAX_TOOL_ROUNDS {
        let reply = match provider {
            "claude" => {
                complete_multi_claude_streaming(
                    app, client, claude_key, &get_active_model(),
                    &augmented_system, &current_history, max_tokens, stream_event,
                ).await?
            }
            "local" => {
                let base = local_llm_base_url()
                    .ok_or_else(|| "Local LLM: not configured.".to_string())?;
                let model = get_local_llm_model()
                    .ok_or_else(|| "Local LLM: no model selected.".to_string())?;
                let key = get_credential("local_llm_api_key");
                complete_multi_local_streaming(
                    app, &base, key.as_deref(), &model,
                    &augmented_system, &current_history, max_tokens, stream_event,
                ).await?
            }
            "gemini" => {
                let key = get_credential("gemini_api_key")
                    .ok_or_else(|| "Gemini: not configured.".to_string())?;
                complete_multi_gemini(
                    client, &key, &get_active_gemini_model(),
                    &augmented_system, &current_history, max_tokens,
                ).await?
            }
            p => return Err(format!("Unknown provider: {p}")),
        };

        if let Some(call) = extract_text_tool_call(&reply) {
            let visible_reply = strip_tool_tag(&reply, &call.tag);
            let label = tool_progress_label(&call.name, &call.input);

            // Append this round's visible text to the accumulator
            if !visible_reply.is_empty() {
                if !accumulated_text.is_empty() {
                    accumulated_text.push('\n');
                }
                accumulated_text.push_str(&visible_reply);
            }

            // Append the tool-running separator and emit the cumulative text
            let tool_separator = format!("\n\n[{}]\n", label);
            accumulated_text.push_str(&tool_separator);
            let _ = app.emit(stream_event, serde_json::json!({
                "delta": &tool_separator,
                "text":  &accumulated_text,
            }));

            let result = execute_tool(&call.name, &call.input).await;

            // Emit dedicated event for tool requests
            if call.name == TOOL_REQUEST_TOOL {
                let _ = app.emit("agent-tool-request", serde_json::json!({
                    "name":        call.input["name"].as_str().unwrap_or(""),
                    "description": call.input["description"].as_str().unwrap_or(""),
                    "why_needed":  call.input["why_needed"].as_str().unwrap_or(""),
                    "example_call":call.input["example_call"].as_str().unwrap_or(""),
                }));
            }

            let mut history: Vec<serde_json::Value> =
                serde_json::from_str(&current_history).unwrap_or_default();
            history.push(serde_json::json!({ "role": "assistant", "content": visible_reply }));
            history.push(serde_json::json!({
                "role": "user",
                "content": format!("[Tool result: {}]\n\n{}", label, result)
            }));
            current_history = serde_json::to_string(&history)
                .unwrap_or_else(|_| current_history.clone());

            if round + 1 == MAX_TOOL_ROUNDS {
                final_text = accumulated_text.clone();
                break;
            }
        } else {
            // No tool — final reply. Append to accumulator and return the whole thing.
            if !accumulated_text.is_empty() {
                accumulated_text.push('\n');
            }
            accumulated_text.push_str(&reply);
            final_text = accumulated_text.clone();
            break;
        }
    }

    if final_text.is_empty() {
        return Err("LLM returned an empty response.".to_string());
    }
    Ok(final_text)
}

/// Top-level agentic multi-turn streaming dispatch with full tool suite.
async fn dispatch_multi_streaming_with_tools(
    app: &tauri::AppHandle,
    client: &Client,
    claude_key: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    let provider = get_ai_provider();

    let providers_to_try: Vec<String> = if provider == "auto" {
        get_provider_order()
    } else {
        vec![provider]
    };

    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &providers_to_try {
        let result = match p.as_str() {
            "claude" => {
                let auth_method = get_credential("claude_auth_method")
                    .unwrap_or_else(|| "api_key".to_string());
                if auth_method == "oauth" {
                    use tauri::Manager;
                    let sidecar = app.state::<crate::sidecar::SidecarState>();
                    let cwd = dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned();
                    crate::sidecar::dispatch_sidecar(
                        app, &sidecar, stream_event,
                        system.to_string(),
                        parse_history_to_sidecar_messages(history_json),
                        get_active_model(), cwd, None,
                    ).await.map(|r| r.text)
                } else if !claude_key.is_empty() {
                    complete_multi_claude_tool_loop(
                        app, client, claude_key, &get_active_model(),
                        system, history_json, max_tokens, stream_event,
                    ).await
                } else {
                    Err("not configured".to_string())
                }
            }
            other => {
                complete_multi_text_tool_loop(
                    app, client, claude_key, other,
                    system, history_json, max_tokens, stream_event,
                ).await
            }
        };

        match result {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                failure_reasons.push(format!("{p}: not configured"));
            }
            Err(e) if is_quota_error(&e) => {
                failure_reasons.push(format!("{p}: rate limited / quota exceeded"));
            }
            Err(e) => return Err(e),
        }
    }

    let summary = failure_reasons.join("; ");
    Err(format!("All providers failed — {summary}"))
}

// ── Agent pipeline commands ────────────────────────────────────────────────────

// ── Provider-aware dispatch helpers ───────────────────────────────────────────
//
// All agent commands call `dispatch` / `dispatch_multi` instead of `complete`
// directly. These functions apply the configured provider priority:
//   "claude"  → Claude only
//   "gemini"  → Gemini only
//   "local"   → Local LLM only
//   "auto"    → Try providers in the user-configured order; fall back on quota errors

/// Returns the user-configured fallback order, e.g. ["claude", "gemini", "local"].
fn get_provider_order() -> Vec<String> {
    let raw = get_credential("ai_provider_order").unwrap_or_default();
    if raw.trim().is_empty() {
        return vec!["claude".to_string(), "gemini".to_string(), "local".to_string()];
    }
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Try one provider for a single-turn call. Returns Ok if it succeeded,
/// Err with the error string otherwise (including "not configured" cases).
async fn try_provider_single(
    app: &tauri::AppHandle,
    provider: &str,
    client: &Client,
    claude_key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    match provider {
        "claude" => {
            let auth_method = get_credential("claude_auth_method")
                .unwrap_or_else(|| "api_key".to_string());
            if auth_method == "oauth" {
                use tauri::Manager;
                let sidecar = app.state::<crate::sidecar::SidecarState>();
                let cwd = dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned();
                crate::sidecar::dispatch_sidecar(
                    app, &sidecar, "sidecar-response",
                    system.to_string(),
                    vec![crate::sidecar::Message { role: "user".to_string(), content: user.to_string() }],
                    get_active_model(), cwd, None,
                ).await.map(|r| r.text)
            } else {
                complete(client, claude_key, &get_active_model(), system, user, max_tokens).await
            }
        }
        "gemini" => {
            let key = get_credential("gemini_api_key")
                .ok_or_else(|| "Gemini: not configured.".to_string())?;
            complete_gemini(client, &key, &get_active_gemini_model(), system, user, max_tokens).await
        }
        "local" => {
            let base = local_llm_base_url()
                .ok_or_else(|| "Local LLM: not configured.".to_string())?;
            let model = get_local_llm_model()
                .ok_or_else(|| "Local LLM: no model selected.".to_string())?;
            let key = get_credential("local_llm_api_key");
            complete_local(&base, key.as_deref(), &model, system, user, max_tokens).await
        }
        p => Err(format!("Unknown provider: {p}")),
    }
}

/// Try one provider for a multi-turn call.
async fn try_provider_multi(
    app: &tauri::AppHandle,
    provider: &str,
    client: &Client,
    claude_key: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
) -> Result<String, String> {
    match provider {
        "claude" => {
            let auth_method = get_credential("claude_auth_method")
                .unwrap_or_else(|| "api_key".to_string());
            if auth_method == "oauth" {
                use tauri::Manager;
                let sidecar = app.state::<crate::sidecar::SidecarState>();
                let cwd = dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned();
                crate::sidecar::dispatch_sidecar(
                    app, &sidecar, "sidecar-response",
                    system.to_string(),
                    parse_history_to_sidecar_messages(history_json),
                    get_active_model(), cwd, None,
                ).await.map(|r| r.text)
            } else {
                complete_multi(client, claude_key, &get_active_model(), system, history_json, max_tokens).await
            }
        }
        "gemini" => {
            let key = get_credential("gemini_api_key")
                .ok_or_else(|| "Gemini: not configured.".to_string())?;
            complete_multi_gemini(client, &key, &get_active_gemini_model(), system, history_json, max_tokens).await
        }
        "local" => {
            let base = local_llm_base_url()
                .ok_or_else(|| "Local LLM: not configured.".to_string())?;
            let model = get_local_llm_model()
                .ok_or_else(|| "Local LLM: no model selected.".to_string())?;
            let key = get_credential("local_llm_api_key");
            complete_multi_local(&base, key.as_deref(), &model, system, history_json, max_tokens).await
        }
        p => Err(format!("Unknown provider: {p}")),
    }
}

async fn dispatch(
    app: &tauri::AppHandle,
    client: &Client,
    claude_key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let provider = get_ai_provider();

    // Single-provider modes — no fallback.
    if provider != "auto" {
        return try_provider_single(app, &provider, client, claude_key, system, user, max_tokens).await;
    }

    // Auto mode: walk the ordered list, skip unconfigured, fall back on quota errors.
    let order = get_provider_order();
    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &order {
        match try_provider_single(app, p, client, claude_key, system, user, max_tokens).await {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                failure_reasons.push(format!("{p}: not configured"));
            }
            Err(e) if is_quota_error(&e) => {
                failure_reasons.push(format!("{p}: rate limited / quota exceeded"));
            }
            Err(e) => return Err(e),
        }
    }

    let summary = if failure_reasons.is_empty() { "No providers configured.".to_string() } else { failure_reasons.join("; ") };
    Err(format!("All providers failed — {summary}"))
}

async fn dispatch_multi(
    app: &tauri::AppHandle,
    client: &Client,
    claude_key: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let provider = get_ai_provider();

    if provider != "auto" {
        return try_provider_multi(app, &provider, client, claude_key, system, history_json, max_tokens).await;
    }

    let order = get_provider_order();
    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &order {
        match try_provider_multi(app, p, client, claude_key, system, history_json, max_tokens).await {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                failure_reasons.push(format!("{p}: not configured"));
            }
            Err(e) if is_quota_error(&e) => {
                failure_reasons.push(format!("{p}: rate limited / quota exceeded"));
            }
            Err(e) => return Err(e),
        }
    }

    let summary = if failure_reasons.is_empty() { "No providers configured.".to_string() } else { failure_reasons.join("; ") };
    Err(format!("All providers failed — {summary}"))
}


/// Agent 1a — Grooming File Probe: ask Claude which files to read before full grooming.
/// Returns JSON: { "files": ["path/to/file", ...], "grep_patterns": ["pattern", ...] }
#[tauri::command]
pub async fn run_grooming_file_probe(app: tauri::AppHandle, ticket_text: String) -> Result<String, String> {
    use tauri::Emitter;
    let _ = app.emit("grooming-progress", serde_json::json!({
        "phase": "probe",
        "message": "Identifying relevant files in the codebase…"
    }));
    let (client, api_key) = llm_client().await?;
    let system = "You are a codebase navigation agent. Given a JIRA ticket, identify the \
        source files most relevant to understanding and implementing it. \
        Return ONLY valid JSON (no markdown fences, no explanation) with exactly this schema:\n\
        {\n\
          \"files\": [\"<relative path from repo root>\", ...],\n\
          \"grep_patterns\": [\"<regex to search for relevant symbols/functions>\", ...]\n\
        }\n\
        Rules:\n\
        - List at most 12 files and 6 grep patterns\n\
        - Paths should be relative (e.g. \"src/reports/ReportEditor.tsx\"), not absolute\n\
        - Grep patterns should target specific function names, class names, or identifiers mentioned in the ticket\n\
        - If a CODEBASE CONTEXT section is provided, use the worktree path information to form accurate paths\n\
        - Do not include test files, lock files, or generated files\n\
        - Return an empty arrays if the ticket is too vague to identify specific files";
    let user = format!("Identify relevant files for this ticket:\n\n{ticket_text}");
    dispatch_streaming(&app, &client, &api_key, system, &user, 600, "grooming-stream").await
}

/// Agent 1 — Grooming: analyse ticket and identify relevant code areas.
/// file_contents is the injected codebase context (file contents from the probe phase).
#[tauri::command]
pub async fn run_grooming_agent(app: tauri::AppHandle, ticket_text: String, file_contents: String) -> Result<String, String> {
    use tauri::Emitter;
    let (client, api_key) = llm_client().await?;

    let file_block = if file_contents.trim().is_empty() {
        let _ = app.emit("grooming-progress", serde_json::json!({
            "phase": "analysis",
            "message": "Analysing ticket (no codebase context — configure a worktree in Settings to enable codebase reading)…"
        }));
        String::new()
    } else {
        let file_count = file_contents.matches("--- ").count();
        let _ = app.emit("grooming-progress", serde_json::json!({
            "phase": "analysis",
            "message": format!("Analysing ticket with {} codebase context block{}…", file_count, if file_count == 1 { "" } else { "s" })
        }));
        format!("\n\n=== RELEVANT FILE CONTENTS (read from codebase) ===\n{file_contents}")
    };

    let system = "You are a grooming agent helping a senior engineer understand and refine a JIRA ticket. \
        You have been given the ticket details and relevant source code from the codebase. \
        Your job is twofold:\n\
        1. Analyse the ticket and produce a structured grooming summary\n\
        2. Identify any gaps, inaccuracies, or missing sections in the ticket and suggest concrete improvements\n\n\
        For each suggested edit:\n\
        - Compare what the ticket currently says against what the code actually does\n\
        - Propose a specific, concrete replacement (not vague advice)\n\
        - For missing sections (e.g. no Acceptance Criteria on a Story, no Steps to Reproduce on a Bug), \
          draft what should be there based on the code context — or raise a clarifying_question if you genuinely cannot determine it\n\n\
        Return ONLY valid JSON (no markdown fences) with this schema:\n\
        {\n\
          \"ticket_summary\": \"<2-3 sentence summary of what the ticket is asking for>\",\n\
          \"ticket_type\": \"feature|bug|chore|spike\",\n\
          \"acceptance_criteria\": [\"<criterion>\", ...],\n\
          \"relevant_areas\": [\n\
            {\"area\": \"<module or layer>\", \"reason\": \"<why relevant>\", \"files_to_check\": [\"<path>\"]}\n\
          ],\n\
          \"ambiguities\": [\"<unclear thing>\", ...],\n\
          \"dependencies\": [\"<other tickets or systems>\", ...],\n\
          \"estimated_complexity\": \"low|medium|high\",\n\
          \"grooming_notes\": \"<anything else worth flagging>\",\n\
          \"suggested_edits\": [\n\
            {\n\
              \"id\": \"<short unique slug e.g. 'ac-1' or 'desc-clarity'>\",\n\
              \"field\": \"<jira field: description|acceptance_criteria|steps_to_reproduce|observed_behavior|expected_behavior|summary>\",\n\
              \"section\": \"<human label e.g. 'Acceptance Criteria' or 'Description'>\",\n\
              \"current\": \"<exact existing text, or null if the section is missing entirely>\",\n\
              \"suggested\": \"<your proposed replacement or addition>\",\n\
              \"reasoning\": \"<1-2 sentences explaining why this change improves the ticket>\"\n\
            }\n\
          ],\n\
          \"clarifying_questions\": [\n\
            \"<question you need answered before you can complete the analysis or a suggestion>\"\n\
          ]\n\
        }\n\n\
        Important:\n\
        - Only raise a clarifying_question when you genuinely cannot determine the answer from the code or ticket\n\
        - Prefer drafting a concrete suggestion (even if tentative) over asking a question\n\
        - If the ticket is a Bug and has no Steps to Reproduce / Observed / Expected Behavior, always suggest them\n\
        - If the ticket is a Story/Task and has no Acceptance Criteria, always suggest them\n\
        - Keep each suggested text concise and actionable";

    let user = format!("Groom this ticket:\n\n{ticket_text}{file_block}");
    let result = dispatch_streaming(&app, &client, &api_key, system, &user, 3000, "grooming-stream").await;
    let _ = app.emit("grooming-progress", serde_json::json!({
        "phase": "done",
        "message": if result.is_ok() { "Analysis complete." } else { "Analysis failed." }
    }));
    result
}

/// Agent 2 — Impact Analysis: assess the blast radius of the planned change.
#[tauri::command]
pub async fn run_impact_analysis(app: tauri::AppHandle, ticket_text: String, grooming_json: String) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = "You are an impact analysis agent. Given a ticket and its grooming analysis, \
        assess the blast radius of the change. Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"risk_level\": \"low|medium|high\",\n\
          \"risk_justification\": \"<why this risk level>\",\n\
          \"affected_areas\": [\"<area that could be affected>\", ...],\n\
          \"potential_regressions\": [\"<thing that could break>\", ...],\n\
          \"cross_cutting_concerns\": [\"<auth, logging, error handling, etc if applicable>\", ...],\n\
          \"files_needing_consistent_updates\": [\"<path hint>\", ...],\n\
          \"recommendations\": \"<key things to be careful about>\"\n\
        }";
    let user = format!("Ticket:\n{ticket_text}\n\nGrooming analysis:\n{grooming_json}");
    dispatch(&app, &client, &api_key, system, &user, 1500).await
}

/// Agent 3a — Triage turn: one conversational exchange in the planning session.
/// history_json is a JSON array of [{role: "user"|"assistant", content: "..."}].
#[tauri::command]
pub async fn run_triage_turn(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = format!(
        "You are a triage agent helping plan the implementation of a JIRA ticket. \
        You have access to the ticket details, grooming analysis, and impact analysis below.\n\n\
        {context_text}\n\n\
        Your role:\n\
        - Help the engineer think through the implementation approach\n\
        - Ask targeted clarifying questions when needed\n\
        - Propose concrete approaches and let the engineer refine them\n\
        - Be concise and practical\n\
        Respond in plain text. Do NOT produce JSON."
    );
    dispatch_multi_streaming_with_tools(&app, &client, &api_key, &system, &history_json, 800, "grooming-stream").await
}

/// Grooming chat turn: structured back-and-forth during ticket grooming.
/// The agent leads the discussion, refines suggested edits, and asks clarifying questions.
/// Returns JSON: { "message": "...", "updated_edits": [...], "updated_questions": [...] }
#[tauri::command]
pub async fn run_grooming_chat_turn(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = format!(
        "You are a grooming agent leading a structured review of a JIRA ticket with a senior engineer. \
        The ticket details, relevant code context, and current state of suggested edits are below.\n\n\
        {context_text}\n\n\
        Your role in this conversation:\n\
        - Respond naturally to the engineer's message\n\
        - Refine, add, or retract suggested edits based on new information\n\
        - Ask follow-up clarifying questions if you still need information\n\
        - When the engineer answers a question, incorporate it into your suggestions immediately\n\
        - Lead toward a complete, well-groomed ticket\n\n\
        Return ONLY valid JSON (no markdown fences) with this schema:\n\
        {{\n\
          \"message\": \"<your conversational reply to the engineer — plain prose, no JSON>\",\n\
          \"updated_edits\": [\n\
            {{\n\
              \"id\": \"<same id as existing edit to update it, or a new slug for new edits>\",\n\
              \"field\": \"<description|acceptance_criteria|steps_to_reproduce|observed_behavior|expected_behavior|summary>\",\n\
              \"section\": \"<human label>\",\n\
              \"current\": \"<existing text or null>\",\n\
              \"suggested\": \"<proposed text>\",\n\
              \"reasoning\": \"<why>\"\n\
            }}\n\
          ],\n\
          \"updated_questions\": [\"<any remaining open questions you still need answered>\"]\n\
        }}\n\n\
        Rules:\n\
        - updated_edits may be empty if no changes are needed this turn\n\
        - To remove a suggestion, omit its id from updated_edits (the frontend will not delete it — include it with a note in reasoning if it should be withdrawn)\n\
        - Keep the message focused and concise"
    );
    dispatch_multi(&app, &client, &api_key, &system, &history_json, 1200).await
}

/// Agent 3b — Finalize plan: extract a structured implementation plan from the triage conversation.
#[tauri::command]
pub async fn finalize_implementation_plan(
    app: tauri::AppHandle,
    context_text: String,
    conversation_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = format!(
        "You are a planning agent. Based on the ticket context and the triage conversation below, \
        produce a final structured implementation plan. \
        Return ONLY valid JSON (no markdown fences):\n\
        {{\n\
          \"summary\": \"<one sentence describing the agreed approach>\",\n\
          \"files\": [\n\
            {{\"path\": \"<file path>\", \"action\": \"create|modify|delete\", \
              \"description\": \"<what changes and why>\"}}\n\
          ],\n\
          \"order_of_operations\": [\"<step 1>\", \"<step 2>\", ...],\n\
          \"edge_cases\": [\"<edge case to handle>\", ...],\n\
          \"do_not_change\": [\"<thing to leave alone and why>\", ...],\n\
          \"assumptions\": [\"<assumption made>\", ...],\n\
          \"open_questions\": [\"<anything still unresolved>\", ...]\n\
        }}\n\n\
        Context:\n{context_text}"
    );
    let user = format!("Triage conversation:\n{conversation_json}");
    dispatch(&app, &client, &api_key, &system, &user, 2000).await
}

/// Agent 4 — Implementation Guidance: step-by-step guide for executing the plan.
#[tauri::command]
pub async fn run_implementation_guidance(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = "You are an implementation guidance agent. Given the ticket and agreed implementation plan, \
        produce a detailed step-by-step guide the engineer can follow while coding. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"steps\": [\n\
            {\"step\": 1, \"title\": \"<short title>\", \"file\": \"<file path>\",\n\
             \"action\": \"<what to do>\", \"details\": \"<how to do it>\",\n\
             \"code_hints\": \"<key code patterns or snippets to follow>\"}\n\
          ],\n\
          \"patterns_to_follow\": [\"<convention to observe>\", ...],\n\
          \"common_pitfalls\": [\"<thing to avoid>\", ...],\n\
          \"definition_of_done\": [\"<how to know the step is complete>\", ...]\n\
        }";
    let user = format!("Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}");
    dispatch(&app, &client, &api_key, system, &user, 2000).await
}

/// Agent 4b — Implementation: actually write code for each file in the plan.
///
/// For each file listed in `plan_json.files`, this command:
///   1. Reads the current file content from the worktree (if it exists)
///   2. Calls Claude once per file with the ticket, plan, guidance, and current content
///   3. Writes the new content back to the worktree via `write_repo_file`
///   4. Emits progress to the `implementation-stream` Tauri event
///
/// Returns a JSON `ImplementationOutput` with per-file results and a summary.
#[tauri::command]
pub async fn run_implementation_agent(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    guidance_json: String,
) -> Result<String, String> {
    use tauri::Emitter;

    let (client, api_key) = llm_client().await?;

    // Parse the plan to get the file list.
    let plan: serde_json::Value = serde_json::from_str(&plan_json)
        .map_err(|e| format!("Invalid plan JSON: {e}"))?;

    let files = plan["files"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let emit = |msg: &str| {
        let _ = app.emit("implementation-stream", serde_json::json!({ "delta": msg }));
    };

    emit(&format!("Starting implementation — {} file(s) to process\n\n", files.len()));

    let mut files_changed: Vec<serde_json::Value> = Vec::new();
    let mut deviations: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for (idx, file_entry) in files.iter().enumerate() {
        let path = match file_entry["path"].as_str() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let action = file_entry["action"].as_str().unwrap_or("modify").to_string();
        let description = file_entry["description"].as_str().unwrap_or("").to_string();

        emit(&format!("[{}/{}] {} — {}\n", idx + 1, files.len(), action.to_uppercase(), path));

        if action == "delete" {
            // Deletion: remove the file from the worktree.
            match super::repo::delete_repo_file_internal(&path) {
                Ok(()) => {
                    emit(&format!("  Deleted {path}\n"));
                    files_changed.push(serde_json::json!({
                        "path": path,
                        "action": "deleted",
                        "summary": "File deleted as per plan"
                    }));
                }
                Err(e) => {
                    emit(&format!("  WARNING: Could not delete {path}: {e}\n"));
                    deviations.push(format!("Could not delete {path}: {e}"));
                }
            }
            continue;
        }

        // Read the current file content (may not exist for new files).
        let current_content = super::repo::read_repo_file_internal(&path)
            .unwrap_or_default();

        let is_new = current_content.is_empty() && action == "create";

        // Build the per-file prompt.
        let file_context = if current_content.is_empty() {
            format!("File `{path}` does not exist yet — create it from scratch.")
        } else {
            format!(
                "Current content of `{path}`:\n```\n{current_content}\n```"
            )
        };

        let system = "You are an expert software engineer implementing a JIRA ticket. \
            You will be given:\n\
            1. The JIRA ticket\n\
            2. The agreed implementation plan\n\
            3. Step-by-step implementation guidance\n\
            4. The current content of a specific file (or a note that it is new)\n\n\
            Your task: produce the COMPLETE new content of that file, implementing ONLY the \
            changes described in the plan for this file. Follow the plan precisely. \
            Do NOT deviate without noting the deviation at the end.\n\n\
            IMPORTANT — respond with ONLY a valid JSON object (no markdown fences):\n\
            {\n\
              \"new_content\": \"<complete file content as a string>\",\n\
              \"summary\": \"<one sentence describing what changed>\",\n\
              \"deviation\": \"<describe any deviation from the plan, or null if none>\"\n\
            }";

        let user = format!(
            "Ticket:\n{ticket_text}\n\n\
             Implementation plan:\n{plan_json}\n\n\
             Implementation guidance:\n{guidance_json}\n\n\
             File to implement:\n{path}\n\
             Planned action: {action}\n\
             Plan description: {description}\n\n\
             {file_context}"
        );

        emit(&format!("  Generating new content…\n"));

        let raw = match complete(&client, &api_key, "claude-sonnet-4-6", system, &user, 8000).await {
            Ok(r) => r,
            Err(e) => {
                emit(&format!("  ERROR: Claude call failed for {path}: {e}\n"));
                deviations.push(format!("Claude call failed for {path}: {e}"));
                skipped.push(path.clone());
                continue;
            }
        };

        // Parse the JSON response.
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                // Try stripping markdown fences if Claude added them despite instructions.
                let stripped = raw
                    .trim()
                    .trim_start_matches("```json")
                    .trim_start_matches("```")
                    .trim_end_matches("```")
                    .trim();
                match serde_json::from_str(stripped) {
                    Ok(v) => v,
                    Err(e) => {
                        emit(&format!("  ERROR: Could not parse response for {path}: {e}\n"));
                        deviations.push(format!("Could not parse response for {path}: {e}"));
                        skipped.push(path.clone());
                        continue;
                    }
                }
            }
        };

        let new_content = match parsed["new_content"].as_str() {
            Some(c) => c.to_string(),
            None => {
                emit(&format!("  ERROR: No new_content in response for {path}\n"));
                skipped.push(path.clone());
                continue;
            }
        };

        let summary = parsed["summary"].as_str().unwrap_or("No summary").to_string();
        let deviation = parsed["deviation"].as_str()
            .filter(|d| !d.is_empty() && *d != "null")
            .map(str::to_string);

        // Write the new content to the worktree.
        match super::repo::write_repo_file_internal(&path, &new_content) {
            Ok(()) => {
                emit(&format!("  Written: {summary}\n"));
                if let Some(ref dev) = deviation {
                    emit(&format!("  DEVIATION: {dev}\n"));
                    deviations.push(format!("{path}: {dev}"));
                }
                files_changed.push(serde_json::json!({
                    "path": path,
                    "action": if is_new { "created" } else { "modified" },
                    "summary": summary
                }));
            }
            Err(e) => {
                emit(&format!("  ERROR: Could not write {path}: {e}\n"));
                deviations.push(format!("Could not write {path}: {e}"));
                skipped.push(path.clone());
            }
        }
    }

    emit(&format!("\nImplementation complete — {} file(s) changed", files_changed.len()));
    if !skipped.is_empty() {
        emit(&format!(", {} skipped", skipped.len()));
    }
    emit("\n");

    let output = serde_json::json!({
        "summary": format!(
            "Implementation complete. {} file(s) changed{}.",
            files_changed.len(),
            if skipped.is_empty() { String::new() } else { format!(", {} skipped", skipped.len()) }
        ),
        "files_changed": files_changed,
        "deviations": deviations,
        "skipped": skipped
    });

    Ok(output.to_string())
}

/// Agent 5 — Test Suggestions: recommend tests to write for the implementation.
#[tauri::command]
pub async fn run_test_suggestions(
    app: tauri::AppHandle,
    plan_json: String,
    guidance_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = "You are a test generation advisor. Given the implementation plan and guidance, \
        recommend specific tests to write. Think independently — challenge the implementation's assumptions. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"test_strategy\": \"<overall testing approach>\",\n\
          \"unit_tests\": [\n\
            {\"description\": \"<what to test>\", \"target\": \"<function/module>\",\n\
             \"cases\": [\"<test case description>\", ...]}\n\
          ],\n\
          \"integration_tests\": [\n\
            {\"description\": \"<what to test>\", \"setup\": \"<test setup notes>\",\n\
             \"cases\": [\"<test case description>\", ...]}\n\
          ],\n\
          \"edge_cases_to_test\": [\"<edge case>\", ...],\n\
          \"coverage_notes\": \"<anything deliberately not covered and why>\"\n\
        }";
    let user = format!("Implementation plan:\n{plan_json}\n\nImplementation guidance:\n{guidance_json}");
    dispatch(&app, &client, &api_key, system, &user, 1500).await
}

/// Agent 6 — Plan Review: critique the plan before any code is written.
#[tauri::command]
pub async fn run_plan_review(
    app: tauri::AppHandle,
    plan_json: String,
    guidance_json: String,
    test_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = "You are a code review agent critiquing an implementation plan before coding begins. \
        Review for completeness, correctness, and risk. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"confidence\": \"ready|needs_attention|requires_rework\",\n\
          \"summary\": \"<one sentence overall assessment>\",\n\
          \"findings\": [\n\
            {\"severity\": \"blocking|non_blocking|suggestion\",\n\
             \"area\": \"<plan area>\", \"feedback\": \"<specific feedback>\"}\n\
          ],\n\
          \"things_to_address\": [\"<must-fix before starting>\", ...],\n\
          \"things_to_watch\": [\"<keep in mind while implementing>\", ...]\n\
        }";
    let user = format!("Plan:\n{plan_json}\n\nGuidance:\n{guidance_json}\n\nTest plan:\n{test_json}");
    dispatch(&app, &client, &api_key, system, &user, 1500).await
}

/// Agent 7 — PR Description: generate a complete pull request description.
#[tauri::command]
pub async fn run_pr_description_gen(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    review_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = "You are a PR description writer. Produce a thorough, professional PR description. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"title\": \"<concise PR title under 70 chars>\",\n\
          \"description\": \"<full markdown PR description including: what changed, why, how implemented, \
            testing approach, linked JIRA ticket, anything reviewers should pay attention to>\"\n\
        }";
    let user = format!("Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nReview notes:\n{review_json}");
    dispatch(&app, &client, &api_key, system, &user, 2000).await
}

/// Agent 8 — Retrospective: capture learnings from the implementation session.
#[tauri::command]
pub async fn run_retrospective_agent(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    review_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = "You are a retrospective agent. Review the full implementation session and capture learnings. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"what_went_well\": [\"<positive observation>\", ...],\n\
          \"what_could_improve\": [\"<area for improvement>\", ...],\n\
          \"patterns_identified\": [\"<reusable pattern or convention observed>\", ...],\n\
          \"agent_skill_suggestions\": [\n\
            {\"skill\": \"<skill name>\", \"suggestion\": \"<what to add/update>\"}\n\
          ],\n\
          \"knowledge_base_entries\": [\n\
            {\"type\": \"decision|pattern|learning\", \"title\": \"<title>\", \"body\": \"<content>\"}\n\
          ],\n\
          \"summary\": \"<one paragraph retrospective summary>\"\n\
        }";
    let user = format!("Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nReview:\n{review_json}");
    dispatch(&app, &client, &api_key, system, &user, 1500).await
}

// ── PR review helpers ─────────────────────────────────────────────────────────

/// Split a full review text (header + diff) into chunks that fit within
/// `chunk_chars`. The PR header (everything before "=== DIFF ===") is kept
/// intact and prepended to every chunk so the model always has context.
/// Each chunk contains one or more complete file diffs.
fn split_review_into_chunks(review_text: &str, chunk_chars: usize) -> Vec<String> {
    // Split at the diff boundary
    let (header, diff_body) = if let Some(pos) = review_text.find("=== DIFF ===") {
        let h = &review_text[..pos + "=== DIFF ===".len()];
        let d = &review_text[pos + "=== DIFF ===".len()..];
        (h.to_string(), d.to_string())
    } else {
        // No diff section — treat the whole thing as one chunk
        return vec![review_text.to_string()];
    };

    // Annotate the diff body with new-file line numbers so the model doesn't
    // have to count hunk offsets itself (which LLMs do unreliably).
    let annotated_diff = annotate_diff_with_line_numbers(&diff_body);

    // Split the annotated diff body into per-file sections
    let mut file_sections: Vec<String> = vec![];
    let mut current = String::new();
    for line in annotated_diff.lines() {
        // The annotation preserves "diff --git" as the first token of file headers
        if line.starts_with("diff --git") && !current.is_empty() {
            file_sections.push(current.clone());
            current.clear();
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        file_sections.push(current);
    }

    if file_sections.is_empty() {
        return vec![review_text.to_string()];
    }

    // Greedily pack file sections into chunks, each prefixed with the header
    let mut chunks: Vec<String> = vec![];
    let mut chunk_diff = String::new();

    for section in &file_sections {
        let candidate_len = header.len() + "\n".len() + chunk_diff.len() + section.len();
        if candidate_len > chunk_chars && !chunk_diff.is_empty() {
            // Current chunk is full — flush it
            chunks.push(format!("{header}\n{chunk_diff}"));
            chunk_diff.clear();
        }
        // If a single file section is larger than the limit, truncate it
        if header.len() + section.len() > chunk_chars {
            let max_section = chunk_chars.saturating_sub(header.len() + 100);
            let truncated = &section[..max_section.min(section.len())];
            chunk_diff.push_str(truncated);
            chunk_diff.push_str("\n[file diff truncated — too large for one chunk]\n");
        } else {
            chunk_diff.push_str(section);
        }
    }
    if !chunk_diff.trim().is_empty() {
        chunks.push(format!("{header}\n{chunk_diff}"));
    }

    chunks
}

/// Annotate every line of a unified diff with its actual new-file line number.
///
/// Each `+` (added) and ` ` (context) line is prefixed with `[Lnnn] ` where
/// `nnn` is the 1-based line number in the new version of the file. `-` (deleted)
/// lines are prefixed with `[del] ` so the model knows they are not in the new
/// file and must not be cited. `@@` hunk headers and `diff`/`---`/`+++` metadata
/// lines are left unchanged.
///
/// This eliminates the need for the model to count hunk offsets itself, which is
/// error-prone and a major source of wrong line number citations.
fn annotate_diff_with_line_numbers(diff: &str) -> String {
    let mut out = String::with_capacity(diff.len() + diff.lines().count() * 8);
    let mut new_line: u32 = 0; // current line number in the new file

    for line in diff.lines() {
        // Hunk header: @@ -old_start,old_count +new_start,new_count @@
        if line.starts_with("@@") {
            // Parse +new_start from the hunk header
            // Format: @@ -A,B +C,D @@ optional context
            if let Some(plus_pos) = line.find('+') {
                let rest = &line[plus_pos + 1..];
                let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
                if let Ok(n) = rest[..end].parse::<u32>() {
                    new_line = n;
                }
            }
            out.push_str(line);
        } else if line.starts_with('+') && !line.starts_with("+++") {
            // Added line — label with its new-file line number, then advance
            out.push_str(&format!("[L{}] {}", new_line, &line[1..]));
            new_line += 1;
        } else if line.starts_with(' ') {
            // Context line — present in both old and new file
            out.push_str(&format!("[L{}] {}", new_line, &line[1..]));
            new_line += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            // Deleted line — not in the new file, must not be cited
            out.push_str(&format!("[del] {}", &line[1..]));
            // old_line would advance here but we don't track it
        } else {
            // diff --git, --- a/..., +++ b/..., index ..., Binary files, etc.
            out.push_str(line);
        }
        out.push('\n');
    }

    out
}

/// The per-chunk findings prompt. Returns a flat JSON array of findings across
/// all five lenses from the provided diff chunk.
const CHUNK_SYSTEM: &str = "You are a senior engineer reviewing one chunk of a PR diff. \
    Identify REAL issues a human expert would flag — not noise.\n\
    \n\
    Return ONLY a valid JSON array of findings — no markdown, no text outside the JSON.\n\
    Each finding: { \"lens\": \"acceptance_criteria\"|\"security\"|\"logic\"|\"quality\"|\"testing\",\n\
      \"severity\": \"blocking\"|\"non_blocking\"|\"nitpick\",\n\
      \"title\": \"<short title>\",\n\
      \"description\": \"<specific reasoning grounded in the diff — not generic advice>\",\n\
      \"file\": \"<path string or null>\",\n\
      \"line_range\": \"<e.g. \\\"L12-L34\\\" or null>\" }\n\
    \n\
    === SEVERITY ===\n\
    - blocking: demonstrably wrong — causes bugs, crashes, data loss, or security vulnerabilities.\n\
    - non_blocking: real concern worth fixing, but no immediate breakage.\n\
    - nitpick: style, naming, minor readability.\n\
    Code that compiles and runs correctly is never blocking on style grounds alone.\n\
    \n\
    === LENS RULES ===\n\
    \n\
    LOGIC:\n\
    - Only flag blocking if you can describe a concrete scenario producing wrong output or a crash.\n\
    - Do NOT flag code that looks unusual but compiles correctly and whose intent is inferrable.\n\
    - Deliberate design choices (renamed labels, changed test expectations) are not logic errors \
      unless they demonstrably conflict with stated requirements.\n\
    \n\
    QUALITY:\n\
    - Flag: typos in identifiers/strings/comments; mixed indentation within a file; missing error \
      handling; O(n) scans where direct lookup is available; hard-to-follow structure; new public \
      API without doc comments.\n\
    - Do NOT flag test framework function choice (test/it/describe/expect etc.) as inconsistency.\n\
    - DUPLICATE/REDUNDANT CODE: only raise this if you can cite the [Lnnn] labels of BOTH \
      occurrences. A variable fetched on one line and filtered/transformed on another is NOT a \
      duplicate. If you cannot cite two distinct lines performing the same operation, drop it.\n\
    \n\
    TESTING:\n\
    - Only flag if non-trivial business logic has no corresponding test anywhere in the diff.\n\
    - Do NOT flag config, build, or asset files (*.json/yaml/toml, Makefile, Dockerfile, lock \
      files, *.css/svg/md, generated files, type-only definitions) — they need no unit tests.\n\
    - Missing tests = non_blocking unless safety-critical or tests were explicitly promised.\n\
    - Bug ticket @tags: if the linked ticket is a Bug with a key, check that new/modified unit \
      tests carry a \\\"@tags <KEY>\\\" annotation. If missing, raise non_blocking. Skip if: not \
      a Bug, no key, annotation already present, or no unit tests in diff.\n\
    \n\
    SECURITY:\n\
    - Flag injection, auth bypass, credential exposure, insecure randomness, unsafe deserialization.\n\
    - Only flag concrete exploitable paths — not theoretical risks.\n\
    - Never flag test/spec files (*.test.ts, *.spec.js, test_*.py, *_test.go etc.).\n\
    \n\
    ACCEPTANCE CRITERIA:\n\
    - If criteria are blank or not provided, return ZERO findings for this lens.\n\
    - Only check against explicitly stated criteria.\n\
    \n\
    === FULL FILE VERIFICATION ===\n\
    The input may include === FULL FILE CONTENTS FROM BRANCH ===.\n\
    Before flagging an undefined type, missing import, duplicate field, type mismatch, or \
    compilation error: scan that section. Definitions outside the changed hunk only appear \
    there, not in the diff. If the identifier IS present, drop the finding or downgrade to \
    a nitpick. Only raise compilation/type findings when absent from both the diff AND the \
    full file contents.\n\
    \n\
    === SELF-CHECK (apply before outputting) ===\n\
    For each finding, answer:\n\
    1. Can I cite the exact [Lnnn] line(s) where I observed this?\n\
    2. For type/compilation claims: have I confirmed the identifier is absent from the full file?\n\
    3. For duplicate-code claims: have I cited two distinct [Lnnn] labels showing the same op?\n\
    If any answer is NO — drop or downgrade the finding. Return [] if nothing passes.\n\
    \n\
    === LINE NUMBERS ===\n\
    Added/context lines: [Lnnn] <content> — nnn is the exact new-file line number.\n\
    Deleted lines: [del] — never cite these in line_range.\n\
    Read the label directly. Do NOT count or estimate.";

/// The synthesis prompt. Takes all chunk findings and the PR header and
/// returns the final structured 5-lens ReviewReport JSON.
const SYNTHESIS_SYSTEM: &str = "You are a senior engineer synthesising a thorough, balanced \
    pull request review. Produce a final, calibrated review report.\n\
    \n\
    Return ONLY a valid JSON object — no markdown fences, no text outside the JSON.\n\
    Schema:\n\
    {\n\
      \"overall\": \"approve\" | \"request_changes\" | \"needs_discussion\",\n\
      \"summary\": \"<two to four sentences: verdict, key strengths, key concerns>\",\n\
      \"bug_test_steps\": null | {\n\
        \"description\": \"<one sentence: what the bug was and what the fix addresses>\",\n\
        \"happy_path\": [\"<step 1>\", ...],\n\
        \"sad_path\": [\"<step 1>\", ...]\n\
      },\n\
      \"lenses\": {\n\
        \"acceptance_criteria\": { \"assessment\": \"...\", \"findings\": [\n\
          { \"severity\": \"blocking\"|\"non_blocking\"|\"nitpick\",\n\
            \"title\": \"...\", \"description\": \"...\",\n\
            \"file\": \"<path string or null>\",\n\
            \"line_range\": \"<\\\"L12-L34\\\" or null>\" }] },\n\
        \"security\": { \"assessment\": \"...\", \"findings\": [...] },\n\
        \"logic\":    { \"assessment\": \"...\", \"findings\": [...] },\n\
        \"quality\":  { \"assessment\": \"...\", \"findings\": [...] },\n\
        \"testing\":  { \"assessment\": \"...\", \"findings\": [...] }\n\
      }\n\
    }\n\
    \n\
    === SYNTHESIS RULES ===\n\
    \n\
    BUG TEST STEPS:\n\
    - Only populate when the linked JIRA ticket type is Bug. Set null for all other types.\n\
    - happy_path: concrete numbered steps to verify the fix works (UI interactions, not code).\n\
    - sad_path: edge-case steps confirming adjacent behaviour is unbroken.\n\
    - Each step must be specific and actionable by a human tester. Aim for 3–6 per path.\n\
    \n\
    SUMMARY:\n\
    - Lead with the verdict. Note what is done WELL, then the most important concerns.\n\
    \n\
    VERIFICATION PASS (apply to every logic and security finding before including it):\n\
    The input includes === FULL FILE CONTENTS FROM BRANCH ===.\n\
    For any finding that claims a type is undefined, a field is duplicated, an import is missing, \
    or a compilation error will occur: check that section. If the identifier is present there, \
    DROP the finding or downgrade it to a nitpick. Only retain compilation/type claims when the \
    identifier is absent from both the diff and the full file contents.\n\
    \n\
    DEDUPLICATION:\n\
    - Merge findings about the same root issue across chunks into one.\n\
    - DROP duplicate/redundant-code findings that cite only one location, or where the diff \
      shows the second reference is a derivation/usage of a value already fetched — not a \
      second fetch. Both occurrences must be cited at distinct line numbers.\n\
    \n\
    SEVERITY CALIBRATION:\n\
    - blocking only if you can articulate a concrete runtime failure, data corruption, or \
      security vulnerability. Downgrade everything else.\n\
    - Do not inflate severity to justify a finding. A genuine nitpick beats a false blocker.\n\
    \n\
    TESTING lens:\n\
    - If tests are present for the new/changed code, say so in the assessment.\n\
    - Non_blocking (never blocking) for missing tests unless safety-critical or explicitly promised.\n\
    - DROP any testing finding for config/build/asset files: *.json/yaml/toml, Makefile, \
      Dockerfile, lock files, *.css/svg/md, generated files, type-only definitions.\n\
    - Bug @tags: if a Bug ticket key is present, check new/modified unit tests carry \
      \\\"@tags <KEY>\\\". If missing, one consolidated non_blocking finding. Skip if: not Bug, \
      no key, annotation present, or no unit tests.\n\
    \n\
    ACCEPTANCE CRITERIA lens:\n\
    - If criteria are blank/not provided: empty findings array, assessment states none available.\n\
    \n\
    QUALITY lens:\n\
    - DROP findings about test framework function choice (test/it/describe/expect etc.).\n\
    \n\
    SECURITY lens:\n\
    - DROP findings whose file is listed under TEST / SPEC FILES IN THIS DIFF.\n\
    \n\
    FORMAT:\n\
    - overall: request_changes if any blocking finding remains, approve if none, \
      needs_discussion if uncertain.\n\
    - file and line_range must be a quoted JSON string or literal null — never a bare word.\n\
    \n\
    LINE NUMBERS:\n\
    - Single-chunk mode: lines are pre-labelled [Lnnn]. Read the label — do not count.\n\
    - Multi-chunk mode: preserve line_range values from chunk findings exactly.\n\
    - Never cite [del] lines.\n\
    \n\
    === SELF-CHECK (apply before outputting) ===\n\
    For each finding in the final report:\n\
    1. Is it grounded in something visible in the diff or full file contents — not inferred?\n\
    2. Type/compilation claims: verified absent from the full file contents section?\n\
    3. Duplicate-code claims: two distinct line numbers cited?\n\
    4. Severity: can I articulate the concrete failure mode for any blocking finding?\n\
    Drop or downgrade any finding where an answer is NO.";

/// Sort findings by severity (blocking first, then non_blocking, then nitpick)
/// and greedily include them up to `max_chars`. Returns the capped JSON array
/// string and the count of findings that were dropped.
fn cap_findings_by_severity(findings_json: &str, max_chars: usize) -> (String, usize) {
    let Ok(arr) = serde_json::from_str::<serde_json::Value>(findings_json) else {
        // Can't parse — return as-is, truncated hard if necessary
        let truncated = if findings_json.len() > max_chars {
            &findings_json[..max_chars]
        } else {
            findings_json
        };
        return (truncated.to_string(), 0);
    };

    let Some(findings) = arr.as_array() else {
        return (findings_json.to_string(), 0);
    };

    // Severity ordering: blocking = 0, non_blocking = 1, nitpick = 2, unknown = 3
    let severity_rank = |f: &serde_json::Value| -> u8 {
        match f.get("severity").and_then(|s| s.as_str()).unwrap_or("") {
            "blocking"     => 0,
            "non_blocking" => 1,
            "nitpick"      => 2,
            _              => 3,
        }
    };

    let mut sorted = findings.clone();
    sorted.sort_by_key(|f| severity_rank(f));

    let mut kept: Vec<serde_json::Value> = Vec::new();
    let mut running_chars = 2usize; // for the outer `[` and `]`

    for finding in &sorted {
        let s = serde_json::to_string(finding).unwrap_or_default();
        let needed = s.len() + if kept.is_empty() { 0 } else { 2 }; // `, ` separator
        if running_chars + needed > max_chars {
            break;
        }
        running_chars += needed;
        kept.push(finding.clone());
    }

    let dropped = findings.len() - kept.len();
    let out = serde_json::to_string(&kept).unwrap_or_else(|_| "[]".to_string());
    (out, dropped)
}

/// Build the synthesis system prompt, appending any user-authored Agent Skills
/// (Review Standards and Implementation Standards) so that project-specific
/// conventions — e.g. "use Vitest not Jest", "all commands must be registered
/// in lib.rs" — are always available to the review agent.
fn build_review_system_prompt(app: &tauri::AppHandle) -> String {
    let mut prompt = SYNTHESIS_SYSTEM.to_string();

    let review_skill = get_skill(app, "review");
    let impl_skill   = get_skill(app, "implementation");

    if review_skill.is_some() || impl_skill.is_some() {
        prompt.push_str("\n\n=== PROJECT-SPECIFIC REVIEW STANDARDS (Agent Skills) ===\n");
        prompt.push_str("The following conventions are specific to this codebase. \
            Apply them when evaluating findings — they take precedence over generic heuristics.\n");
        if let Some(s) = review_skill {
            prompt.push_str("\n--- Review Standards ---\n");
            prompt.push_str(&s);
        }
        if let Some(s) = impl_skill {
            prompt.push_str("\n--- Implementation Standards ---\n");
            prompt.push_str(&s);
        }
    }

    prompt
}

/// Analyse a pull request across four review lenses and return a JSON review report.
/// Uses a map-reduce strategy for large diffs:
///   1. Split the diff into file-level chunks that fit the model's context window.
///   2. Run a lightweight "find findings" pass on each chunk (non-streaming).
///   3. Stream a single synthesis pass that merges all chunk findings into the
///      final 4-lens ReviewReport.
/// For small diffs that fit in one chunk, skips directly to the synthesis pass.
#[tauri::command]
pub async fn review_pr(app: tauri::AppHandle, review_text: String) -> Result<String, String> {
    use tauri::Emitter;
    // Reset the cancellation flag at the start of every new review.
    REVIEW_CANCELLED.store(false, Ordering::Relaxed);
    let (client, api_key) = llm_client().await?;

    // Determine the chunk size based on the active provider.
    // Local LLMs typically have 8k-32k context; cloud models can handle much more.
    let provider = get_ai_provider();
    let effective_provider = if provider == "auto" {
        get_provider_order().into_iter().next().unwrap_or_else(|| "claude".to_string())
    } else {
        provider
    };
    // Conservative: leave room for the system prompt + response tokens
    let chunk_chars: usize = if effective_provider == "local" { 12_000 } else { 80_000 };

    let chunks = split_review_into_chunks(&review_text, chunk_chars);
    let needs_chunking = chunks.len() > 1;

    // ── Map pass (skip for single-chunk diffs) ────────────────────────────────
    let all_findings_json: String = if needs_chunking {
        let total = chunks.len();
        let _ = app.emit("pr-review-progress", serde_json::json!({
            "phase": "analysis",
            "message": format!("Large diff detected — reviewing {total} file chunk{} separately…",
                if total == 1 { "" } else { "s" })
        }));

        let mut all_findings: Vec<serde_json::Value> = vec![];

        for (i, chunk) in chunks.iter().enumerate() {
            // Check for cancellation before starting each chunk
            if REVIEW_CANCELLED.load(Ordering::Relaxed) {
                let _ = app.emit("pr-review-progress", serde_json::json!({
                    "phase": "cancelled",
                    "message": "Review cancelled."
                }));
                return Err("Review cancelled by user.".to_string());
            }

            let _ = app.emit("pr-review-progress", serde_json::json!({
                "phase": "analysis",
                "message": format!("Reviewing chunk {}/{total} ({} chars)…", i + 1, chunk.len())
            }));
            // Signal the frontend to clear the stream display before each new chunk
            let _ = app.emit("pr-review-stream-reset", serde_json::json!({}));

            let user = format!("Find all review findings in this diff chunk:\n\n{chunk}");
            match dispatch_streaming(&app, &client, &api_key, CHUNK_SYSTEM, &user, 2000, "pr-review-stream").await {
                Ok(raw) => {
                    // Strip optional markdown fences the model may have added
                    let cleaned = raw
                        .trim()
                        .trim_start_matches("```json")
                        .trim_start_matches("```")
                        .trim_end_matches("```")
                        .trim();
                    if let Ok(arr) = serde_json::from_str::<serde_json::Value>(cleaned) {
                        if let Some(findings) = arr.as_array() {
                            all_findings.extend(findings.iter().cloned());
                        }
                    }
                    // If the chunk failed to parse, silently continue — we'd rather
                    // produce a partial report than abort the whole review.
                }
                Err(e) => {
                    // Non-fatal: emit a warning and continue with remaining chunks
                    let _ = app.emit("pr-review-progress", serde_json::json!({
                        "phase": "analysis",
                        "message": format!("Warning: chunk {}/{total} failed ({e}) — continuing…", i + 1)
                    }));
                }
            }
        }

        serde_json::to_string(&all_findings).unwrap_or_else(|_| "[]".to_string())
    } else {
        // Small diff — no pre-pass needed; synthesis will work directly from the diff
        "[]".to_string()
    };

    // ── Synthesis pass (always streamed) ─────────────────────────────────────
    // Check for cancellation before the synthesis pass too
    if REVIEW_CANCELLED.load(Ordering::Relaxed) {
        let _ = app.emit("pr-review-progress", serde_json::json!({
            "phase": "cancelled",
            "message": "Review cancelled."
        }));
        return Err("Review cancelled by user.".to_string());
    }

    let synthesis_user = if needs_chunking {
        let _ = app.emit("pr-review-stream-reset", serde_json::json!({}));

        // Cap findings by severity before building the synthesis prompt so the
        // combined input never blows the model's context window.
        // Budget: for local models leave ~4k chars for findings; cloud gets 40k.
        let findings_budget: usize = if effective_provider == "local" { 4_000 } else { 40_000 };
        let (capped_findings_json, dropped_count) =
            cap_findings_by_severity(&all_findings_json, findings_budget);

        let drop_note = if dropped_count > 0 {
            format!("\n\nNote: {dropped_count} lower-severity finding(s) were omitted to fit the model context window. All blocking and non-blocking findings are included.")
        } else {
            String::new()
        };

        let _ = app.emit("pr-review-progress", serde_json::json!({
            "phase": "analysis",
            "message": if dropped_count > 0 {
                format!("Synthesising findings ({dropped_count} low-severity finding(s) trimmed to fit context)…")
            } else {
                "Synthesising findings into final report…".to_string()
            }
        }));

        // Extract just the PR header (no diff) for the synthesis context
        let header = if let Some(pos) = review_text.find("=== DIFF ===") {
            review_text[..pos + "=== DIFF ===".len()].to_string()
                + "\n[diff reviewed in chunks — findings collected above]"
        } else {
            review_text.clone()
        };

        format!(
            "Pull request context:\n{header}\n\n\
             Findings collected from reviewing all diff chunks:{drop_note}\n{capped_findings_json}\n\n\
             Produce the final review report JSON."
        )
    } else {
        let _ = app.emit("pr-review-progress", serde_json::json!({
            "phase": "analysis",
            "message": "Analysing diff across five review lenses…"
        }));
        // For single-chunk diffs, pass the full diff directly to synthesis,
        // with the diff annotated so the model can read line numbers directly.
        // Prepend a structured instruction so the model applies all five lenses
        // explicitly rather than doing a generic read.
        let annotated_text = if let Some(pos) = review_text.find("=== DIFF ===") {
            let header = &review_text[..pos + "=== DIFF ===".len()];
            let diff_body = &review_text[pos + "=== DIFF ===".len()..];
            format!("{header}{}", annotate_diff_with_line_numbers(diff_body))
        } else {
            review_text.clone()
        };
        format!(
            "Review this pull request across five lenses: acceptance_criteria, security, \
             logic, quality, and testing. Apply the severity calibration rules from your \
             system prompt carefully — do not inflate severity. Note what is done well in \
             the summary. Produce the final review report JSON.\n\n{annotated_text}"
        )
    };

    let result = dispatch_streaming(
        &app, &client, &api_key,
        &build_review_system_prompt(&app),
        &synthesis_user,
        4000,
        "pr-review-stream",
    ).await;

    let _ = app.emit("pr-review-progress", serde_json::json!({
        "phase": "done",
        "message": if result.is_ok() { "Review complete." } else { "Review failed." }
    }));
    result
}

/// Conversational follow-up chat about a completed PR review.
/// Takes the full review context (PR metadata + report JSON) and the chat
/// history, returns a plain-text assistant reply.
#[tauri::command]
pub async fn chat_pr_review(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;

    // Load project-specific skills — Review Standards and Implementation Standards
    // both inform what "good code" means for this codebase.
    let review_skill = get_skill(&app, "review");
    let impl_skill   = get_skill(&app, "implementation");
    let skills_block = if review_skill.is_some() || impl_skill.is_some() {
        let mut block = String::from(
            "\n\n=== PROJECT-SPECIFIC CONVENTIONS (Agent Skills) ===\n\
            These codebase-specific standards must inform any code you write or suggest:\n"
        );
        if let Some(s) = review_skill { block.push_str("\n--- Review Standards ---\n"); block.push_str(&s); }
        if let Some(s) = impl_skill   { block.push_str("\n--- Implementation Standards ---\n"); block.push_str(&s); }
        block
    } else {
        String::new()
    };

    let system = format!(
        "You are an expert code reviewer who has just completed a structured review of a pull \
        request. The review report, PR comments, and PR context are below.\n\n\
        {context_text}\n\n\
        The engineer is now asking you follow-up questions about your findings. Your role:\n\
        - Explain your reasoning clearly when asked why you raised a finding\n\
        - When a finding was informed by a PR comment from another reviewer, say so explicitly: \
          cite the comment author by name and quote the relevant part of their comment. \
          Do not present their observation as your own independent conclusion.\n\
        - When a finding comes from your own analysis of the diff (not from any comment), \
          say so clearly: explain which lines or patterns led you to the conclusion.\n\
        - Reconsider or soften a finding if the engineer provides additional context that \
          changes its relevance\n\
        - Point to specific parts of the diff or specific comments when relevant\n\
        - Be concise and direct — this is a conversation, not another report\n\
        - Do NOT produce JSON — reply in plain prose only\n\
        - When writing or suggesting code examples, follow the project-specific conventions \
          below. For example: if the standards specify Vitest, use Vitest syntax — not Jest \
          or any other framework.{skills_block}"
    );
    dispatch_multi_streaming_with_tools(&app, &client, &api_key, &system, &history_json, 1024, "pr-review-chat-stream").await
}

/// Generate workload rebalancing suggestions from pre-compiled capacity text.
#[tauri::command]
pub async fn generate_workload_suggestions(app: tauri::AppHandle, workload_text: String) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;

    let system = "You are a scrum master assistant helping balance work across a development team. \
        Analyse the workload data and suggest specific, actionable ticket reassignments. \
        Be concrete: name the ticket key, the current assignee, and the suggested new assignee. \
        Consider both story point load and PR review load when assessing capacity. \
        Keep suggestions brief and practical.";

    let user = format!(
        "Analyse this sprint workload and suggest rebalancing moves:\n\n{workload_text}\n\n\
        Format your response as:\n\
        **Summary** — one sentence describing the overall balance.\n\n\
        **Recommended moves** (if any):\n\
        - Move [TICKET-KEY] \"summary\" from [Person A] → [Person B]. Reason: ...\n\n\
        **Developers at risk** (if any): who may not complete their load.\n\n\
        **Developers with capacity**: who could take on more.\n\n\
        If the workload is already well balanced, say so clearly. Do not invent problems."
    );

    dispatch(&app, &client, &api_key, system, &user, 1024).await
}

/// Assess a JIRA ticket for development readiness and return a JSON quality report.
#[tauri::command]
pub async fn assess_ticket_quality(app: tauri::AppHandle, ticket_text: String) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;

    let system = "You are a senior engineering lead reviewing JIRA tickets for sprint readiness. \
        Assess the provided ticket strictly and honestly. \
        You MUST respond with ONLY a valid JSON object — no markdown fences, no explanation outside the JSON. \
        Use exactly this schema:\n\
        {\n\
          \"overall\": \"ready\" | \"needs_work\" | \"not_ready\",\n\
          \"summary\": \"<one sentence overall assessment>\",\n\
          \"criteria\": [\n\
            {\"name\": \"Acceptance criteria\", \"result\": \"pass\" | \"partial\" | \"fail\", \"feedback\": \"<specific feedback>\"},\n\
            {\"name\": \"Scope definition\", \"result\": \"pass\" | \"partial\" | \"fail\", \"feedback\": \"<specific feedback>\"},\n\
            {\"name\": \"Dependencies identified\", \"result\": \"pass\" | \"partial\" | \"fail\", \"feedback\": \"<specific feedback>\"},\n\
            {\"name\": \"Unambiguous intent\", \"result\": \"pass\" | \"partial\" | \"fail\", \"feedback\": \"<specific feedback>\"},\n\
            {\"name\": \"Edge cases considered\", \"result\": \"pass\" | \"partial\" | \"fail\", \"feedback\": \"<specific feedback>\"},\n\
            {\"name\": \"Estimate reasonableness\", \"result\": \"pass\" | \"partial\" | \"fail\", \"feedback\": \"<specific feedback>\"}\n\
          ],\n\
          \"open_questions\": [\"<question>\", ...],\n\
          \"suggested_improvements\": \"<specific rewrites or additions for the description / acceptance criteria>\"\n\
        }";

    let user = format!("Assess this ticket for sprint readiness:\n\n{ticket_text}");

    dispatch(&app, &client, &api_key, system, &user, 1500).await
}

/// Generate a sprint retrospective summary from pre-compiled sprint data.
#[tauri::command]
pub async fn generate_sprint_retrospective(app: tauri::AppHandle, sprint_text: String) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;

    let system = "You are an experienced agile coach helping a scrum master run sprint retrospectives. \
        Write concise, honest, and actionable retrospective summaries based on sprint metrics. \
        Be specific — reference story points, completion rates, and PR data where relevant. \
        Avoid generic filler. Each section should be 2-4 bullet points.";

    let user = format!(
        "Generate a sprint retrospective summary from the following sprint data:\n\n{sprint_text}\n\n\
        Format your response in markdown with these four sections:\n\
        ## What Went Well\n\
        ## What Could Be Improved\n\
        ## Patterns & Observations\n\
        ## Suggested Discussion Points\n\n\
        End with a one-paragraph **Summary** the scrum master can use to open the meeting."
    );

    dispatch(&app, &client, &api_key, system, &user, 1024).await
}

// ── Address PR Comments agent ─────────────────────────────────────────────────

/// Analyse PR reviewer comments and the PR diff to produce a structured fix plan.
/// Streams its reasoning to `address-pr-stream`.
/// Returns a JSON array of fix proposals.
#[tauri::command]
pub async fn analyze_pr_comments(
    app: tauri::AppHandle,
    review_text: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;

    let system = "You are an expert software engineer helping the PR author address code review \
        comments left by their team. You will be given:\n\
        1. The full PR diff\n\
        2. All reviewer comments (inline comments annotated with file/line context)\n\
        3. The content of files referenced in inline comments\n\n\
        Your task is to produce a structured fix plan. Analyse every reviewer comment carefully. \
        For each comment, decide:\n\
        - What is the reviewer asking for?\n\
        - What specific code change would address it?\n\
        - How confident are you in the fix? (High / Medium / Needs human judgment)\n\n\
        You MUST respond with ONLY a valid JSON array — no markdown fences, no explanation outside the JSON.\n\
        Schema for each element:\n\
        {\n\
          \"commentId\": <number — the Bitbucket comment id>,\n\
          \"file\": \"<relative file path or null for general comments>\",\n\
          \"fromLine\": <number or null>,\n\
          \"toLine\": <number or null>,\n\
          \"reviewerName\": \"<commenter display name>\",\n\
          \"commentSummary\": \"<one sentence: what the reviewer wants>\",\n\
          \"proposedFix\": \"<concrete description of the change to make>\",\n\
          \"confidence\": \"High\" | \"Medium\" | \"Needs human judgment\",\n\
          \"affectedFiles\": [\"<relative path>\"],\n\
          \"newContent\": \"<the exact replacement file content if confidence is High or Medium, otherwise null>\",\n\
          \"skippable\": false\n\
        }\n\
        Set `newContent` only when you can produce the full replacement content for the affected file. \
        For general architectural or design comments where the fix is open-ended, set confidence to \
        'Needs human judgment' and leave newContent null.\n\
        Do not invent problems. Only address comments that are actually present.";

    dispatch_streaming(
        &app,
        &client,
        &api_key,
        system,
        &review_text,
        4096,
        "address-pr-stream",
    )
    .await
}

/// Multi-turn chat for the Address PR Comments workflow.
/// The `history_json` contains the conversation so far.
#[tauri::command]
pub async fn chat_address_pr(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;
    let system = format!(
        "You are an expert software engineer helping the PR author address code review comments. \
        The PR diff, reviewer comments, and fix plan are below.\n\n\
        {context_text}\n\n\
        The engineer is now conversing with you about the fix plan. Your role:\n\
        - Explain your reasoning for any proposed fix\n\
        - Revise a proposed fix if the engineer asks you to approach it differently\n\
        - When revising, describe the new approach clearly\n\
        - Be concise and direct — this is a conversation, not a report\n\
        - Do NOT produce JSON unless the engineer explicitly asks you to regenerate the full fix plan"
    );
    dispatch_multi_streaming_with_tools(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        1024,
        "address-pr-chat-stream",
    )
    .await
}

#[tauri::command]
pub async fn generate_standup_briefing(app: tauri::AppHandle, standup_text: String) -> Result<String, String> {
    let (client, api_key) = llm_client().await?;

    let system = "You are a scrum master assistant. \
        Generate concise, ready-to-read daily standup briefings from team activity data. \
        Be specific (use ticket keys and PR numbers). \
        Keep the total length suitable for reading aloud in a 10-15 minute standup.";

    let user = format!(
        "Generate a standup briefing from this team activity data:\n\n{standup_text}\n\n\
        Format:\n\
        1. One-sentence sprint status.\n\
        2. One block per team member:\n   \
           **Name**\n   \
           Yesterday: ...\n   \
           Today: ...\n   \
           Blockers: ... (or \"None\")\n\
        3. A brief **Flags** section for items the scrum master should raise proactively.\n\
        Skip members with genuinely no data."
    );

    dispatch(&app, &client, &api_key, system, &user, 1024).await
}
