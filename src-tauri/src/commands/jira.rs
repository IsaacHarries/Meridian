use crate::commands::credentials::get_credential;
use crate::commands::preferences::get_pref;
use crate::jira::{CustomFieldConfig, JiraClient, JiraFieldMeta, JiraIssue, JiraSprint, RawIssueField};

fn get_config(key: &str) -> Option<String> {
    get_pref(key).or_else(|| get_credential(key))
}

fn jira_client() -> Result<(JiraClient, i64), String> {
    let base_url = get_credential("jira_base_url")
        .ok_or("JIRA URL not configured. Check Settings.")?;
    let email = get_credential("jira_email")
        .ok_or("JIRA email not configured. Check Settings.")?;
    let api_token = get_credential("jira_api_token")
        .ok_or("JIRA API token not configured. Check Settings.")?;
    let board_id_str = get_config("jira_board_id")
        .ok_or("JIRA board ID not configured. Check Settings → Configuration.")?;
    let board_id: i64 = board_id_str
        .trim()
        .parse()
        .map_err(|_| "JIRA board ID must be a number. Check Settings → Configuration.")?;

    let client = JiraClient::new(base_url, email, api_token)?;
    Ok((client, board_id))
}


/// Active sprint for the configured board.
#[tauri::command]
pub async fn get_active_sprint() -> Result<Option<JiraSprint>, String> {
    let (client, board_id) = jira_client()?;
    client.get_active_sprint(board_id).await
}

/// All active sprints for the configured board (boards can have multiple active sprints).
#[tauri::command]
pub async fn get_all_active_sprints() -> Result<Vec<JiraSprint>, String> {
    let (client, board_id) = jira_client()?;
    client.get_all_active_sprints(board_id).await
}

/// All issues across all active sprints.
#[tauri::command]
pub async fn get_all_active_sprint_issues() -> Result<Vec<(JiraSprint, Vec<JiraIssue>)>, String> {
    let (client, board_id) = jira_client()?;
    let cfg = CustomFieldConfig::default();
    let sprints = client.get_all_active_sprints(board_id).await?;
    let mut result = Vec::new();
    for sprint in sprints {
        let issues = client.get_sprint_issues(sprint.id, &cfg).await?;
        result.push((sprint, issues));
    }
    Ok(result)
}

/// All issues in a specific sprint.
#[tauri::command]
pub async fn get_sprint_issues(sprint_id: i64) -> Result<Vec<JiraIssue>, String> {
    let (client, _) = jira_client()?;
    let cfg = CustomFieldConfig::default();
    client.get_sprint_issues(sprint_id, &cfg).await
}

/// All issues in the active sprint.
#[tauri::command]
pub async fn get_active_sprint_issues() -> Result<Vec<JiraIssue>, String> {
    let (client, board_id) = jira_client()?;
    let cfg = CustomFieldConfig::default();
    match client.get_active_sprint(board_id).await? {
        Some(sprint) => client.get_sprint_issues(sprint.id, &cfg).await,
        None => Ok(vec![]),
    }
}

/// Issues in the active sprint assigned to the authenticated user.
#[tauri::command]
pub async fn get_my_sprint_issues() -> Result<Vec<JiraIssue>, String> {
    let (client, _) = jira_client()?;
    let cfg = CustomFieldConfig::default();
    let jql = "assignee = currentUser() AND sprint in openSprints() ORDER BY priority DESC";
    client.search_issues(jql, 50, &cfg).await
}

/// Full detail for a single issue.
#[tauri::command]
pub async fn get_issue(issue_key: String) -> Result<JiraIssue, String> {
    let (client, _) = jira_client()?;
    let cfg = CustomFieldConfig::default();
    client.get_issue(&issue_key, &cfg).await
}

/// Most-recent closed sprints, newest first.
#[tauri::command]
pub async fn get_completed_sprints(limit: u32) -> Result<Vec<JiraSprint>, String> {
    let (client, board_id) = jira_client()?;
    client.get_completed_sprints(board_id, limit as usize).await
}

/// Issues in a completed sprint by sprint ID.
#[tauri::command]
pub async fn get_sprint_issues_by_id(sprint_id: i64) -> Result<Vec<JiraIssue>, String> {
    let (client, _) = jira_client()?;
    let cfg = CustomFieldConfig::default();
    client.get_sprint_issues(sprint_id, &cfg).await
}

/// Future (not-yet-started) sprints for the configured board, soonest first.
#[tauri::command]
pub async fn get_future_sprints(limit: u32) -> Result<Vec<JiraSprint>, String> {
    let (client, board_id) = jira_client()?;
    client.get_future_sprints(board_id, limit as usize).await
}

/// General-purpose JQL search (used by Ticket Quality Checker and other workflows).
#[tauri::command]
pub async fn search_jira_issues(jql: String, max_results: u32) -> Result<Vec<JiraIssue>, String> {
    let (client, _) = jira_client()?;
    let cfg = CustomFieldConfig::default();
    client.search_issues(&jql, max_results as usize, &cfg).await
}

/// Diagnostic: fetch ALL fields for a single issue (with ?expand=names so field IDs
/// are mapped to human-readable display names). No admin permissions required.
/// Returns a list of { id, name, value } objects sorted custom-fields-last.
#[tauri::command]
pub async fn get_raw_issue_fields(issue_key: String) -> Result<Vec<RawIssueField>, String> {
    let (client, _) = jira_client()?;
    client.get_raw_issue_fields(&issue_key).await
}

/// Fetch all field definitions from the JIRA workspace (id + name + type).
/// Use this alongside get_raw_issue_fields to map field IDs to human-readable names.
#[tauri::command]
pub async fn get_jira_fields() -> Result<Vec<JiraFieldMeta>, String> {
    let (client, _) = jira_client()?;
    client.get_all_fields().await
}

/// Update an issue's description (and optionally its summary).
/// `description` is plain text; the Rust layer converts it to ADF for the v3 API.
#[tauri::command]
pub async fn update_jira_issue(
    issue_key: String,
    summary: Option<String>,
    description: String,
) -> Result<(), String> {
    let (client, _) = jira_client()?;
    client
        .update_issue_description(&issue_key, summary.as_deref(), &description)
        .await
}

/// Update multiple fields on a JIRA issue in a single PUT request.
/// `fields_json` is a JSON object mapping JIRA field IDs to plain-text values.
/// Standard fields: "summary", "description".
/// Custom fields: "customfield_10034", etc. All text values are wrapped in ADF
/// doc nodes for the v3 API (except "summary" which is a plain string).
#[tauri::command]
pub async fn update_jira_fields(
    issue_key: String,
    fields_json: String,
) -> Result<(), String> {
    let (client, _) = jira_client()?;
    client.update_fields(&issue_key, &fields_json).await
}

