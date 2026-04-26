use super::dispatch;
use crate::commands::grooming_templates::read_grooming_template;
use tauri::Emitter;

/// Build a "=== FORMAT TEMPLATES ===" block for the grooming agent's system
/// prompt, listing whichever of the acceptance-criteria / steps-to-reproduce
/// templates the user has configured. Returns an empty string if neither is
/// set, so the block is simply absent from the prompt.
fn format_templates_block(app: &tauri::AppHandle) -> String {
    let ac = read_grooming_template(app, "acceptance_criteria");
    let str_ = read_grooming_template(app, "steps_to_reproduce");
    if ac.is_none() && str_.is_none() {
        return String::new();
    }
    let mut out = String::from(
        "\n\n=== FORMAT TEMPLATES ===\n\
         When you draft text for the `suggested` field of an edit, follow the \
         format shown below for the matching `field`. Match the structure, \
         bullet style, numbering, and line breaks exactly — the user relies on \
         a consistent format across tickets.\n",
    );
    if let Some(ac) = ac {
        out.push_str("\n--- Format for field `acceptance_criteria` ---\n");
        out.push_str(ac.trim_end());
        out.push('\n');
    }
    if let Some(str_) = str_ {
        out.push_str("\n--- Format for field `steps_to_reproduce` ---\n");
        out.push_str(str_.trim_end());
        out.push('\n');
    }
    out
}

/// Agent 1a — Grooming File Probe: ask Claude which files to read before full grooming.
/// Returns JSON: { "files": ["path/to/file", ...], "grep_patterns": ["pattern", ...] }
#[tauri::command]
pub async fn run_grooming_file_probe(
    app: tauri::AppHandle,
    ticket_text: String,
) -> Result<String, String> {
    let _ = app.emit(
        "grooming-progress",
        serde_json::json!({
            "phase": "probe",
            "message": "Identifying relevant files in the codebase…"
        }),
    );
    let (client, api_key) = dispatch::llm_client().await?;
    let system = "You are a codebase navigation agent. Given a JIRA ticket, identify the \
        source files most relevant to understanding and implementing it. \
        Return ONLY valid JSON (no markdown fences, no explanation) with exactly this schema:\n\
        {\n\
          \"files\": [\"<relative path from repo root>\", ...],\n\
          \"grep_patterns\": [\"<regex to search for relevant symbols/functions>\", ...]\n\
        }\n\
        Rules:\n\
        - List at most 12 files and 6 grep patterns\n\
        - Paths should be relative (e.g. \"src/reports/ReportEditor.tsx\"), not absolute\n\
        - Grep patterns should target specific function names, class names, or identifiers mentioned in the ticket\n\
        - If a CODEBASE CONTEXT section is provided, use the worktree path information to form accurate paths\n\
        - Do not include test files, lock files, or generated files\n\
        - Return an empty arrays if the ticket is too vague to identify specific files";
    let user = format!("Identify relevant files for this ticket:\n\n{ticket_text}");
    dispatch::dispatch_streaming(
        &app,
        &client,
        &api_key,
        system,
        &user,
        600,
        "grooming-stream",
    )
    .await
}

/// Agent 1 — Grooming: analyse ticket and identify relevant code areas.
/// file_contents is the injected codebase context (file contents from the probe phase).
#[tauri::command]
pub async fn run_grooming_agent(
    app: tauri::AppHandle,
    ticket_text: String,
    file_contents: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let file_block = if file_contents.trim().is_empty() {
        let _ = app.emit(
            "grooming-progress",
            serde_json::json!({
                "phase": "analysis",
                "message": "Analysing ticket (no codebase context provided)…"
            }),
        );
        String::new()
    } else {
        let file_count = file_contents.matches("--- ").count();
        let _ = app.emit("grooming-progress", serde_json::json!({
            "phase": "analysis",
            "message": format!("Analysing ticket with {} codebase context block{}…", file_count, if file_count == 1 { "" } else { "s" })
        }));
        format!("\n\n=== RELEVANT FILE CONTENTS (read from codebase) ===\n{file_contents}")
    };

    let base_system = "You are a grooming agent helping a senior engineer understand and refine a JIRA ticket. \
        You have been given the ticket details and relevant source code from the codebase. \
        Your job is twofold:\n\
        1. Analyse the ticket and produce a structured grooming summary\n\
        2. Identify any gaps, inaccuracies, or missing sections in the ticket and suggest concrete improvements\n\n\
        For each suggested edit:\n\
        - Compare what the ticket currently says against what the code actually does\n\
        - Propose a specific, concrete replacement (not vague advice)\n\
        - For missing sections (e.g. no Acceptance Criteria on a Story, no Steps to Reproduce on a Bug), \
          draft what should be there based on the code context — or raise a clarifying_question if you genuinely cannot determine it\n\n\
        Return ONLY valid JSON (no markdown fences) with this schema:\n\
        {\n\
          \"ticket_summary\": \"<2-3 sentence summary of what the ticket is asking for>\",\n\
          \"ticket_type\": \"feature|bug|chore|spike\",\n\
          \"acceptance_criteria\": [\"<criterion>\", ...],\n\
          \"relevant_areas\": [\n\
            {\"area\": \"<module or layer>\", \"reason\": \"<why relevant>\", \"files_to_check\": [\"<path>\"]}\n\
          ],\n\
          \"ambiguities\": [\"<unclear thing>\", ...],\n\
          \"dependencies\": [\"<other tickets or systems>\", ...],\n\
          \"estimated_complexity\": \"low|medium|high\",\n\
          \"grooming_notes\": \"<anything else worth flagging>\",\n\
          \"suggested_edits\": [\n\
            {\n\
              \"id\": \"<short unique slug e.g. 'ac-1' or 'desc-clarity'>\",\n\
              \"field\": \"<jira field: description|acceptance_criteria|steps_to_reproduce|observed_behavior|expected_behavior|summary>\",\n\
              \"section\": \"<human label e.g. 'Acceptance Criteria' or 'Description'>\",\n\
              \"current\": \"<exact existing text, or null if the section is missing entirely>\",\n\
              \"suggested\": \"<your proposed replacement or addition>\",\n\
              \"reasoning\": \"<1-2 sentences explaining why this change improves the ticket>\"\n\
            }\n\
          ],\n\
          \"clarifying_questions\": [\n\
            \"<question you need answered before you can complete the analysis or a suggestion>\"\n\
          ]\n\
        }\n\n\
        Important:\n\
        - Only raise a clarifying_question when you genuinely cannot determine the answer from the code or ticket\n\
        - Prefer drafting a concrete suggestion (even if tentative) over asking a question\n\
        - If the ticket title (summary) is vague, too generic, or does not clearly convey the scope \
          or intent of the work, suggest a concrete improved title using field `summary` — be specific \
          and concise (under 80 characters). Only suggest a title change if it genuinely adds clarity; \
          do not change titles that are already specific\n\
        - If the ticket is a Bug and has no Steps to Reproduce / Observed / Expected Behavior, always suggest them\n\
        - If the ticket is a Story/Task and has no Acceptance Criteria, always suggest them\n\
        - Keep each suggested text concise and actionable\n\
        - Only include ONE suggested_edit per field value — if you have multiple improvements for \
          the same field (e.g. multiple acceptance criteria points), consolidate them into a single \
          edit with all content merged. Never produce two suggested_edits with the same `field`.";

    let templates_block = format_templates_block(&app);
    let system = if templates_block.is_empty() {
        base_system.to_string()
    } else {
        format!("{base_system}{templates_block}")
    };

    let user = format!("Groom this ticket:\n\n{ticket_text}{file_block}");
    let result = dispatch::dispatch_streaming(
        &app,
        &client,
        &api_key,
        &system,
        &user,
        8000,
        "grooming-stream",
    )
    .await;

    let _ = app.emit(
        "grooming-progress",
        serde_json::json!({
            "phase": "done",
            "message": if result.is_ok() { "Analysis complete." } else { "Analysis failed." }
        }),
    );
    result
}

