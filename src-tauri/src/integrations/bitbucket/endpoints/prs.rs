use reqwest::StatusCode;
use serde_json::Value;

use super::super::client::BitbucketClient;
use super::super::parsing::parse_pr;
use super::super::types::BitbucketPr;

impl BitbucketClient {
    // ── Pull Requests ─────────────────────────────────────────────────────────

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

    /// Full contents of `path` as it exists at the PR's source commit. Used by
    /// the diff viewer to show context surrounding the changed hunks.
    pub async fn get_pr_file_content(&self, pr_id: i64, path: &str) -> Result<String, String> {
        let pr_url = self.repo_url(&format!("/pullrequests/{pr_id}"));
        let pr_json = self.get_json(&pr_url).await?;
        let commit_hash = pr_json["source"]["commit"]["hash"]
            .as_str()
            .ok_or("Could not determine PR source commit hash")?;
        let file_url = self.repo_url(&format!("/src/{commit_hash}/{path}"));
        self.get_text(&file_url).await
    }

    /// Upload an image as a PR-level attachment via Bitbucket's undocumented
    /// `/pullrequests/{id}/attachments` endpoint. Mirrors the behaviour of
    /// the web UI's "paste an image" flow: we POST a multipart form with the
    /// file under field `files`, and Bitbucket returns a JSON document
    /// listing the uploaded files with reference URLs.
    ///
    /// This endpoint is undocumented — it may change shape, or be locked
    /// down to session auth (vs. App Password) at any time. The caller is
    /// expected to surface failures clearly so the user can switch back to
    /// the data-URI fallback in Settings.
    pub async fn upload_pr_attachment(
        &self,
        pr_id: i64,
        filename: &str,
        bytes: Vec<u8>,
        content_type: Option<&str>,
    ) -> Result<String, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/attachments"));
        let mut part = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string());
        if let Some(ct) = content_type {
            part = part.mime_str(ct).map_err(|e| format!("Invalid content-type '{ct}': {e}"))?;
        }
        let form = reqwest::multipart::Form::new().part("files", part);

        let resp = self
            .client
            .post(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .multipart(form)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    "Could not reach Bitbucket. Check your internet connection.".to_string()
                } else {
                    format!("Upload failed: {e}")
                }
            })?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Bitbucket returned {status} uploading attachment to {url}. Body: {body}",
            ));
        }

        // Bitbucket's documented response for issue attachments returns a
        // `values` array with `links.self.href`. We try that first, and fall
        // back to scanning the entire response for any plausible URL — the
        // PR-attachment endpoint isn't documented, so its exact shape is
        // observed empirically.
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("Could not parse upload response: {e}"))?;

        if let Some(values) = body["values"].as_array() {
            if let Some(first) = values.first() {
                if let Some(href) = first["links"]["self"]["href"].as_str() {
                    return Ok(href.to_string());
                }
                if let Some(name) = first["name"].as_str() {
                    // Some shape variants return only a name; reconstruct the
                    // canonical attachment URL from it. The browser proxy
                    // (`fetch_bitbucket_image`) handles auth on retrieval.
                    return Ok(self.repo_url(&format!(
                        "/pullrequests/{pr_id}/attachments/{name}",
                    )));
                }
            }
        }

        Err(format!(
            "Upload succeeded but Bitbucket's response shape was unexpected — could not locate the attachment URL. Raw response: {body}",
        ))
    }
}
