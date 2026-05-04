use std::process::Command;

use super::_shared::{base_branch, git, pr_address_worktree_path, worktree_path};
use super::types::WorktreeInfo;

/// Build a URL-and-git-friendly slug from a ticket summary.
fn slugify_summary(summary: &str) -> String {
    let mut out = String::with_capacity(summary.len());
    let mut last_dash = true;
    for ch in summary.chars() {
        if ch.is_ascii_alphanumeric() {
            out.extend(ch.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    // Cap total length to keep branch names reasonable
    if trimmed.len() > 50 {
        trimmed[..50].trim_end_matches('-').to_string()
    } else {
        trimmed
    }
}

/// Create a feature branch for a JIRA ticket off the configured base branch.
/// Name pattern: `feature/<ISSUE-KEY>-<slug>`. The ticket key is embedded so
/// JIRA's Bitbucket integration auto-links the branch to the issue.
///
/// If the branch already exists, it is checked out and updated to match
/// `origin/<base_branch>` — guarantees a clean starting point for Implementation.
#[tauri::command]
pub async fn create_feature_branch(
    issue_key: String,
    summary: String,
) -> Result<WorktreeInfo, String> {
    let path = worktree_path()?;
    let base = base_branch();
    let remote_ref = format!("origin/{base}");

    let slug = slugify_summary(&summary);
    let branch_name = if slug.is_empty() {
        format!("feature/{issue_key}")
    } else {
        format!("feature/{issue_key}-{slug}")
    };

    // Refresh origin so the branch point is current.
    let remotes = git(&path, &["remote"]).unwrap_or_default();
    let has_origin = remotes.lines().any(|r| r.trim() == "origin");
    if has_origin {
        git(&path, &["fetch", "origin"]).map_err(|e| format!("git fetch failed: {e}"))?;
    }

    // If branch exists locally, check it out; otherwise create from base.
    let exists_local =
        git(&path, &["rev-parse", "--verify", &branch_name]).is_ok();

    if exists_local {
        git(&path, &["checkout", &branch_name])
            .map_err(|e| format!("git checkout {branch_name} failed: {e}"))?;
    } else {
        let start_point = if has_origin { remote_ref.clone() } else { base.clone() };
        git(&path, &["checkout", "-b", &branch_name, &start_point])
            .map_err(|e| format!("git checkout -b {branch_name} failed: {e}"))?;
    }

    let head_commit = git(&path, &["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let head_message = git(&path, &["log", "-1", "--format=%s"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    Ok(WorktreeInfo {
        path: path.to_string_lossy().to_string(),
        branch: branch_name,
        head_commit,
        head_message,
    })
}

/// Stage and commit all current worktree changes. No-op (returns `None`) if
/// there is nothing to commit. Returns the new HEAD short sha on success.
#[tauri::command]
pub async fn commit_worktree_changes(message: String) -> Result<Option<String>, String> {
    let root = worktree_path()?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }

    git(&root, &["add", "-A"])?;

    // `git diff --cached --quiet` exits 0 if no staged changes, 1 if there are.
    let out = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["diff", "--cached", "--quiet"])
        .output()
        .map_err(|e| format!("git error: {e}"))?;
    let has_changes = matches!(out.status.code(), Some(1));
    if !has_changes {
        return Ok(None);
    }

    git(&root, &["commit", "-m", &message])?;
    let head = git(&root, &["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    Ok(Some(head))
}

/// Squash all commits on the current branch since the merge-base with the
/// configured base branch into a single commit with the provided message.
/// If there are 0 or 1 commits ahead, this rewrites the single commit's
/// message without creating a merge.
#[tauri::command]
pub async fn squash_worktree_commits(message: String) -> Result<String, String> {
    let root = worktree_path()?;
    let base = base_branch();
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }

    // Prefer origin/<base> for the merge-base; fall back to local <base>.
    let remote_ref = format!("origin/{base}");
    let merge_base = git(&root, &["merge-base", "HEAD", &remote_ref])
        .or_else(|_| git(&root, &["merge-base", "HEAD", &base]))
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Could not find merge-base with {base}: {e}"))?;

    // Count commits since merge-base.
    let count_str = git(&root, &["rev-list", "--count", &format!("{merge_base}..HEAD")])?;
    let ahead: u32 = count_str.trim().parse().unwrap_or(0);

    if ahead == 0 {
        return Err(format!(
            "No commits to squash — branch is at the same commit as {base}."
        ));
    }

    // Soft reset to the merge-base so all changes stay staged, then commit once.
    git(&root, &["reset", "--soft", &merge_base])?;
    git(&root, &["commit", "-m", &message])?;

    let head = git(&root, &["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    Ok(head)
}

/// Push the current feature branch of the implementation worktree to origin.
/// Uses `--set-upstream` so subsequent pushes track the remote branch.
#[tauri::command]
pub async fn push_worktree_branch() -> Result<String, String> {
    let root = worktree_path()?;
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    if branch == "HEAD" || branch.is_empty() {
        return Err("Worktree is not on a branch — cannot push.".to_string());
    }
    let base = base_branch();
    if branch == base {
        return Err(format!(
            "Refusing to push: current branch is the base branch '{base}'. \
             A feature branch must be created first."
        ));
    }
    git(&root, &["push", "--set-upstream", "origin", &branch])?;
    Ok(branch)
}

/// Commit all changes in the PR address worktree with the given message.
#[tauri::command]
pub async fn commit_pr_address_changes(message: String) -> Result<String, String> {
    let root = pr_address_worktree_path()?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    git(&root, &["add", "-A"])?;
    git(&root, &["commit", "-m", &message])?;
    let head = git(&root, &["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    Ok(head)
}

/// Push the current branch of the PR address worktree to origin.
#[tauri::command]
pub async fn push_pr_address_branch() -> Result<(), String> {
    let root = pr_address_worktree_path()?;
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    git(&root, &["push", "origin", &branch])?;
    Ok(())
}
