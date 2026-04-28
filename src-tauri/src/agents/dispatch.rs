use crate::llms::claude;
use crate::llms::gemini;
use crate::llms::local_llm;
use crate::storage::credentials::get_credential;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

/// "claude" | "gemini" | "local" | "auto"  (default: "auto" = Claude first, Gemini on quota error)
pub fn get_ai_provider() -> String {
    crate::storage::preferences::get_pref("ai_provider")
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "auto".to_string())
}

/// Returns the user-configured fallback order, e.g. ["claude", "gemini", "local"].
pub fn get_provider_order() -> Vec<String> {
    let raw = crate::storage::preferences::get_pref("ai_provider_order").unwrap_or_default();
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

// ── Per-panel / per-stage AI override resolution ──────────────────────────────

/// One override entry: which provider+model to use for a given panel or stage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiOverride {
    pub provider: String,
    pub model: String,
}

/// Identifies the panel (and optionally the stage within it) that an LLM call
/// originates from. Used to look up per-panel and per-stage overrides.
#[derive(Default, Debug, Clone)]
pub struct AiContext {
    pub panel: Option<String>,
    pub stage: Option<String>,
}

impl AiContext {
    pub fn panel(panel: &str) -> Self {
        Self { panel: Some(panel.to_string()), stage: None }
    }

    pub fn stage(panel: &str, stage: &str) -> Self {
        Self { panel: Some(panel.to_string()), stage: Some(stage.to_string()) }
    }
}

