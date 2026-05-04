use serde_json::Value;

use super::types::{
    BitbucketComment, BitbucketInlineContext, BitbucketPr, BitbucketReviewer, BitbucketUser,
};

// ── Parsing helpers ───────────────────────────────────────────────────────────

pub(super) fn parse_user(v: &Value) -> BitbucketUser {
    let display_name = v["display_name"].as_str().unwrap_or("").to_string();
    let nickname = v["nickname"].as_str()
        .or_else(|| v["username"].as_str())
        .unwrap_or("")
        .to_string();
    // Fall back to nickname if display_name is missing (some Bitbucket endpoints omit it)
    let display_name = if display_name.is_empty() { nickname.clone() } else { display_name };
    BitbucketUser {
        display_name,
        nickname,
        account_id: v["account_id"].as_str().map(str::to_string),
    }
}

pub(super) fn parse_pr(v: &Value) -> BitbucketPr {
    let title = v["title"].as_str().unwrap_or("").to_string();
    let description = v["description"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let source_branch = v["source"]["branch"]["name"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // Extract the first JIRA-style key (PROJ-123) from title, branch, or description
    let jira_issue_key = extract_jira_key(&title)
        .or_else(|| extract_jira_key(&source_branch))
        .or_else(|| description.as_deref().and_then(extract_jira_key));

    // Build a lookup of account_id -> (approved, state) from the participants array.
    // The reviewers[] array only has identity fields; approval state lives in participants[].
    let mut participant_approval: std::collections::HashMap<String, (bool, String)> =
        std::collections::HashMap::new();
    let mut changes_requested = false;
    if let Some(parts) = v["participants"].as_array() {
        for p in parts {
            if let Some(account_id) = p["user"]["account_id"].as_str() {
                let approved = p["approved"].as_bool().unwrap_or(false);
                let state = p["state"]
                    .as_str()
                    .unwrap_or("UNAPPROVED")
                    .to_string();
                if state.to_lowercase() == "changes_requested" {
                    changes_requested = true;
                }
                participant_approval.insert(account_id.to_string(), (approved, state));
            }
        }
    }

    let reviewers = v["reviewers"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    // Bitbucket reviewer objects are flat — fields are directly on the
                    // object, not nested under a "user" key.
                    let user = parse_user(r);
                    let (approved, state) = user
                        .account_id
                        .as_deref()
                        .and_then(|id| participant_approval.get(id))
                        .cloned()
                        .unwrap_or((false, "UNAPPROVED".to_string()));
                    BitbucketReviewer { user, approved, state }
                })
                .collect()
        })
        .unwrap_or_default();

    BitbucketPr {
        id: v["id"].as_i64().unwrap_or(0),
        title,
        description,
        state: v["state"].as_str().unwrap_or("").to_string(),
        author: parse_user(&v["author"]),
        reviewers,
        source_branch,
        destination_branch: v["destination"]["branch"]["name"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        created_on: v["created_on"].as_str().unwrap_or("").to_string(),
        updated_on: v["updated_on"].as_str().unwrap_or("").to_string(),
        comment_count: v["comment_count"].as_i64().unwrap_or(0),
        task_count: v["task_count"].as_i64().unwrap_or(0),
        url: v["links"]["html"]["href"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        jira_issue_key,
        changes_requested,
        draft: v["draft"].as_bool().unwrap_or(false),
    }
}

pub(super) fn parse_comment(v: &Value) -> BitbucketComment {
    let inline = if v["inline"].is_object() {
        Some(BitbucketInlineContext {
            path: v["inline"]["path"].as_str().unwrap_or("").to_string(),
            from_line: v["inline"]["from"].as_i64(),
            to_line: v["inline"]["to"].as_i64(),
        })
    } else {
        None
    };

    BitbucketComment {
        id: v["id"].as_i64().unwrap_or(0),
        content: v["content"]["raw"].as_str().unwrap_or("").to_string(),
        // Bitbucket Cloud uses "author" for comments; fall back to "user" just in case
        author: {
            let author = parse_user(&v["author"]);
            if author.display_name.is_empty() && author.nickname.is_empty() {
                parse_user(&v["user"])
            } else {
                author
            }
        },
        created_on: v["created_on"].as_str().unwrap_or("").to_string(),
        updated_on: v["updated_on"].as_str().unwrap_or("").to_string(),
        inline,
        parent_id: v["parent"]["id"].as_i64(),
    }
}

/// Extract the first JIRA issue key (e.g. `PROJ-123`) from a string.
fn extract_jira_key(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_uppercase() {
            let start = i;
            // Collect project key prefix (uppercase letters + digits)
            while i < chars.len() && (chars[i].is_ascii_uppercase() || chars[i].is_ascii_digit()) {
                i += 1;
            }
            let prefix_len = i - start;
            // Minimum 2-char prefix, followed by '-', followed by digits
            if prefix_len >= 2 && i < chars.len() && chars[i] == '-' {
                i += 1;
                let num_start = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if i > num_start {
                    return Some(chars[start..i].iter().collect());
                }
            }
        } else {
            i += 1;
        }
    }
    None
}
