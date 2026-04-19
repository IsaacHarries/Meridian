# GitHub Copilot Provider — Implementation Guide

> **Audience**: an implementation agent (Gemini 3 Flash) wiring GitHub Copilot
> into Meridian as a fourth LLM provider alongside Claude, Gemini, and Local LLM.
>
> **Follow this guide top-to-bottom.** Every step lists the exact file, the
> exact function/const to add, and the *pattern to mirror* from the existing
> Claude/Gemini implementations. Do **not** invent new abstractions — copy the
> existing shape.

---

## 1. Background & design decisions

### 1.1 What GitHub Copilot exposes

GitHub Copilot does **not** offer a general-purpose, consumer-facing API key.
It is authenticated as a subscription attached to a user's GitHub account. The
established integration pattern (used by Zed, Neovim copilot.lua, opencode,
avante.nvim, CopilotChat.nvim) is:

1. Run the **GitHub OAuth Device Flow** using VS Code's public client ID
   (`Iv1.b507a08c87ecfe98`, scope `read:user`). This gets a long-lived GitHub
   OAuth token.
2. Exchange that GitHub OAuth token for a **short-lived Copilot token** by
   calling `GET https://api.github.com/copilot_internal/v2/token` with
   `Authorization: token <github-oauth-token>`. The response includes a
   `token` field and an `expires_at` (unix seconds). Tokens typically live
   ~30 minutes.
3. Call the **OpenAI-compatible Copilot endpoint**
   `https://api.githubcopilot.com/chat/completions` with
   `Authorization: Bearer <copilot-token>`, plus required identity headers
   (see §4.3).

### 1.2 "API key" path

The user asked for an API-key option "if that's available". Two options:

- **Personal GitHub OAuth token**: advanced users can paste a GitHub OAuth
  token that was minted elsewhere (e.g. `gh auth token`). Meridian then runs
  the same exchange (step 2 above) to mint Copilot tokens.
- **GitHub Models API (optional, stretch)**: GitHub exposes a separate
  OpenAI-compatible endpoint at `https://models.github.ai/inference` accepting
  a GitHub PAT. This is a different product (GitHub Models, not Copilot) so
  **do not implement it unless the stretch section at the bottom is reached**.

Implement the OAuth Device Flow as the primary path. Add an "API key" (really:
"paste an existing GitHub OAuth token") as the secondary path — this matches
the user's stated requirement and reuses the same token-exchange plumbing.

### 1.3 Where this slots into Meridian's architecture

Meridian's LLM plumbing has four layers. Mirror each one for Copilot:

| Layer | File(s) | What to add |
|---|---|---|
| HTTP / refresh / complete | `src-tauri/src/llms/copilot.rs` (new) | `refresh_copilot_token_if_needed`, `complete_copilot`, `complete_multi_copilot`, `get_copilot_models`, `get_custom_copilot_models`, `add_custom_copilot_model`, `remove_custom_copilot_model`, `validate_copilot`, `test_copilot_stored` |
| Module registration | `src-tauri/src/llms/mod.rs` | `pub mod copilot;` |
| OAuth command | `src-tauri/src/commands/validate.rs` | `start_copilot_oauth`, `ping_copilot` |
| Credential allowlist | `src-tauri/src/commands/credentials.rs` | add `copilot_*` keys |
| Command re-exports | `src-tauri/src/commands/mod.rs` | re-export the new public commands |
| Tauri handler registration | `src-tauri/src/lib.rs` | register commands in the `invoke_handler!` macro and the `use commands::{…}` list |
| Dispatch | `src-tauri/src/agents/dispatch.rs` | add `"copilot"` arm to `try_provider_single`, `try_provider_multi`, `dispatch_streaming`, `dispatch_multi_streaming`, `dispatch_multi_streaming_with_tools`; extend `DEFAULT_ORDER` |
| Frontend bindings | `src/lib/tauri.ts` | Typed wrappers for the new invoke calls |
| Settings UI | `src/screens/SettingsScreen.tsx` | `CopilotSection` component, add to `AI_PROVIDER_MODES` + `PROVIDER_META` + `DEFAULT_ORDER` |
| Credential status | `src-tauri/src/commands/credentials.rs` + `src/lib/tauri.ts` | add `copilot_api_key` to `CredentialStatus` |

### 1.4 Credential keys you will add

Match the Claude / Gemini naming convention exactly:

| Key | Stored in | Meaning |
|---|---|---|
| `copilot_api_key` | Keychain (secret) | The current short-lived Copilot token (`ghu_…` or `tid=…`). Used as `Authorization: Bearer …` against `api.githubcopilot.com`. |
| `copilot_oauth_json` | Keychain (secret) | JSON blob: `{ "githubToken": "...", "copilotToken": "...", "expiresAt": <unix-ms> }`. This is the refresh source. |
| `copilot_auth_method` | Keychain (non-secret, readable via `get_non_secret_config`) | `"oauth"` or `"api_key"`. |
| `copilot_model` | Preferences (plain JSON) | Selected model id, e.g. `gpt-4o`, `claude-sonnet-4`, `o3-mini`. |
| `copilot_custom_models` | Preferences (plain JSON, serialized `Vec<String>`) | User-added model IDs. |

**Do not** add a `copilot_*` variant of every non-secret key to
`NON_SECRET_KEYS`; only `copilot_auth_method` goes there.

---

## 2. Step-by-step implementation

### Step 1 — Create `src-tauri/src/llms/copilot.rs`

Create the new module. Structure mirrors `gemini.rs` (same shape, slightly
simpler because there is no "Code Assist" side-path).

```rust
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
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const DEVICE_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

/// Exchange endpoint: GitHub OAuth token → short-lived Copilot token.
const COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";

/// Chat completions endpoint.
const COPILOT_API_BASE: &str = "https://api.githubcopilot.com";

/// Scope requested during device flow. Copilot access is tied to the account,
/// so `read:user` is sufficient — do not ask for more.
const COPILOT_SCOPE: &str = "read:user";

/// Refresh 5 minutes before the Copilot token actually expires.
const COPILOT_REFRESH_BUFFER_MS: u64 = 5 * 60 * 1000;

/// Identity headers required by api.githubcopilot.com. Mirror VS Code
/// Copilot Chat so the backend accepts the request. These are non-sensitive.
const COPILOT_INTEGRATION_ID: &str = "vscode-chat";
const COPILOT_EDITOR_VERSION: &str = "vscode/1.95.0";
const COPILOT_EDITOR_PLUGIN_VERSION: &str = "copilot-chat/0.22.0";
const COPILOT_USER_AGENT: &str = "GitHubCopilotChat/0.22.0";
```

---

### Step 2 — Token exchange & refresh in `copilot.rs`

Add **one** exchange helper and **one** refresh helper. The refresh helper is
the equivalent of `refresh_gemini_oauth_if_needed` — call it at the start of
every dispatch.

```rust
/// Exchange a long-lived GitHub OAuth token for a short-lived Copilot token.
/// Copilot tokens expire every ~30 minutes, so this is called by
/// `refresh_copilot_token_if_needed` whenever the cached one is near expiry.
async fn exchange_github_token_for_copilot(
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
```

---

### Step 3 — Chat completion helpers in `copilot.rs`

Copilot speaks the OpenAI chat completions protocol. Add the same set of
helpers Gemini has: single-turn, multi-turn non-streaming, streaming
multi-turn, plus a ping helper. Reuse `history_to_openai_messages` shape
(role: `user`/`assistant`, content: string).

```rust
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
    let req = copilot_request_headers(client.post(&url), token)
        .header("Accept", "text/event-stream");
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
                        let _ = app.emit(
                            stream_event,
                            serde_json::json!({ "delta": delta }),
                        );
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
```

---

### Step 4 — Model catalogue, validation, test commands in `copilot.rs`

Follow `gemini.rs` exactly. Attempt a live `GET /models` on
`api.githubcopilot.com` to enumerate models the user has access to; fall back
to a curated list if unavailable.

```rust
const COPILOT_BUILTIN_MODELS: &[(&str, &str)] = &[
    ("gpt-4o",             "GPT-4o"),
    ("gpt-4o-mini",        "GPT-4o Mini"),
    ("o3-mini",            "o3 Mini"),
    ("claude-sonnet-4",    "Claude Sonnet 4 (via Copilot)"),
    ("claude-3.5-sonnet",  "Claude 3.5 Sonnet (via Copilot)"),
    ("gemini-2.5-pro",     "Gemini 2.5 Pro (via Copilot)"),
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
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(
            "GitHub Copilot rejected the token. Re-authenticate in Settings.".to_string(),
        ),
        s => {
            let body = resp.text().await.unwrap_or_default();
            Err(format!("Unexpected response from Copilot (HTTP {s}). {body}"))
        }
    }
}
```

