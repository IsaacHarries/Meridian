use crate::llms::claude;
use crate::llms::gemini;
use crate::llms::local_llm;
use crate::storage::credentials::get_credential;
use reqwest::Client;
use std::time::Duration;

/// "claude" | "gemini" | "local" | "auto"  (default: "auto" = Claude first, Gemini on quota error)
pub fn get_ai_provider() -> String {
    get_credential("ai_provider")
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "auto".to_string())
}

/// Returns the user-configured fallback order, e.g. ["claude", "gemini", "local"].
pub fn get_provider_order() -> Vec<String> {
    let raw = get_credential("ai_provider_order").unwrap_or_default();
    if raw.trim().is_empty() {
        return vec![
            "claude".to_string(),
            "gemini".to_string(),
            "copilot".to_string(),
            "local".to_string(),
        ];
    }
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Returns true when an error string indicates the Claude quota / rate limit was
/// exceeded and it is worth trying a Gemini fallback.
pub fn is_quota_error(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("429")
        || e.contains("rate_limit")
        || e.contains("overloaded")
        || e.contains("you've hit your limit")
        || e.contains("hit your limit")
        || e.contains("usage_exceeded")
        || e.contains("usage limit")
        || e.contains("quota")
        || e.contains("credit balance")
        || e.contains("daily message limit")
}

pub async fn llm_client() -> Result<(Client, String), String> {
    use crate::http::make_corporate_client;
    let client = make_corporate_client(Duration::from_secs(60))?;
    let auth_method = get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
    if auth_method == "oauth" {
        claude::refresh_oauth_if_needed(&client).await?;
    }
    let api_key = get_credential("anthropic_api_key").unwrap_or_default();
    Ok((client, api_key))
}

pub async fn try_provider_single(
    _app: &tauri::AppHandle,
    provider: &str,
    client: &Client,
    claude_key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    match provider {
        "claude" => {
            if claude_key.is_empty() {
                Err("not configured".to_string())
            } else {
                claude::complete(
                    client,
                    claude_key,
                    &claude::get_active_model(),
                    system,
                    user,
                    max_tokens,
                )
                .await
            }
        }
        "gemini" => {
            let key = get_credential("gemini_api_key")
                .ok_or_else(|| "Gemini: not configured.".to_string())?;
            let model = crate::storage::preferences::get_pref("gemini_model")
                .or_else(|| get_credential("gemini_model"))
                .filter(|m: &String| !m.trim().is_empty())
                .ok_or_else(|| "Gemini: no model selected in Settings.".to_string())?;
            gemini::complete_gemini(client, &key, &model, system, user, max_tokens).await
        }
        "copilot" => {
            let token = get_credential("copilot_api_key")
                .ok_or_else(|| "Copilot: not configured.".to_string())?;
            let model = crate::storage::preferences::get_pref("copilot_model")
                .or_else(|| get_credential("copilot_model"))
                .filter(|m| !m.trim().is_empty())
                .ok_or_else(|| "Copilot: no model selected in Settings.".to_string())?;
            if let Err(e) = crate::llms::copilot::refresh_copilot_token_if_needed(client).await {
                return Err(format!("Copilot token refresh failed: {e}"));
            }
            let token = get_credential("copilot_api_key").unwrap_or(token);
            crate::llms::copilot::complete_copilot(client, &token, &model, system, user, max_tokens)
                .await
        }
        "local" => {
            let base = local_llm::local_llm_base_url()
                .ok_or_else(|| "Local LLM: not configured.".to_string())?;
            let model = local_llm::get_local_llm_model()
                .ok_or_else(|| "Local LLM: no model selected.".to_string())?;
            let key = get_credential("local_llm_api_key");
            local_llm::complete_local(&base, key.as_deref(), &model, system, user, max_tokens).await
        }
        p => Err(format!("Unknown provider: {p}")),
    }
}

pub async fn try_provider_multi(
    app: &tauri::AppHandle,
    provider: &str,
    client: &Client,
    claude_key: &str,
    system: &str,
    history_json: &str,
    max_tokens: u32,
    stream_event: &str,
) -> Result<String, String> {
    match provider {
        "claude" => {
            if claude_key.is_empty() {
                Err("not configured".to_string())
            } else {
                claude::complete_multi(
                    client,
                    claude_key,
                    &claude::get_active_model(),
                    system,
                    history_json,
                    max_tokens,
                )
                .await
            }
        }
        "gemini" => {
            let key = get_credential("gemini_api_key")
                .ok_or_else(|| "Gemini: not configured.".to_string())?;
            let model = crate::storage::preferences::get_pref("gemini_model")
                .or_else(|| get_credential("gemini_model"))
                .filter(|m: &String| !m.trim().is_empty())
                .ok_or_else(|| "Gemini: no model selected in Settings.".to_string())?;
            let history: Vec<serde_json::Value> = serde_json::from_str(history_json)
                .map_err(|e| format!("Invalid history JSON: {e}"))?;
            gemini::complete_multi_gemini(
                app,
                client,
                &key,
                &model,
                system,
                &history,
                max_tokens,
                stream_event,
            )
            .await
        }
        "copilot" => {
            let token = get_credential("copilot_api_key")
                .ok_or_else(|| "Copilot: not configured.".to_string())?;
            let model = crate::storage::preferences::get_pref("copilot_model")
                .or_else(|| get_credential("copilot_model"))
                .filter(|m| !m.trim().is_empty())
                .ok_or_else(|| "Copilot: no model selected in Settings.".to_string())?;
            if let Err(e) = crate::llms::copilot::refresh_copilot_token_if_needed(client).await {
                return Err(format!("Copilot token refresh failed: {e}"));
            }
            let token = get_credential("copilot_api_key").unwrap_or(token);
            let history: Vec<serde_json::Value> = serde_json::from_str(history_json)
                .map_err(|e| format!("Invalid history JSON: {e}"))?;
            crate::llms::copilot::complete_multi_copilot(
                client, &token, &model, system, &history, max_tokens,
            )
            .await
        }
        "local" => {
            let base = local_llm::local_llm_base_url()
                .ok_or_else(|| "Local LLM: not configured.".to_string())?;
            let model = local_llm::get_local_llm_model()
                .ok_or_else(|| "Local LLM: no model selected.".to_string())?;
            let key = get_credential("local_llm_api_key");
            let history: Vec<serde_json::Value> = serde_json::from_str(history_json)
                .map_err(|e| format!("Invalid history JSON: {e}"))?;
            local_llm::complete_multi_local(
                &base,
                key.as_deref(),
                &model,
                system,
                &history,
                max_tokens,
            )
            .await
        }
        p => Err(format!("Unknown provider: {p}")),
    }
}

pub async fn dispatch(
    app: &tauri::AppHandle,
    client: &Client,
    claude_key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let provider = get_ai_provider();

    if provider != "auto" {
        return try_provider_single(app, &provider, client, claude_key, system, user, max_tokens)
            .await;
    }

    let order = get_provider_order();
    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &order {
        match try_provider_single(app, p, client, claude_key, system, user, max_tokens).await {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                failure_reasons.push(format!("{p}: not configured"));
            }
            Err(e) if is_quota_error(&e) => {
                failure_reasons.push(format!("{p}: rate limited / quota exceeded — {e}"));
            }
            Err(e) => return Err(e),
        }
    }

    let summary = if failure_reasons.is_empty() {
        "No providers configured.".to_string()
    } else {
        failure_reasons.join("; ")
    };
    Err(format!("All providers failed — {summary}"))
}

