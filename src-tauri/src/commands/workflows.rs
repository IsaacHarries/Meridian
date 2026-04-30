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
    let internal = resolved
        .providers
        .first()
        .ok_or_else(|| "No provider configured".to_string())?;
    let sidecar_provider = to_sidecar_provider(internal)?;
    let model = dispatch::model_for_provider(internal, ctx);
    if model.trim().is_empty() {
        return Err(format!(
            "No model configured for provider {internal}. Set one in Settings."
        ));
    }
    let credentials = resolve_credentials(sidecar_provider).await?;
    Ok(ModelSelection {
        provider: sidecar_provider.to_string(),
        model,
        credentials,
    })
}

#[tauri::command]
pub async fn run_grooming_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    ticket_text: String,
    file_contents: String,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::stage("implement_ticket", "grooming");
    let model = resolve_model_for_context(&ctx).await?;

    let templates = serde_json::json!({
        "acceptance_criteria": read_grooming_template(&app, "acceptance_criteria"),
        "steps_to_reproduce": read_grooming_template(&app, "steps_to_reproduce"),
    });

    let input = serde_json::json!({
        "ticketText": ticket_text,
        "fileContents": file_contents,
        "templates": templates,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "grooming-workflow-event",
        "grooming",
        input,
        model,
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
    #[serde(rename = "worktreePath")]
    worktree_path: String,
    #[serde(rename = "codebaseContext")]
    codebase_context: Option<String>,
    #[serde(rename = "groomingTemplates")]
    grooming_templates: Option<serde_json::Value>,
    skills: Option<serde_json::Value>,
    #[serde(rename = "prTemplate")]
    pr_template: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn run_implementation_pipeline_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    args: PipelineStartArgs,
) -> Result<WorkflowResult, String> {
    let ctx = AiContext::stage("implement_ticket", "pipeline");
    let model = resolve_model_for_context(&ctx).await?;

    // Phase 3c — read the build-verify settings from the prefs store. The
    // sidecar uses these to decide whether to insert the build_check sub-loop
    // after implementation. Both must be set for the loop to run; either
    // disabled or empty command short-circuits to the normal checkpoint.
    let build_verify_enabled =
        crate::storage::preferences::get_pref("build_verify_enabled")
            .map(|v| v == "true")
            .unwrap_or(false);
    let build_check_command =
        crate::storage::preferences::get_pref("build_check_command").unwrap_or_default();

    let input = serde_json::json!({
        "ticketText": args.ticket_text,
        "ticketKey": args.ticket_key,
        "worktreePath": args.worktree_path,
        "codebaseContext": args.codebase_context.unwrap_or_default(),
        "groomingTemplates": args.grooming_templates,
        "skills": args.skills,
        "prTemplate": args.pr_template,
        "buildVerifyEnabled": build_verify_enabled,
        "buildCheckCommand": build_check_command,
    });

    crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "implementation-pipeline-event",
        "implementation_pipeline",
        input,
        model,
        Some(args.worktree_path),
    )
    .await
}

#[tauri::command]
pub async fn resume_implementation_pipeline_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    thread_id: String,
    resume_value: serde_json::Value,
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
    )
    .await
}

#[tauri::command]
pub async fn rewind_implementation_pipeline_workflow(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    thread_id: String,
    to_node: String,
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
    )
    .await
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
    // behaviour is unchanged for users on local models.
    let (chunk_chars, findings_budget) = if model.provider == "ollama" {
        (12_000u32, 4_000u32)
    } else {
        (80_000u32, 40_000u32)
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
    let ctx = AiContext::stage("implement_ticket", "grooming");
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
    )
    .await
}