---

### Step 5 — Register `copilot` module in `src-tauri/src/llms/mod.rs`

Add a single line:

```rust
pub mod claude;
pub mod copilot;      // ← new
pub mod gemini;
pub mod local_llm;
```

---

### Step 6 — OAuth Device Flow in `src-tauri/src/commands/validate.rs`

GitHub's OAuth Device Flow is simpler than PKCE: no redirect server needed.
Add two functions at the bottom of the file (below the existing `start_gemini_oauth`).

```rust
// ── GitHub Copilot OAuth (Device Flow) ───────────────────────────────────────

use crate::llms::copilot::{self, COPILOT_CLIENT_ID};

const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_DEVICE_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const COPILOT_SCOPE: &str = "read:user";

#[tauri::command]
pub async fn start_copilot_oauth() -> Result<String, String> {
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
        return Err(format!("Device code request failed (HTTP {status}).\n{body}"));
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
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(expires_in_secs);
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
                return Err(
                    "Device code expired before user completed authorization.".to_string(),
                );
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
        copilot::exchange_github_token_for_copilot_pub(&client, &github_token).await?;

    store_credential("copilot_api_key", &copilot_token)?;
    store_credential("copilot_auth_method", "oauth")?;
    store_credential(
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
    let model = get_credential("copilot_model")
        .filter(|m| !m.trim().is_empty())
        .ok_or("No Copilot model selected. Please select a model in Settings first.")?;

    let client = make_corporate_client(Duration::from_secs(30))?;
    copilot::refresh_copilot_token_if_needed(&client).await?;
    let token = get_credential("copilot_api_key").unwrap_or_default();

    let reply = copilot::complete_copilot_for_ping(&client, &token, &model).await?;
    Ok(format!(
        "Message sent successfully. Copilot replied: \"{reply}\""
    ))
}
```

Two things to note:
1. The device-flow exchange helper `exchange_github_token_for_copilot` in
   `copilot.rs` was originally defined as `async fn`; re-expose it as
   `pub async fn exchange_github_token_for_copilot_pub(…)` or change its
   visibility to `pub(crate)` — whichever is cleanest. The function body is
   the same.
2. `pbcopy` is macOS-only. Meridian already targets macOS (per CLAUDE.md), so
   that's fine. If the spawn fails, it's a non-issue — the code is still shown
   via `user_code` in the success message.

---

### Step 7 — Credential allowlist in `src-tauri/src/commands/credentials.rs`

Extend `ALLOWED_KEYS` and `NON_SECRET_KEYS`. Also extend `CredentialStatus`.

```rust
const ALLOWED_KEYS: &[&str] = &[
    "anthropic_api_key",
    "claude_oauth_json",
    "claude_auth_method",
    "gemini_api_key",
    "gemini_auth_method",
    "gemini_oauth_json",
    "gemini_project_id",
    "copilot_api_key",          // ← new
    "copilot_auth_method",      // ← new
    "copilot_oauth_json",       // ← new
    "ai_provider_order",
    // … rest unchanged …
];

const NON_SECRET_KEYS: &[&str] = &[
    "claude_auth_method",
    "gemini_auth_method",
    "copilot_auth_method",      // ← new
    "ai_provider_order",
    // … rest unchanged …
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub anthropic_api_key: bool,
    pub gemini_api_key: bool,
    pub copilot_api_key: bool,   // ← new
    pub local_llm_url: bool,
    // … rest unchanged …
}
```

Update the `credential_status` function to set `copilot_api_key` from
`has("copilot_api_key")`, and add `pub fn copilot_complete(&self) -> bool { self.copilot_api_key }`.

---

### Step 8 — Dispatch plumbing in `src-tauri/src/agents/dispatch.rs`

Extend `DEFAULT_ORDER` and every match. **Important**: Copilot does not
currently have a streaming path in this guide; for streaming, fall through to
`try_provider_multi` with the non-streaming path, or add a streaming arm that
calls `complete_multi_copilot_streaming` and emits deltas directly (preferred
if time allows).

**a) Default order** — `get_provider_order()`:

```rust
return vec![
    "claude".to_string(),
    "gemini".to_string(),
    "copilot".to_string(),
    "local".to_string(),
];
```

**b) `try_provider_single`** — add after the `"gemini"` arm, before `"local"`:

