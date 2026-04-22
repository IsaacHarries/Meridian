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
    /// The comment this task is anchored to, if any.
    pub comment_id: Option<i64>,
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
        // Read the SSL verify preference (default: false)
        let disable_ssl_verify = crate::storage::preferences::get_pref("bitbucket_disable_ssl_verify")
            .map(|v| v == "true")
            .unwrap_or(false);
        let client = crate::http::make_corporate_client(Duration::from_secs(15), disable_ssl_verify)?;
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

    /// POST with no body — used for approve (empty body is correct per Bitbucket docs).
    async fn post_empty(&self, url: &str) -> Result<(), String> {
        let resp = self
            .client
            .post(url)
            .basic_auth(&self.username, Some(&self.access_token))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        let hint = if status == StatusCode::FORBIDDEN {
            " — your App Password needs 'Pull requests: Write' permission. \
             Update it at bitbucket.org → Personal settings → App passwords."
        } else if status == StatusCode::UNAUTHORIZED {
            " — check your username and App Password in Settings."
        } else {
            ""
        };
        Err(format!("Bitbucket returned {status} for POST {url}{hint}\nBody: {body}"))
    }

    /// DELETE — used for unapprove / remove needs-work.
    async fn delete_req(&self, url: &str) -> Result<(), String> {
        let resp = self
            .client
            .delete(url)
            .basic_auth(&self.username, Some(&self.access_token))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;
        let status = resp.status();
        if status.is_success() || status == StatusCode::NO_CONTENT {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        let hint = if status == StatusCode::FORBIDDEN {
            " — your App Password needs 'Pull requests: Write' permission."
        } else {
            ""
        };
        Err(format!("Bitbucket returned {status} for DELETE {url}{hint}\nBody: {body}"))
    }

    /// Create a new pull request. Bitbucket Cloud does not support draft PRs
    /// at the API level, so this mimics "draft" by creating the PR with no
    /// reviewers — nobody gets notified. Add reviewers from the Bitbucket UI
    /// when you're ready for the PR to be reviewed.
    ///
    /// Bitbucket API: POST /2.0/repositories/{workspace}/{slug}/pullrequests
    pub async fn create_pull_request(
        &self,
        title: &str,
        description: &str,
        source_branch: &str,
        destination_branch: &str,
    ) -> Result<BitbucketPr, String> {
        let url = self.repo_url("/pullrequests");

        let body = serde_json::json!({
            "title": title,
            "description": description,
            "source": { "branch": { "name": source_branch } },
            "destination": { "branch": { "name": destination_branch } },
            "close_source_branch": true,
            "reviewers": [],
        });

        let resp = self
            .client
            .post(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let hint = match status {
                StatusCode::UNAUTHORIZED => {
                    " — check your username and App Password in Settings."
                }
                StatusCode::FORBIDDEN => {
                    " — your App Password needs 'Pull requests: Write' permission."
                }
                StatusCode::NOT_FOUND => {
                    " — workspace/repo not found, or the source branch hasn't been pushed to origin."
                }
                StatusCode::BAD_REQUEST => {
                    " — Bitbucket rejected the request. A PR for this branch may already exist, or the source branch may not exist on origin."
                }
                _ => "",
            };
            return Err(format!(
                "Bitbucket returned {status} creating pull request{hint}\nBody: {text}"
            ));
        }

        let json: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse PR response: {e}"))?;
        Ok(parse_pr(&json))
    }

    /// Approve a PR on behalf of the authenticated user.
    /// Bitbucket API: POST /2.0/repositories/{workspace}/{slug}/pullrequests/{id}/approve
    pub async fn approve_pr(&self, pr_id: i64) -> Result<(), String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/approve"));
        self.post_empty(&url).await
    }

    /// Remove approval (unapprove) from a PR.
    /// Bitbucket API: DELETE /2.0/repositories/{workspace}/{slug}/pullrequests/{id}/approve
    pub async fn unapprove_pr(&self, pr_id: i64) -> Result<(), String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/approve"));
        self.delete_req(&url).await
    }

    /// Mark a PR as "Needs work" (request changes).
    /// Bitbucket API: POST /2.0/repositories/{workspace}/{slug}/pullrequests/{id}/request-changes
    pub async fn request_changes_pr(&self, pr_id: i64) -> Result<(), String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/request-changes"));
        self.post_empty(&url).await
    }

    /// Remove "Needs work" status.
    /// Bitbucket API: DELETE /2.0/repositories/{workspace}/{slug}/pullrequests/{id}/request-changes
    pub async fn unrequest_changes_pr(&self, pr_id: i64) -> Result<(), String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/request-changes"));
        self.delete_req(&url).await
    }

    /// Fetch the authenticated user's nickname from the Bitbucket /user endpoint.
    /// This is the account username that appears as `author.nickname` on PRs —
    /// it is distinct from the email address used for Basic auth.
    /// Fetch the authenticated user's account_id from the Bitbucket /user endpoint.
    /// Requires Account: Read scope on the App Password.
    pub async fn get_current_user_account_id(&self) -> Result<String, String> {
        let url = "https://api.bitbucket.org/2.0/user".to_string();
        let body = self.get_json(&url).await?;
        let account_id = body["account_id"]
            .as_str()
            .ok_or_else(|| "Bitbucket /user response did not contain an account_id field".to_string())?
            .to_string();
        eprintln!("[meridian] get_current_user_account_id: resolved account_id={:?}", account_id);
        Ok(account_id)
    }

    /// Fetch open PRs authored by the authenticated user.
    /// Uses the /user endpoint to get the authenticated user's account_id,
    /// then filters all open PRs client-side by that id.
    pub async fn get_my_authored_open_prs(&self) -> Result<Vec<BitbucketPr>, String> {
        let my_account_id = self.get_current_user_account_id().await?;
        let all = self.get_open_prs().await?;
        eprintln!("[meridian] get_my_authored_open_prs: my_account_id={:?}, filtering {} total PRs", my_account_id, all.len());
        let filtered: Vec<BitbucketPr> = all
            .into_iter()
            .filter(|pr| pr.author.account_id.as_deref() == Some(my_account_id.as_str()))
            .collect();
        eprintln!("[meridian] get_my_authored_open_prs: {} PRs matched", filtered.len());
        Ok(filtered)
    }

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

    /// Open PRs authored by the authenticated user (filtered by username).
    pub async fn get_my_open_prs(&self) -> Result<Vec<BitbucketPr>, String> {
        self.get_my_authored_open_prs().await
    }

    /// Filter open PRs to those authored by the given username (nickname or account_id).
    /// Uses an explicit username so callers can pass `bitbucket_username` rather than
    /// `bitbucket_email`, since the Bitbucket API `nickname` field is the account
    /// username — not the email address used for Basic auth.
    pub async fn get_my_open_prs_by_username(&self, username: &str) -> Result<Vec<BitbucketPr>, String> {
        let all = self.get_open_prs().await?;
        let username_lc = username.to_lowercase();
        eprintln!("[meridian] get_my_open_prs: matching against={:?}", username_lc);
        eprintln!("[meridian] get_my_open_prs: {} total open PRs", all.len());
        for pr in &all {
            eprintln!(
                "[meridian]   PR #{}: author.nickname={:?} author.account_id={:?}",
                pr.id, pr.author.nickname, pr.author.account_id
            );
        }
        let matched: Vec<BitbucketPr> = all
            .into_iter()
            .filter(|pr| {
                let nickname = pr.author.nickname.to_lowercase();
                let account_id = pr.author.account_id.as_deref().unwrap_or("").to_lowercase();
                // Match on account_id first (reliable), then nickname as fallback
                account_id == username_lc || nickname == username_lc
            })
            .collect();
        eprintln!("[meridian] get_my_open_prs: {} PRs matched", matched.len());
        Ok(matched)
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
        // Debug: log the first comment's raw JSON so we can see the author field structure
        if let Some(first) = values.first() {
            eprintln!("[meridian] first comment author JSON: {}", first["author"]);
        }
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
                comment_id: t["comment"]["id"].as_i64(),
            })
            .collect())
    }

    /// Post a comment on a PR. Pass `inline_path` + `inline_to_line` to create an
    /// inline comment anchored to a specific file and line in the new version of
    /// the diff. Pass `parent_id` to reply to an existing comment thread.
    pub async fn post_pr_comment(
        &self,
        pr_id: i64,
        content: &str,
        inline_path: Option<&str>,
        inline_to_line: Option<i64>,
        parent_id: Option<i64>,
    ) -> Result<BitbucketComment, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/comments"));

        let mut body = serde_json::json!({
            "content": { "raw": content }
        });

        if let Some(path) = inline_path {
            let mut inline = serde_json::json!({ "path": path });
            if let Some(line) = inline_to_line {
                inline["to"] = serde_json::json!(line);
            }
            body["inline"] = inline;
        }

        if let Some(pid) = parent_id {
            body["parent"] = serde_json::json!({ "id": pid });
        }

        let resp = self
            .client
            .post(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let hint = if status.as_u16() == 403 {
                " — your App Password needs 'Pull requests: Write' permission."
            } else {
                ""
            };
            return Err(format!("Bitbucket returned {status} posting comment{hint}\nBody: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse comment response: {e}"))?;
        Ok(parse_comment(&json))
    }

    /// Create a task linked to a comment on a PR.
    pub async fn create_pr_task(        &self,
        pr_id: i64,
        comment_id: i64,
        content: &str,
    ) -> Result<BitbucketTask, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/tasks"));

        let body = serde_json::json!({
            "content": { "raw": content },
            "comment": { "id": comment_id }
        });

        let resp = self
            .client
            .post(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bitbucket returned {status} creating task\nBody: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse task response: {e}"))?;
        Ok(BitbucketTask {
            id: json["id"].as_i64().unwrap_or(0),
            content: json["content"]["raw"].as_str().unwrap_or("").to_string(),
            resolved: json["state"].as_str().unwrap_or("") == "RESOLVED",
            comment_id: json["comment"]["id"].as_i64(),
        })
    }

    /// Resolve or re-open a task by PATCH /tasks/{task_id}.
    pub async fn resolve_pr_task(&self, pr_id: i64, task_id: i64, resolved: bool) -> Result<BitbucketTask, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/tasks/{task_id}"));
        let state = if resolved { "RESOLVED" } else { "UNRESOLVED" };
        let body = serde_json::json!({ "state": state });

        let resp = self
            .client
            .put(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bitbucket returned {status} updating task\nBody: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse task response: {e}"))?;
        Ok(BitbucketTask {
            id: json["id"].as_i64().unwrap_or(0),
            content: json["content"]["raw"].as_str().unwrap_or("").to_string(),
            resolved: json["state"].as_str().unwrap_or("") == "RESOLVED",
            comment_id: json["comment"]["id"].as_i64(),
        })
    }

    /// Delete a comment from a PR. Only succeeds if the authenticated user is the author.
    pub async fn delete_pr_comment(&self, pr_id: i64, comment_id: i64) -> Result<(), String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/comments/{comment_id}"));

        let resp = self
            .client
            .delete(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let hint = if status.as_u16() == 403 {
                " — you can only delete your own comments, and your App Password needs 'Pull requests: Write' permission."
            } else {
                ""
            };
            return Err(format!("Bitbucket returned {status} deleting comment{hint}\nBody: {text}"));
        }

        Ok(())
    }

    /// Update the content of a PR comment. Only succeeds if the authenticated user is the author.
    pub async fn update_pr_comment(
        &self,
        pr_id: i64,
        comment_id: i64,
        new_content: &str,
    ) -> Result<BitbucketComment, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/comments/{comment_id}"));

        let body = serde_json::json!({
            "content": { "raw": new_content }
        });

        let resp = self
            .client
            .put(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let hint = if status.as_u16() == 403 {
                " — you can only edit your own comments, and your App Password needs 'Pull requests: Write' permission."
            } else {
                ""
            };
            return Err(format!("Bitbucket returned {status} updating comment{hint}\nBody: {text}"));
        }

        let json: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse update response: {e}"))?;

        Ok(parse_comment(&json))
    }
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

fn parse_user(v: &Value) -> BitbucketUser {
    let display_name = v["display_name"].as_str().unwrap_or("").to_string();
    let nickname = v["nickname"].as_str()
        .or_else(|| v["username"].as_str())
        .unwrap_or("")
        .to_string();
    // Fall back to nickname if display_name is missing (some Bitbucket endpoints omit it)
    let display_name = if display_name.is_empty() { nickname.clone() } else { display_name };
    BitbucketUser {
        display_name,
        nickname,
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
        // Bitbucket Cloud uses "author" for comments; fall back to "user" just in case
        author: {
            let author = parse_user(&v["author"]);
            if author.display_name.is_empty() && author.nickname.is_empty() {
                parse_user(&v["user"])
            } else {
                author
            }
        },
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
