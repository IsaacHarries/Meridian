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
        1500,
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
        "You are a triage agent helping plan the implementation of a JIRA ticket. \
        You have access to the ticket details, grooming analysis, and impact analysis below.\n\n\
        {context_text}\n\n\
        Your role:\n\
        - Help the engineer think through the implementation approach\n\
        - Ask targeted clarifying questions when needed\n\
        Propose concrete approaches and let the engineer refine them\n\
        - Be concise and practical\n\
        Respond in plain text. Do NOT produce JSON."
    );
    dispatch::dispatch_multi_streaming(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        800,
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
    dispatch::dispatch_streaming(&app, &client, &api_key, &system, &user, 2000, "plan-stream").await
}
