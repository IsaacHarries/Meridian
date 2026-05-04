use crate::llms::claude;
use crate::llms::local_llm;
use crate::storage::credentials::get_credential;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

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

/// Default provider used by panels/stages with no explicit override.
/// Persisted under `ai_default_provider` (set during onboarding the first
/// time a provider is authenticated, and editable in Settings → Default
/// model). Returns None when nothing is set; callers surface that as a
/// "configure a default model" error rather than picking one for the user.
pub fn get_default_provider() -> Option<String> {
    crate::storage::preferences::get_pref("ai_default_provider")
        .filter(|p| !p.trim().is_empty())
}

/// Default model paired with `ai_default_provider`. Returns None when
/// unset — callers fall through to the per-provider model preference
/// (`claude_model`, `gemini_model`, …) so a partially-configured default
/// still surfaces *some* model rather than failing.
pub fn get_default_model() -> Option<String> {
    crate::storage::preferences::get_pref("ai_default_model")
        .filter(|m| !m.trim().is_empty())
}

/// One resolved (provider, model) pair for a workflow dispatch.
///
/// There is no longer a fallback chain — earlier versions of the app
/// returned `Vec<String>` so the sidecar could try multiple providers on
/// quota errors, but the user-facing model is now "you pick one provider
/// per panel/stage; if it isn't authenticated the header badges it". The
/// type stays a struct (rather than a tuple) so adding a third field
/// later (e.g. credentials, request budget) doesn't ripple.
#[derive(Debug, Clone)]
pub struct ResolvedAi {
    pub provider: String,
    pub model: String,
}

/// Resolve the effective provider+model for a context.
///
/// Lookup order: stage override → panel override → global default. The
/// global default itself uses `ai_default_provider` + `ai_default_model`
/// when set; if those are missing it falls back to the earliest provider
/// that has a saved per-provider model so a half-configured app still
/// produces *some* answer rather than silently picking Claude.
pub fn resolve(ctx: &AiContext) -> ResolvedAi {
    if let Some(s) = ctx.stage.as_deref().and_then(get_stage_override) {
        return ResolvedAi { provider: s.provider, model: s.model };
    }
    if let Some(p) = ctx.panel.as_deref().and_then(get_panel_override) {
        return ResolvedAi { provider: p.provider, model: p.model };
    }
    if let Some(provider) = get_default_provider() {
        let model = get_default_model()
            .unwrap_or_else(|| model_for_provider_default(&provider));
        return ResolvedAi { provider, model };
    }
    // Fallback: scan known providers for any saved per-provider model.
    // The sidecar will reject an empty model with a clear error if even
    // this turns up nothing — that's the right surface for "user hasn't
    // finished onboarding".
    for p in ["claude", "gemini", "copilot", "local"] {
        let model = model_for_provider_default(p);
        if !model.is_empty() {
            return ResolvedAi { provider: p.to_string(), model };
        }
    }
    ResolvedAi { provider: String::new(), model: String::new() }
}

fn model_for_provider_default(provider: &str) -> String {
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

/// Resolve the model to use for a given provider in a given context. Used
/// by code paths that already know which provider they want (e.g. when a
/// command pre-selects a provider) and just need the matching model id.
pub fn model_for_provider(provider: &str, ctx: &AiContext) -> String {
    if let Some(s) = ctx.stage.as_deref().and_then(get_stage_override) {
        if s.provider == provider {
            return s.model;
        }
    }
    if let Some(p) = ctx.panel.as_deref().and_then(get_panel_override) {
        if p.provider == provider {
            return p.model;
        }
    }
    if let Some(def_provider) = get_default_provider() {
        if def_provider == provider {
            if let Some(m) = get_default_model() {
                return m;
            }
        }
    }
    model_for_provider_default(provider)
}

pub async fn llm_client() -> Result<(Client, String), String> {
    use crate::http::make_corporate_client;
    let client = make_corporate_client(Duration::from_secs(60), false)?;
    let api_key = get_credential("anthropic_api_key").unwrap_or_default();
    Ok((client, api_key))
}
