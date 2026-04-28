use crate::integrations::bitbucket::{
    BitbucketClient, BitbucketComment, BitbucketPr, BitbucketTask,
};
use crate::storage::credentials::get_credential;
use crate::storage::preferences::get_pref;

fn get_config(key: &str) -> Option<String> {
    get_pref(key).or_else(|| get_credential(key))
}

fn bitbucket_client() -> Result<BitbucketClient, String> {
    let workspace = get_credential("bitbucket_workspace")
        .ok_or("Bitbucket workspace not configured. Check Settings.")?;
    let username = get_credential("bitbucket_email")
        .ok_or("Bitbucket username (email) not configured. Check Settings.")?;
    let access_token = get_credential("bitbucket_access_token")
        .ok_or("Bitbucket access token not configured. Check Settings.")?;
    let repo_slug = get_config("bitbucket_repo_slug")
        .ok_or("Bitbucket repository not configured. Check Settings → Configuration.")?;

    BitbucketClient::new(workspace, repo_slug, username, access_token)
}

/// All open PRs in the configured repository.
#[tauri::command]
pub async fn get_open_prs() -> Result<Vec<BitbucketPr>, String> {
    let client = bitbucket_client()?;
    client.get_open_prs().await
}

/// Open PRs where the configured user is listed as a reviewer.
#[tauri::command]
pub async fn get_prs_for_review() -> Result<Vec<BitbucketPr>, String> {
    let client = bitbucket_client()?;
    // Use the JIRA accountId (stored during JIRA validation) to match Bitbucket
    // reviewer account_ids — both use the same Atlassian account ID.
    match get_credential("jira_account_id") {
        Some(account_id) => client.get_prs_for_review(&account_id).await,
        None => {
            // No account ID yet — fall back to all open PRs with a warning.
            // User should validate JIRA credentials in Settings to enable filtering.
            client.get_open_prs().await
        }
    }
}

