use super::_shared::{
    base_branch, checkout_branch_in, git, grooming_worktree_path, pr_address_worktree_path,
    pr_review_worktree_path, worktree_path,
};
use super::types::WorktreeInfo;

/// Fetch from origin and reset the worktree to the configured base branch.
/// Returns the new HEAD commit hash.
#[tauri::command]
pub async fn sync_worktree() -> Result<WorktreeInfo, String> {
    let path = worktree_path()?;
    let branch = base_branch();

    // Check if 'origin' remote exists
    let remotes = git(&path, &["remote"]).unwrap_or_default();
    let has_origin = remotes.lines().any(|r| r.trim() == "origin");

    if has_origin {
        // Fetch
        git(&path, &["fetch", "origin"]).map_err(|e| format!("git fetch failed: {e}"))?;

        // Reset hard to origin/<branch>
        let remote_ref = format!("origin/{branch}");
        git(&path, &["reset", "--hard", &remote_ref])
            .map_err(|e| format!("git reset to {remote_ref} failed: {e}"))?;
    } else {
        // No origin, just ensure the local base branch is checked out and reset hard to HEAD
        // to ensure a clean state for the agent, if the branch exists.
        let _ = git(&path, &["checkout", &branch]);
        let _ = git(&path, &["reset", "--hard", "HEAD"]);
    }

    let head_commit = git(&path, &["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let head_message = git(&path, &["log", "-1", "--format=%s"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| String::new());

    Ok(WorktreeInfo {
        path: path.to_string_lossy().to_string(),
        branch,
        head_commit,
        head_message,
    })
}

/// Pull latest changes in the grooming worktree from origin/<base_branch>.
/// Ensures grooming always reads from an up-to-date develop snapshot.
#[tauri::command]
pub async fn sync_grooming_worktree() -> Result<WorktreeInfo, String> {
    let path = grooming_worktree_path()?;
    let branch = base_branch();

    let remotes = git(&path, &["remote"]).unwrap_or_default();
    let has_origin = remotes.lines().any(|r| r.trim() == "origin");

    if has_origin {
        git(&path, &["pull", "origin", &branch])
            .map_err(|e| format!("git pull origin {branch} failed: {e}"))?;
    }

    let head_commit = git(&path, &["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let head_message = git(&path, &["log", "-1", "--format=%s"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| String::new());

    Ok(WorktreeInfo {
        path: path.to_string_lossy().to_string(),
        branch,
        head_commit,
        head_message,
    })
}

/// Check out a specific branch in the implementation worktree.
/// Returns the HEAD info after checkout.
#[tauri::command]
pub async fn checkout_worktree_branch(branch: String) -> Result<WorktreeInfo, String> {
    let path = worktree_path()?;
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    checkout_branch_in(&path, &branch)
}

/// Check out a specific branch in the PR review worktree.
/// Uses `pr_review_worktree_path` if configured, otherwise falls back to
/// `repo_worktree_path`.
#[tauri::command]
pub async fn checkout_pr_review_branch(branch: String) -> Result<WorktreeInfo, String> {
    let path = pr_review_worktree_path()?;
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    checkout_branch_in(&path, &branch)
}

/// Check out a branch in the PR address worktree.
#[tauri::command]
pub async fn checkout_pr_address_branch(branch: String) -> Result<WorktreeInfo, String> {
    let path = pr_address_worktree_path()?;
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    checkout_branch_in(&path, &branch)
}
