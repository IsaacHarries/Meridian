use crate::integrations::jira::client::JiraClient;
use crate::integrations::jira::types::JiraFieldMeta;

impl JiraClient {
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
}
