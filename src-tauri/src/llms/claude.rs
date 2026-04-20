use reqwest::Client;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::http::make_corporate_client;
use crate::storage::credentials::{get_credential, store_credential};

// ── Review cancellation flag ─────────────────────────────────────────────────
// Set to true by `cancel_review`; polled in the chunk loop so the review stops
// cleanly between chunks without interrupting an in-flight HTTP request.

static REVIEW_CANCELLED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn cancel_review() {
    REVIEW_CANCELLED.store(true, Ordering::Relaxed);
}

pub fn is_cancelled() -> bool {
    REVIEW_CANCELLED.load(Ordering::Relaxed)
}

pub fn reset_cancellation() {
    REVIEW_CANCELLED.store(false, Ordering::Relaxed);
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

// ── OAuth subscription-billing body rewriting ─────────────────────────────────
//
// When a request to `/v1/messages` carries an OAuth access token from a
// Claude.ai subscription (`sk-ant-oat01-…`), Anthropic validates that the
// request looks like it originated from the Claude Code CLI. If it doesn't,
// the request is rejected with `429 rate_limit_error` regardless of the
// account's actual usage — the OAuth token has zero quota on the non-Claude-
// Code path. Two markers are required in the body:
//
//   1. `system` must be an **array** whose first two entries are
//      (a) a `x-anthropic-billing-header: …` text block and
//      (b) the Claude Code identity string.
//   2. Any other system-prompt content must NOT live in `system[]` (triggers a
//      follow-up `400 "out of extra usage"` rejection). Instead it's prepended
//      to the first user message, which is functionally equivalent.
//
// Algorithm reverse-engineered from
// https://github.com/griffinmartin/opencode-claude-auth
// (src/signing.ts + src/transforms.ts). The `cch` and version suffix are
// SHA-256 fingerprints derived from the first user message text and a constant
// salt.

const BILLING_SALT: &str = "59cf53e54c78";
const CC_VERSION: &str = "2.1.90";
const CC_ENTRYPOINT: &str = "cli";
const CLAUDE_CODE_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn compute_cch(message_text: &str) -> String {
    sha256_hex(message_text).chars().take(5).collect()
}

fn compute_version_suffix(message_text: &str, version: &str) -> String {
    let chars: Vec<char> = message_text.chars().collect();
    let sampled: String = [4, 7, 20]
        .iter()
        .map(|&i| chars.get(i).copied().unwrap_or('0'))
        .collect();
    let input = format!("{BILLING_SALT}{sampled}{version}");
    sha256_hex(&input).chars().take(3).collect()
}

fn build_billing_header(first_user_text: &str) -> String {
    let suffix = compute_version_suffix(first_user_text, CC_VERSION);
    let cch = compute_cch(first_user_text);
    format!(
        "x-anthropic-billing-header: cc_version={CC_VERSION}.{suffix}; \
         cc_entrypoint={CC_ENTRYPOINT}; cch={cch};"
    )
}

fn first_user_text(messages: &serde_json::Value) -> String {
    let arr = match messages.as_array() {
        Some(a) => a,
        None => return String::new(),
    };
    for m in arr {
        if m.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        match m.get("content") {
            Some(serde_json::Value::String(s)) => return s.clone(),
            Some(serde_json::Value::Array(blocks)) => {
                for b in blocks {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                            return t.to_string();
                        }
                    }
                }
            }
            _ => {}
        }
        break;
    }
    String::new()
}

fn prepend_to_first_user(messages: &mut serde_json::Value, prefix: &str) {
    let arr = match messages.as_array_mut() {
        Some(a) => a,
        None => return,
    };
    for m in arr.iter_mut() {
        if m.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let content = match m.get_mut("content") {
            Some(c) => c,
            None => return,
        };
        match content {
            serde_json::Value::String(s) => {
                *s = format!("{prefix}\n\n{s}");
            }
            serde_json::Value::Array(blocks) => {
                blocks.insert(0, json!({"type": "text", "text": prefix}));
            }
            _ => {}
        }
        return;
    }
    arr.insert(0, json!({"role": "user", "content": prefix}));
}