/// Open PRs authored by the configured Bitbucket user.
/// Uses the jira_account_id credential (shared Atlassian account_id) to identify
/// the user — no extra API call needed, and no additional scopes required.
#[tauri::command]
pub async fn get_my_open_prs() -> Result<Vec<BitbucketPr>, String> {
    let client = bitbucket_client()?;
    // JIRA and Bitbucket share the same Atlassian account_id. We store it
    // during JIRA credential validation, so we can use it here without
    // hitting the Bitbucket /user endpoint (which requires Account: Read scope).
    let account_id = get_credential("jira_account_id")
        .ok_or("Could not determine your Bitbucket account. Please validate your JIRA credentials in Settings first — this stores your shared Atlassian account ID.")?;
    client.get_my_open_prs_by_username(&account_id).await
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

/// Full contents of a file at the PR's source commit — used by the diff viewer
/// to lazy-load surrounding context around the changed hunks.
#[tauri::command]
pub async fn get_pr_file_content(pr_id: i64, path: String) -> Result<String, String> {
    let client = bitbucket_client()?;
    client.get_pr_file_content(pr_id, &path).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxiedImage {
    /// MIME type as reported by Bitbucket. Defaults to `application/octet-stream`
    /// when the header was missing — the frontend uses this to construct a
    /// `data:` URI, so a missing type still produces a valid (if generic) URI.
    pub content_type: String,
    /// Base64-encoded image bytes.
    pub data_base64: String,
}

/// Fetch a Bitbucket-hosted image with the configured Basic auth and return
/// its bytes base64-encoded. The Tauri webview can't supply per-request auth
/// for `<img src>`, so this command stands in: the frontend turns the result
/// into a `data:` URI and renders it directly. Refuses any URL not pointing
/// at `bitbucket.org` or `api.bitbucket.org` so this can't be abused as a
/// general-purpose authenticated fetch primitive.
#[tauri::command]
pub async fn fetch_bitbucket_image(url: String) -> Result<ProxiedImage, String> {
    use base64::Engine;
    if !is_bitbucket_url(&url) {
        return Err(
            "Refusing to proxy non-Bitbucket URL — only bitbucket.org and api.bitbucket.org are allowed.".to_string(),
        );
    }
    let client = bitbucket_client()?;
    let (bytes, content_type) = client.fetch_authed_bytes(&url).await?;
    Ok(ProxiedImage {
        content_type: content_type
            .unwrap_or_else(|| "application/octet-stream".to_string()),
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// Strict allow-list check for the proxy. Matches the schemes and hosts
/// Bitbucket actually serves user content from, with a trailing-slash anchor
/// so `bitbucket.org.evil.example/` can't sneak past a naive prefix match.
fn is_bitbucket_url(url: &str) -> bool {
    url.starts_with("https://bitbucket.org/")
        || url.starts_with("https://api.bitbucket.org/")
}

/// Upload an image to Bitbucket as a PR attachment via the undocumented
/// `/pullrequests/{id}/attachments` endpoint. The frontend hands us the bytes
/// base64-encoded (so the JS bridge stays string-typed); we decode here and
/// stream a multipart form to Bitbucket. Returns the attachment URL which
/// the frontend embeds as `![filename](url)` in the comment markdown.
#[tauri::command]
pub async fn upload_pr_attachment(
    pr_id: i64,
    filename: String,
    data_base64: String,
    content_type: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("Invalid base64 in upload payload: {e}"))?;
    let client = bitbucket_client()?;
    client
        .upload_pr_attachment(pr_id, &filename, bytes, content_type.as_deref())
        .await
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

/// All tasks on a PR (used to determine Ready for QA eligibility).
#[tauri::command]
pub async fn get_pr_tasks(pr_id: i64) -> Result<Vec<BitbucketTask>, String> {
    let client = bitbucket_client()?;
    client.get_pr_tasks(pr_id).await
}

/// Create a new pull request on Bitbucket. Bitbucket Cloud has no real draft
/// state, so this mimics it by creating the PR with no reviewers — nobody is
/// notified. Add reviewers from the Bitbucket UI when ready.
#[tauri::command]
pub async fn create_pull_request(
    title: String,
    description: String,
    source_branch: String,
    destination_branch: String,
) -> Result<BitbucketPr, String> {
    let client = bitbucket_client()?;
    client
        .create_pull_request(&title, &description, &source_branch, &destination_branch)
        .await
}

/// Approve a PR as the authenticated user.
/// Requires App Password with 'Pull requests: Write' scope.
#[tauri::command]
pub async fn approve_pr(pr_id: i64) -> Result<(), String> {
    let client = bitbucket_client()?;
    client.approve_pr(pr_id).await
}

/// Remove approval from a PR (unapprove).
#[tauri::command]
pub async fn unapprove_pr(pr_id: i64) -> Result<(), String> {
    let client = bitbucket_client()?;
    client.unapprove_pr(pr_id).await
}

/// Mark a PR as 'Needs work' (request changes).
#[tauri::command]
pub async fn request_changes_pr(pr_id: i64) -> Result<(), String> {
    let client = bitbucket_client()?;
    client.request_changes_pr(pr_id).await
}

/// Remove 'Needs work' status from a PR.
#[tauri::command]
pub async fn unrequest_changes_pr(pr_id: i64) -> Result<(), String> {
    let client = bitbucket_client()?;
    client.unrequest_changes_pr(pr_id).await
}

/// Post a general or inline comment on a PR.
/// Set `inline_path` + `inline_to_line` for an inline comment.
/// Set `parent_id` to reply to an existing comment thread.
#[tauri::command]
pub async fn post_pr_comment(
    pr_id: i64,
    content: String,
    inline_path: Option<String>,
    inline_to_line: Option<i64>,
    parent_id: Option<i64>,
) -> Result<crate::integrations::bitbucket::BitbucketComment, String> {
    let client = bitbucket_client()?;
    client
        .post_pr_comment(
            pr_id,
            &content,
            inline_path.as_deref(),
            inline_to_line,
            parent_id,
        )
        .await
}

/// Create a task linked to a specific comment on a PR.
#[tauri::command]
pub async fn create_pr_task(
    pr_id: i64,
    comment_id: i64,
    content: String,
) -> Result<crate::integrations::bitbucket::BitbucketTask, String> {
    let client = bitbucket_client()?;
    client.create_pr_task(pr_id, comment_id, &content).await
}

/// Update a task's text content on a PR.
#[tauri::command]
pub async fn update_pr_task(
    pr_id: i64,
    task_id: i64,
    content: String,
) -> Result<crate::integrations::bitbucket::BitbucketTask, String> {
    let client = bitbucket_client()?;
    client.update_pr_task(pr_id, task_id, &content).await
}

/// Resolve or re-open a task on a PR.
#[tauri::command]
pub async fn resolve_pr_task(
    pr_id: i64,
    task_id: i64,
    resolved: bool,
) -> Result<crate::integrations::bitbucket::BitbucketTask, String> {
    let client = bitbucket_client()?;
    client.resolve_pr_task(pr_id, task_id, resolved).await
}

/// Delete a comment from a PR (only succeeds if the authed user is the author).
#[tauri::command]
pub async fn delete_pr_comment(pr_id: i64, comment_id: i64) -> Result<(), String> {
    let client = bitbucket_client()?;
    client.delete_pr_comment(pr_id, comment_id).await
}

/// Update the content of a PR comment (only succeeds if the authed user is the author).
#[tauri::command]
pub async fn update_pr_comment(
    pr_id: i64,
    comment_id: i64,
    new_content: String,
) -> Result<crate::integrations::bitbucket::BitbucketComment, String> {
    let client = bitbucket_client()?;
    client
        .update_pr_comment(pr_id, comment_id, &new_content)
        .await
}
