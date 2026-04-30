use reqwest::{Client, StatusCode};
use std::time::Duration;

use crate::http::make_corporate_client;
use crate::storage::credentials::{get_credential, store_credential};

// ── Gemini OAuth token refresh ────────────────────────────────────────────────

const GEMINI_REFRESH_URL: &str = "https://oauth2.googleapis.com/token";
const GEMINI_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
// Distributed publicly by the open-source Gemini CLI; Google's token endpoint
// requires it for this client even with PKCE. Not actually secret.
const GEMINI_CLIENT_SECRET: &str = "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";
/// Refresh 5 minutes before the token actually expires.
const OAUTH_REFRESH_BUFFER_MS: u64 = 5 * 60 * 1000;

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
            "client_secret": GEMINI_CLIENT_SECRET,
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

    // Update the stored JSON with new access token and expiry
    let mut updated = oauth_data.clone();
    let obj = updated
        .as_object_mut()
        .ok_or("Stored Gemini OAuth data is not an object")?;

    obj.insert(
        "accessToken".to_string(),
        serde_json::Value::String(new_access.to_string()),
    );
    obj.insert(
        "expiresAt".to_string(),
        serde_json::Value::Number(serde_json::Number::from(new_expires_at)),
    );

    // If a new refresh token was returned, update it too
    if let Some(rt) = new_tokens.get("refresh_token").and_then(|v| v.as_str()) {
        obj.insert(
            "refreshToken".to_string(),
            serde_json::Value::String(rt.to_string()),
        );
    }

    store_credential("gemini_api_key", new_access)?;
    store_credential("gemini_oauth_json", &updated.to_string())?;

    Ok(())
}

// ── Gemini Code Assist API (OAuth path) ──────────────────────────────────────

const GEMINI_CODE_ASSIST_BASE: &str = "https://cloudcode-pa.googleapis.com/v1internal";

/// Matches the User-Agent the official Gemini CLI sends. The server uses this
/// for surface/tier classification — sending a generic UA appears to put the
/// request into a different (tighter) quota bucket.
fn gemini_cli_user_agent(model: &str) -> String {
    let version = env!("CARGO_PKG_VERSION");
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    format!("GeminiCLI/{version}/{model} ({os}; {arch}; meridian)")
}

/// Stable session ID for the lifetime of the Meridian process. The Code Assist
/// server uses this to recognise that follow-up requests are part of the same
/// conversation rather than counting each as a new session.
fn meridian_session_id() -> &'static str {
    use std::sync::OnceLock;
    static SESSION: OnceLock<String> = OnceLock::new();
    SESSION.get_or_init(|| {
        use sha2::{Digest, Sha256};
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let seed = format!("meridian-{}-{}", now.as_nanos(), std::process::id());
        let digest = Sha256::digest(seed.as_bytes());
        digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
    })
}

fn code_assist_metadata() -> serde_json::Value {
    serde_json::json!({
        "ideType": "IDE_UNSPECIFIED",
        "platform": "PLATFORM_UNSPECIFIED",
        "pluginType": "GEMINI"
    })
}