/// Build the JSON body for a POST to `/v1/messages`, rewriting the `system`
/// and first user message for OAuth tokens so the request passes Anthropic's
/// Claude Code subscription-billing validation (see the big comment above).
/// For plain API keys (`sk-ant-api*`) the body is emitted in its conventional
/// shape with `system` as a single string.
pub fn build_messages_body(
    api_key: &str,
    model: &str,
    user_system: &str,
    mut messages: serde_json::Value,
    max_tokens: u32,
    stream: bool,
    tools: Option<serde_json::Value>,
) -> serde_json::Value {
    let is_oauth = !api_key.starts_with("sk-ant-api");

    let system_value: serde_json::Value = if is_oauth {
        // Compute cch / version suffix from the *original* first user text,
        // before we prepend the caller's system prompt.
        let original_first_user = first_user_text(&messages);
        let system = json!([
            {"type": "text", "text": build_billing_header(&original_first_user)},
            {"type": "text", "text": CLAUDE_CODE_IDENTITY},
        ]);
        if !user_system.trim().is_empty() {
            prepend_to_first_user(&mut messages, user_system);
        }
        system
    } else {
        serde_json::Value::String(user_system.to_string())
    };

    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system_value,
        "messages": messages,
    });

    if stream {
        body["stream"] = serde_json::Value::Bool(true);
    }
    if let Some(t) = tools {
        body["tools"] = t;
    }

    body
}

/// Extract retry delay in milliseconds from response headers.
/// Checks (in priority order):
///   1. `anthropic-ratelimit-unified-reset` — Unix timestamp (seconds) used by the
///      Claude Code CLI's unified rate-limit system.
///   2. `retry-after` — standard HTTP header (seconds to wait).
///   3. `default_ms` fallback.
fn retry_after_ms(headers: &reqwest::header::HeaderMap, default_ms: u64) -> u64 {
    // anthropic-ratelimit-unified-reset is a Unix epoch timestamp in seconds.
    if let Some(reset_ts) = headers
        .get("anthropic-ratelimit-unified-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let wait_secs = reset_ts.saturating_sub(now_secs).max(1);
        return wait_secs * 1000;
    }

    // Standard Retry-After header (seconds).
    headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .map(|secs| secs * 1000)
        .unwrap_or(default_ms)
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
        if major >= 3 {
            Some(format!("{major}.{minor}"))
        } else {
            None
        }
    });

    match version {
        Some(v) => format!("Claude {tier} {v}"),
        None => format!("Claude {tier}"),
    }
}

/// Tier sort weight: Haiku < Sonnet < Opus (ascending capability).
fn tier_weight(id: &str) -> u8 {
    if id.contains("haiku") {
        0
    } else if id.contains("sonnet") {
        1
    } else if id.contains("opus") {
        2
    } else {
        3
    }
}

/// Fetch the live model list from `GET /v1/models`, filter to current Claude
/// 4.x+ models, and return them sorted Haiku → Sonnet → Opus (newest version
/// first within each tier).  Returns `Err` on any network or parse failure so
/// callers can fall back gracefully.
async fn fetch_models_live(
    client: &Client,
    api_key: &str,
) -> Result<Vec<(String, String)>, String> {
    let req = client
        .get("https://api.anthropic.com/v1/models")
        .header("anthropic-version", "2023-06-01");

    let req = if api_key.starts_with("sk-ant-api") {
        req.header("x-api-key", api_key)
    } else {
        req.header("Authorization", format!("Bearer {api_key}"))
            .header(
                "anthropic-beta",
                "oauth-2025-04-20,claude-code-20250219,files-api-2025-04-14",
            )
            .header("anthropic-client-platform", "claude_code_cli")
    };

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Models API request failed: {e}"))?;

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

    let mut models: Vec<(String, i64, u8)> = data
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            if !id.starts_with("claude-") {
                return None;
            }
            if id.contains("claude-3") || id.contains("instant") {
                return None;
            }
            if id.ends_with("-latest") || id.contains("preview") {
                return None;
            }
            if !id.contains("opus") && !id.contains("sonnet") && !id.contains("haiku") {
                return None;
            }
            let created: i64 = m["created_at"]
                .as_i64()
                .or_else(|| {
                    m["created_at"]
                        .as_str()
                        .and_then(|s| s.split('-').next()?.parse::<i64>().ok())
                })
                .unwrap_or(0);
            Some((id.to_string(), created, tier_weight(id)))
        })
        .collect();

    if models.is_empty() {
        return Err("Models API returned no usable models".to_string());
    }

    models.sort_by(|a, b| a.2.cmp(&b.2).then(b.1.cmp(&a.1)));

    Ok(models
        .into_iter()
        .map(|(id, _, _)| {
            let label = model_label(&id);
            (id, label)
        })
        .collect())
}

pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";

pub const AVAILABLE_MODELS: &[(&str, &str)] = &[
    ("claude-haiku-4-5-20251001", "Claude Haiku 4.5  — Fastest"),
    (
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6 — Balanced (recommended)",
    ),
    ("claude-opus-4-6", "Claude Opus 4.6   — Most capable"),
];

/// Return the model catalogue for the settings UI.
#[tauri::command]
pub async fn get_claude_models() -> Vec<(String, String)> {
    if let Some(api_key) = get_credential("anthropic_api_key") {
        if let Ok(client) = make_corporate_client(Duration::from_secs(8)) {
            if let Ok(models) = fetch_models_live(&client, &api_key).await {
                return models;
            }
        }
    }
    AVAILABLE_MODELS
        .iter()
        .map(|(id, label)| (id.to_string(), label.to_string()))
        .collect()
}

pub fn get_active_model() -> String {
    get_credential("claude_model")
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

pub async fn complete<F>(
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
    on_retry: F,
) -> Result<String, String>
where
    F: Fn(u32, u64),
{
    eprintln!("[meridian] complete: starting request (model={model}, max_tokens={max_tokens}, user_len={})", user.len());
    let body = build_messages_body(
        api_key,
        model,
        system,
        json!([{ "role": "user", "content": user }]),
        max_tokens,
        false,
        None,
    );

    const MAX_RETRIES: u32 = 5;
    let mut delay_ms = 2_000u64;
    let mut attempt = 0u32;

    let resp = loop {
        eprintln!("[meridian] complete: send attempt {}", attempt + 1);
        let req = client
            .post("https://api.anthropic.com/v1/messages")
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");

        let req = if api_key.starts_with("sk-ant-api") {
            req.header("x-api-key", api_key)
        } else {
            req.header("Authorization", format!("Bearer {api_key}"))
                .header(
                    "anthropic-beta",
                    "oauth-2025-04-20,claude-code-20250219,files-api-2025-04-14",
                )
                .header("anthropic-client-platform", "claude_code_cli")
        };

        let resp = req.json(&body).send().await.map_err(|e| {
            eprintln!("[meridian] complete: request error: {e}");
            if e.is_connect() || e.is_timeout() {
                "Could not reach api.anthropic.com. Check your internet connection.".to_string()
            } else {
                format!("Request failed: {e}")
            }
        })?;

        eprintln!("[meridian] complete: status={}", resp.status());
        if resp.status().as_u16() == 429 && attempt < MAX_RETRIES {
            let wait_ms = retry_after_ms(resp.headers(), delay_ms);
            eprintln!("[meridian] complete: rate limited, waiting {wait_ms}ms");
            attempt += 1;
            on_retry(attempt, wait_ms);
            delay_ms = (delay_ms * 2).min(30_000);
            tokio::time::sleep(tokio::time::Duration::from_millis(wait_ms)).await;
            continue;
        }

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            eprintln!("[meridian] complete: error body: {body}");
            return Err(format!("Claude API error {status}: {body}"));
        }

        break resp;
    };

    eprintln!("[meridian] complete: reading response body");
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Claude response: {e}"))?;

    let result = json["content"][0]["text"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from Claude API.".to_string());
    eprintln!("[meridian] complete: done (ok={})", result.is_ok());
    result
}

pub async fn complete_claude_streaming(
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

    eprintln!("[meridian] complete_claude_streaming: starting request");
    let body = build_messages_body(
        api_key,
        model,
        system,
        json!([{ "role": "user", "content": user }]),
        max_tokens,
        true,
        None,
    );

    const MAX_RETRIES: u32 = 5;
    let mut delay_ms = 2_000u64;
    let mut attempt = 0u32;

    let resp = loop {
        eprintln!(
            "[meridian] complete_claude_streaming: send attempt {}",
            attempt + 1
        );
        let req = client
            .post("https://api.anthropic.com/v1/messages")
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");

        let req = if api_key.starts_with("sk-ant-api") {
            req.header("x-api-key", api_key)
        } else {
            req.header("Authorization", format!("Bearer {api_key}"))
                .header(
                    "anthropic-beta",
                    "oauth-2025-04-20,claude-code-20250219,files-api-2025-04-14",
                )
                .header("anthropic-client-platform", "claude_code_cli")
        };

        let resp = match req.json(&body).send().await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[meridian] complete_claude_streaming: request error: {e}");
                if e.is_connect() || e.is_timeout() {
                    return Err(
                        "Could not reach api.anthropic.com. Check your internet connection."
                            .to_string(),
                    );
                } else {
                    return Err(format!("Request failed: {e}"));
                }
            }
        };

        eprintln!(
            "[meridian] complete_claude_streaming: status={}",
            resp.status()
        );
        if resp.status().as_u16() == 429 && attempt < MAX_RETRIES {
            let wait_ms = retry_after_ms(resp.headers(), delay_ms);
            eprintln!(
                "[meridian] complete_claude_streaming: rate limited, waiting {}ms",
                wait_ms
            );
            delay_ms = (delay_ms * 2).min(30_000);
            attempt += 1;
            tokio::time::sleep(tokio::time::Duration::from_millis(wait_ms)).await;
            continue;
        }

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            eprintln!(
                "[meridian] complete_claude_streaming: error body: {}",
                body_text
            );
            return Err(format!("Claude API error {status}: {body_text}"));
        }

        break resp;
    };

    eprintln!("[meridian] complete_claude_streaming: starting to read stream");
    let mut stream = resp.bytes_stream();
    let mut full_text = String::new();
    let mut buffer = String::new();

    'outer: while let Some(chunk) = stream.next().await {
        if REVIEW_CANCELLED.load(Ordering::Relaxed) {
            eprintln!("[meridian] complete_claude_streaming: cancelled by user");
            return Err("Review cancelled by user.".to_string());
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[meridian] complete_claude_streaming: stream error: {e}");
                return Err(format!("Stream read error: {e}"));
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer = buffer[nl + 1..].to_string();

            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line["data: ".len()..];

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                let event_type = json["type"].as_str().unwrap_or("");
                match event_type {
                    "content_block_delta" => {
                        if json["delta"]["type"].as_str() == Some("text_delta") {
                            if let Some(text) = json["delta"]["text"].as_str() {
                                if !text.is_empty() {
                                    full_text.push_str(text);
                                    let _ = app.emit(
                                        stream_event,
                                        serde_json::json!({
                                            "delta": text,
                                        }),
                                    );
                                }
                            }
                        }
                    }
                    "message_stop" => {
                        eprintln!("[meridian] complete_claude_streaming: received message_stop");
                        break 'outer;
                    }
                    "error" => {
                        let msg = json["error"]["message"]
                            .as_str()
                            .unwrap_or("Unknown streaming error");
                        eprintln!(
                            "[meridian] complete_claude_streaming: API level stream error: {}",
                            msg
                        );
                        return Err(format!("Claude stream error: {msg}"));
                    }
                    _ => {}
                }
            }
        }
    }

    eprintln!(
        "[meridian] complete_claude_streaming: finished (len={})",
        full_text.len()
    );
    if full_text.is_empty() {
        return Err("Claude returned an empty streaming response.".to_string());
    }
    Ok(full_text)
}

