use serde_json::Value;

use super::super::client::BitbucketClient;
use super::super::parsing::parse_comment;
use super::super::types::BitbucketComment;

impl BitbucketClient {
    pub async fn get_pr_comments(&self, pr_id: i64) -> Result<Vec<BitbucketComment>, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/comments?pagelen=100"));
        let body = self.get_json(&url).await?;
        let values = body["values"].as_array().cloned().unwrap_or_default();
        // Debug: log the first comment's raw JSON so we can see the author field structure
        if let Some(first) = values.first() {
            eprintln!("[meridian] first comment author JSON: {}", first["author"]);
        }
        Ok(values.iter().map(parse_comment).collect())
    }

    /// Post a comment on a PR. Pass `inline_path` + `inline_to_line` to create an
    /// inline comment anchored to a specific file and line in the new version of
    /// the diff. Pass `parent_id` to reply to an existing comment thread.
    pub async fn post_pr_comment(
        &self,
        pr_id: i64,
        content: &str,
        inline_path: Option<&str>,
        inline_to_line: Option<i64>,
        parent_id: Option<i64>,
    ) -> Result<BitbucketComment, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/comments"));

        let mut body = serde_json::json!({
            "content": { "raw": content }
        });

        if let Some(path) = inline_path {
            let mut inline = serde_json::json!({ "path": path });
            if let Some(line) = inline_to_line {
                inline["to"] = serde_json::json!(line);
            }
            body["inline"] = inline;
        }

        if let Some(pid) = parent_id {
            body["parent"] = serde_json::json!({ "id": pid });
        }

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
            let hint = if status.as_u16() == 403 {
                " — your App Password needs 'Pull requests: Write' permission."
            } else {
                ""
            };
            return Err(format!("Bitbucket returned {status} posting comment{hint}\nBody: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse comment response: {e}"))?;
        Ok(parse_comment(&json))
    }

    /// Delete a comment from a PR. Only succeeds if the authenticated user is the author.
    pub async fn delete_pr_comment(&self, pr_id: i64, comment_id: i64) -> Result<(), String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/comments/{comment_id}"));

        let resp = self
            .client
            .delete(&url)
            .basic_auth(&self.username, Some(&self.access_token))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let hint = if status.as_u16() == 403 {
                " — you can only delete your own comments, and your App Password needs 'Pull requests: Write' permission."
            } else {
                ""
            };
            return Err(format!("Bitbucket returned {status} deleting comment{hint}\nBody: {text}"));
        }

        Ok(())
    }

    /// Update the content of a PR comment. Only succeeds if the authenticated user is the author.
    pub async fn update_pr_comment(
        &self,
        pr_id: i64,
        comment_id: i64,
        new_content: &str,
    ) -> Result<BitbucketComment, String> {
        let url = self.repo_url(&format!("/pullrequests/{pr_id}/comments/{comment_id}"));

        let body = serde_json::json!({
            "content": { "raw": new_content }
        });

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
            let hint = if status.as_u16() == 403 {
                " — you can only edit your own comments, and your App Password needs 'Pull requests: Write' permission."
            } else {
                ""
            };
            return Err(format!("Bitbucket returned {status} updating comment{hint}\nBody: {text}"));
        }

        let json: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse update response: {e}"))?;

        Ok(parse_comment(&json))
    }
}