pub async fn ensure_gemini_codeassist_project(
    client: &Client,
    access_token: &str,
) -> Result<String, String> {
    if let Some(p) = get_credential("gemini_project_id").filter(|p| !p.trim().is_empty()) {
        return Ok(p);
    }

    // Don't pass `cloudaicompanionProject` for free-tier users — sending an
    // empty string (or any value) downgrades the tier classification on the server.
    // The official Gemini CLI omits this field entirely when the user has no
    // GOOGLE_CLOUD_PROJECT env var set.
    let load_resp = client
        .post(format!("{GEMINI_CODE_ASSIST_BASE}:loadCodeAssist"))
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .header("User-Agent", gemini_cli_user_agent("none"))
        .json(&serde_json::json!({
            "metadata": code_assist_metadata(),
        }))
        .send()
        .await
        .map_err(|e| format!("loadCodeAssist request failed: {e}"))?;

    if !load_resp.status().is_success() {
        let s = load_resp.status();
        let body = load_resp.text().await.unwrap_or_default();
        return Err(format!("loadCodeAssist failed (HTTP {s}). {body}"));
    }

    let load_data: serde_json::Value = load_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse loadCodeAssist response: {e}"))?;

    if let Some(p) = load_data
        .get("cloudaicompanionProject")
        .and_then(|v| v.as_str())
    {
        if !p.is_empty() {
            store_credential("gemini_project_id", p)?;
            return Ok(p.to_string());
        }
    }

    let tier_id = load_data
        .get("allowedTiers")
        .and_then(|v| v.as_array())
        .and_then(|tiers| {
            tiers
                .iter()
                .find(|t| {
                    t.get("isDefault")
                        .and_then(|d| d.as_bool())
                        .unwrap_or(false)
                })
                .or_else(|| tiers.first())
        })
        .and_then(|t| t.get("id").and_then(|id| id.as_str()))
        .unwrap_or("free-tier")
        .to_string();

    let onboard_body = serde_json::json!({
        "tierId": tier_id,
        "metadata": code_assist_metadata(),
    });

    let mut op: serde_json::Value = serde_json::json!({ "done": false });
    for _ in 0..30 {
        let onboard_resp = client
            .post(format!("{GEMINI_CODE_ASSIST_BASE}:onboardUser"))
            .bearer_auth(access_token)
            .header("Content-Type", "application/json")
            .header("User-Agent", gemini_cli_user_agent("none"))
            .json(&onboard_body)
            .send()
            .await
            .map_err(|e| format!("onboardUser request failed: {e}"))?;

        if !onboard_resp.status().is_success() {
            let s = onboard_resp.status();
            let body = onboard_resp.text().await.unwrap_or_default();
            return Err(format!("onboardUser failed (HTTP {s}). {body}"));
        }

        op = onboard_resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse onboardUser response: {e}"))?;

        if op.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
            break;
        }

        tokio::time::sleep(Duration::from_millis(2000)).await;
    }

    let project = op
        .pointer("/response/cloudaicompanionProject/id")
        .and_then(|v| v.as_str())
        .ok_or("onboardUser completed without a project id")?;

    store_credential("gemini_project_id", project)?;
    Ok(project.to_string())
}

pub fn history_to_gemini_contents(history: &[serde_json::Value]) -> Vec<serde_json::Value> {
    history
        .iter()
        .map(|msg| {
            let role = match msg.get("role").and_then(|r| r.as_str()) {
                Some("assistant") => "model",
                _ => "user",
            };
            let text = msg
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            serde_json::json!({
                "role": role,
                "parts": [{ "text": text }]
            })
        })
        .collect()
}

/// The Code Assist API (`cloudcode-pa.googleapis.com`) only accepts concrete
/// versioned model IDs — it returns 404 for the `*-latest` aliases that the
/// public Generative Language API exposes. Translate common aliases to their
/// current concrete versions, matching what the official gemini-cli ships.
fn resolve_code_assist_model(model: &str) -> &str {
    match model {
        "gemini-flash-latest" | "gemini-2.5-flash-latest" => "gemini-2.5-flash",
        "gemini-pro-latest" | "gemini-2.5-pro-latest" => "gemini-2.5-pro",
        "gemini-flash-lite-latest" | "gemini-2.5-flash-lite-latest" => "gemini-2.5-flash-lite",
        other => other,
    }
}