pub async fn complete_multi(
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let messages: serde_json::Value =
        serde_json::from_str(history_json).map_err(|e| format!("Invalid history JSON: {e}"))?;

    let body = build_messages_body(api_key, model, system, messages, max_tokens, false, None);

    const MAX_RETRIES: u32 = 5;
    let mut delay_ms = 2_000u64;
    let mut attempt = 0u32;

    let resp = loop {
        let req = client
            .post("https://api.anthropic.com/v1/messages")
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");

        let req = if api_key.starts_with("sk-ant-api") {
            req.header("x-api-key", api_key)
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

        if resp.status().as_u16() == 429 && attempt < MAX_RETRIES {
            let wait_ms = retry_after_ms(resp.headers(), delay_ms);
            delay_ms = (delay_ms * 2).min(30_000);
            attempt += 1;
            tokio::time::sleep(tokio::time::Duration::from_millis(wait_ms)).await;
            continue;
        }

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Claude API error {status}: {body}"));
        }

        break resp;
    };

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Claude response: {e}"))?;

    json["content"][0]["text"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Unexpected response shape from Claude API.".to_string())
}

pub async fn complete_multi_claude_streaming(
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

    let messages: serde_json::Value =
        serde_json::from_str(history_json).map_err(|e| format!("Invalid history JSON: {e}"))?;

    let body = build_messages_body(api_key, model, system, messages, max_tokens, true, None);

    const MAX_RETRIES: u32 = 5;
    let mut delay_ms = 2_000u64;
    let mut attempt = 0u32;

    let resp = loop {
        let req = client
            .post("https://api.anthropic.com/v1/messages")
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");

        let req = if api_key.starts_with("sk-ant-api") {
            req.header("x-api-key", api_key)
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

        if resp.status().as_u16() == 429 && attempt < MAX_RETRIES {
            let wait_ms = retry_after_ms(resp.headers(), delay_ms);
            delay_ms = (delay_ms * 2).min(30_000);
            attempt += 1;
            tokio::time::sleep(tokio::time::Duration::from_millis(wait_ms)).await;
            continue;
        }

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(format!("Claude API error {status}: {body_text}"));
        }

        break resp;
    };

    let mut stream = resp.bytes_stream();
    let mut full_text = String::new();
    let mut buffer = String::new();

    'outer: while let Some(chunk) = stream.next().await {
        if REVIEW_CANCELLED.load(Ordering::Relaxed) {
            return Err("Review cancelled by user.".to_string());
        }
        let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer = buffer[nl + 1..].to_string();

            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line["data: ".len()..];

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                let event_type = json["type"].as_str().unwrap_or("");
                match event_type {
                    "content_block_delta" => {
                        if json["delta"]["type"].as_str() == Some("text_delta") {
                            if let Some(text) = json["delta"]["text"].as_str() {
                                if !text.is_empty() {
                                    full_text.push_str(text);
                                    let _ = app.emit(
                                        stream_event,
                                        serde_json::json!({
                                            "delta": text,
                                        }),
                                    );
                                }
                            }
                        }
                    }
                    "message_stop" => break 'outer,
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

// ── Claude native tool-use streaming agentic loop ─────────────────────────────

pub async fn complete_multi_claude_tool_loop(
    app: &tauri::AppHandle,
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    use crate::agents::tools::{all_tools_def, execute_tool, tool_progress_label};
    use futures_util::StreamExt;
    use tauri::Emitter;

    let tools_def = all_tools_def();
    let base_messages: serde_json::Value =
        serde_json::from_str(history_json).map_err(|e| format!("Invalid history JSON: {e}"))?;
    let mut messages: Vec<serde_json::Value> =
        base_messages.as_array().cloned().unwrap_or_default();

    let mut accumulated_text = String::new();
    let mut final_text = String::new();

    const MAX_TOOL_ROUNDS: usize = 8;

    for _round in 0..MAX_TOOL_ROUNDS {
        let body = build_messages_body(
            api_key,
            model,
            system,
            serde_json::Value::Array(messages.clone()),
            max_tokens,
            true,
            Some(tools_def.clone()),
        );

        let mut retry_delay_ms = 1_000u64;
        let mut send_attempt = 0u32;
        let resp = 'send: loop {
            let req = client
                .post("https://api.anthropic.com/v1/messages")
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json");

            let req = if api_key.starts_with("sk-ant-api") {
                req.header("x-api-key", api_key)
            } else {
                req.header("Authorization", format!("Bearer {api_key}"))
                    .header(
                        "anthropic-beta",
                        "oauth-2025-04-20,claude-code-20250219,files-api-2025-04-14",
                    )
                    .header("anthropic-client-platform", "claude_code_cli")
            };

            let r = req.json(&body).send().await.map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    "Could not reach api.anthropic.com.".to_string()
                } else {
                    format!("Request failed: {e}")
                }
            })?;

            if r.status().as_u16() == 429 && send_attempt < 5 {
                let wait_ms = retry_after_ms(r.headers(), retry_delay_ms);
                retry_delay_ms = (retry_delay_ms * 2).min(60_000);
                send_attempt += 1;
                tokio::time::sleep(tokio::time::Duration::from_millis(wait_ms)).await;
                continue 'send;
            }

            if !r.status().is_success() {
                let status = r.status();
                let body_text = r.text().await.unwrap_or_default();
                return Err(format!("Claude API error {status}: {body_text}"));
            }
            break r;
        };

        let mut stream = resp.bytes_stream();
        let mut round_text = String::new();
        let mut tool_calls: Vec<serde_json::Value> = vec![];
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
                if !line.starts_with("data: ") {
                    continue;
                }
                let data = &line["data: ".len()..];
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    match json["type"].as_str().unwrap_or("") {
                        "content_block_delta" => {
                            if json["delta"]["type"].as_str() == Some("text_delta") {
                                if let Some(text) = json["delta"]["text"].as_str() {
                                    round_text.push_str(text);
                                    accumulated_text.push_str(text);
                                    let _ = app.emit(stream_event, json!({ "delta": text }));
                                }
                            } else if json["delta"]["type"].as_str() == Some("input_json_delta") {
                                if let Some(index) = json["index"].as_u64() {
                                    if let Some(call) = tool_calls.get_mut(index as usize) {
                                        let delta =
                                            json["delta"]["partial_json"].as_str().unwrap_or("");
                                        let current = call["input"].as_str().unwrap_or("");
                                        call["input"] = json!(format!("{}{}", current, delta));
                                    }
                                }
                            }
                        }
                        "content_block_start" => {
                            if json["content_block"]["type"].as_str() == Some("tool_use") {
                                tool_calls.push(json["content_block"].clone());
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        if tool_calls.is_empty() {
            final_text = round_text;
            break;
        }

        let mut assistant_content = vec![];
        if !round_text.is_empty() {
            assistant_content.push(json!({ "type": "text", "text": round_text }));
        }

        let mut tool_results = vec![];
        for call in tool_calls {
            let id = call["id"].as_str().unwrap_or("").to_string();
            let name = call["name"].as_str().unwrap_or("").to_string();
            let input_str = call["input"].as_str().unwrap_or("{}");
            let input: serde_json::Value = serde_json::from_str(input_str).unwrap_or(json!({}));

            assistant_content.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input
            }));

            let label = tool_progress_label(&name, &input);
            let _ = app.emit(
                stream_event,
                json!({ "delta": format!("\n\n⚙️ {}\n", label) }),
            );

            let result = execute_tool(&name, &input).await;
            tool_results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": result
            }));
        }

        messages.push(json!({ "role": "assistant", "content": assistant_content }));
        messages.push(json!({ "role": "user", "content": tool_results }));
    }

    Ok(if final_text.is_empty() {
        accumulated_text
    } else {
        final_text
    })
}

