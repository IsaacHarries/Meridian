use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

use crate::http::make_corporate_client;

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
}

// ── HTTP client ───────────────────────────────────────────────────────────────

pub struct BitbucketClient {
    client: Client,
    workspace: String,
    repo_slug: String,
    /// Bitbucket username (email or account username) — used as the Basic auth user.
    username: String,
    /// Bitbucket App Password — used as the Basic auth password.
    access_token: String,
}

impl BitbucketClient {
    pub fn new(
        workspace: String,
        repo_slug: String,
        username: String,
        access_token: String,
    ) -> Result<Self, String> {
        let client = make_corporate_client(Duration::from_secs(15))?;
        Ok(Self {
            client,
            workspace,
            repo_slug,
            username,
            access_token,
        })
    }

    fn repo_url(&self, path: &str) -> String {
        format!(
            "https://api.bitbucket.org/2.0/repositories/{}/{}{path}",
            self.workspace, self.repo_slug
        )
    }

    async fn get_json(&self, url: &str) -> Result<Value, String> {
        let resp = self
            .client
            .get(url)
            .basic_auth(&self.username, Some(&self.access_token))
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    "Could not reach Bitbucket. Check your internet connection.".to_string()
                } else {
                    format!("Request failed: {e}")
                }
            })?;

        let status = resp.status();
        match status {
            StatusCode::OK => resp
                .json::<Value>()
                .await
                .map_err(|e| format!("Failed to parse Bitbucket response: {e}")),
            StatusCode::UNAUTHORIZED => {
                let body = resp.text().await.unwrap_or_default();
                let detail = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(str::to_string));
                let hint = detail
                    .map(|d| format!(" Bitbucket said: \"{d}\""))
                    .unwrap_or_default();
                Err(format!(
                    "Bitbucket returned 401 Unauthorized for {url}.{hint} \
                     Check your username and App Password in Settings — the token may have \
                     expired or been revoked. Generate a new one at \
                     bitbucket.org → Personal settings → App passwords."
                ))
            }
            StatusCode::FORBIDDEN => {
                let body = resp.text().await.unwrap_or_default();
                let detail = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(str::to_string));
                let hint = detail
                    .map(|d| format!(" Bitbucket said: \"{d}\""))
                    .unwrap_or_default();
                Err(format!(
                    "Bitbucket returned 403 Forbidden for {url}.{hint} \
                     Your App Password may lack the required scopes — ensure it has \
                     Repositories: Read and Pull requests: Read permissions."
                ))
            }
            StatusCode::NOT_FOUND => Err(format!(
                "Bitbucket repository not found (404): {}/{} — \
                 check your workspace and repository slug in Settings.",
                self.workspace, self.repo_slug
            )),
            s => {
                let body = resp.text().await.unwrap_or_default();
                Err(format!("Bitbucket returned unexpected status {s} for {url}. Body: {body}"))
            }
        }
    }

    async fn get_text(&self, url: &str) -> Result<String, String> {
        let resp = self
            .client
            .get(url)
            .basic_auth(&self.username, Some(&self.access_token))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        match resp.status() {
            StatusCode::OK => resp
                .text()
                .await
                .map_err(|e| format!("Failed to read response: {e}")),
            StatusCode::UNAUTHORIZED => Err(format!(
                "Bitbucket returned 401 Unauthorized for {url}. \
                 Check your username and App Password in Settings."
            )),
            StatusCode::FORBIDDEN => Err(format!(
                "Bitbucket returned 403 Forbidden for {url}. \
                 Your App Password may lack Pull requests: Read permission."
            )),
            s => Err(format!("Bitbucket returned unexpected status {s} for {url}")),
        }
    }

    // ── Pull Requests ─────────────────────────────────────────────────────────

    /// All open PRs in the repository.
    pub async fn get_open_prs(&self) -> Result<Vec<BitbucketPr>, String> {
        let url = self.repo_url(
            "/pullrequests?state=OPEN&pagelen=50\
             &fields=values.id,values.title,values.description,values.state,values.draft,\
             values.author,values.reviewers,values.participants,values.source,values.destination,\
             values.created_on,values.updated_on,values.comment_count,values.task_count,\
             values.links,next",
        );
        let body = self.get_json(&url).await?;
        let values = body["values"].as_array().cloned().unwrap_or_default();
        Ok(values.iter().map(parse_pr).collect())
    }

    /// Merged PRs — up to the last 50. Pass `since_iso` (e.g. a sprint start date) to filter
    /// client-side by `updated_on`.
    pub async fn get_merged_prs(&self, since_iso: Option<&str>) -> Result<Vec<BitbucketPr>, String> {
        let url = self.repo_url(
            "/pullrequests?state=MERGED&pagelen=50\
             &fields=values.id,values.title,values.description,values.state,values.draft,\
             values.author,values.reviewers,values.participants,values.source,values.destination,\
             values.created_on,values.updated_on,values.comment_count,values.task_count,\
             values.links,next",
        );
        let body = self.get_json(&url).await?;
        let values = body["values"].as_array().cloned().unwrap_or_default();
        let prs: Vec<BitbucketPr> = values.iter().map(parse_pr).collect();

        if let Some(since) = since_iso {
            Ok(prs.into_iter().filter(|pr| pr.updated_on.as_str() >= since).collect())
        } else {
            Ok(prs)
        }
    }

    /// Open PRs where the authenticated user is listed as a reviewer.
    /// Filters client-side by account_id since role=REVIEWER does not work
    /// correctly with Bitbucket App Password authentication.
    pub async fn get_prs_for_review(&self, account_id: &str) -> Result<Vec<BitbucketPr>, String> {
        let all = self.get_open_prs().await?;
        Ok(all
            .into_iter()
            .filter(|pr| {
                pr.reviewers.iter().any(|r| {
                    r.user.account_id
                        .as_deref()
                        .map(|id| id == account_id)
                        .unwrap_or(false)
                })
            })
            .collect())
    }

    pub async fn get_pr(&self, pr_id: i64) -> Result<BitbucketPr, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}"));
        let body = self.get_json(&url).await?;
        Ok(parse_pr(&body))
    }

    pub async fn get_pr_diff(&self, pr_id: i64) -> Result<String, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/diff"));
        self.get_text(&url).await
    }

    pub async fn get_pr_comments(&self, pr_id: i64) -> Result<Vec<BitbucketComment>, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/comments?pagelen=100"));
        let body = self.get_json(&url).await?;
        let values = body["values"].as_array().cloned().unwrap_or_default();
        Ok(values.iter().map(parse_comment).collect())
    }

    pub async fn get_pr_tasks(&self, pr_id: i64) -> Result<Vec<BitbucketTask>, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/tasks?pagelen=100"));
        let body = self.get_json(&url).await?;
        let values = body["values"].as_array().cloned().unwrap_or_default();
        Ok(values
            .iter()
            .map(|t| BitbucketTask {
                id: t["id"].as_i64().unwrap_or(0),
                content: t["content"]["raw"].as_str().unwrap_or("").to_string(),
                resolved: t["state"].as_str().unwrap_or("") == "RESOLVED",
            })
            .collect())
    }
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

