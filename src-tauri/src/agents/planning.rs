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
/// Used when the user wants to ask questions or request clarifications after
/// seeing stage output (impact, plan, implementation, tests, review, pr, retro).
#[tauri::command]
pub async fn run_checkpoint_chat_turn(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let system = format!(
        "You are a senior software engineer helping a developer understand and act on pipeline \
        output. You have full context on the ticket, pipeline history, and the current stage output below.\n\n\
        {context_text}\n\n\
        Answer the developer's questions clearly and concisely. Reference specific details from \
        the stage output when relevant. If the developer asks you to change something, explain \
        what they need to do or what the implications are. \
        Respond in plain text. Do NOT produce JSON."
    );
    dispatch::dispatch_multi_streaming(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        800,
        "checkpoint-chat-stream",
    )
    .await
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