fn generate_request_id() -> String {
    use sha2::{Digest, Sha256};
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seed = format!("{}-{}", now.as_nanos(), std::process::id());
    let digest = Sha256::digest(seed.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub async fn complete_multi_gemini_codeassist(
    client: &Client,
    access_token: &str,
    project_id: &str,
    model: &str,
    system: &str,
    history: &[serde_json::Value],
    max_tokens: u32,
) -> Result<String, String> {
    let resolved_model = resolve_code_assist_model(model);
    let contents = history_to_gemini_contents(history);

    let mut request = serde_json::json!({
        "contents": contents,
        "session_id": meridian_session_id(),
        "generationConfig": { "maxOutputTokens": max_tokens }
    });
    if !system.trim().is_empty() {
        request["systemInstruction"] = serde_json::json!({
            "parts": [{ "text": system }]
        });
    }

    let body = serde_json::json!({
        "model": resolved_model,
        "project": project_id,
        "user_prompt_id": generate_request_id(),
        "request": request,
    });

    let ua = gemini_cli_user_agent(resolved_model);
    eprintln!(
        "[meridian gemini] code assist request: model={resolved_model} (requested={model}) project={project_id} session={}",
        meridian_session_id()
    );

    let resp = client
        .post(format!("{GEMINI_CODE_ASSIST_BASE}:generateContent"))
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .header("User-Agent", &ua)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach cloudcode-pa.googleapis.com.".to_string()
            } else {
                format!("Code Assist request failed: {e}")
            }
        })?;

    if !resp.status().is_success() {
        let s = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Gemini Code Assist API error {s} (model={resolved_model}, project={project_id}): {body_text}"
        ));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Code Assist response: {e}"))?;

    json.pointer("/response/candidates/0/content/parts/0/text")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("Unexpected Code Assist response shape: {json}"))
}

const GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";

pub async fn complete_gemini_for_ping(
    client: &Client,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    complete_gemini(client, api_key, model, "", "Say hello.", 32).await
}

pub async fn complete_gemini(
    client: &Client,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let auth_method = get_credential("gemini_auth_method").unwrap_or_else(|| "api_key".to_string());
    if auth_method == "oauth" {
        refresh_gemini_oauth_if_needed(client).await?;
        let token = get_credential("gemini_api_key").unwrap_or_else(|| api_key.to_string());
        let project = ensure_gemini_codeassist_project(client, &token).await?;
        let history = vec![serde_json::json!({ "role": "user", "content": user })];
        return complete_multi_gemini_codeassist(
            client, &token, &project, model, system, &history, max_tokens,
        )
        .await;
    }

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

/// Built-in Gemini models. The Code Assist OAuth path has no dynamic
/// `models.list`, and the public Generative Language API rejects personal
/// OAuth tokens — so Zed, the official Gemini CLI, and Meridian all ship a
/// curated list. Users can extend it via "Custom models" in Settings.
const GEMINI_BUILTIN_MODELS: &[(&str, &str)] = &[
    ("gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)"),
    ("gemini-3-flash-preview", "Gemini 3 Flash (preview)"),
    (
        "gemini-3.1-flash-lite-preview",
        "Gemini 3.1 Flash-Lite (preview)",
    ),
    ("gemini-2.5-pro", "Gemini 2.5 Pro"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
];

const GEMINI_CUSTOM_MODELS_PREF: &str = "gemini_custom_models";

fn load_custom_gemini_models() -> Vec<String> {
    let Some(raw) = crate::storage::preferences::load_map()
        .get(GEMINI_CUSTOM_MODELS_PREF)
        .cloned()
    else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
}

fn save_custom_gemini_models(models: &[String]) -> Result<(), String> {
    let mut map = crate::storage::preferences::load_map();
    if models.is_empty() {
        map.remove(GEMINI_CUSTOM_MODELS_PREF);
    } else {
        let json = serde_json::to_string(models)
            .map_err(|e| format!("Failed to serialise custom models: {e}"))?;
        map.insert(GEMINI_CUSTOM_MODELS_PREF.to_string(), json);
    }
    crate::storage::preferences::save_map(&map)
}

#[tauri::command]
pub async fn get_gemini_models() -> Result<Vec<(String, String)>, String> {
    let auth_method = get_credential("gemini_auth_method").unwrap_or_else(|| "api_key".to_string());
    get_credential("gemini_api_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or("Gemini credentials are not configured.")?;

    // Touch the token refresher on OAuth so the rest of the app doesn't hit
    // an expired session right after the user opens Settings.
    if auth_method == "oauth" {
        if let Ok(client) = make_corporate_client(Duration::from_secs(8), false) {
            let _ = refresh_gemini_oauth_if_needed(&client).await;
        }
    }

    let mut out: Vec<(String, String)> = GEMINI_BUILTIN_MODELS
        .iter()
        .map(|(id, name)| (id.to_string(), name.to_string()))
        .collect();

    for id in load_custom_gemini_models() {
        if out.iter().any(|(existing, _)| existing == &id) {
            continue;
        }
        let display = format!("{id} (custom)");
        out.push((id, display));
    }

    Ok(out)
}

#[tauri::command]
pub fn get_custom_gemini_models() -> Result<Vec<String>, String> {
    Ok(load_custom_gemini_models())
}

#[tauri::command]
pub fn add_custom_gemini_model(model_id: String) -> Result<Vec<String>, String> {
    let id = model_id.trim().to_string();
    if id.is_empty() {
        return Err("Model ID cannot be empty.".to_string());
    }
    if GEMINI_BUILTIN_MODELS.iter().any(|(m, _)| *m == id) {
        return Err(format!("\"{id}\" is already a built-in model."));
    }
    let mut list = load_custom_gemini_models();
    if !list.contains(&id) {
        list.push(id);
    }
    save_custom_gemini_models(&list)?;
    Ok(list)
}

#[tauri::command]
pub fn remove_custom_gemini_model(model_id: String) -> Result<Vec<String>, String> {
    let id = model_id.trim();
    let mut list = load_custom_gemini_models();
    list.retain(|m| m != id);
    save_custom_gemini_models(&list)?;
    Ok(list)
}

#[tauri::command]
pub async fn validate_gemini(api_key: String) -> Result<String, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("API key cannot be empty.".to_string());
    }

    let client = make_corporate_client(Duration::from_secs(10), false)
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let url =
        format!("https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=1");

    let resp = client.get(&url).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "Could not reach generativelanguage.googleapis.com. \
                 Check your internet connection."
                .to_string()
        } else {
            format!("Request failed: {e}")
        }
    })?;

    match resp.status() {
        s if s.is_success() => {
            store_credential("gemini_api_key", key)?;
            Ok("Connected to Gemini API successfully.".to_string())
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err("Gemini rejected the API key. \
                 Check the key at console.cloud.google.com → APIs & Services → Credentials."
            .to_string()),
        s => Err(format!("Unexpected response from Gemini API (HTTP {s}).")),
    }
}

