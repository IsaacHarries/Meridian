use crate::bitbucket::{BitbucketClient, BitbucketComment, BitbucketPr};
use crate::commands::credentials::get_credential;

fn bitbucket_client() -> Result<BitbucketClient, String> {
    let workspace = get_credential("bitbucket_workspace")
        .ok_or("Bitbucket workspace not configured. Check Settings.")?;
    let access_token = get_credential("bitbucket_access_token")
        .ok_or("Bitbucket access token not configured. Check Settings.")?;
    let repo_slug = get_credential("bitbucket_repo_slug")
        .ok_or("Bitbucket repository not configured. Check Settings → Configuration.")?;

    BitbucketClient::new(workspace, repo_slug, access_token)
}

/// All open PRs in the configured repository.
#[tauri::command]
pub async fn get_open_prs() -> Result<Vec<BitbucketPr>, String> {
    let client = bitbucket_client()?;
    client.get_open_prs().await
}

/// Open PRs where the configured Bitbucket user is listed as a reviewer.
#[tauri::command]
pub async fn get_prs_for_review() -> Result<Vec<BitbucketPr>, String> {
    let client = bitbucket_client()?;
    // Username is auto-stored during token validation. Fall back to all open PRs if absent.
    match get_credential("bitbucket_username") {
        Some(username) => client.get_prs_for_review(&username).await,
        None => client.get_open_prs().await,
    }
}

/// Full detail for a single PR.
#[tauri::command]
pub async fn get_pr(pr_id: i64) -> Result<BitbucketPr, String> {
    let client = bitbucket_client()?;
    client.get_pr(pr_id).await
}

/// Raw unified diff for a PR (used by the PR Review Assistant).
#[tauri::command]
pub async fn get_pr_diff(pr_id: i64) -> Result<String, String> {
    let client = bitbucket_client()?;
    client.get_pr_diff(pr_id).await
}

/// Merged PRs, optionally filtered to those updated on or after `since_iso` (sprint start date).
#[tauri::command]
pub async fn get_merged_prs(since_iso: Option<String>) -> Result<Vec<BitbucketPr>, String> {
    let client = bitbucket_client()?;
    client.get_merged_prs(since_iso.as_deref()).await
}

/// All comments on a PR.
#[tauri::command]
pub async fn get_pr_comments(pr_id: i64) -> Result<Vec<BitbucketComment>, String> {
    let client = bitbucket_client()?;
    client.get_pr_comments(pr_id).await
}
