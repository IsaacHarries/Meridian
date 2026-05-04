use std::collections::HashMap;

use crate::integrations::jira::client::JiraClient;
use crate::integrations::jira::parsing::{
    field_value_to_string, issue_fields_with_custom, parse_issue,
};
use crate::integrations::jira::types::{CustomFieldConfig, JiraIssue, RawIssueField};

impl JiraClient {
    // ── Issues ────────────────────────────────────────────────────────────────

    pub async fn get_sprint_issues(
        &self,
        sprint_id: i64,
        complete_date: Option<&str>,
        custom_fields: &CustomFieldConfig,
    ) -> Result<Vec<JiraIssue>, String> {
        let fields = issue_fields_with_custom(custom_fields);
        let url = self.url(&format!(
            "/rest/agile/1.0/sprint/{sprint_id}/issue?maxResults=100&expand=changelog&fields={fields}"
        ));
        let body = self.get_json(&url).await?;
        let issues = body["issues"].as_array().cloned().unwrap_or_default();
        Ok(issues.iter().map(|i| parse_issue(i, &self.base_url, custom_fields, complete_date)).collect())
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

        Ok(parse_issue(&body, &self.base_url, &auto_cfg, None))
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
        Ok(issues.iter().map(|i| parse_issue(i, &self.base_url, custom_fields, None)).collect())
    }

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
                // Custom rich-text fields (e.g. acceptance criteria, steps to reproduce)
                // require ADF in JIRA v3. Wrap multi-paragraph text in ADF doc nodes.
                let paragraphs: Vec<serde_json::Value> = text
                    .split("\n\n")
                    .filter(|p| !p.trim().is_empty())
                    .map(|para| {
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
                    "content": if paragraphs.is_empty() {
                        vec![serde_json::json!({ "type": "paragraph", "content": [] })]
                    } else {
                        paragraphs
                    }
                });
                fields_payload.insert(key.clone(), adf);
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
