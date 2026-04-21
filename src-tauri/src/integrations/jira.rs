use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
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

/// A single heading + body section parsed out of the JIRA ADF description.
/// heading is None for content that appears before the first heading.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DescriptionSection {
    pub heading: Option<String>,
    pub content: String,
}

/// A single field entry returned by the raw-field inspector.
/// Includes the machine ID, the human-readable name (from JIRA's `names` expand),
/// and a short display value. No admin permissions required.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RawIssueField {
    pub id: String,
    pub name: String,
    pub value: String,
}

/// Metadata about a single JIRA custom field (id + name + type).
/// Returned by the /rest/api/3/field endpoint (may require admin on some instances).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JiraFieldMeta {
    pub id: String,
    pub name: String,
    pub field_type: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssue {
    pub id: String,
    pub key: String,
    pub url: String,
    pub summary: String,
    pub description: Option<String>,
    /// Structured sections parsed from the ADF description (heading → body pairs).
    /// Empty when the description has no headings (plain prose only).
    pub description_sections: Vec<DescriptionSection>,
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
    /// Acceptance criteria — extracted from a custom field if configured via
    /// the `jira_field_acceptance_criteria` setting, otherwise None.
    pub acceptance_criteria: Option<String>,
    /// Steps to reproduce — from a custom field if configured.
    pub steps_to_reproduce: Option<String>,
    /// Observed behaviour — from a custom field if configured.
    pub observed_behavior: Option<String>,
    /// Expected behaviour — from a custom field if configured.
    pub expected_behavior: Option<String>,
    /// Any extra configured custom fields, keyed by the field name (not ID).
    pub extra_fields: std::collections::HashMap<String, String>,
    /// Mapping of semantic field name → discovered JIRA field ID.
    /// e.g. { "acceptance_criteria": "customfield_10034", "steps_to_reproduce": "customfield_10070" }
    /// Empty map if the field was not discovered. Only populated by get_issue (full detail fetch).
    pub discovered_field_ids: std::collections::HashMap<String, String>,
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

    /// Future (not-yet-started) sprints for the configured board, sorted by
    /// start date ascending (soonest first). Returns at most `limit` sprints.
    pub async fn get_future_sprints(
        &self,
        board_id: i64,
        limit: usize,
    ) -> Result<Vec<JiraSprint>, String> {
        let url = self.url(&format!(
            "/rest/agile/1.0/board/{board_id}/sprint?state=future&maxResults=50"
        ));
        let body = self.get_json(&url).await?;
        let values = body["values"].as_array().cloned().unwrap_or_default();
        let mut sprints: Vec<JiraSprint> = values.iter().map(parse_sprint).collect();
        // Sort by startDate ascending — nearest upcoming sprint first.
        sprints.sort_by(|a, b| {
            let a_start = a.start_date.as_deref().unwrap_or("");
            let b_start = b.start_date.as_deref().unwrap_or("");
            a_start.cmp(b_start)
        });
        sprints.truncate(limit);
        Ok(sprints)
    }

    // ── Issues ────────────────────────────────────────────────────────────────

    pub async fn get_sprint_issues(
        &self,
        sprint_id: i64,
        custom_fields: &CustomFieldConfig,
    ) -> Result<Vec<JiraIssue>, String> {
        let fields = issue_fields_with_custom(custom_fields);
        let url = self.url(&format!(
            "/rest/agile/1.0/sprint/{sprint_id}/issue?maxResults=100&fields={fields}"
        ));
        let body = self.get_json(&url).await?;
        let issues = body["issues"].as_array().cloned().unwrap_or_default();
        Ok(issues.iter().map(|i| parse_issue(i, &self.base_url, custom_fields)).collect())
    }

    pub async fn get_issue(
        &self,
        issue_key: &str,
        custom_fields: &CustomFieldConfig,
    ) -> Result<JiraIssue, String> {
        // Fetch with expand=names so we get ALL fields (including custom ones)
        // and a names map so we can auto-discover custom field IDs by display name.
        let url = self.url(&format!(
            "/rest/api/3/issue/{issue_key}?expand=names"
        ));
        let body = self.get_json(&url).await?;

        // Build a display-name → field-id map from the `names` object.
        let names: HashMap<String, String> = body["names"]
            .as_object()
            .map(|obj| {
                obj.iter()
                    .map(|(id, name)| (name.as_str().unwrap_or("").to_lowercase(), id.clone()))
                    .collect()
            })
            .unwrap_or_default();

        // Auto-discover custom field IDs by well-known display names, falling
        // back to whatever the caller passed in via custom_fields.
        let auto_cfg = CustomFieldConfig {
            acceptance_criteria: custom_fields.acceptance_criteria.clone()
                .or_else(|| names.get("acceptance criteria").cloned())
                .or_else(|| names.get("acceptance_criteria").cloned()),
            steps_to_reproduce: custom_fields.steps_to_reproduce.clone()
                .or_else(|| names.get("steps to reproduce").cloned())
                .or_else(|| names.get("steps_to_reproduce").cloned()),
            observed_behavior: custom_fields.observed_behavior.clone()
                .or_else(|| names.get("observed behavior").cloned())
                .or_else(|| names.get("observed behaviour").cloned()),
            expected_behavior: custom_fields.expected_behavior.clone()
                .or_else(|| names.get("expected behavior").cloned())
                .or_else(|| names.get("expected behaviour").cloned())
                .or_else(|| names.get("expected result").cloned())
                .or_else(|| names.get("expected results").cloned()),
            extra: custom_fields.extra.clone(),
        };

        Ok(parse_issue(&body, &self.base_url, &auto_cfg))
    }

    /// Fetch a raw field map for a single issue with human-readable names.
    /// Uses `?expand=names` so JIRA returns a `names` object mapping every
    /// `customfield_XXXXX` to its display name — no admin permissions required.
    /// Returns fields sorted: standard fields first (alphabetically), then
    /// custom fields (alphabetically by display name).
    pub async fn get_raw_issue_fields(
        &self,
        issue_key: &str,
    ) -> Result<Vec<RawIssueField>, String> {
        // expand=names gives us { names: { "customfield_10034": "Acceptance Criteria", … } }
        let url = self.url(&format!("/rest/api/3/issue/{issue_key}?expand=names"));
        let body = self.get_json(&url).await?;

        // Build a map of field_id → human name from the `names` object
        let names: HashMap<String, String> = body["names"]
            .as_object()
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or(k).to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let fields = &body["fields"];
        if let Some(map) = fields.as_object() {
            let mut standard: Vec<RawIssueField> = vec![];
            let mut custom: Vec<RawIssueField> = vec![];

            for (id, v) in map {
                let display = field_value_to_string(v);
                if display.is_empty() {
                    continue;
                }
                let name = names.get(id).cloned().unwrap_or_else(|| id.clone());
                let entry = RawIssueField { id: id.clone(), name, value: display };
                if id.starts_with("customfield_") {
                    custom.push(entry);
                } else {
                    standard.push(entry);
                }
            }

            standard.sort_by(|a, b| a.id.cmp(&b.id));
            custom.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

            standard.extend(custom);
            Ok(standard)
        } else {
            Ok(vec![])
        }
    }

    /// List all field definitions in the workspace (id + name + type).
    /// Requires field-configuration browse permissions in some instances.
    /// Returns an empty list (not an error) if access is denied (403).
    pub async fn get_all_fields(&self) -> Result<Vec<JiraFieldMeta>, String> {
        let url = self.url("/rest/api/3/field");
        // A 403 here just means the user lacks admin-level field access —
        // return empty rather than surfacing a confusing error.
        let body = match self.get_json(&url).await {
            Ok(b) => b,
            Err(e) if e.contains("403") || e.contains("Forbidden") => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        if let Some(arr) = body.as_array() {
            let mut fields: Vec<JiraFieldMeta> = arr
                .iter()
                .map(|f| JiraFieldMeta {
                    id: f["id"].as_str().unwrap_or("").to_string(),
                    name: f["name"].as_str().unwrap_or("").to_string(),
                    field_type: f["schema"]["type"].as_str().map(str::to_string),
                })
                .collect();
            fields.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            Ok(fields)
        } else {
            Ok(vec![])
        }
    }

    pub async fn search_issues(
        &self,
        jql: &str,
        max_results: usize,
        custom_fields: &CustomFieldConfig,
    ) -> Result<Vec<JiraIssue>, String> {
        let fields_str = issue_fields_with_custom(custom_fields);
        let fields: Vec<&str> = fields_str.split(',').collect();
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
        Ok(issues.iter().map(|i| parse_issue(i, &self.base_url, custom_fields)).collect())
    }
}

// ── Custom field configuration ────────────────────────────────────────────────

/// Holds the custom field IDs configured by the user for their JIRA workspace.
/// All fields are optional — if None the corresponding `JiraIssue` field will be None.
#[derive(Debug, Default, Clone)]
pub struct CustomFieldConfig {
    /// e.g. "customfield_10034" for Acceptance Criteria
    pub acceptance_criteria: Option<String>,
    /// e.g. "customfield_10035"
    pub steps_to_reproduce: Option<String>,
    /// e.g. "customfield_10036"
    pub observed_behavior: Option<String>,
    /// e.g. "customfield_10037"
    pub expected_behavior: Option<String>,
    /// Extra arbitrary mappings: display name → field id.
    /// Populated from `jira_extra_custom_fields` (JSON string in keychain).
    pub extra: HashMap<String, String>,
}

impl CustomFieldConfig {
    /// Collect all configured custom field IDs (deduplicated).
    pub fn all_field_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = vec![];
        if let Some(id) = &self.acceptance_criteria { ids.push(id.clone()); }
        if let Some(id) = &self.steps_to_reproduce  { ids.push(id.clone()); }
        if let Some(id) = &self.observed_behavior    { ids.push(id.clone()); }
        if let Some(id) = &self.expected_behavior    { ids.push(id.clone()); }
        for id in self.extra.values() { ids.push(id.clone()); }
        ids.dedup();
        ids
    }
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

fn issue_fields_with_custom(cfg: &CustomFieldConfig) -> String {
    let mut base = "summary,status,assignee,reporter,issuetype,priority,\
        customfield_10016,customfield_10028,labels,description,parent,created,updated"
        .to_string();
    for id in cfg.all_field_ids() {
        base.push(',');
        base.push_str(&id);
    }
    base
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

fn parse_issue(v: &Value, base_url: &str, cfg: &CustomFieldConfig) -> JiraIssue {
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

    let description_sections = parse_adf_description(&fields["description"]);

    let issue_type_name = fields["issuetype"]["name"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // ── Custom fields ──────────────────────────────────────────────────────────
    // For Story-type issues: if no dedicated Acceptance Criteria custom field is
    // configured (or it is empty), fall back to extracting the Requirements column
    // from the description table — the conventional layout for Story tickets in
    // this workspace (User Story | Requirements table in the description).
    let acceptance_criteria = cfg.acceptance_criteria.as_deref()
        .and_then(|id| extract_field_text(&fields[id]))
        .or_else(|| {
            if issue_type_name.eq_ignore_ascii_case("story") {
                extract_story_ac_from_description_table(&fields["description"])
            } else {
                None
            }
        });
    let steps_to_reproduce = cfg.steps_to_reproduce.as_deref()
        .and_then(|id| extract_field_text(&fields[id]))
        .or_else(|| find_section_content(&description_sections, &[
            "Steps to Reproduce", "Steps To Reproduce", "Steps to reproduce",
            "Reproduction Steps", "How to Reproduce",
        ]));
    let observed_behavior = cfg.observed_behavior.as_deref()
        .and_then(|id| extract_field_text(&fields[id]))
        .or_else(|| find_section_content(&description_sections, &[
            "Observed Behavior", "Observed Behaviour", "Observed behavior", "Observed behaviour",
            "Current Behavior", "Current Behaviour", "Actual Behavior", "Actual Behaviour",
        ]));
    let expected_behavior = cfg.expected_behavior.as_deref()
        .and_then(|id| extract_field_text(&fields[id]))
        .or_else(|| find_section_content(&description_sections, &[
            "Expected Behavior", "Expected Behaviour", "Expected behavior", "Expected behaviour",
            "Expected Result", "Expected Results",
        ]));

    let mut extra_fields: HashMap<String, String> = HashMap::new();
    for (display_name, field_id) in &cfg.extra {
        if let Some(text) = extract_field_text(&fields[field_id]) {
            extra_fields.insert(display_name.clone(), text);
        }
    }

    JiraIssue {
        id: v["id"].as_str().unwrap_or("").to_string(),
        url: format!("{base_url}/browse/{key}"),
        key,
        summary: fields["summary"].as_str().unwrap_or("").to_string(),
        description,
        description_sections,
        status,
        status_category,
        assignee: parse_user(&fields["assignee"]),
        reporter: parse_user(&fields["reporter"]),
        issue_type: issue_type_name,
        priority: fields["priority"]["name"].as_str().map(str::to_string),
        story_points,
        labels,
        epic_key,
        epic_summary,
        created: fields["created"].as_str().unwrap_or("").to_string(),
        updated: fields["updated"].as_str().unwrap_or("").to_string(),
        acceptance_criteria,
        steps_to_reproduce,
        observed_behavior,
        expected_behavior,
        extra_fields,
        discovered_field_ids: {
            let mut m = HashMap::new();
            if let Some(id) = &cfg.acceptance_criteria { m.insert("acceptance_criteria".into(), id.clone()); }
            if let Some(id) = &cfg.steps_to_reproduce  { m.insert("steps_to_reproduce".into(), id.clone()); }
            if let Some(id) = &cfg.observed_behavior   { m.insert("observed_behavior".into(), id.clone()); }
            if let Some(id) = &cfg.expected_behavior   { m.insert("expected_behavior".into(), id.clone()); }
            m
        },
    }
}

/// Look up a section body from parsed description sections by heading name.
/// Matching is case-insensitive. Returns None if no matching heading is found
/// or the matched section has empty content.
fn find_section_content(sections: &[DescriptionSection], headings: &[&str]) -> Option<String> {
    sections
        .iter()
        .find(|s| {
            s.heading
                .as_deref()
                .map(|h| headings.iter().any(|t| h.trim().eq_ignore_ascii_case(t)))
                .unwrap_or(false)
        })
        .map(|s| s.content.clone())
        .filter(|c| !c.is_empty())
}

/// Extract text from a custom field value.
/// Handles ADF docs, plain strings, and numeric values.
fn extract_field_text(v: &Value) -> Option<String> {    if v.is_null() {
        return None;
    }
    // ADF document
    if v.get("type").and_then(|t| t.as_str()) == Some("doc") {
        return extract_adf_text(v);
    }
    // Plain string
    if let Some(s) = v.as_str() {
        let trimmed = s.trim().to_string();
        return if trimmed.is_empty() { None } else { Some(trimmed) };
    }
    // Number
    if let Some(n) = v.as_f64() {
        return Some(n.to_string());
    }
    // Object with a "value" key (e.g. select fields)
    if let Some(s) = v.get("value").and_then(|s| s.as_str()) {
        let trimmed = s.trim().to_string();
        return if trimmed.is_empty() { None } else { Some(trimmed) };
    }
    // Array of values (multi-select)
    if let Some(arr) = v.as_array() {
        let joined: String = arr
            .iter()
            .filter_map(|item| {
                item.get("value").and_then(|s| s.as_str())
                    .or_else(|| item.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .collect::<Vec<_>>()
            .join(", ");
        return if joined.is_empty() { None } else { Some(joined) };
    }
    None
}

/// Convert any field value to a short debug string for the raw-fields diagnostic.
fn field_value_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_string(),
        Value::Array(arr) => {
            if arr.is_empty() {
                return String::new();
            }
            // Try to extract .value or .name from each item
            let items: Vec<String> = arr
                .iter()
                .map(|item| {
                    item.get("value").and_then(|s| s.as_str()).map(str::to_string)
                        .or_else(|| item.get("name").and_then(|s| s.as_str()).map(str::to_string))
                        .or_else(|| item.as_str().map(str::to_string))
                        .unwrap_or_else(|| item.to_string())
                })
                .collect();
            items.join(", ")
        }
        Value::Object(map) => {
            // ADF doc — extract text
            if map.get("type").and_then(|t| t.as_str()) == Some("doc") {
                let text = collect_adf_text(v);
                let trimmed = text.trim().to_string();
                // Limit for display
                if trimmed.len() > 200 {
                    format!("{}…", &trimmed[..200])
                } else {
                    trimmed
                }
            } else {
                // Try common summary fields
                map.get("name").and_then(|s| s.as_str()).map(str::to_string)
                    .or_else(|| map.get("value").and_then(|s| s.as_str()).map(str::to_string))
                    .or_else(|| map.get("displayName").and_then(|s| s.as_str()).map(str::to_string))
                    .or_else(|| map.get("summary").and_then(|s| s.as_str()).map(str::to_string))
                    .unwrap_or_default()
            }
        }
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
            | "blockquote" | "codeBlock" | "rule" | "tableCell" | "tableHeader"
            | "tableRow" | "table" => "\n",
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

/// For Story-type issues: scan the top-level ADF `doc` node for a `table` whose
/// headers indicate a user-story / requirements layout.
///
/// Expected table shape (2 columns):
///   Column 0: User Story  ("As a …, I want …")
///   Column 1: Requirements / Acceptance Criteria
///
/// The function identifies the requirements column by looking for a header cell
/// whose text contains "requirement" or "acceptance" (case-insensitive).  If no
/// such header exists but the table has exactly 2 columns it falls back to
/// treating column 1 as requirements.
///
/// Returns None if no suitable table is found or if the table is empty.
fn extract_story_ac_from_description_table(description_adf: &Value) -> Option<String> {
    let top_content = description_adf
        .get("content")
        .and_then(|c| c.as_array())?;

    for node in top_content {
        let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if node_type != "table" {
            continue;
        }

        let rows = match node.get("content").and_then(|c| c.as_array()) {
            Some(r) => r,
            None => continue,
        };

        // ── Detect which column index holds Requirements ───────────────────────
        // The first row may be a header row (tableHeader cells) or a data row.
        let mut req_col: Option<usize> = None;
        let mut data_rows: Vec<&Value> = vec![];

        for (row_idx, row) in rows.iter().enumerate() {
            let row_type = row.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if row_type != "tableRow" {
                continue;
            }
            let cells = match row.get("content").and_then(|c| c.as_array()) {
                Some(c) => c,
                None => continue,
            };

            // Try to read column headers from first row containing tableHeader cells
            if req_col.is_none() && row_idx == 0 {
                let has_headers = cells
                    .iter()
                    .any(|c| c.get("type").and_then(|t| t.as_str()) == Some("tableHeader"));

                if has_headers {
                    for (col_idx, cell) in cells.iter().enumerate() {
                        let cell_text = collect_adf_text(cell).to_lowercase();
                        if cell_text.contains("requirement")
                            || cell_text.contains("acceptance")
                            || cell_text.contains("criteria")
                        {
                            req_col = Some(col_idx);
                            break;
                        }
                    }
                    // If still not found but exactly 2 columns, default to col 1
                    if req_col.is_none() && cells.len() == 2 {
                        req_col = Some(1);
                    }
                    // Header row — skip for data extraction
                    continue;
                }
            }

            data_rows.push(row);
        }

        // If we never saw a header row, default to column 1 for a 2-column table
        if req_col.is_none() {
            // Peek at the first data row to check column count
            let first_row = data_rows.first().copied().or_else(|| rows.first());
            if let Some(row) = first_row {
                if let Some(cells) = row.get("content").and_then(|c| c.as_array()) {
                    if cells.len() == 2 {
                        req_col = Some(1);
                    }
                }
            }
        }

        let col = match req_col {
            Some(c) => c,
            None => continue, // can't determine requirements column
        };

        // ── Extract requirements text from every data row at `col` ────────────
        let mut entries: Vec<String> = vec![];
        for row in &data_rows {
            if let Some(cells) = row.get("content").and_then(|c| c.as_array()) {
                if let Some(cell) = cells.get(col) {
                    let text = collect_adf_text(cell).trim().to_string();
                    if !text.is_empty() {
                        entries.push(text);
                    }
                }
            }
        }

        if !entries.is_empty() {
            return Some(entries.join("\n\n"));
        }
    }

    None
}

fn parse_adf_description(v: &Value) -> Vec<DescriptionSection> {
    let mut sections = Vec::new();
    if let Some(content) = v.get("content").and_then(|c| c.as_array()) {
        let mut current_section = DescriptionSection {
            heading: None,
            content: String::new(),
        };
        for node in content {
            let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match node_type {
                "heading" => {
                    // Flush the current section before starting a new one.
                    if !current_section.content.is_empty() || current_section.heading.is_some() {
                        let trimmed = current_section.content.trim().to_string();
                        if !trimmed.is_empty() || current_section.heading.is_some() {
                            sections.push(DescriptionSection {
                                heading: current_section.heading,
                                content: trimmed,
                            });
                        }
                    }
                    // Collect all text from the heading node's children.
                    let heading_text = collect_adf_text(node).trim().to_string();
                    current_section = DescriptionSection {
                        heading: if heading_text.is_empty() { None } else { Some(heading_text) },
                        content: String::new(),
                    };
                }
                _ => {
                    let text = collect_adf_text(node);
                    if !text.trim().is_empty() {
                        if !current_section.content.is_empty() {
                            current_section.content.push('\n');
                        }
                        current_section.content.push_str(&text);
                    }
                }
            }
        }
        // Flush the last section.
        let trimmed = current_section.content.trim().to_string();
        if !trimmed.is_empty() || current_section.heading.is_some() {
            sections.push(DescriptionSection {
                heading: current_section.heading,
                content: trimmed,
            });
        }
    }
    sections
}

// ── JiraClient: update issue ──────────────────────────────────────────────────

impl JiraClient {
    /// Update the description (and optionally summary) of an issue.
    /// `description_markdown` is plain text / markdown; we wrap it in ADF format
    /// which is what the JIRA Cloud v3 API expects.
    pub async fn update_issue_description(
        &self,
        issue_key: &str,
        summary: Option<&str>,
        description_markdown: &str,
    ) -> Result<(), String> {
        let url = self.url(&format!("/rest/api/3/issue/{issue_key}"));

        // Convert plain-text / markdown paragraphs to ADF paragraph nodes.
        let paragraphs: Vec<serde_json::Value> = description_markdown
            .split("\n\n")
            .filter(|p| !p.trim().is_empty())
            .map(|para| {
                // Split paragraph lines into text nodes joined by hardBreak nodes.
                let lines: Vec<&str> = para.lines().collect();
                let mut inline_nodes: Vec<serde_json::Value> = vec![];
                for (i, line) in lines.iter().enumerate() {
                    inline_nodes.push(serde_json::json!({
                        "type": "text",
                        "text": line.trim()
                    }));
                    if i < lines.len() - 1 {
                        inline_nodes.push(serde_json::json!({ "type": "hardBreak" }));
                    }
                }
                serde_json::json!({
                    "type": "paragraph",
                    "content": inline_nodes
                })
            })
            .collect();

        let adf = serde_json::json!({
            "version": 1,
            "type": "doc",
            "content": paragraphs
        });

        let mut fields = serde_json::json!({
            "description": adf
        });

        if let Some(s) = summary {
            fields["summary"] = serde_json::Value::String(s.to_string());
        }

        let body = serde_json::json!({ "fields": fields });

        let resp = self
            .client
            .put(&url)
            .basic_auth(&self.email, Some(&self.api_token))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("JIRA update request failed: {e}"))?;

        let status = resp.status();
        if status.is_success() || status.as_u16() == 204 {
            return Ok(());
        }

        let body_text = resp.text().await.unwrap_or_default();
        Err(format!(
            "JIRA returned HTTP {status} when updating {issue_key}: {body_text}"
        ))
    }

    /// Update multiple fields on a JIRA issue in a single PUT request.
    /// `fields_json` is a JSON object mapping JIRA field IDs to plain-text values.
    /// Standard fields: "summary" (plain string).
    /// All other fields are wrapped in ADF doc nodes for the v3 API.
    pub async fn update_fields(
        &self,
        issue_key: &str,
        fields_json: &str,
    ) -> Result<(), String> {
        let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(fields_json)
            .map_err(|e| format!("Invalid fields JSON: {e}"))?;

        let mut fields_payload = serde_json::Map::new();
        for (key, val) in &map {
            let text = val.as_str().unwrap_or("").to_string();
            if key == "summary" {
                // Summary is always a plain string in JIRA v3
                fields_payload.insert(key.clone(), serde_json::Value::String(text));
            } else if key == "description" {
                // Description is always ADF in JIRA v3
                let adf = serde_json::json!({
                    "version": 1,
                    "type": "doc",
                    "content": [{
                        "type": "paragraph",
                        "content": [{ "type": "text", "text": text }]
                    }]
                });
                fields_payload.insert(key.clone(), adf);
            } else {
                // Custom fields (customfield_XXXXX) for acceptance criteria, steps to
                // reproduce, observed/expected behavior etc. are string-type fields —
                // JIRA returns them as plain strings, so we must write them as plain
                // strings. Sending ADF to a string field causes JIRA to silently
                // accept the request (204) but not persist the value correctly.
                fields_payload.insert(key.clone(), serde_json::Value::String(text));
            }
        }

        let url = self.url(&format!("/rest/api/3/issue/{issue_key}"));
        let body = serde_json::json!({ "fields": fields_payload });

        let resp = self
            .client
            .put(&url)
            .basic_auth(&self.email, Some(&self.api_token))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("JIRA update request failed: {e}"))?;

        let status = resp.status();
        if status.is_success() || status.as_u16() == 204 {
            return Ok(());
        }

        let body_text = resp.text().await.unwrap_or_default();
        Err(format!(
            "JIRA returned HTTP {status} when updating fields on {issue_key}: {body_text}"
        ))
    }
}

