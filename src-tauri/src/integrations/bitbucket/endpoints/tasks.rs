use super::super::client::BitbucketClient;
use super::super::types::BitbucketTask;

impl BitbucketClient {
    pub async fn get_pr_tasks(&self, pr_id: i64) -> Result<Vec<BitbucketTask>, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/tasks?pagelen=100"));
        let body = self.get_json(&url).await?;
        let values = body["values"].as_array().cloned().unwrap_or_default();
        Ok(values
            .iter()
            .map(|t| BitbucketTask {
                id: t["id"].as_i64().unwrap_or(0),
                content: t["content"]["raw"].as_str().unwrap_or("").to_string(),
                resolved: t["state"].as_str().unwrap_or("") == "RESOLVED",
                comment_id: t["comment"]["id"].as_i64(),
            })
            .collect())
    }

    /// Create a task linked to a comment on a PR.
    pub async fn create_pr_task(        &self,
        pr_id: i64,
        comment_id: i64,
        content: &str,
    ) -> Result<BitbucketTask, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/tasks"));

        let body = serde_json::json!({
            "content": { "raw": content },
            "comment": { "id": comment_id }
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
            return Err(format!("Bitbucket returned {status} creating task\nBody: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse task response: {e}"))?;
        Ok(BitbucketTask {
            id: json["id"].as_i64().unwrap_or(0),
            content: json["content"]["raw"].as_str().unwrap_or("").to_string(),
            resolved: json["state"].as_str().unwrap_or("") == "RESOLVED",
            comment_id: json["comment"]["id"].as_i64(),
        })
    }

    /// Update a task's text content via PUT /tasks/{task_id}.
    pub async fn update_pr_task(&self, pr_id: i64, task_id: i64, content: &str) -> Result<BitbucketTask, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/tasks/{task_id}"));
        let body = serde_json::json!({ "content": { "raw": content } });

        let resp = self
            .client
            .put(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bitbucket returned {status} updating task\nBody: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse task response: {e}"))?;
        Ok(BitbucketTask {
            id: json["id"].as_i64().unwrap_or(0),
            content: json["content"]["raw"].as_str().unwrap_or("").to_string(),
            resolved: json["state"].as_str().unwrap_or("") == "RESOLVED",
            comment_id: json["comment"]["id"].as_i64(),
        })
    }

    /// Resolve or re-open a task by PATCH /tasks/{task_id}.
    pub async fn resolve_pr_task(&self, pr_id: i64, task_id: i64, resolved: bool) -> Result<BitbucketTask, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/tasks/{task_id}"));
        let state = if resolved { "RESOLVED" } else { "UNRESOLVED" };
        let body = serde_json::json!({ "state": state });

        let resp = self
            .client
            .put(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bitbucket returned {status} updating task\nBody: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse task response: {e}"))?;
        Ok(BitbucketTask {
            id: json["id"].as_i64().unwrap_or(0),
            content: json["content"]["raw"].as_str().unwrap_or("").to_string(),
            resolved: json["state"].as_str().unwrap_or("") == "RESOLVED",
            comment_id: json["comment"]["id"].as_i64(),
        })
    }
}
