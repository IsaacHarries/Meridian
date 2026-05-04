use reqwest::{Client, StatusCode};
use serde_json::Value;
use std::time::Duration;

// ── HTTP client ───────────────────────────────────────────────────────────────

pub struct BitbucketClient {
    pub(super) client: Client,
    pub(super) workspace: String,
    pub(super) repo_slug: String,
    /// Bitbucket username (email or account username) — used as the Basic auth user.
    pub(super) username: String,
    /// Bitbucket App Password — used as the Basic auth password.
    pub(super) access_token: String,
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

    pub(super) fn repo_url(&self, path: &str) -> String {
        format!(
            "https://api.bitbucket.org/2.0/repositories/{}/{}{path}",
            self.workspace, self.repo_slug
        )
    }

    pub(super) async fn get_json(&self, url: &str) -> Result<Value, String> {
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

    pub(super) async fn get_text(&self, url: &str) -> Result<String, String> {
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

    /// POST with no body — used for approve (empty body is correct per Bitbucket docs).
    pub(super) async fn post_empty(&self, url: &str) -> Result<(), String> {
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
    pub(super) async fn delete_req(&self, url: &str) -> Result<(), String> {
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

    /// Fetch arbitrary bytes from Bitbucket with this client's Basic auth
    /// applied. Used to proxy `<img>` requests in PR descriptions / comments,
    /// since the Tauri webview can't supply per-request auth headers and
    /// Bitbucket-hosted images (attachments, user-content URLs) all sit
    /// behind auth.
    ///
    /// Caller must have already validated that `url` points at a Bitbucket
    /// host — this method does not re-check; it just trusts and forwards.
    pub async fn fetch_authed_bytes(
        &self,
        url: &str,
    ) -> Result<(Vec<u8>, Option<String>), String> {
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
        if !status.is_success() {
            return Err(format!(
                "Bitbucket returned {status} fetching {url}",
            ));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed to read image bytes: {e}"))?;
        Ok((bytes.to_vec(), content_type))
    }
}