pub async fn dispatch_streaming(
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
                if claude_key.is_empty() {
                    Err("not configured".to_string())
                } else {
                    claude::complete_claude_streaming(
                        app,
                        client,
                        claude_key,
                        &claude::get_active_model(),
                        system,
                        user,
                        max_tokens,
                        stream_event,
                    )
                    .await
                }
            }
            "local" => {
                let base = match local_llm::local_llm_base_url() {
                    Some(b) => b,
                    None => {
                        failure_reasons.push("Local LLM: not configured".to_string());
                        continue;
                    }
                };
                let model = match local_llm::get_local_llm_model() {
                    Some(m) => m,
                    None => {
                        failure_reasons.push("Local LLM: no model selected".to_string());
                        continue;
                    }
                };
                let key = get_credential("local_llm_api_key");
                local_llm::complete_local_streaming(
                    app,
                    &base,
                    key.as_deref(),
                    &model,
                    system,
                    user,
                    max_tokens,
                    stream_event,
                )
                .await
            }
            p => try_provider_single(app, p, client, claude_key, system, user, max_tokens).await,
        };

        match result {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                failure_reasons.push(format!("{p}: not configured"));
            }
            Err(e) if is_quota_error(&e) => {
                failure_reasons.push(format!("{p}: rate limited / quota exceeded — {e}"));
            }
            Err(e) => return Err(e),
        }
    }

    let summary = failure_reasons.join("; ");
    Err(format!("All providers failed — {summary}"))
}

