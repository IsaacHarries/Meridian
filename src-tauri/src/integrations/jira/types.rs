use serde::Serialize;
use std::collections::HashMap;

// ── Output types (returned to the frontend via Tauri commands) ───────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JiraSprint {
    pub id: i64,
    pub name: String,
    pub state: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Set only on closed sprints — the timestamp when the sprint was completed.
    pub complete_date: Option<String>,
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
    /// ISO-8601 timestamp when the issue was resolved (transitioned to Done).
    /// None if unresolved or if the field was not fetched.
    pub resolution_date: Option<String>,
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
    /// True if the issue was in a Done-category status at the sprint's completeDate.
    /// None when no sprint close date was available (e.g. active sprint or non-sprint fetch).
    pub completed_in_sprint: Option<bool>,
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
