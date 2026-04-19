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

#[tauri::command]
pub async fn generate_standup_briefing(
    app: tauri::AppHandle,
    standup_text: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

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

    dispatch::dispatch(&app, &client, &api_key, system, &user, 1024).await
}