fn parse_overrides_map(key: &str) -> HashMap<String, AiOverride> {
    let raw = crate::storage::preferences::get_pref(key).unwrap_or_default();
    if raw.trim().is_empty() {
        return HashMap::new();
    }
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn get_panel_override(panel: &str) -> Option<AiOverride> {
    parse_overrides_map("panel_ai_overrides").remove(panel)
}

pub fn get_stage_override(stage: &str) -> Option<AiOverride> {
    parse_overrides_map("stage_ai_overrides").remove(stage)
}

/// The provider list and per-provider model map to use for a given context.
#[derive(Debug, Clone)]
pub struct ResolvedAi {
    /// Providers to try in order. Length 1 when global priority is locked.
    pub providers: Vec<String>,
    /// Provider → model overrides resolved from stage/panel preferences.
    pub model_for: HashMap<String, String>,
}

/// Resolves the effective provider list and per-provider model overrides for
/// the given context, applying these rules:
///
/// - Global priority locked (`ai_provider` != `"auto"`) wins: only the locked
///   provider is tried. The model comes from a stage/panel override _only_ if
///   that override's provider matches the locked one — otherwise the locked
///   provider's default model is used.
/// - Otherwise (auto): a stage override's provider is preferred, falling back
///   to a panel override's provider, falling back to the configured order.
///   The preferred provider is tried first; remaining providers in the order
///   form the fallback chain. Model overrides for each provider are folded in.
pub fn resolve(ctx: &AiContext) -> ResolvedAi {
    let global = get_ai_provider();
    let order = get_provider_order();

    let stage_ov = ctx.stage.as_deref().and_then(get_stage_override);
    let panel_ov = ctx.panel.as_deref().and_then(get_panel_override);

    let mut model_for: HashMap<String, String> = HashMap::new();

    if global != "auto" {
        // Locked. Only honour overrides whose provider matches the locked one.
        if let Some(s) = stage_ov.as_ref() {
            if s.provider == global {
                model_for.insert(global.clone(), s.model.clone());
            }
        }
        if !model_for.contains_key(&global) {
            if let Some(p) = panel_ov.as_ref() {
                if p.provider == global {
                    model_for.insert(global.clone(), p.model.clone());
                }
            }
        }
        return ResolvedAi { providers: vec![global], model_for };
    }

    // Auto. Stage override wins over panel override for the preferred provider
    // and for the model of that provider.
    let preferred = stage_ov
        .as_ref()
        .map(|o| o.provider.clone())
        .or_else(|| panel_ov.as_ref().map(|o| o.provider.clone()));

    if let Some(s) = stage_ov.as_ref() {
        model_for.insert(s.provider.clone(), s.model.clone());
    }
    if let Some(p) = panel_ov.as_ref() {
        model_for.entry(p.provider.clone()).or_insert_with(|| p.model.clone());
    }

    let providers = if let Some(pref) = preferred {
        let mut v = vec![pref.clone()];
        for p in order {
            if p != pref {
                v.push(p);
            }
        }
        v
    } else {
        order
    };

    ResolvedAi { providers, model_for }
}

/// Resolves the model to use for a given provider in a given context. Returns
/// the provider's user-configured default model (e.g. `claude::get_active_model()`)
/// when there is no panel/stage override for it.
pub fn model_for_provider(provider: &str, ctx: &AiContext) -> String {
    if let Some(m) = resolve(ctx).model_for.get(provider) {
        return m.clone();
    }
    match provider {
        "claude" => claude::get_active_model(),
        "gemini" => crate::storage::preferences::get_pref("gemini_model")
            .or_else(|| get_credential("gemini_model"))
            .unwrap_or_default(),
        "copilot" => crate::storage::preferences::get_pref("copilot_model")
            .or_else(|| get_credential("copilot_model"))
            .unwrap_or_default(),
        "local" => local_llm::get_local_llm_model().unwrap_or_default(),
        _ => String::new(),
    }
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
    let client = make_corporate_client(Duration::from_secs(60), false)?;
    let api_key = get_credential("anthropic_api_key").unwrap_or_default();
    Ok((client, api_key))
}

pub async fn try_provider_single(
    app: &tauri::AppHandle,
    provider: &str,
    client: &Client,
    claude_key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
    ctx: &AiContext,
) -> Result<String, String> {
    match provider {
        "claude" => {
            let auth_method =
                get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
            let model = model_for_provider("claude", ctx);
            let model = if model.is_empty() { claude::get_active_model() } else { model };
            if auth_method == "oauth" {
                claude::refresh_oauth_if_needed(client).await?;
                let fresh_key = get_credential("anthropic_api_key").unwrap_or_default();
                return claude::complete(
                    client,
                    &fresh_key,
                    &model,
                    system,
                    user,
                    max_tokens,
                    |_, _| {},
                )
                .await;
            }
            if claude_key.is_empty() {
                Err("not configured".to_string())
            } else {
                claude::complete(
                    client,
                    claude_key,
                    &model,
                    system,
                    user,
                    max_tokens,
                    |_, _| {},
                )
                .await
            }
        }
        "gemini" => {
            let key = get_credential("gemini_api_key")
                .ok_or_else(|| "Gemini: not configured.".to_string())?;
            let model = model_for_provider("gemini", ctx);
            if model.trim().is_empty() {
                return Err("Gemini: no model selected in Settings.".to_string());
            }
            gemini::complete_gemini(client, &key, &model, system, user, max_tokens).await
        }
        "copilot" => {
            let token = get_credential("copilot_api_key")
                .ok_or_else(|| "Copilot: not configured.".to_string())?;
            let model = model_for_provider("copilot", ctx);
            if model.trim().is_empty() {
                return Err("Copilot: no model selected in Settings.".to_string());
            }
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
            let model = model_for_provider("local", ctx);
            if model.trim().is_empty() {
                return Err("Local LLM: no model selected.".to_string());
            }
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
    ctx: &AiContext,
) -> Result<String, String> {
    match provider {
        "claude" => {
            let auth_method =
                get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
            if auth_method == "oauth" {
                claude::refresh_oauth_if_needed(client).await?;
            }
            let key = get_credential("anthropic_api_key").unwrap_or_else(|| claude_key.to_string());
            if key.is_empty() {
                Err("not configured".to_string())
            } else {
                let model = model_for_provider("claude", ctx);
                let model = if model.is_empty() { claude::get_active_model() } else { model };
                claude::complete_multi(
                    client,
                    &key,
                    &model,
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
            let model = model_for_provider("gemini", ctx);
            if model.trim().is_empty() {
                return Err("Gemini: no model selected in Settings.".to_string());
            }
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
            let model = model_for_provider("copilot", ctx);
            if model.trim().is_empty() {
                return Err("Copilot: no model selected in Settings.".to_string());
            }
            if let Err(e) = crate::llms::copilot::refresh_copilot_token_if_needed(client).await {
                return Err(format!("Copilot token refresh failed: {e}"));
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
            let base = local_llm::local_llm_base_url()
                .ok_or_else(|| "Local LLM: not configured.".to_string())?;
            let model = model_for_provider("local", ctx);
            if model.trim().is_empty() {
                return Err("Local LLM: no model selected.".to_string());
            }
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
    ctx: &AiContext,
) -> Result<String, String> {
    let resolved = resolve(ctx);
    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &resolved.providers {
        match try_provider_single(app, p, client, claude_key, system, user, max_tokens, ctx).await {
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
    ctx: &AiContext,
) -> Result<String, String> {
    let providers_to_try: Vec<String> = resolve(ctx).providers;

    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &providers_to_try {
        let result = match p.as_str() {
            "claude" => {
                let auth_method =
                    get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
                if auth_method == "oauth" {
                    claude::refresh_oauth_if_needed(client).await?;
                }
                let key =
                    get_credential("anthropic_api_key").unwrap_or_else(|| claude_key.to_string());
                if key.is_empty() {
                    Err("not configured".to_string())
                } else {
                    let model = model_for_provider("claude", ctx);
                    let model = if model.is_empty() { claude::get_active_model() } else { model };
                    claude::complete_claude_streaming(
                        app,
                        client,
                        &key,
                        &model,
                        system,
                        user,
                        max_tokens,
                        stream_event,
                    )
                    .await
                }
            }
            "gemini" => {
                let key = match get_credential("gemini_api_key") {
                    Some(k) if !k.trim().is_empty() => k,
                    _ => {
                        failure_reasons.push("Gemini: not configured".to_string());
                        continue;
                    }
                };
                let model = model_for_provider("gemini", ctx);
                if model.trim().is_empty() {
                    failure_reasons.push("Gemini: no model selected in Settings.".to_string());
                    continue;
                }
                gemini::complete_gemini_streaming(
                    app,
                    client,
                    &key,
                    &model,
                    system,
                    user,
                    max_tokens,
                    stream_event,
                )
                .await
            }
            "copilot" => {
                let token = match get_credential("copilot_api_key") {
                    Some(t) if !t.trim().is_empty() => t,
                    _ => {
                        failure_reasons.push("Copilot: not configured".to_string());
                        continue;
                    }
                };
                let model = model_for_provider("copilot", ctx);
                if model.trim().is_empty() {
                    failure_reasons.push("Copilot: no model selected in Settings.".to_string());
                    continue;
                }
                if let Err(e) = crate::llms::copilot::refresh_copilot_token_if_needed(client).await
                {
                    failure_reasons.push(format!("copilot: {e}"));
                    continue;
                }
                let token = get_credential("copilot_api_key").unwrap_or(token);
                crate::llms::copilot::complete_copilot_streaming(
                    app,
                    client,
                    &token,
                    &model,
                    system,
                    user,
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
                let model = model_for_provider("local", ctx);
                if model.trim().is_empty() {
                    failure_reasons.push("Local LLM: no model selected".to_string());
                    continue;
                }
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
            p => try_provider_single(app, p, client, claude_key, system, user, max_tokens, ctx).await,
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
    ctx: &AiContext,
) -> Result<String, String> {
    let providers_to_try: Vec<String> = resolve(ctx).providers;

    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &providers_to_try {
        let result = match p.as_str() {
            "claude" => {
                let auth_method =
                    get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
                if auth_method == "oauth" {
                    claude::refresh_oauth_if_needed(client).await?;
                }
                let key =
                    get_credential("anthropic_api_key").unwrap_or_else(|| claude_key.to_string());
                if key.is_empty() {
                    Err("not configured".to_string())
                } else {
                    let model = model_for_provider("claude", ctx);
                    let model = if model.is_empty() { claude::get_active_model() } else { model };
                    claude::complete_multi_claude_streaming(
                        app,
                        client,
                        &key,
                        &model,
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
                let model = model_for_provider("copilot", ctx);
                if model.trim().is_empty() {
                    failure_reasons.push("Copilot: no model selected".to_string());
                    continue;
                }
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
                let model = model_for_provider("local", ctx);
                if model.trim().is_empty() {
                    failure_reasons.push("Local LLM: no model selected".to_string());
                    continue;
                }
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
                    ctx,
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
    ctx: &AiContext,
) -> Result<String, String> {
    let providers_to_try: Vec<String> = resolve(ctx).providers;

    let mut failure_reasons: Vec<String> = Vec::new();

    for p in &providers_to_try {
        let result = match p.as_str() {
            "claude" => {
                let auth_method =
                    get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
                if auth_method == "oauth" {
                    claude::refresh_oauth_if_needed(client).await?;
                }
                let key =
                    get_credential("anthropic_api_key").unwrap_or_else(|| claude_key.to_string());
                if key.is_empty() {
                    Err("not configured".to_string())
                } else {
                    let model = model_for_provider("claude", ctx);
                    let model = if model.is_empty() { claude::get_active_model() } else { model };
                    claude::complete_multi_claude_tool_loop(
                        app,
                        client,
                        &key,
                        &model,
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
                    ctx,
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
