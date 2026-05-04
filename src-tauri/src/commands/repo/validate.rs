use super::_shared::{
    git, grooming_worktree_path, pr_address_worktree_path, pr_review_worktree_path, worktree_path,
};
use super::types::WorktreeInfo;

/// Validate that the configured path is a git worktree, returning basic metadata.
#[tauri::command]
pub async fn validate_worktree() -> Result<WorktreeInfo, String> {
    let path = worktree_path()?;

    // Confirm it's a git repository (worktree or main checkout)
    git(&path, &["rev-parse", "--git-dir"])?;

    let branch = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

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

/// Validate the configured grooming worktree path. Falls back to the main worktree.
#[tauri::command]
pub async fn validate_grooming_worktree() -> Result<WorktreeInfo, String> {
    let path = grooming_worktree_path()?;
    git(&path, &["rev-parse", "--git-dir"])?;
    let branch = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
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

/// Validate that the configured PR review worktree path is a valid git repository.
/// Falls back to the main worktree path if no dedicated PR review path is configured.
#[tauri::command]
pub async fn validate_pr_review_worktree() -> Result<WorktreeInfo, String> {
    let path = pr_review_worktree_path()?;

    git(&path, &["rev-parse", "--git-dir"])?;

    let branch = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

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

/// Validate the configured PR address worktree path.
/// Falls back to pr_review_worktree_path → repo_worktree_path.
#[tauri::command]
pub async fn validate_pr_address_worktree() -> Result<WorktreeInfo, String> {
    let path = pr_address_worktree_path()?;

    git(&path, &["rev-parse", "--git-dir"])?;

    let branch = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

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
