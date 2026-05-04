use reqwest::{Client, StatusCode};
use serde_json::Value;
use std::time::Duration;

// ── HTTP client ───────────────────────────────────────────────────────────────

pub struct JiraClient {
    pub(in crate::integrations::jira) client: Client,
    pub base_url: String,
    pub(in crate::integrations::jira) email: String,
    pub(in crate::integrations::jira) api_token: String,
}

impl JiraClient {
    pub fn new(base_url: String, email: String, api_token: String) -> Result<Self, String> {
        // Read the generic SSL verify preference (default: false)
        let disable_ssl_verify = crate::storage::preferences::get_pref("disable_ssl_verify")
            .map(|v| v == "true")
            .unwrap_or(false);
        let client = crate::http::make_corporate_client(Duration::from_secs(15), disable_ssl_verify)?;
        Ok(Self {
            client,
            base_url,
            email,
            api_token,
        })
    }

    pub(in crate::integrations::jira) fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// Fetch arbitrary bytes from this JIRA instance with the client's Basic
    /// auth applied. Used by the image-proxy command so `<img>` tags pointing
    /// at attachment URLs can render in the webview (which can't supply
    /// per-request auth headers on its own).
    pub async fn fetch_authed_bytes(
        &self,
        url: &str,
    ) -> Result<(Vec<u8>, Option<String>), String> {
        let resp = self
            .client
            .get(url)
            .basic_auth(&self.email, Some(&self.api_token))
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    "Could not reach JIRA. Check your internet connection.".to_string()
                } else {
                    format!("Request failed: {e}")
                }
            })?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("JIRA returned {status} fetching {url}"));
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

    pub(in crate::integrations::jira) async fn get_json(&self, url: &str) -> Result<Value, String> {
        let resp = self
            .client
            .get(url)
            .basic_auth(&self.email, Some(&self.api_token))
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    "Could not reach JIRA. Check your internet connection.".to_string()
                } else {
                    format!("Request failed: {e}")
                }
            })?;

        let status = resp.status();

        // Catch redirects before consuming the body — a redirect here almost always
        // means the request was sent to an OAuth/SAML login page.
        if status.is_redirection() {
            let location = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("(no location header)")
                .to_string();
            return Err(format!(
                "JIRA redirected the request to {location} (HTTP {status}). \
                 This usually means your workspace URL is wrong, or your organisation \
                 uses a proxy/SSO that intercepts API calls. \
                 Check your workspace URL in Settings."
            ));
        }

        let www_auth = resp
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        match status {
            StatusCode::OK => resp
                .json::<Value>()
                .await
                .map_err(|e| format!("Failed to parse JIRA response: {e}")),
            StatusCode::UNAUTHORIZED => {
                let body = resp.text().await.unwrap_or_default();
                let body_excerpt = if body.len() > 400 { &body[..400] } else { &body };
                let detail = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| {
                        v["message"].as_str()
                            .or_else(|| v["errorMessages"].get(0).and_then(|m| m.as_str()))
                            .map(str::to_string)
                    });
                let mut parts = vec![format!("JIRA returned 401 Unauthorized for {url}.")];
                if !www_auth.is_empty() {
                    parts.push(format!("WWW-Authenticate: {www_auth}"));
                }
                if let Some(d) = detail {
                    parts.push(format!("JIRA message: \"{d}\""));
                } else if !body_excerpt.is_empty() {
                    parts.push(format!("Body: {body_excerpt}"));
                }
                parts.push(
                    "Check your email and API token in Settings — the token may have \
                     expired or been revoked. Generate a new one at \
                     id.atlassian.com → Security → API tokens."
                        .to_string(),
                );
                Err(parts.join("\n"))
            }
            StatusCode::FORBIDDEN => {
                let body = resp.text().await.unwrap_or_default();
                let body_excerpt = if body.len() > 400 { &body[..400] } else { &body };
                let detail = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| {
                        v["message"].as_str()
                            .or_else(|| v["errorMessages"].get(0).and_then(|m| m.as_str()))
                            .map(str::to_string)
                    });
                let mut parts = vec![format!("JIRA returned 403 Forbidden for {url}.")];
                if !www_auth.is_empty() {
                    parts.push(format!("WWW-Authenticate: {www_auth}"));
                }
                if let Some(d) = detail {
                    parts.push(format!("JIRA message: \"{d}\""));
                } else if !body_excerpt.is_empty() {
                    parts.push(format!("Body: {body_excerpt}"));
                }
                parts.push(
                    "Your account may lack permission to access this board or resource. \
                     Check that the board ID in Settings is correct and that your account \
                     has Browse Projects and Agile board permissions in JIRA."
                        .to_string(),
                );
                Err(parts.join("\n"))
            }
            StatusCode::NOT_FOUND => Err(format!(
                "JIRA resource not found (404): {url} — \
                 check your board ID in Settings and ensure the board exists."
            )),
            s => {
                let body = resp.text().await.unwrap_or_default();
                let body_excerpt = if body.len() > 400 { &body[..400] } else { &body };
                Err(format!("JIRA returned unexpected status {s} for {url}.\nBody: {body_excerpt}"))
            }
        }
    }
}