```rust
"copilot" => {
    let token = get_credential("copilot_api_key")
        .ok_or_else(|| "Copilot: not configured.".to_string())?;
    let model = get_credential("copilot_model")
        .filter(|m| !m.trim().is_empty())
        .ok_or_else(|| "Copilot: no model selected in Settings.".to_string())?;
    crate::llms::copilot::refresh_copilot_token_if_needed(client).await?;
    let token = get_credential("copilot_api_key").unwrap_or(token);
    crate::llms::copilot::complete_copilot(
        client, &token, &model, system, user, max_tokens,
    )
    .await
}
```

**c) `try_provider_multi`** — same shape, but call `complete_multi_copilot`
passing a parsed `history: Vec<serde_json::Value>`:

```rust
"copilot" => {
    let token = get_credential("copilot_api_key")
        .ok_or_else(|| "Copilot: not configured.".to_string())?;
    let model = get_credential("copilot_model")
        .filter(|m| !m.trim().is_empty())
        .ok_or_else(|| "Copilot: no model selected in Settings.".to_string())?;
    crate::llms::copilot::refresh_copilot_token_if_needed(client).await?;
    let token = get_credential("copilot_api_key").unwrap_or(token);
    let history: Vec<serde_json::Value> = serde_json::from_str(history_json)
        .map_err(|e| format!("Invalid history JSON: {e}"))?;
    crate::llms::copilot::complete_multi_copilot(
        client, &token, &model, system, &history, max_tokens,
    )
    .await
}
```

**d) `dispatch_multi_streaming`** — add a real streaming arm:

```rust
"copilot" => {
    let token = match get_credential("copilot_api_key") {
        Some(t) if !t.trim().is_empty() => t,
        _ => {
            failure_reasons.push("Copilot: not configured".to_string());
            continue;
        }
    };
    let model = match get_credential("copilot_model")
        .filter(|m| !m.trim().is_empty())
    {
        Some(m) => m,
        None => {
            failure_reasons.push("Copilot: no model selected".to_string());
            continue;
        }
    };
    if let Err(e) = crate::llms::copilot::refresh_copilot_token_if_needed(client).await {
        failure_reasons.push(format!("copilot: {e}"));
        continue;
    }
    let token = get_credential("copilot_api_key").unwrap_or(token);
    let history: Vec<serde_json::Value> = serde_json::from_str(history_json)
        .map_err(|e| format!("Invalid history JSON: {e}"))?;
    crate::llms::copilot::complete_multi_copilot_streaming(
        app, client, &token, &model, system, &history, max_tokens, stream_event,
    )
    .await
}
```

**e) `dispatch_streaming`** — for `"copilot"`, fall through to
`try_provider_single` (non-streaming). That matches how Gemini is handled.
No new arm needed there.

**f) `dispatch_multi_streaming_with_tools`** — Copilot does not implement
native tool-use in this guide. Let the `other =>` arm in that function invoke
`complete_multi_text_tool_loop(…, "copilot", …)` as it already does for
Gemini/local.

---

### Step 9 — Command re-exports in `src-tauri/src/commands/mod.rs`

Add to the `pub use llms::…` block:

```rust
pub use llms::copilot::{
    add_custom_copilot_model, get_copilot_models, get_custom_copilot_models,
    remove_custom_copilot_model, test_copilot_stored, validate_copilot,
};
```

And add to the `pub use validate::{…}` block:

```rust
pub use validate::{
    debug_jira_endpoints, import_claude_code_token, ping_anthropic, ping_copilot,
    ping_gemini, start_claude_oauth, start_copilot_oauth, start_gemini_oauth,
    test_anthropic_stored, test_bitbucket_stored, test_jira_stored,
    validate_anthropic, validate_bitbucket, validate_jira,
};
```

---

### Step 10 — Register in `src-tauri/src/lib.rs`

Two places:

**a)** The big `use commands::{…}` import — add:

```rust
add_custom_copilot_model,
get_copilot_models,
get_custom_copilot_models,
remove_custom_copilot_model,
validate_copilot,
test_copilot_stored,
start_copilot_oauth,
ping_copilot,
```

**b)** The `tauri::generate_handler![…]` macro — add in the AI providers
section (near the Gemini commands):

```rust
get_copilot_models,
get_custom_copilot_models,
add_custom_copilot_model,
remove_custom_copilot_model,
validate_copilot,
test_copilot_stored,
start_copilot_oauth,
ping_copilot,
```

