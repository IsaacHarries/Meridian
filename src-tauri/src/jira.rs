use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

// ── Output types (returned to the frontend via Tauri commands) ───────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JiraSprint {
    pub id: i64,
    pub name: String,
    pub state: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub goal: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JiraUser {
    pub account_id: String,
    pub display_name: String,
    pub email_address: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssue {
    pub id: String,
    pub key: String,
    pub url: String,
    pub summary: String,
    pub description: Option<String>,
    pub status: String,
    pub status_category: String,
    pub assignee: Option<JiraUser>,
    pub reporter: Option<JiraUser>,
    pub issue_type: String,
    pub priority: Option<String>,
    pub story_points: Option<f64>,
    pub labels: Vec<String>,
    pub epic_key: Option<String>,
    pub epic_summary: Option<String>,
    pub created: String,
    pub updated: String,
}

// ── HTTP client ───────────────────────────────────────────────────────────────

pub struct JiraClient {
    client: Client,
    pub base_url: String,
    email: String,
    api_token: String,
}

impl JiraClient {
    pub fn new(base_url: String, email: String, api_token: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .use_native_tls()
            .build()
            .map_err(|e| format!("HTTP client error: {e}"))?;
        Ok(Self {
            client,
            base_url,
            email,
            api_token,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn get_json(&self, url: &str) -> Result<Value, String> {
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

    // ── Sprints ───────────────────────────────────────────────────────────────

    pub async fn get_active_sprint(&self, board_id: i64) -> Result<Option<JiraSprint>, String> {
        let url = self.url(&format!(
            "/rest/agile/1.0/board/{board_id}/sprint?state=active"
        ));
        let body = self.get_json(&url).await?;
        let values = body["values"].as_array().cloned().unwrap_or_default();
        Ok(values.first().map(parse_sprint))
    }

    pub async fn get_all_active_sprints(&self, board_id: i64) -> Result<Vec<JiraSprint>, String> {
        let url = self.url(&format!(
            "/rest/agile/1.0/board/{board_id}/sprint?state=active"
        ));
        let body = self.get_json(&url).await?;
        let values = body["values"].as_array().cloned().unwrap_or_default();
        Ok(values.iter().map(parse_sprint).collect())
    }

    pub async fn get_completed_sprints(
        &self,
        board_id: i64,
        limit: usize,
    ) -> Result<Vec<JiraSprint>, String> {
        // The Agile API returns sprints oldest-first with no sort parameter.
        // We paginate to collect all closed sprints, then sort newest-first
        // client-side so we always return the most recently completed ones.
        let page_size = 50usize;
        let mut all_sprints: Vec<JiraSprint> = Vec::new();
        let mut start_at = 0usize;

        loop {
            let url = self.url(&format!(
                "/rest/agile/1.0/board/{board_id}/sprint?state=closed&maxResults={page_size}&startAt={start_at}"
            ));
            let body = self.get_json(&url).await?;
            let values = body["values"].as_array().cloned().unwrap_or_default();
            let page_len = values.len();
            all_sprints.extend(values.iter().map(parse_sprint));

            // Stop when the page is smaller than requested (last page) or
            // when we already have far more than we need.
            let is_last = body["isLast"].as_bool().unwrap_or(false);
            if is_last || page_len < page_size || all_sprints.len() >= 500 {
                break;
            }
            start_at += page_len;
        }

        // Sort by endDate descending — most recently completed sprint first.
        // Sprints with no endDate sort to the end.
        all_sprints.sort_by(|a, b| {
            let a_end = a.end_date.as_deref().unwrap_or("");
            let b_end = b.end_date.as_deref().unwrap_or("");
            b_end.cmp(a_end)
        });
        all_sprints.truncate(limit);
        Ok(all_sprints)
    }

    // ── Issues ────────────────────────────────────────────────────────────────

    pub async fn get_sprint_issues(&self, sprint_id: i64) -> Result<Vec<JiraIssue>, String> {
        let fields = issue_fields();
        let url = self.url(&format!(
            "/rest/agile/1.0/sprint/{sprint_id}/issue?maxResults=100&fields={fields}"
        ));
        let body = self.get_json(&url).await?;
        let issues = body["issues"].as_array().cloned().unwrap_or_default();
        Ok(issues.iter().map(|i| parse_issue(i, &self.base_url)).collect())
    }

    pub async fn get_issue(&self, issue_key: &str) -> Result<JiraIssue, String> {
        let fields = issue_fields();
        let url = self.url(&format!(
            "/rest/api/3/issue/{issue_key}?fields={fields}"
        ));
        let body = self.get_json(&url).await?;
        Ok(parse_issue(&body, &self.base_url))
    }

    pub async fn search_issues(
        &self,
        jql: &str,
        max_results: usize,
    ) -> Result<Vec<JiraIssue>, String> {
        let fields: Vec<&str> = issue_fields().split(',').collect();
        let url = self.url("/rest/api/3/search/jql");
        let payload = serde_json::json!({
            "jql": jql,
            "maxResults": max_results,
            "fields": fields,
        });
        let resp = self
            .client
            .post(&url)
            .basic_auth(&self.email, Some(&self.api_token))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if status.is_redirection() {
            let location = resp.headers().get("location")
                .and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            return Err(format!("JIRA redirected search to {location}"));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let excerpt = if body.len() > 400 { &body[..400] } else { &body };
            return Err(format!("JIRA search returned {status}. Body: {excerpt}"));
        }
        let body = resp.json::<serde_json::Value>().await
            .map_err(|e| format!("Failed to parse JIRA search response: {e}"))?;
        let issues = body["issues"].as_array().cloned().unwrap_or_default();
        Ok(issues.iter().map(|i| parse_issue(i, &self.base_url)).collect())
    }
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

fn issue_fields() -> &'static str {
    "summary,status,assignee,reporter,issuetype,priority,customfield_10016,customfield_10028,labels,description,parent,created,updated"
}

fn parse_sprint(v: &Value) -> JiraSprint {
    JiraSprint {
        id: v["id"].as_i64().unwrap_or(0),
        name: v["name"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("").to_string(),
        start_date: v["startDate"].as_str().map(str::to_string),
        end_date: v["endDate"].as_str().map(str::to_string),
        goal: v["goal"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    }
}

fn parse_issue(v: &Value, base_url: &str) -> JiraIssue {
    let key = v["key"].as_str().unwrap_or("").to_string();
    let fields = &v["fields"];

    let status = fields["status"]["name"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let status_category = fields["status"]["statusCategory"]["name"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // Story points: try customfield_10016 (most common), then customfield_10028
    let story_points = fields["customfield_10016"]
        .as_f64()
        .or_else(|| fields["customfield_10028"].as_f64());

    let labels = fields["labels"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let description = extract_adf_text(&fields["description"]);

    // Epic: parent field with issuetype "Epic"
    let (epic_key, epic_summary) = {
        let parent = &fields["parent"];
        if parent.is_object() {
            let parent_type = parent["fields"]["issuetype"]["name"]
                .as_str()
                .unwrap_or("");
            if parent_type == "Epic" {
                (
                    parent["key"].as_str().map(str::to_string),
                    parent["fields"]["summary"].as_str().map(str::to_string),
                )
            } else {
                (None, None)
            }
        } else {
            (None, None)
        }
    };

    JiraIssue {
        id: v["id"].as_str().unwrap_or("").to_string(),
        url: format!("{base_url}/browse/{key}"),
        key,
        summary: fields["summary"].as_str().unwrap_or("").to_string(),
        description,
        status,
        status_category,
        assignee: parse_user(&fields["assignee"]),
        reporter: parse_user(&fields["reporter"]),
        issue_type: fields["issuetype"]["name"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        priority: fields["priority"]["name"].as_str().map(str::to_string),
        story_points,
        labels,
        epic_key,
        epic_summary,
        created: fields["created"].as_str().unwrap_or("").to_string(),
        updated: fields["updated"].as_str().unwrap_or("").to_string(),
    }
}

fn parse_user(v: &Value) -> Option<JiraUser> {
    if v.is_null() || !v.is_object() {
        return None;
    }
    Some(JiraUser {
        account_id: v["accountId"].as_str().unwrap_or("").to_string(),
        display_name: v["displayName"].as_str().unwrap_or("").to_string(),
        email_address: v["emailAddress"].as_str().map(str::to_string),
    })
}

/// Recursively extract plain text from an Atlassian Document Format (ADF) node.
fn extract_adf_text(node: &Value) -> Option<String> {
    if node.is_null() || !node.is_object() {
        return None;
    }
    let text = collect_adf_text(node);
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn collect_adf_text(node: &Value) -> String {
    // Leaf text node
    if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
        return text.to_string();
    }
    // Block/inline node with children
    if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
        let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let separator = match node_type {
            "paragraph" | "heading" | "bulletList" | "orderedList" | "listItem"
            | "blockquote" | "codeBlock" | "rule" => "\n",
            _ => " ",
        };
        return content
            .iter()
            .map(collect_adf_text)
            .collect::<Vec<_>>()
            .join(separator);
    }
    String::new()
}

