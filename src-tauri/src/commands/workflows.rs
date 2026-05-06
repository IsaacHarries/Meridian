// Tauri commands that dispatch LangGraph workflows to the TypeScript sidecar.
//
// Each command resolves the active provider+model for the given panel/stage
// context (using the existing per-panel/per-stage override resolver), reads
// credentials from the keychain (refreshing OAuth tokens / ensuring Gemini
// CodeAssist project IDs as required), builds a ModelSelection, invokes
// `integrations::sidecar::run_workflow`, and returns the final structured
// output to the frontend.

use std::time::Duration;

use crate::agents::dispatch::{self, AiContext};
use crate::commands::grooming_templates::read_grooming_template;
use crate::http::make_corporate_client;
use crate::integrations::sidecar::{
    AnthropicCreds, CopilotCreds, GoogleCreds, ModelSelection, OllamaCreds, ProviderCredentials,
    SidecarState, WorkflowResult,
};
use crate::llms::claude::refresh_oauth_if_needed as refresh_claude_oauth_if_needed;
use crate::llms::copilot::refresh_copilot_token_if_needed;
use crate::llms::gemini::{ensure_gemini_codeassist_project, refresh_gemini_oauth_if_needed};
use crate::storage::credentials::get_credential;

/// Map Meridian's internal provider names ("claude", "gemini", "local",
/// "copilot") to the sidecar's normalised names ("anthropic", "google",
/// "ollama", "copilot").
pub fn to_sidecar_provider(internal: &str) -> Result<&'static str, String> {
    match internal {
        "claude" => Ok("anthropic"),
        "gemini" => Ok("google"),
        "copilot" => Ok("copilot"),
        "local" => Ok("ollama"),
        other => Err(format!("Unknown internal provider: {other}")),
    }
}

pub async fn resolve_credentials(provider: &str) -> Result<ProviderCredentials, String> {
    match provider {
        "anthropic" => {
            let token = get_credential("anthropic_api_key")
                .ok_or_else(|| "Anthropic credential not configured".to_string())?;
            if token.starts_with("sk-ant-api") {
                Ok(ProviderCredentials::Anthropic(AnthropicCreds::ApiKey {
                    api_key: token,
                }))
            } else {
                // OAuth bearer token (sk-ant-oat01-…) for Claude.ai subscription.
                // Refresh near-expiry tokens before passing to the sidecar — the
                // Claude.ai endpoint rejects stale tokens with "OAuth authentication
                // is currently not supported", indistinguishable from a malformed
                // request envelope at the API level.
                let client = make_corporate_client(Duration::from_secs(60), false)?;
                refresh_claude_oauth_if_needed(&client).await?;
                let fresh = get_credential("anthropic_api_key")
                    .ok_or_else(|| "Anthropic OAuth token missing after refresh".to_string())?;
                Ok(ProviderCredentials::Anthropic(AnthropicCreds::OAuth {
                    access_token: fresh,
                }))
            }
        }
        "google" => {
            let auth_method =
                get_credential("gemini_auth_method").unwrap_or_else(|| "api_key".to_string());
            if auth_method == "oauth" {
                // Refresh the access token if it's near expiry, then ensure the
                // CodeAssist project has been onboarded for this account.
                let client = make_corporate_client(Duration::from_secs(60), false)?;
                refresh_gemini_oauth_if_needed(&client).await?;
                let token = get_credential("gemini_api_key")
                    .ok_or_else(|| "Gemini OAuth access token missing".to_string())?;
                let project = ensure_gemini_codeassist_project(&client, &token).await?;
                Ok(ProviderCredentials::Google(GoogleCreds::OAuth {
                    access_token: token,
                    project: Some(project),
                }))
            } else {
                let token = get_credential("gemini_api_key")
                    .ok_or_else(|| "Gemini API key not configured".to_string())?;
                Ok(ProviderCredentials::Google(GoogleCreds::ApiKey {
                    api_key: token,
                }))
            }
        }
        "copilot" => {
            // Copilot uses an OAuth bundle that mints short-lived API tokens.
            // Refresh the API token if it's expired before passing it through.
            let client = make_corporate_client(Duration::from_secs(60), false)?;
            refresh_copilot_token_if_needed(&client).await?;
            let token = get_credential("copilot_api_key")
                .ok_or_else(|| "Copilot credential not configured".to_string())?;
            Ok(ProviderCredentials::Copilot(CopilotCreds::OAuth {
                access_token: token,
            }))
        }
        "ollama" => {
            let base_url = get_credential("local_llm_url")
                .filter(|u: &String| !u.trim().is_empty())
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            Ok(ProviderCredentials::Ollama(OllamaCreds { base_url }))
        }
        other => Err(format!("Unsupported provider for sidecar workflows: {other}")),
    }
}