/// Grooming chat turn: structured back-and-forth during ticket grooming.
/// The agent leads the discussion, refines suggested edits, and asks clarifying questions.
/// Returns JSON: { "message": "...", "updated_edits": [...], "updated_questions": [...] }
#[tauri::command]
pub async fn run_grooming_chat_turn(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let templates_block = format_templates_block(&app);
    let system = format!(
        "You are a grooming agent leading a structured review of a JIRA ticket with a senior engineer. \
        The ticket details, relevant code context, and current state of suggested edits are below.\n\n\
        {context_text}\n\n\
        Your role in this conversation:\n\
        - Respond naturally to the engineer's message\n\
        - Refine, add, or retract suggested edits based on new information\n\
        - Ask follow-up clarifying questions if you still need information\n\
        - When the engineer answers a question, incorporate it into your suggestions immediately\n\
        - Lead toward a complete, well-groomed ticket\n\n\
        IMPORTANT — you have NO ability to write to JIRA, Bitbucket, or any external system. \
        You only return suggested edits as JSON; the engineer must approve them in the UI before \
        anything is pushed anywhere.\n\n\
        CRITICAL: You MUST always respond with ONLY a valid JSON object — no markdown fences, no prose outside the JSON, \
        no matter how conversational the engineer's message is. Every single response must be valid JSON.\n\n\
        Required schema:\n\
        {{\n\
          \"message\": \"<your conversational reply to the engineer — plain prose, no JSON>\",\n\
          \"updated_edits\": [\n\
            {{\n\
              \"id\": \"<same id as existing edit to update it, or a new slug for new edits>\",\n\
              \"field\": \"<description|acceptance_criteria|steps_to_reproduce|observed_behavior|expected_behavior|summary>\",\n\
              \"section\": \"<human label>\",\n\
              \"current\": \"<existing text or null>\",\n\
              \"suggested\": \"<proposed text>\",\n\
              \"reasoning\": \"<why>\"\n\
            }}\n\
          ],\n\
          \"updated_questions\": [\"<any remaining open questions you still need answered>\"],\n\
          \"updated_ambiguities\": [\"<remaining unresolved ambiguities — drop ones the engineer has clarified>\"]\n\
        }}\n\n\
        Rules:\n\
        - updated_edits may be empty if no changes are needed this turn\n\
        - To remove a suggestion, omit its id from updated_edits (the frontend will not delete it — include it with a note in reasoning if it should be withdrawn)\n\
        - updated_ambiguities MUST reflect the conversation so far. If the engineer has clarified a previously \
          listed ambiguity, drop it from this list. If new ambiguities surface, add them. \
          Return the FULL current list every turn — it replaces the previous list, it does not merge.\n\
        - If you change the suggested text or current text of an existing edit, the engineer's previous \
          approval is automatically reset and they must re-approve — your edit is a fresh proposal.\n\
        - Keep the message focused and concise\n\
        - Even if the engineer says only 'yes', 'ok', or 'thanks', you must still return the full JSON object{templates_block}"
    );
    dispatch::dispatch_multi_streaming_with_tools(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        4096,
        "grooming-chat-stream",
    )
    .await
}

/// Assess a JIRA ticket for development readiness and return a JSON quality report.
#[tauri::command]
pub async fn assess_ticket_quality(
    app: tauri::AppHandle,
    ticket_text: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

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

    dispatch::dispatch(&app, &client, &api_key, system, &user, 1500).await
}
