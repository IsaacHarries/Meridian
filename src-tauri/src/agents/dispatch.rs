use crate::llms::claude;
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
