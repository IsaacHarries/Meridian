use reqwest::Client;
use serde_json::json;
use std::time::Duration;

use super::credentials::{get_credential, store_credential};
use crate::http::make_corporate_client;

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
        .timeout(Duration::from_secs(120)) // local models can be slow
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

/// Build an HTTP client, silently refresh the OAuth token if needed, then
/// return the (possibly updated) access token ready for API calls.
async fn claude_client() -> Result<(Client, String), String> {
    let client = make_corporate_client(Duration::from_secs(60))?;
    refresh_oauth_if_needed(&client).await?;
    let api_key = get_credential("anthropic_api_key")
        .ok_or("Anthropic API key not configured. Check Settings.")?;
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
    provider: &str,
    client: &Client,
    claude_key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    match provider {
        "claude" => complete(client, claude_key, &get_active_model(), system, user, max_tokens).await,
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
    provider: &str,
    client: &Client,
    claude_key: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
) -> Result<String, String> {
    match provider {
        "claude" => complete_multi(client, claude_key, &get_active_model(), system, history_json, max_tokens).await,
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
    client: &Client,
    claude_key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let provider = get_ai_provider();

    // Single-provider modes — no fallback.
    if provider != "auto" {
        return try_provider_single(&provider, client, claude_key, system, user, max_tokens).await;
    }

    // Auto mode: walk the ordered list, skip unconfigured, fall back on quota errors.
    let order = get_provider_order();
    let mut last_err = "No providers configured.".to_string();

    for p in &order {
        match try_provider_single(p, client, claude_key, system, user, max_tokens).await {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                // Provider not set up — skip silently.
                last_err = e;
            }
            Err(e) if is_quota_error(&e) => {
                // Quota exhausted — try next provider.
                last_err = format!("{p} quota exceeded, trying next provider…");
                let _ = e; // log-worthy but not returned unless all fail
            }
            Err(e) => return Err(e), // Hard error — surface immediately.
        }
    }

    Err(format!("All providers failed or are unconfigured. Last error: {last_err}"))
}

async fn dispatch_multi(
    client: &Client,
    claude_key: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let provider = get_ai_provider();

    if provider != "auto" {
        return try_provider_multi(&provider, client, claude_key, system, history_json, max_tokens).await;
    }

    let order = get_provider_order();
    let mut last_err = "No providers configured.".to_string();

    for p in &order {
        match try_provider_multi(p, client, claude_key, system, history_json, max_tokens).await {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                last_err = e;
            }
            Err(e) if is_quota_error(&e) => {
                last_err = format!("{p} quota exceeded, trying next provider…");
            }
            Err(e) => return Err(e),
        }
    }

    Err(format!("All providers failed or are unconfigured. Last error: {last_err}"))
}


/// Agent 1 — Grooming: analyse ticket and identify relevant code areas.
#[tauri::command]
pub async fn run_grooming_agent(ticket_text: String) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;
    let system = "You are a grooming agent helping a senior engineer understand a JIRA ticket. \
        Analyse the ticket thoroughly and return ONLY valid JSON (no markdown fences) with this schema:\n\
        {\n\
          \"ticket_summary\": \"<2-3 sentence summary of what the ticket is asking for>\",\n\
          \"ticket_type\": \"feature|bug|chore|spike\",\n\
          \"acceptance_criteria\": [\"<criterion>\", ...],\n\
          \"relevant_areas\": [\n\
            {\"area\": \"<module or layer>\", \"reason\": \"<why relevant>\", \"files_to_check\": [\"<path hint>\"]}\n\
          ],\n\
          \"ambiguities\": [\"<unclear thing>\", ...],\n\
          \"dependencies\": [\"<other tickets or systems this depends on>\", ...],\n\
          \"estimated_complexity\": \"low|medium|high\",\n\
          \"grooming_notes\": \"<anything else worth flagging>\"\n\
        }";
    let user = format!("Groom this ticket:\n\n{ticket_text}");
    dispatch(&client, &api_key, system, &user, 1500).await
}

/// Agent 2 — Impact Analysis: assess the blast radius of the planned change.
#[tauri::command]
pub async fn run_impact_analysis(ticket_text: String, grooming_json: String) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;
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
    dispatch(&client, &api_key, system, &user, 1500).await
}

/// Agent 3a — Triage turn: one conversational exchange in the planning session.
/// history_json is a JSON array of [{role: "user"|"assistant", content: "..."}].
#[tauri::command]
pub async fn run_triage_turn(
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;
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
    dispatch_multi(&client, &api_key, &system, &history_json, 800).await
}