---

### Step 11 — Frontend bindings in `src/lib/tauri.ts`

Add to `CredentialStatus`:

```ts
export interface CredentialStatus {
  anthropicApiKey: boolean;
  geminiApiKey: boolean;
  copilotApiKey: boolean;   // ← new
  localLlmUrl: boolean;
  // … rest unchanged …
}
```

Add to `aiProviderComplete`:

```ts
export function aiProviderComplete(s: CredentialStatus) {
  return s.anthropicApiKey || s.geminiApiKey || s.copilotApiKey || s.localLlmUrl;
}
```

Add these exported wrappers near the Gemini ones:

```ts
export async function startCopilotOauth(): Promise<string> {
  return invoke<string>("start_copilot_oauth");
}

export async function getCopilotModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_copilot_models");
}

export async function getCustomCopilotModels(): Promise<string[]> {
  return invoke<string[]>("get_custom_copilot_models");
}

export async function addCustomCopilotModel(modelId: string): Promise<string[]> {
  return invoke<string[]>("add_custom_copilot_model", { modelId });
}

export async function removeCustomCopilotModel(modelId: string): Promise<string[]> {
  return invoke<string[]>("remove_custom_copilot_model", { modelId });
}

export async function validateCopilot(apiKey: string): Promise<string> {
  return invoke<string>("validate_copilot", { apiKey });
}

export async function testCopilotStored(): Promise<string> {
  return invoke<string>("test_copilot_stored");
}

export async function pingCopilot(): Promise<string> {
  return invoke<string>("ping_copilot");
}
```

---

### Step 12 — Settings UI in `src/screens/SettingsScreen.tsx`

**a)** Add `"copilot"` to `AI_PROVIDER_MODES` (line ~683):

```tsx
const AI_PROVIDER_MODES = [
  { value: "auto", label: "Auto (ordered fallback)" },
  { value: "claude", label: "Claude only" },
  { value: "gemini", label: "Gemini only" },
  { value: "copilot", label: "Copilot only" },   // ← new
  { value: "local", label: "Local LLM only" },
] as const;
```

**b)** Add to `PROVIDER_META` (line ~690):

```tsx
copilot: {
  label: "Copilot",
  color: "border-emerald-400/40 bg-emerald-400/10 text-emerald-400",
  dot: "bg-emerald-400",
},
```

**c)** Update `DEFAULT_ORDER` (line ~711):

```tsx
const DEFAULT_ORDER = ["claude", "gemini", "copilot", "local"];
```

**d)** Update `modeDesc` dict (line ~837):

```tsx
copilot: "Always use GitHub Copilot exclusively. No fallback.",
```

**e)** Build a new `CopilotSection` component. Copy `GeminiSection`
wholesale — it is the closest fit (API key + OAuth dual flow, model picker,
custom models) — and do a global rename in the copy:

| In GeminiSection | Becomes in CopilotSection |
|---|---|
| `gemini_api_key` | `copilot_api_key` |
| `gemini_auth_method` | `copilot_auth_method` |
| `gemini_model` | `copilot_model` |
| `validateGemini` | `validateCopilot` |
| `testGeminiStored` | `testCopilotStored` |
| `pingGemini` | `pingCopilot` |
| `startGeminiOauth` | `startCopilotOauth` |
| `getGeminiModels` | `getCopilotModels` |
| `getCustomGeminiModels` | `getCustomCopilotModels` |
| `addCustomGeminiModel` | `addCustomCopilotModel` |
| `removeCustomGeminiModel` | `removeCustomCopilotModel` |
| CardTitle "Google Gemini" | "GitHub Copilot" |
| CardDescription subtext | "Use your GitHub Copilot subscription for AI features" |
| "API Key" button label | "GitHub Token" |
| "Google Account" button label | "GitHub (Device Flow)" |
| placeholder `"AIza…"` | `"ghp_… or gho_…"` |
| "aistudio.google.com/apikey" help-link | "github.com/settings/tokens" |
| "Connect with Google" button | "Connect with GitHub" |

Adjust the OAuth-path copy to explain the **device-flow UX**:
> "A browser window will open on github.com/login/device. The one-time code
> has been copied to your clipboard — paste it and approve to finish sign-in."

**f)** Wire it into the provider stack (line ~3154). Insert right after the
`<GeminiSection …/>`:

```tsx
<CopilotSection
  isConfigured={credStatus.copilotApiKey}
  onSaved={refreshStatus}
/>
```

---

### Step 13 — Build & sanity-check

Run in this order, stopping at the first failure and fixing it:

```bash
pnpm tauri dev           # Rust backend rebuilds; TypeScript compiles; app launches
```

Verify in the running app:

1. Settings screen shows a new **GitHub Copilot** card with `API Key` and
   `Device Flow` tabs.
2. `Connect with GitHub` opens the browser to github.com/login/device with
   the user code copied to clipboard.
3. After approving, the card shows a success toast and the model picker
   populates.
4. Pick a model, click `Send test message` — it should return a reply.
5. In `AI Provider Priority`, Copilot is a drag item and "Copilot only" is
   selectable.
6. Select "Copilot only" and run any Meridian workflow (e.g. standup
   briefing) — it should succeed end-to-end.

---

## 3. Testing hints

Add unit tests in `src-tauri/src/llms/copilot.rs` under `#[cfg(test)]` for:

- `history_to_copilot_messages` — empty system, empty history, mixed roles.
- JSON parsing of a canned streaming SSE body (ensure `[DONE]` terminates
  cleanly and deltas accumulate in order).

Do **not** add integration tests that require a live Copilot token.

---

## 4. Known pitfalls — read before coding

1. **Do not** request OAuth scopes beyond `read:user`. Copilot authorization
   is tied to the account, not to a scope. Wider scopes trigger extra
   consent screens and user friction.
2. **Do not** pre-bake a GitHub OAuth `client_secret`. The device flow uses
   a public client (`Iv1.b507a08c87ecfe98`) — there is no secret.
3. The Copilot token (`copilot_api_key`) expires every ~30 min. Every
   dispatch path **must** call `refresh_copilot_token_if_needed(client)`
   first. Omitting this is the #1 cause of intermittent 401s.
4. The `Copilot-Integration-Id` header is **required**. Requests without it
   are rejected with 400.
5. `api.githubcopilot.com/chat/completions` is OpenAI-compatible but
   **not** the same as `api.openai.com`. Do not rebase this against an
   OpenAI provider — keep it as its own `copilot` module.
6. The streaming endpoint emits SSE lines with `data: {…}` / `data: [DONE]`.
   Handle `[DONE]` as a terminator before attempting to parse it as JSON.
7. On model listing: older subscriptions return 404 for `/models`. The
   `get_copilot_models` fallback to `COPILOT_BUILTIN_MODELS` handles this;
   don't bubble the 404 up.
8. Never log the `copilot_api_key` value — only log presence (`token.len() > 0`).

---

## 5. Out of scope (do NOT implement)

- GitHub Models API (`models.github.ai/inference`) as a separate provider —
  that's a different GitHub product and doubles the surface area.
- Sidecar integration (`src-sidecar/src/`) — Copilot is HTTP-only, no
  sidecar needed. All calls happen in the Rust backend.
- Native tool-use/agentic loop for Copilot. Copilot's OpenAI-compatible
  endpoint does support function calling, but Meridian's existing fallback
  through `complete_multi_text_tool_loop` is sufficient for v1.
- Billing/rate-limit header parsing. Copilot's rate-limit response headers
  differ from Anthropic's. v1 can surface the raw 429 body and let the
  existing `is_quota_error` check trigger the fallback chain.

---

## 6. Summary checklist

- [ ] `src-tauri/src/llms/copilot.rs` created with all helpers.
- [ ] `src-tauri/src/llms/mod.rs` lists `pub mod copilot;`.
- [ ] `validate.rs` has `start_copilot_oauth` + `ping_copilot`.
- [ ] `credentials.rs` allowlist & `CredentialStatus` updated.
- [ ] `commands/mod.rs` re-exports new commands.
- [ ] `lib.rs` imports + registers in `invoke_handler!`.
- [ ] `agents/dispatch.rs` has `copilot` arms and `DEFAULT_ORDER` updated.
- [ ] `src/lib/tauri.ts` has typed wrappers + `copilotApiKey` in status.
- [ ] `SettingsScreen.tsx` has `CopilotSection` + provider-picker updates.
- [ ] `pnpm tauri dev` boots clean.
- [ ] Device-flow connect + ping verified in-app.
- [ ] Dispatch chain exercises Copilot end-to-end on at least one workflow.