#[tauri::command]
pub async fn test_gemini_stored() -> Result<String, String> {
    let auth_method = get_credential("gemini_auth_method").unwrap_or_else(|| "api_key".to_string());

    let key = get_credential("gemini_api_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or("Gemini credentials are not configured.")?;

    let client = make_corporate_client(Duration::from_secs(10), false)
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // For OAuth, send a real generateContent request so we test the generation
    // quota path, not just the metadata endpoint (loadCodeAssist doesn't touch
    // the generation quota so it always succeeds even when the model is rate-limited).
    if auth_method == "oauth" {
        refresh_gemini_oauth_if_needed(&client).await?;
        let token = get_credential("gemini_api_key").unwrap_or(key.clone());
        let project = ensure_gemini_codeassist_project(&client, &token).await?;
        let model = crate::storage::preferences::get_pref("gemini_model")
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| "gemini-2.5-flash".to_string());
        return complete_multi_gemini_codeassist(
            &client,
            &token,
            &project,
            &model,
            "",
            &[serde_json::json!({ "role": "user", "content": "Say hello." })],
            32,
        )
        .await
        .map(|_| "Connected to Gemini Code Assist successfully.".to_string());
    }

    let url =
        format!("https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=1");
    let resp = client.get(&url).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "Could not reach Google APIs. Check your internet connection.".to_string()
        } else {
            format!("Request failed: {e}")
        }
    })?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    match status {
        s if s.is_success() => Ok("Connected to Gemini API successfully.".to_string()),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            Err(format!("Gemini rejected the stored API key (HTTP {status}). {body_text}"))
        }
        s => Err(format!(
            "Unexpected response from Gemini API (HTTP {s}). {body_text}"
        )),
    }
}

