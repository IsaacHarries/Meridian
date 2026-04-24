use super::dispatch;

/// Generate workload rebalancing suggestions from pre-compiled capacity text.
#[tauri::command]
pub async fn generate_workload_suggestions(
    app: tauri::AppHandle,
    workload_text: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let system =
        "You are a scrum master assistant helping balance work across a development team. \
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

    dispatch::dispatch(&app, &client, &api_key, system, &user, 1024).await
}

/// Multi-turn Q&A over the current sprint dashboard state. Caller sends a
/// compact context string (sprint summary, issues, PRs, workloads) and the
/// running chat history as JSON. Streams reply text to `sprint-chat-stream`.
#[tauri::command]
pub async fn chat_sprint_dashboard(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let system = format!(
        "You are a scrum master's assistant, answering questions about the user's current \
        sprint dashboard. You have a compact snapshot of the sprint state below: the sprint \
        metadata, every issue with its status/assignee/points, every open and recently merged \
        PR, and a per-developer workload breakdown.\n\n\
        {context_text}\n\n\
        Rules:\n\
        - Answer ONLY from the snapshot. If something isn't in the data, say so plainly.\n\
        - Be concrete: cite ticket keys, PR numbers, and developer names where relevant.\n\
        - When asked to rebalance, suggest specific moves (ticket → developer) with brief reasons.\n\
        - Keep replies tight — this is a conversation, not an essay. Use bullet points for lists.\n\
        - Reply in plain markdown. No JSON."
    );

    dispatch::dispatch_multi_streaming(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        2048,
        "sprint-chat-stream",
    )
    .await
}

/// Generate a sprint retrospective summary from pre-compiled sprint data.
#[tauri::command]
pub async fn generate_sprint_retrospective(
    app: tauri::AppHandle,
    sprint_text: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let system =
        "You are an experienced agile coach helping a scrum master run sprint retrospectives. \
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

    dispatch::dispatch(&app, &client, &api_key, system, &user, 1024).await
}

