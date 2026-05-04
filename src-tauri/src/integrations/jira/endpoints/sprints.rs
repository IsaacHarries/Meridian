use crate::integrations::jira::client::JiraClient;
use crate::integrations::jira::parsing::parse_sprint;
use crate::integrations::jira::types::JiraSprint;

impl JiraClient {
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
}
