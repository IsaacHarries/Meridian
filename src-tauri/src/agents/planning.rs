use super::dispatch;

/// Agent 2 — Impact Analysis: assess the blast radius of the planned change.
#[tauri::command]
pub async fn run_impact_analysis(
    app: tauri::AppHandle,
    ticket_text: String,
    grooming_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
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
    dispatch::dispatch_streaming(
        &app,
        &client,
        &api_key,
        system,
        &user,
        4000,
        "impact-stream",
    )
    .await
}

/// Agent 3a — Triage turn: one conversational exchange in the planning session.
/// history_json is a JSON array of [{role: "user"|"assistant", content: "..."}].
#[tauri::command]
pub async fn run_triage_turn(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let system = format!(
        "You are a triage agent helping the engineer THINK THROUGH how to approach a JIRA ticket. \
        You have access to the ticket details, grooming analysis, and impact analysis below.\n\n\
        {context_text}\n\n\
        Triage is the exploratory stage — a back-and-forth conversation about HOW to attack \
        the work. A separate Implementation Plan stage runs AFTER you and is responsible for \
        producing the file-by-file, step-by-step plan. Do NOT do that work here.\n\n\
        SCOPE — what to do in this stage:\n\
        - Propose 1–3 candidate approaches in a few sentences each, with the trade-offs that \
          distinguish them (performance, complexity, risk, scope creep, etc.)\n\
        - Surface decisions the engineer needs to make (e.g. \"in-memory vs. Redis\", \
          \"sync vs. async retry\", \"new endpoint vs. extend existing\")\n\
        - Ask targeted clarifying questions when an ambiguity actually blocks the choice\n\
        - React to the engineer's pushback and refine the recommendation\n\
        - Once the engineer commits to a direction, briefly confirm — the next stage will \
          translate it into a concrete plan\n\n\
        OUT OF SCOPE — DO NOT do the following (the Implementation Plan stage handles them):\n\
        - Listing every file that will change with create/modify/delete actions\n\
        - Phase-by-phase or step-by-step breakdowns of how to implement\n\
        - Snippets of code or pseudocode\n\
        - Exhaustive edge-case enumeration\n\
        - 'Definition of done' checklists\n\n\
        FORMAT — return ONLY valid JSON (no markdown fences, no prose outside the JSON):\n\
        {{\n\
          \"message\": \"<1–3 sentence conversational reply for the chat — acknowledgments, \
                          framing, transitions. Do NOT restate the full proposal here.>\",\n\
          \"proposal\": \"<the current proposed approach as markdown — comparing approaches \
                          with trade-offs, or a refined recommendation. This is what the \
                          engineer reads in the middle panel as the 'current state'. Replace \
                          (don't append to) the prior proposal each turn — return what is \
                          true now after this turn.>\",\n\
          \"questions\": [\"<question 1>\", \"<question 2>\", ...]\n\
        }}\n\n\
        Rules:\n\
        - `message` is short — under ~50 words. It belongs in chat, not the proposal.\n\
        - `proposal` is at most a few short paragraphs or bullets. Aim for under ~250 words. \
          If you find yourself writing 'Phase 1', 'Step 1', or a numbered file list, stop — \
          that belongs in the Implementation Plan, not here.\n\
          On turns where the engineer hasn't asked you to revise the approach (e.g. they're \
          just answering one of your questions), it is FINE to return the previous proposal \
          unchanged — return it verbatim. Do not invent changes.\n\
        - `questions` contains ONLY questions you genuinely need answered. Empty array if none. \
          Each question should be self-contained and answerable in 1–2 sentences.\n\
        - Never embed questions inside `proposal`. They go in `questions`."
    );
    dispatch::dispatch_multi_streaming(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        8000,
        "triage-stream",
    )
    .await
}

