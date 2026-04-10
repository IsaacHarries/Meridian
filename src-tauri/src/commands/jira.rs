use crate::commands::credentials::get_credential;
use crate::jira::{JiraClient, JiraIssue, JiraSprint};

fn jira_client() -> Result<(JiraClient, i64), String> {
    let base_url = get_credential("jira_base_url")
        .ok_or("JIRA URL not configured. Check Settings.")?;
    let email = get_credential("jira_email")
        .ok_or("JIRA email not configured. Check Settings.")?;
    let api_token = get_credential("jira_api_token")
        .ok_or("JIRA API token not configured. Check Settings.")?;
    let board_id_str = get_credential("jira_board_id")
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

/// All issues in a specific sprint.
#[tauri::command]
pub async fn get_sprint_issues(sprint_id: i64) -> Result<Vec<JiraIssue>, String> {
    let (client, _) = jira_client()?;
    client.get_sprint_issues(sprint_id).await
}

/// All issues in the active sprint.
#[tauri::command]
pub async fn get_active_sprint_issues() -> Result<Vec<JiraIssue>, String> {
    let (client, board_id) = jira_client()?;
    match client.get_active_sprint(board_id).await? {
        Some(sprint) => client.get_sprint_issues(sprint.id).await,
        None => Ok(vec![]),
    }
}

/// Issues in the active sprint assigned to the authenticated user.
#[tauri::command]
pub async fn get_my_sprint_issues() -> Result<Vec<JiraIssue>, String> {
    let (client, _) = jira_client()?;
    let jql = "assignee = currentUser() AND sprint in openSprints() ORDER BY priority DESC";
    client.search_issues(jql, 50).await
}

/// Full detail for a single issue.
#[tauri::command]
pub async fn get_issue(issue_key: String) -> Result<JiraIssue, String> {
    let (client, _) = jira_client()?;
    client.get_issue(&issue_key).await
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
    client.get_sprint_issues(sprint_id).await
}

/// General-purpose JQL search (used by Ticket Quality Checker and other workflows).
#[tauri::command]
pub async fn search_jira_issues(jql: String, max_results: u32) -> Result<Vec<JiraIssue>, String> {
    let (client, _) = jira_client()?;
    client.search_issues(&jql, max_results as usize).await
}
