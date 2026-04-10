use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

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

// ── HTTP client ───────────────────────────────────────────────────────────────

pub struct BitbucketClient {
    client: Client,
    workspace: String,
    repo_slug: String,
    access_token: String,
}

impl BitbucketClient {
    pub fn new(
        workspace: String,
        repo_slug: String,
        access_token: String,
    ) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("HTTP client error: {e}"))?;
        Ok(Self {
            client,
            workspace,
            repo_slug,
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
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    "Could not reach Bitbucket. Check your internet connection.".to_string()
                } else {
                    format!("Request failed: {e}")
                }
            })?;

        match resp.status() {
            StatusCode::OK => resp
                .json::<Value>()
                .await
                .map_err(|e| format!("Failed to parse Bitbucket response: {e}")),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                Err("Bitbucket authentication failed. Check your access token in Settings."
                    .to_string())
            }
            StatusCode::NOT_FOUND => Err(format!(
                "Repository not found: {}/{}",
                self.workspace, self.repo_slug
            )),
            s => Err(format!("Bitbucket returned unexpected status {s}")),
        }
    }

    async fn get_text(&self, url: &str) -> Result<String, String> {
        let resp = self
            .client
            .get(url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        match resp.status() {
            StatusCode::OK => resp
                .text()
                .await
                .map_err(|e| format!("Failed to read response: {e}")),
            s => Err(format!("Bitbucket returned unexpected status {s}")),
        }
    }

    // ── Pull Requests ─────────────────────────────────────────────────────────

    /// All open PRs in the repository.
    pub async fn get_open_prs(&self) -> Result<Vec<BitbucketPr>, String> {
        let url = self.repo_url(
            "/pullrequests?state=OPEN&pagelen=50\
             &fields=values.id,values.title,values.description,values.state,\
             values.author,values.reviewers,values.source,values.destination,\
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
             &fields=values.id,values.title,values.description,values.state,\
             values.author,values.reviewers,values.source,values.destination,\
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

    /// Open PRs where `username` is listed as a reviewer (filtered client-side).
    pub async fn get_prs_for_review(&self, username: &str) -> Result<Vec<BitbucketPr>, String> {
        let all = self.get_open_prs().await?;
        Ok(all
            .into_iter()
            .filter(|pr| {
                pr.reviewers
                    .iter()
                    .any(|r| r.user.nickname.eq_ignore_ascii_case(username))
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

    let reviewers = v["reviewers"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|r| BitbucketReviewer {
                    user: parse_user(&r["user"]),
                    approved: r["approved"].as_bool().unwrap_or(false),
                    state: r["state"].as_str().unwrap_or("UNAPPROVED").to_string(),
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