/// Agent 3b — Finalize plan: extract a structured implementation plan from the triage conversation.
#[tauri::command]
pub async fn finalize_implementation_plan(
    context_text: String,
    conversation_json: String,
) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;
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
    dispatch(&client, &api_key, &system, &user, 2000).await
}

/// Agent 4 — Implementation Guidance: step-by-step guide for executing the plan.
#[tauri::command]
pub async fn run_implementation_guidance(
    ticket_text: String,
    plan_json: String,
) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;
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
    dispatch(&client, &api_key, system, &user, 2000).await
}

/// Agent 5 — Test Suggestions: recommend tests to write for the implementation.
#[tauri::command]
pub async fn run_test_suggestions(
    plan_json: String,
    guidance_json: String,
) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;
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
    dispatch(&client, &api_key, system, &user, 1500).await
}

/// Agent 6 — Plan Review: critique the plan before any code is written.
#[tauri::command]
pub async fn run_plan_review(
    plan_json: String,
    guidance_json: String,
    test_json: String,
) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;
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
    dispatch(&client, &api_key, system, &user, 1500).await
}

/// Agent 7 — PR Description: generate a complete pull request description.
#[tauri::command]
pub async fn run_pr_description_gen(
    ticket_text: String,
    plan_json: String,
    review_json: String,
) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;
    let system = "You are a PR description writer. Produce a thorough, professional PR description. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"title\": \"<concise PR title under 70 chars>\",\n\
          \"description\": \"<full markdown PR description including: what changed, why, how implemented, \
            testing approach, linked JIRA ticket, anything reviewers should pay attention to>\"\n\
        }";
    let user = format!("Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nReview notes:\n{review_json}");
    dispatch(&client, &api_key, system, &user, 2000).await
}

/// Agent 8 — Retrospective: capture learnings from the implementation session.
#[tauri::command]
pub async fn run_retrospective_agent(
    ticket_text: String,
    plan_json: String,
    review_json: String,
) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;
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
    dispatch(&client, &api_key, system, &user, 1500).await
}

/// Analyse a pull request across four review lenses and return a JSON review report.
#[tauri::command]
pub async fn review_pr(review_text: String) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;

    let system = "You are an expert code reviewer. Analyse the provided pull request across exactly \
        four review lenses and return ONLY a valid JSON object — no markdown fences, no text outside the JSON.\n\
        \n\
        Schema:\n\
        {\n\
          \"overall\": \"approve\" | \"request_changes\" | \"needs_discussion\",\n\
          \"summary\": \"<one sentence verdict>\",\n\
          \"lenses\": {\n\
            \"acceptance_criteria\": {\n\
              \"assessment\": \"<one sentence summary>\",\n\
              \"findings\": [\n\
                { \"severity\": \"blocking\" | \"non_blocking\" | \"nitpick\",\n\
                  \"title\": \"<short title>\",\n\
                  \"description\": \"<detailed explanation>\",\n\
                  \"file\": \"<file path or null>\",\n\
                  \"line_range\": \"<e.g. L12-L34 or null>\" }\n\
              ]\n\
            },\n\
            \"security\": { \"assessment\": \"...\", \"findings\": [...] },\n\
            \"logic\":    { \"assessment\": \"...\", \"findings\": [...] },\n\
            \"quality\":  { \"assessment\": \"...\", \"findings\": [...] }\n\
          }\n\
        }\n\
        \n\
        Rules:\n\
        - Security and logic findings default to blocking unless clearly minor.\n\
        - If a lens has no findings, return an empty findings array with a positive assessment.\n\
        - Cite specific file paths and line ranges from the diff for all findings where possible.\n\
        - Only report findings you actually observe in the diff — do not invent generic issues.";

    let user = format!("Review this pull request:\n\n{review_text}");

    dispatch(&client, &api_key, system, &user, 4000).await
}

/// Generate workload rebalancing suggestions from pre-compiled capacity text.
#[tauri::command]
pub async fn generate_workload_suggestions(workload_text: String) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;

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

    dispatch(&client, &api_key, system, &user, 1024).await
}

/// Assess a JIRA ticket for development readiness and return a JSON quality report.
#[tauri::command]
pub async fn assess_ticket_quality(ticket_text: String) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;

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

    dispatch(&client, &api_key, system, &user, 1500).await
}

/// Generate a sprint retrospective summary from pre-compiled sprint data.
#[tauri::command]
pub async fn generate_sprint_retrospective(sprint_text: String) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;

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

    dispatch(&client, &api_key, system, &user, 1024).await
}

#[tauri::command]
pub async fn generate_standup_briefing(standup_text: String) -> Result<String, String> {
    let (client, api_key) = claude_client().await?;

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

    dispatch(&client, &api_key, system, &user, 1024).await
}