pub async fn dispatch_multi_streaming(
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
                if claude_key.is_empty() {
                    Err("not configured".to_string())
                } else {
                    claude::complete_multi_claude_streaming(
                        app,
                        client,
                        claude_key,
                        &claude::get_active_model(),
                        system,
                        history_json,
                        max_tokens,
                        stream_event,
                    )
                    .await
                }
            }
            "copilot" => {
                let token = match get_credential("copilot_api_key") {
                    Some(t) if !t.trim().is_empty() => t,
                    _ => {
                        failure_reasons.push("Copilot: not configured".to_string());
                        continue;
                    }
                };
                let model = match crate::storage::preferences::get_pref("copilot_model")
                    .or_else(|| get_credential("copilot_model"))
                    .filter(|m| !m.trim().is_empty())
                {
                    Some(m) => m,
                    None => {
                        failure_reasons.push("Copilot: no model selected".to_string());
                        continue;
                    }
                };
                if let Err(e) = crate::llms::copilot::refresh_copilot_token_if_needed(client).await
                {
                    failure_reasons.push(format!("copilot: {e}"));
                    continue;
                }
                let token = get_credential("copilot_api_key").unwrap_or(token);
                let history: Vec<serde_json::Value> = serde_json::from_str(history_json)
                    .map_err(|e| format!("Invalid history JSON: {e}"))?;
                crate::llms::copilot::complete_multi_copilot_streaming(
                    app,
                    client,
                    &token,
                    &model,
                    system,
                    &history,
                    max_tokens,
                    stream_event,
                )
                .await
            }
            "local" => {
                let base = match local_llm::local_llm_base_url() {
                    Some(b) => b,
                    None => {
                        failure_reasons.push("Local LLM: not configured".to_string());
                        continue;
                    }
                };
                let model = match local_llm::get_local_llm_model() {
                    Some(m) => m,
                    None => {
                        failure_reasons.push("Local LLM: no model selected".to_string());
                        continue;
                    }
                };
                let key = get_credential("local_llm_api_key");
                let history: Vec<serde_json::Value> = serde_json::from_str(history_json)
                    .map_err(|e| format!("Invalid history JSON: {e}"))?;
                local_llm::complete_multi_local_streaming(
                    app,
                    &base,
                    key.as_deref(),
                    &model,
                    system,
                    &history,
                    max_tokens,
                    stream_event,
                )
                .await
            }
            p => {
                try_provider_multi(
                    app,
                    p,
                    client,
                    claude_key,
                    system,
                    history_json,
                    max_tokens,
                    stream_event,
                )
                .await
            }
        };

        match result {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                failure_reasons.push(format!("{p}: not configured"));
            }
            Err(e) if is_quota_error(&e) => {
                failure_reasons.push(format!("{p}: rate limited / quota exceeded — {e}"));
            }
            Err(e) => return Err(e),
        }
    }

    let summary = failure_reasons.join("; ");
    Err(format!("All providers failed — {summary}"))
}

pub async fn dispatch_multi_streaming_with_tools(
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
                if claude_key.is_empty() {
                    Err("not configured".to_string())
                } else {
                    claude::complete_multi_claude_tool_loop(
                        app,
                        client,
                        claude_key,
                        &claude::get_active_model(),
                        system,
                        history_json,
                        max_tokens,
                        stream_event,
                    )
                    .await
                }
            }
            other => {
                claude::complete_multi_text_tool_loop(
                    app,
                    client,
                    claude_key,
                    other,
                    system,
                    history_json,
                    max_tokens,
                    stream_event,
                )
                .await
            }
        };

        match result {
            Ok(r) => return Ok(r),
            Err(e) if e.contains("not configured") || e.contains("no model") => {
                failure_reasons.push(format!("{p}: not configured"));
            }
            Err(e) if is_quota_error(&e) => {
                failure_reasons.push(format!("{p}: rate limited / quota exceeded — {e}"));
            }
            Err(e) => return Err(e),
        }
    }

    let summary = failure_reasons.join("; ");
    Err(format!("All providers failed — {summary}"))
}