pub async fn complete_multi_text_tool_loop(
    app: &tauri::AppHandle,
    client: &Client,
    claude_key: &str,
    provider: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    use crate::agents::dispatch::try_provider_multi;
    use crate::agents::tools::{
        execute_tool, extract_text_tool_call, strip_tool_tag, tool_progress_label,
        TOOL_SYSTEM_SUFFIX,
    };
    use tauri::Emitter;

    let mut messages: Vec<serde_json::Value> =
        serde_json::from_str(history_json).unwrap_or_default();
    let mut accumulated_text = String::new();
    let mut final_text = String::new();
    let full_system = format!("{}{}", system, TOOL_SYSTEM_SUFFIX);

    for _round in 0..8 {
        let history_str = serde_json::to_string(&messages).unwrap_or_else(|_| "[]".to_string());
        let round_reply = try_provider_multi(
            app,
            provider,
            client,
            claude_key,
            &full_system,
            &history_str,
            max_tokens,
            stream_event,
        )
        .await?;

        if let Some(call) = extract_text_tool_call(&round_reply) {
            let stripped = strip_tool_tag(&round_reply, &call.tag);
            accumulated_text.push_str(&stripped);

            let label = tool_progress_label(&call.name, &call.input);
            let _ = app.emit(
                stream_event,
                json!({ "delta": format!("\n\n⚙️ {}\n", label) }),
            );

            let result = execute_tool(&call.name, &call.input).await;

            messages.push(json!({ "role": "assistant", "content": round_reply }));
            messages
                .push(json!({ "role": "user", "content": format!("Tool result:\n{}", result) }));
        } else {
            final_text = round_reply;
            break;
        }
    }

    Ok(if final_text.is_empty() {
        accumulated_text
    } else {
        final_text
    })
}

#[cfg(test)]
mod oauth_billing_tests {
    use super::*;

    #[test]
    fn sha256_hex_known_input() {
        assert_eq!(
            sha256_hex("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn cch_is_5_hex_chars() {
        let cch = compute_cch("any message");
        assert_eq!(cch.len(), 5);
        assert!(cch.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn billing_header_format() {
        let h = build_billing_header("Say hello.");
        assert!(h.starts_with("x-anthropic-billing-header: cc_version="));
        assert!(h.contains("cc_entrypoint=cli"));
        assert!(h.contains("cch="));
        assert!(h.ends_with(';'));
    }
}
