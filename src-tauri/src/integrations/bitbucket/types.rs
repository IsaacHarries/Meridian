use serde::Serialize;

// ── Output types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketUser {
    pub display_name: String,
    pub nickname: String,
    pub account_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketReviewer {
    pub user: BitbucketUser,
    pub approved: bool,
    pub state: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketPr {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    pub state: String,
    pub author: BitbucketUser,
    pub reviewers: Vec<BitbucketReviewer>,
    pub source_branch: String,
    pub destination_branch: String,
    pub created_on: String,
    pub updated_on: String,
    pub comment_count: i64,
    pub task_count: i64,
    pub url: String,
    pub jira_issue_key: Option<String>,
    pub changes_requested: bool,
    pub draft: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketComment {
    pub id: i64,
    pub content: String,
    pub author: BitbucketUser,
    pub created_on: String,
    pub updated_on: String,
    pub inline: Option<BitbucketInlineContext>,
    pub parent_id: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketInlineContext {
    pub path: String,
    pub from_line: Option<i64>,
    pub to_line: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketTask {
    pub id: i64,
    pub content: String,
    pub resolved: bool,
    /// The comment this task is anchored to, if any.
    pub comment_id: Option<i64>,
}