/// Checkpoint chat turn: general Q&A at any post-triage pipeline stage.
/// Actionable checkpoint chat — replaces the old conversational-only turn.
///
/// Runs in a tool loop so the agent can read files for context, then returns structured JSON:
///
/// Implementation stage:
///   { "message": "...", "file_writes": [{"path":"...","content":"..."}],
///     "deviations_resolved": ["..."], "skipped_resolved": ["..."] }
///
/// All other stages:
///   { "message": "...", "updated_output": <full updated stage JSON or null> }
///
/// The frontend parses the response, applies any file writes and state patches.
#[tauri::command]
pub async fn run_checkpoint_action(
    app: tauri::AppHandle,
    stage: String,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let is_impl = stage == "implementation";

    let system = if is_impl {
        format!(
            "You are a senior software engineer implementing code changes in a git worktree.\n\n\
            {context_text}\n\n\
            The developer is asking you to write or fix one or more files.\n\n\
            WORKFLOW:\n\
            1. Use read_repo_file to read every file you intend to change (understand what's there).\n\
            2. Use write_repo_file to write each file with its COMPLETE new content. Do NOT \
               truncate or omit anything — partial content overwrites the whole file.\n\
            3. You MUST use write_repo_file for every file. Never describe code in your message \
               or return it as text — that will NOT update the filesystem.\n\
            4. After writing all files, return your FINAL response.\n\n\
            Your FINAL response (after all tool calls) MUST be ONLY this JSON — no markdown \
            fences, no prose outside it:\n\
            {{\n\
              \"message\": \"<one sentence describing what was written — NO code>\",\n\
              \"files_written\": [\"<path1>\", \"<path2>\"],\n\
              \"deviations_resolved\": [\"<exact deviation string this fix addresses>\"],\n\
              \"skipped_resolved\": [\"<path from the skipped list that you have now written>\"]\n\
            }}\n\
            The files_written list must contain every path you wrote with write_repo_file.\n\
            Use empty arrays for fields where nothing applies."
        )
    } else {
        format!(
            "You are a senior software engineer reviewing and updating pipeline output.\n\n\
            {context_text}\n\n\
            The developer may ask you to correct, clarify, or update the stage output shown above.\n\
            Use read_repo_file or grep_repo if you need extra code context to answer accurately.\n\n\
            Your FINAL response (after any tool calls) MUST be exactly this JSON with no markdown \
            fences or extra text outside it:\n\
            {{\n\
              \"message\": \"<what you changed or answered>\",\n\
              \"updated_output\": <the complete updated stage output JSON object, or null if nothing changed>\n\
            }}"
        )
    };

    dispatch::dispatch_multi_streaming_with_tools(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        if is_impl { 16000 } else { 4000 },
        "checkpoint-chat-stream",
    )
    .await
}

/// Kept for backward-compatibility — callers should prefer run_checkpoint_action.
#[tauri::command]
pub async fn run_checkpoint_chat_turn(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    run_checkpoint_action(app, "other".to_string(), context_text, history_json).await
}

/// Agent 3b — Finalize plan: extract a structured implementation plan from the triage conversation.
#[tauri::command]
pub async fn finalize_implementation_plan(
    app: tauri::AppHandle,
    context_text: String,
    conversation_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
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
    dispatch::dispatch_streaming(&app, &client, &api_key, &system, &user, 6000, "plan-stream").await
}

/// Dev sandbox — invoke a single agent tool by name and return the raw result.
#[tauri::command]
pub async fn run_tool_test(tool_name: String, input_json: String) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| format!("Invalid input JSON: {e}"))?;
    Ok(crate::agents::tools::execute_tool(&tool_name, &input).await)
}

/// Run a tool through the real LLM tool-call loop for a specific provider.
/// Returns JSON: { tool_called: bool, tool_result: string, llm_response: string }
#[tauri::command]
pub async fn run_tool_test_with_llm(
    app: tauri::AppHandle,
    provider: String,
    tool_name: String,
    input_json: String,
) -> Result<String, String> {
    use crate::agents::dispatch;
    use crate::storage::credentials::get_credential;

    // Ask the LLM to call the tool with the supplied parameters.
    let system = format!(
        "You are a tool-calling test agent. The user will ask you to call a specific tool \
         with specific parameter values. You MUST call that tool immediately using the \
         tool-calling mechanism — do not describe it, do not ask questions, just call it."
    );
    let user_msg = format!(
        "Please call the `{tool_name}` tool with exactly these parameters:\n{input_json}"
    );
    let history = serde_json::json!([{ "role": "user", "content": user_msg }]);
    let history_str = history.to_string();

    let (client, claude_key) = dispatch::llm_client().await?;

    let result = match provider.as_str() {
        "claude" => {
            let auth_method =
                get_credential("claude_auth_method").unwrap_or_else(|| "api_key".to_string());
            if auth_method == "oauth" {
                crate::llms::claude::refresh_oauth_if_needed(&client).await?;
            }
            let key = get_credential("anthropic_api_key").unwrap_or(claude_key.clone());
            if key.is_empty() {
                return Err("Claude: not configured (no API key)".to_string());
            }
            crate::llms::claude::complete_multi_claude_tool_loop(
                &app,
                &client,
                &key,
                &crate::llms::claude::get_active_model(),
                &system,
                &history_str,
                4096,
                "tool-sandbox-stream",
            )
            .await
        }
        other => {
            crate::llms::claude::complete_multi_text_tool_loop(
                &app,
                &client,
                &claude_key,
                other,
                &system,
                &history_str,
                4096,
                "tool-sandbox-stream",
            )
            .await
        }
    };

    match result {
        Ok(raw) => {
            // The tool loop returns the final LLM text after tool execution.
            // Wrap it so the frontend can show structured output.
            let out = serde_json::json!({
                "ok": true,
                "provider": provider,
                "tool_name": tool_name,
                "llm_response": raw,
            });
            Ok(out.to_string())
        }
        Err(e) => {
            let out = serde_json::json!({
                "ok": false,
                "provider": provider,
                "tool_name": tool_name,
                "error": e,
            });
            Ok(out.to_string())
        }
    }
}
