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
    complete(&client, &api_key, &get_active_model(), system, &user, 1500).await
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
    complete(&client, &api_key, &get_active_model(), system, &user, 1500).await
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
    complete_multi(&client, &api_key, &get_active_model(), &system, &history_json, 800).await
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
    complete(&client, &api_key, &get_active_model(), &system, &user, 2000).await
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
    complete(&client, &api_key, &get_active_model(), system, &user, 2000).await
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
    complete(&client, &api_key, &get_active_model(), system, &user, 1500).await
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
    complete(&client, &api_key, &get_active_model(), system, &user, 1500).await
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
    complete(&client, &api_key, &get_active_model(), system, &user, 2000).await
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
    complete(&client, &api_key, &get_active_model(), system, &user, 1500).await
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

    complete(&client, &api_key, &get_active_model(), system, &user, 4000).await
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

    complete(&client, &api_key, &get_active_model(), system, &user, 1024).await
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

    complete(&client, &api_key, &get_active_model(), system, &user, 1500).await
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

    complete(&client, &api_key, &get_active_model(), system, &user, 1024).await
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

    complete(&client, &api_key, &get_active_model(), system, &user, 1024).await
}