/// Resolve the active provider+model for a given panel/stage context, using
/// the same logic as the rest of the app, then build a `ModelSelection`
/// payload for the sidecar.
pub async fn resolve_model_for_context(ctx: &AiContext) -> Result<ModelSelection, String> {
    let resolved = dispatch::resolve(ctx);
    if resolved.provider.trim().is_empty() {
        return Err(
            "No default AI model is configured. Set one in Settings → Models or finish onboarding."
                .to_string(),
        );
    }
    let sidecar_provider = to_sidecar_provider(&resolved.provider)?;
    if resolved.model.trim().is_empty() {
        return Err(format!(
            "No model configured for provider {}. Set one in Settings.",
            resolved.provider,
        ));
    }
    let credentials = resolve_credentials(sidecar_provider).await?;
    let max_tokens = resolve_max_output_tokens(sidecar_provider);
    Ok(ModelSelection {
        provider: sidecar_provider.to_string(),
        model: resolved.model,
        credentials,
        max_tokens,
    })
}

/// Per-provider response-token ceiling, read live on every workflow
/// dispatch so the user's Settings choice takes effect on the very
/// next call. Returns None for Ollama (the local server enforces the
/// loaded model's context window — overriding it produces confusing
/// mid-response truncation when models with different limits get
/// loaded).
fn resolve_max_output_tokens(provider: &'static str) -> Option<u32> {
    let key = match provider {
        "anthropic" => "anthropic_max_output_tokens",
        "google" => "gemini_max_output_tokens",
        "copilot" => "copilot_max_output_tokens",
        _ => return None,
    };
    crate::storage::preferences::get_pref(key)
        .and_then(|raw| raw.parse::<u32>().ok())
        .filter(|&n| n > 0)
}