fn parse_user(v: &Value) -> BitbucketUser {
    BitbucketUser {
        display_name: v["display_name"].as_str().unwrap_or("").to_string(),
        nickname: v["nickname"].as_str().unwrap_or("").to_string(),
        account_id: v["account_id"].as_str().map(str::to_string),
    }
}

fn parse_pr(v: &Value) -> BitbucketPr {
    let title = v["title"].as_str().unwrap_or("").to_string();
    let description = v["description"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let source_branch = v["source"]["branch"]["name"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // Extract the first JIRA-style key (PROJ-123) from title, branch, or description
    let jira_issue_key = extract_jira_key(&title)
        .or_else(|| extract_jira_key(&source_branch))
        .or_else(|| description.as_deref().and_then(extract_jira_key));

    // Build a lookup of account_id -> (approved, state) from the participants array.
    // The reviewers[] array only has identity fields; approval state lives in participants[].
    let mut participant_approval: std::collections::HashMap<String, (bool, String)> =
        std::collections::HashMap::new();
    let mut changes_requested = false;
    if let Some(parts) = v["participants"].as_array() {
        for p in parts {
            if let Some(account_id) = p["user"]["account_id"].as_str() {
                let approved = p["approved"].as_bool().unwrap_or(false);
                let state = p["state"]
                    .as_str()
                    .unwrap_or("UNAPPROVED")
                    .to_string();
                if state.to_lowercase() == "changes_requested" {
                    changes_requested = true;
                }
                participant_approval.insert(account_id.to_string(), (approved, state));
            }
        }
    }

    let reviewers = v["reviewers"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    // Bitbucket reviewer objects are flat — fields are directly on the
                    // object, not nested under a "user" key.
                    let user = parse_user(r);
                    let (approved, state) = user
                        .account_id
                        .as_deref()
                        .and_then(|id| participant_approval.get(id))
                        .cloned()
                        .unwrap_or((false, "UNAPPROVED".to_string()));
                    BitbucketReviewer { user, approved, state }
                })
                .collect()
        })
        .unwrap_or_default();

    BitbucketPr {
        id: v["id"].as_i64().unwrap_or(0),
        title,
        description,
        state: v["state"].as_str().unwrap_or("").to_string(),
        author: parse_user(&v["author"]),
        reviewers,
        source_branch,
        destination_branch: v["destination"]["branch"]["name"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        created_on: v["created_on"].as_str().unwrap_or("").to_string(),
        updated_on: v["updated_on"].as_str().unwrap_or("").to_string(),
        comment_count: v["comment_count"].as_i64().unwrap_or(0),
        task_count: v["task_count"].as_i64().unwrap_or(0),
        url: v["links"]["html"]["href"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        jira_issue_key,
        changes_requested,
        draft: v["draft"].as_bool().unwrap_or(false),
    }
}

fn parse_comment(v: &Value) -> BitbucketComment {
    let inline = if v["inline"].is_object() {
        Some(BitbucketInlineContext {
            path: v["inline"]["path"].as_str().unwrap_or("").to_string(),
            from_line: v["inline"]["from"].as_i64(),
            to_line: v["inline"]["to"].as_i64(),
        })
    } else {
        None
    };

    BitbucketComment {
        id: v["id"].as_i64().unwrap_or(0),
        content: v["content"]["raw"].as_str().unwrap_or("").to_string(),
        author: parse_user(&v["author"]),
        created_on: v["created_on"].as_str().unwrap_or("").to_string(),
        updated_on: v["updated_on"].as_str().unwrap_or("").to_string(),
        inline,
        parent_id: v["parent"]["id"].as_i64(),
    }
}

/// Extract the first JIRA issue key (e.g. `PROJ-123`) from a string.
fn extract_jira_key(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_uppercase() {
            let start = i;
            // Collect project key prefix (uppercase letters + digits)
            while i < chars.len() && (chars[i].is_ascii_uppercase() || chars[i].is_ascii_digit()) {
                i += 1;
            }
            let prefix_len = i - start;
            // Minimum 2-char prefix, followed by '-', followed by digits
            if prefix_len >= 2 && i < chars.len() && chars[i] == '-' {
                i += 1;
                let num_start = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if i > num_start {
                    return Some(chars[start..i].iter().collect());
                }
            }
        } else {
            i += 1;
        }
    }
    None
}
