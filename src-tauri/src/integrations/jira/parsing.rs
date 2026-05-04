use serde_json::Value;
use std::collections::HashMap;

use super::adf::{collect_adf_markdown, collect_adf_text, extract_adf_markdown};
use super::types::{CustomFieldConfig, DescriptionSection, JiraIssue, JiraSprint, JiraUser};

pub(in crate::integrations::jira) fn issue_fields_with_custom(cfg: &CustomFieldConfig) -> String {
    let mut base = "summary,status,assignee,reporter,issuetype,priority,\
        customfield_10016,customfield_10028,labels,description,parent,created,updated,resolutiondate"
        .to_string();
    for id in cfg.all_field_ids() {
        base.push(',');
        base.push_str(&id);
    }
    base
}

pub(in crate::integrations::jira) fn parse_sprint(v: &Value) -> JiraSprint {
    JiraSprint {
        id: v["id"].as_i64().unwrap_or(0),
        name: v["name"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("").to_string(),
        start_date: v["startDate"].as_str().map(str::to_string),
        end_date: v["endDate"].as_str().map(str::to_string),
        complete_date: v["completeDate"].as_str().map(str::to_string),
        goal: v["goal"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    }
}

pub(in crate::integrations::jira) fn parse_issue(v: &Value, base_url: &str, cfg: &CustomFieldConfig, sprint_complete_date: Option<&str>) -> JiraIssue {
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

    // The description is rendered with MarkdownBlock on the frontend, so
    // route it through the markdown projection (preserves bold / italic /
    // code / links / headings / lists / image embeds) instead of the
    // formatting-stripping plain-text path.
    let description = extract_adf_markdown(&fields["description"], base_url);

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

    let description_sections = parse_adf_description(&fields["description"], base_url);

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
        .and_then(|id| extract_field_text(&fields[id], base_url))
        .or_else(|| {
            if issue_type_name.eq_ignore_ascii_case("story") {
                extract_story_ac_from_description_table(&fields["description"])
            } else {
                None
            }
        });
    let steps_to_reproduce = cfg.steps_to_reproduce.as_deref()
        .and_then(|id| extract_field_text(&fields[id], base_url))
        .or_else(|| find_section_content(&description_sections, &[
            "Steps to Reproduce", "Steps To Reproduce", "Steps to reproduce",
            "Reproduction Steps", "How to Reproduce",
        ]));
    let observed_behavior = cfg.observed_behavior.as_deref()
        .and_then(|id| extract_field_text(&fields[id], base_url))
        .or_else(|| find_section_content(&description_sections, &[
            "Observed Behavior", "Observed Behaviour", "Observed behavior", "Observed behaviour",
            "Current Behavior", "Current Behaviour", "Actual Behavior", "Actual Behaviour",
        ]));
    let expected_behavior = cfg.expected_behavior.as_deref()
        .and_then(|id| extract_field_text(&fields[id], base_url))
        .or_else(|| find_section_content(&description_sections, &[
            "Expected Behavior", "Expected Behaviour", "Expected behavior", "Expected behaviour",
            "Expected Result", "Expected Results",
        ]));

    let mut extra_fields: HashMap<String, String> = HashMap::new();
    for (display_name, field_id) in &cfg.extra {
        if let Some(text) = extract_field_text(&fields[field_id], base_url) {
            extra_fields.insert(display_name.clone(), text);
        }
    }

    // Determine whether this issue was in a Done-category status at sprint close.
    // Walk the changelog backwards: any status change that occurred AFTER the sprint's
    // completeDate is "undone" to reconstruct the status at the close snapshot.
    let completed_in_sprint = sprint_complete_date.map(|close_ts| {
        // Collect all status-change history items, newest first.
        let mut status_changes: Vec<(String, String, String)> = v["changelog"]["histories"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|h| {
                let created = h["created"].as_str()?.to_string();
                h["items"].as_array()?.iter().find_map(|item| {
                    if item["field"].as_str() == Some("status") {
                        Some((
                            created.clone(),
                            item["fromString"].as_str().unwrap_or("").to_string(),
                            item["toString"].as_str().unwrap_or("").to_string(),
                        ))
                    } else {
                        None
                    }
                })
            })
            .collect();

        // Sort newest-first so we can peel off post-close changes.
        status_changes.sort_by(|a, b| b.0.cmp(&a.0));

        // Start from the current status name and rewind any changes made after close.
        let mut effective_status = status.clone();
        for (changed_at, from_status, to_status) in &status_changes {
            if changed_at.as_str() > close_ts {
                // This change happened after the sprint closed — undo it.
                if effective_status == *to_status {
                    effective_status = from_status.clone();
                }
            }
        }

        // Determine Done category. If the effective status matches the current status,
        // we can use the known category. Otherwise, match against common Done status names.
        if effective_status == status {
            status_category == "Done"
        } else {
            let s = effective_status.to_lowercase();
            matches!(s.as_str(),
                "done" | "closed" | "resolved" | "complete" | "completed" |
                "won't fix" | "wont fix" | "cannot reproduce" | "duplicate" | "fixed"
            )
        }
    });

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
        resolution_date: fields["resolutiondate"].as_str().map(str::to_string),
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
        completed_in_sprint,
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
/// Handles ADF docs (projected to markdown so the frontend can render
/// bold / italic / lists / code / links the way JIRA does), plain
/// strings, and numeric values.
pub(in crate::integrations::jira) fn extract_field_text(v: &Value, base_url: &str) -> Option<String> {
    if v.is_null() {
        return None;
    }
    // ADF document
    if v.get("type").and_then(|t| t.as_str()) == Some("doc") {
        return extract_adf_markdown(v, base_url);
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
pub(in crate::integrations::jira) fn field_value_to_string(v: &Value) -> String {
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

fn parse_adf_description(v: &Value, base_url: &str) -> Vec<DescriptionSection> {
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
                    // Headings stay plain text — they're rendered by the UI as
                    // a labelled section title, not interpreted as markdown.
                    let heading_text = collect_adf_text(node).trim().to_string();
                    current_section = DescriptionSection {
                        heading: if heading_text.is_empty() { None } else { Some(heading_text) },
                        content: String::new(),
                    };
                }
                _ => {
                    // Body content emits markdown so the frontend can render
                    // images (and any future inline-media kinds) — the same
                    // string still reads cleanly as plain text for non-image
                    // content because plain prose round-trips identically.
                    let text = collect_adf_markdown(node, base_url);
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