#[tauri::command]
pub async fn run_grooming_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    ticket_text: String,
    file_contents: String,
    ticket_type: Option<String>,
) -> Result<WorkflowResult, String> {
    // The standalone Ticket Quality screen shows its own
    // HeaderModelPicker keyed on the `ticket_quality` panel — using
    // that panel's AI context here means the user's selection in the
    // dropdown actually drives this call, and the per-model token
    // bucket the badge displays matches the model the call ran on.
    // Pre-fix this resolved against the implement_ticket pipeline's
    // grooming stage, so a panel-level override on Ticket Quality was
    // silently ignored and tokens bucketed under the wrong model.
    let ctx = AiContext::panel("ticket_quality");
    let model = resolve_model_for_context(&ctx).await?;

    let templates = serde_json::json!({
        "acceptance_criteria": read_grooming_template(&app, "acceptance_criteria"),
        "steps_to_reproduce": read_grooming_template(&app, "steps_to_reproduce"),
    });

    let input = serde_json::json!({
        "ticketText": ticket_text,
        "fileContents": file_contents,
        "templates": templates,
        "ticketType": ticket_type,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "grooming-workflow-event",
        "grooming",
        input,
        model,
        None,
        None,
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct PipelineStartArgs {
    #[serde(rename = "ticketText")]
    ticket_text: String,
    #[serde(rename = "ticketKey")]
    ticket_key: String,
    /// JIRA issue type as the frontend sees it ("Bug", "Story", …).
    /// Threaded into the grooming node so the bug-specific rules block
    /// in the system prompt is omitted on non-bug runs.
    #[serde(rename = "ticketType", default)]
    ticket_type: Option<String>,
    #[serde(rename = "worktreePath")]
    worktree_path: String,
    #[serde(rename = "codebaseContext")]
    codebase_context: Option<String>,
    skills: Option<serde_json::Value>,
    #[serde(rename = "prTemplate")]
    pr_template: Option<serde_json::Value>,
    /// Frontend-supplied UUID for this run. Tagged on every event so the
    /// implement-ticket store can drop stale events from a prior run that
    /// the user has explicitly cancelled (via retryStage at an earlier
    /// stage). Optional for backwards-compat — falls back to a server-
    /// generated id when omitted.
    #[serde(rename = "runId", default)]
    run_id: Option<String>,
}

#[tauri::command]
pub async fn run_implementation_pipeline_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    args: PipelineStartArgs,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::stage("implement_ticket", "pipeline");
    let model = resolve_model_for_context(&ctx).await?;

    // Read the user's grooming format templates from disk and bundle them
    // into the workflow input. Mirrors `run_grooming_workflow` /
    // `run_grooming_chat_workflow` so the pipeline's grooming stage gets
    // the same template guidance the standalone grooming workflow does.
    // Pre-sidecar these were read here too; the LangGraph refactor briefly
    // expected the frontend to pass them, but no caller did, so the
    // pipeline grooming stage was running without templates.
    let grooming_templates = serde_json::json!({
        "acceptance_criteria": read_grooming_template(&app, "acceptance_criteria"),
        "steps_to_reproduce": read_grooming_template(&app, "steps_to_reproduce"),
    });

    let input = serde_json::json!({
        "ticketText": args.ticket_text,
        "ticketKey": args.ticket_key,
        "ticketType": args.ticket_type,
        "worktreePath": args.worktree_path,
        "codebaseContext": args.codebase_context.unwrap_or_default(),
        "groomingTemplates": grooming_templates,
        "skills": args.skills,
        "prTemplate": args.pr_template,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "implementation-pipeline-event",
        "implementation_pipeline",
        input,
        model,
        Some(args.worktree_path),
        args.run_id,
    )
    .await
}

#[tauri::command]
pub async fn resume_implementation_pipeline_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    thread_id: String,
    resume_value: serde_json::Value,
    #[allow(non_snake_case)] runId: Option<String>,
) -> Result<WorkflowResult, String> {
    // Refresh the OAuth token so long-running pipelines (which can span an
    // hour of triage chat + tool loops) don't 401 mid-stage. The sidecar
    // overwrites `state.model` with this fresh credential before resuming.
    let ctx = AiContext::stage("implement_ticket", "pipeline");
    let model = resolve_model_for_context(&ctx).await?;
    crate::integrations::sidecar::resume_workflow(
        &app,
        &state,
        "implementation-pipeline-event",
        thread_id,
        resume_value,
        Some(model),
        runId,
    )
    .await
}

#[tauri::command]
pub async fn rewind_implementation_pipeline_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    thread_id: String,
    to_node: String,
    #[allow(non_snake_case)] runId: Option<String>,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::stage("implement_ticket", "pipeline");
    let model = resolve_model_for_context(&ctx).await?;
    crate::integrations::sidecar::rewind_workflow(
        &app,
        &state,
        "implementation-pipeline-event",
        thread_id,
        to_node,
        Some(model),
        runId,
    )
    .await
}

/// Cancel an in-flight implementation pipeline run. Used when the user
/// explicitly invalidates a run by clicking Retry at an earlier stage —
/// the prior run's output is no longer relevant, and we want to stop
/// emitting its events so the UI doesn't jump back to a later stage when
/// the orphan run finishes. No-op if the run already completed or the
/// sidecar isn't running.
#[tauri::command]
pub async fn cancel_implementation_pipeline_workflow(
    state: tauri::State<'_, SidecarState>,
    #[allow(non_snake_case)] runId: String,
) -> Result<(), String> {
    crate::integrations::sidecar::cancel_workflow(&state, runId).await
}

#[tauri::command]
pub async fn run_pr_review_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    review_text: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("pr_review");
    let model = resolve_model_for_context(&ctx).await?;

    // Local LLMs have much smaller usable context windows than cloud providers.
    // Use the same per-provider budgets the old Rust review_pr used so chunking
    // behaviour is unchanged for users on local models. The cloud-side default
    // is user-overridable (Settings → PR Review → chunk size); local stays
    // pinned at 12k since the constraint is the model's window, not preference.
    let (chunk_chars, findings_budget) = if model.provider == "ollama" {
        (12_000u32, 4_000u32)
    } else {
        let user_chunk = crate::storage::preferences::get_pref("pr_review_default_chunk_chars")
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&v| v >= 4_000 && v <= 200_000)
            .unwrap_or(80_000);
        // Findings budget scales linearly with chunk size — the prior 80k/40k
        // ratio (0.5x) keeps the synthesis prompt within the same proportion
        // of the chunk budget at any setting.
        let findings = (user_chunk / 2).max(4_000);
        (user_chunk, findings)
    };

    // Project-specific Agent Skills are appended to the synthesis system
    // prompt in the sidecar. Pass them through the input so the sidecar stays
    // stateless w.r.t. the user's local skill set.
    let review_skill = crate::commands::skills::get_skill(&app, "review");
    let impl_skill = crate::commands::skills::get_skill(&app, "implementation");
    let mut skills_block = String::new();
    if let Some(s) = review_skill {
        skills_block.push_str("\n--- Review Standards ---\n");
        skills_block.push_str(&s);
    }
    if let Some(s) = impl_skill {
        skills_block.push_str("\n--- Implementation Standards ---\n");
        skills_block.push_str(&s);
    }

    let input = serde_json::json!({
        "reviewText": review_text,
        "chunkChars": chunk_chars,
        "findingsBudget": findings_budget,
        "skillsBlock": if skills_block.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(skills_block) },
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "pr-review-workflow-event",
        "pr_review",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_sprint_retrospective_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    sprint_text: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("retrospectives");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "sprintText": sprint_text,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "sprint-retrospective-workflow-event",
        "sprint_retrospective",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_workload_suggestions_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    workload_text: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("sprint_dashboard");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "workloadText": workload_text,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "workload-suggestions-workflow-event",
        "workload_suggestions",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_meeting_summary_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    transcript_text: String,
    current_title: String,
    current_tags_json: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("meetings");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "transcriptText": transcript_text,
        "currentTitle": current_title,
        "currentTagsJson": current_tags_json,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "meeting-summary-workflow-event",
        "meeting_summary",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_meeting_title_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    content_text: String,
    current_tags_json: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("meetings");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "contentText": content_text,
        "currentTagsJson": current_tags_json,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "meeting-title-workflow-event",
        "meeting_title",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_sprint_dashboard_chat_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    context_text: String,
    history_json: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("sprint_dashboard");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "contextText": context_text,
        "historyJson": history_json,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "sprint-dashboard-chat-workflow-event",
        "sprint_dashboard_chat",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_meeting_chat_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    context_text: String,
    history_json: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("meetings");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "contextText": context_text,
        "historyJson": history_json,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "meeting-chat-workflow-event",
        "meeting_chat",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_cross_meetings_chat_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    context_hits: serde_json::Value,
    history_json: String,
    semantic_available: bool,
) -> Result<WorkflowResult, String> {
    // Reuse the meetings panel's AI context — same provider/model
    // selection, same token bucket. The cross-meetings flow is just
    // a different system prompt over the same panel scope.
    let ctx = AiContext::panel("meetings");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "contextHits": context_hits,
        "historyJson": history_json,
        "semanticAvailable": semantic_available,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "cross-meetings-chat-workflow-event",
        "cross_meetings_chat",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_analyze_pr_comments_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    review_text: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("address_pr_comments");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "reviewText": review_text,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "analyze-pr-comments-workflow-event",
        "analyze_pr_comments",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_pr_review_chat_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    context_text: String,
    history_json: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("pr_review");
    let model = resolve_model_for_context(&ctx).await?;

    // Project-specific Agent Skills are appended to the chat system prompt
    // in the sidecar — pass them through the input rather than reading them
    // there, so the sidecar stays stateless w.r.t. the user's local skill set.
    let review_skill = crate::commands::skills::get_skill(&app, "review");
    let impl_skill = crate::commands::skills::get_skill(&app, "implementation");
    let mut skills_block = String::new();
    if review_skill.is_some() || impl_skill.is_some() {
        skills_block.push_str(
            "=== PROJECT-SPECIFIC CONVENTIONS (Agent Skills) ===\n\
             These codebase-specific standards must inform any code you write or suggest:\n",
        );
        if let Some(s) = review_skill {
            skills_block.push_str("\n--- Review Standards ---\n");
            skills_block.push_str(&s);
        }
        if let Some(s) = impl_skill {
            skills_block.push_str("\n--- Implementation Standards ---\n");
            skills_block.push_str(&s);
        }
    }

    let input = serde_json::json!({
        "contextText": context_text,
        "historyJson": history_json,
        "skillsBlock": if skills_block.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(skills_block)
        },
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "pr-review-chat-workflow-event",
        "pr_review_chat",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_address_pr_chat_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    context_text: String,
    history_json: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::panel("address_pr_comments");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "contextText": context_text,
        "historyJson": history_json,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "address-pr-chat-workflow-event",
        "address_pr_chat",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_grooming_chat_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    context_text: String,
    history_json: String,
) -> Result<WorkflowResult, String> {
    // Resolve under the same Ticket Quality panel context as the
    // standalone grooming run — the screen's HeaderModelPicker writes
    // panel overrides keyed on `ticket_quality`.
    let ctx = AiContext::panel("ticket_quality");
    let model = resolve_model_for_context(&ctx).await?;

    // Pull the user's grooming format templates from the store and pass them
    // into the sidecar input. The sidecar appends them to the system prompt
    // so the agent's `suggested` text matches the user's expected structure.
    let templates = serde_json::json!({
        "acceptance_criteria": crate::commands::grooming_templates::read_grooming_template(
            &app,
            "acceptance_criteria",
        ),
        "steps_to_reproduce": crate::commands::grooming_templates::read_grooming_template(
            &app,
            "steps_to_reproduce",
        ),
    });

    let input = serde_json::json!({
        "contextText": context_text,
        "historyJson": history_json,
        "templates": templates,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "grooming-chat-workflow-event",
        "grooming_chat",
        input,
        model,
        None,
        None,
    )
    .await
}

/// Apply a batch of plan-edit ops the user just accepted from an
/// orchestrator-proposed `edit_plan`. Mutates `state.plan` on the pipeline
/// thread via the sidecar's `apply_plan_edits` workflow. Each op is
/// re-validated by Zod in the sidecar at the trust boundary.
#[tauri::command]
pub async fn apply_plan_edits(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    pipeline_thread_id: String,
    edits: serde_json::Value,
) -> Result<WorkflowResult, String> {
    // Model isn't actually used by this workflow (no LLM call) but the
    // sidecar's run_workflow contract requires one. Resolve the panel
    // default; if no model is configured we fall back to a placeholder
    // since this workflow is purely state-mutating.
    let ctx = AiContext::panel("implement_ticket");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "pipelineThreadId": pipeline_thread_id,
        "edits": edits,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "apply-plan-edits-workflow-event",
        "apply_plan_edits",
        input,
        model,
        None,
        None,
    )
    .await
}

/// Orchestrator chat — one user turn against the long-lived implement-ticket
/// orchestrator workflow. The sidecar persists per-ticket state (thread,
/// stage summaries, user notes, pending proposal) keyed by `thread_id`, so
/// each call only ships the new message + per-turn context. The orchestrator
/// is allowed to propose pipeline actions; the result includes any
/// `pendingProposal` the frontend should render as a confirm card.
#[tauri::command]
pub async fn chat_with_orchestrator(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    thread_id: String,
    pipeline_thread_id: Option<String>,
    message: String,
    message_kind: Option<String>,
    current_stage: Option<String>,
    context_text: Option<String>,
    clear_pending_proposal: Option<bool>,
    drop_summaries_for_stages: Option<Vec<String>>,
) -> Result<WorkflowResult, String> {
    // The orchestrator is panel-scoped (not stage-scoped) — it spans every
    // stage. Fetch the configured model for the implement-ticket panel.
    let ctx = AiContext::panel("implement_ticket");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "threadId": thread_id,
        "pipelineThreadId": pipeline_thread_id,
        "message": message,
        "messageKind": message_kind.unwrap_or_else(|| "user".to_string()),
        "currentStage": current_stage,
        "contextText": context_text,
        "clearPendingProposal": clear_pending_proposal.unwrap_or(false),
        "dropSummariesForStages": drop_summaries_for_stages.unwrap_or_default(),
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "orchestrator-workflow-event",
        "implement_ticket_orchestrator",
        input,
        model,
        None,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_grooming_file_probe_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    ticket_text: String,
) -> Result<WorkflowResult, String> {
    use tauri::Emitter;
    // Preserve the legacy "grooming-progress" toast the UI surfaces while the
    // probe is running.
    let _ = app.emit(
        "grooming-progress",
        serde_json::json!({
            "phase": "probe",
            "message": "Identifying relevant files in the codebase…"
        }),
    );

    let ctx = AiContext::stage("implement_ticket", "grooming");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "ticketText": ticket_text,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "grooming-file-probe-workflow-event",
        "grooming_file_probe",
        input,
        model,
        None,
        None,
    )
    .await
}
