use std::path::PathBuf;

use serde::Serialize;

use super::_shared::{
    base_branch as configured_base_branch, get_config, git, grooming_worktree_path,
    pr_address_worktree_path, pr_review_worktree_path, worktree_path,
};
use super::types::WorktreeInfo;

/// Validate the user's source-repo path (auto-managed worktree mode).
///
/// Confirms the configured `repo_source_path` exists, contains a `.git`
/// directory, and that `git -C <path>` commands run cleanly against it.
/// Returns the same `WorktreeInfo` shape as the per-workflow validators
/// so the Settings UI can render branch + HEAD metadata in the same
/// style. Used by the "Verify" button — running before any workflow
/// triggers worktree creation surfaces auth / path errors up front
/// instead of failing on the first IPC into a workflow.
#[tauri::command]
pub async fn validate_source_repo() -> Result<WorktreeInfo, String> {
    let raw = get_config("repo_source_path").ok_or_else(|| {
        "Source repo path not configured. Set it in Settings → Workflows → Worktrees."
            .to_string()
    })?;
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return Err("Source repo path is empty.".to_string());
    }
    if !path.exists() {
        return Err(format!(
            "Source repo path '{}' does not exist.",
            path.display()
        ));
    }
    if !path.join(".git").exists() {
        return Err(format!(
            "Source repo path '{}' is not a git repository (no .git directory).",
            path.display()
        ));
    }

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseBranchInfo {
    pub branch: String,
    /// Path the branch was looked up against — the source repo in auto
    /// mode, the implementation worktree in manual mode. Surfaced so
    /// the UI can show *which* repo was checked when the user
    /// reconfigures and re-verifies.
    pub checked_against: String,
    /// True when a local branch with the configured name exists. False
    /// is fine on its own — many setups only have the remote tip.
    pub local_exists: bool,
    /// True when `origin/<branch>` resolves. The expected happy-path
    /// for shared repos; the worktree creation flow anchors against it.
    pub remote_exists: bool,
    /// Short SHA at the tip the branch resolves to. Prefers the remote
    /// ref when present, falls back to the local ref otherwise.
    pub head_commit: String,
}

/// Validate that the configured base branch (`repo_base_branch`) is
/// reachable from the appropriate source repo for the active worktree
/// mode. In auto mode the lookup runs against `repo_source_path`; in
/// manual mode it runs against the implementation worktree (`repo_worktree_path`).
/// Reports whether the local branch and `origin/<branch>` both
/// resolve, plus the short SHA each side points at, so the user can
/// catch typos like `develop` vs `dev` before the first workflow run
/// fails downstream.
#[tauri::command]
pub async fn validate_base_branch() -> Result<BaseBranchInfo, String> {
    let branch = configured_base_branch();
    if branch.trim().is_empty() {
        return Err("Base branch is empty.".to_string());
    }

    // Pick the repo to check against based on which mode is active —
    // in auto mode the worktrees may not exist yet, so the source repo
    // is the only thing we can interrogate. In manual mode the
    // implementation worktree is the canonical tracking checkout.
    let mode = get_config("worktree_mode")
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_else(|| "manual".to_string());

    let path: PathBuf = if mode == "auto" {
        let raw = get_config("repo_source_path").ok_or_else(|| {
            "Source repo path not configured. Set it in Settings → Workflows → Worktrees."
                .to_string()
        })?;
        let p = PathBuf::from(raw.trim());
        if !p.exists() {
            return Err(format!(
                "Source repo path '{}' does not exist.",
                p.display()
            ));
        }
        if !p.join(".git").exists() {
            return Err(format!(
                "Source repo path '{}' is not a git repository.",
                p.display()
            ));
        }
        p
    } else {
        // manual mode: use the implementation worktree path, with the
        // standard cred-store fallback for legacy installs.
        worktree_path()?
    };

    // Best-effort fetch so the remote ref reflects the upstream tip
    // rather than a stale clone. Failure is tolerated — the local
    // verification still tells the user whether the branch name is
    // recognised at all.
    let _ = git(&path, &["fetch", "origin", &branch]);

    let remote_ref = format!("origin/{branch}");
    let local_exists = git(&path, &["rev-parse", "--verify", &branch]).is_ok();
    let remote_sha = git(&path, &["rev-parse", "--short", &remote_ref])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let local_sha = if local_exists {
        git(&path, &["rev-parse", "--short", &branch])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    let remote_exists = remote_sha.is_some();
    if !local_exists && !remote_exists {
        // Distinguish "branch is configured but the repo is empty" from
        // "branch genuinely missing". A fresh `git clone` of a GitHub repo
        // that has zero commits leaves HEAD pointing at
        // `refs/heads/<branch>` (an unborn ref) — `rev-parse --verify`
        // returns non-zero because there's no SHA to print, but the
        // branch is correctly *set up*. Telling the user "not found"
        // here is misleading; surface the real situation instead.
        let unborn = git(&path, &["symbolic-ref", "-q", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string())
            .map(|head| head == format!("refs/heads/{branch}"))
            .unwrap_or(false);
        if unborn {
            return Err(format!(
                "Branch '{branch}' is configured (HEAD → refs/heads/{branch}) \
                 but the repository at '{}' has no commits yet — push an initial \
                 commit to origin/{branch}, then re-verify.",
                path.display()
            ));
        }
        return Err(format!(
            "Branch '{branch}' not found locally or as origin/{branch} in '{}'. \
             Check the spelling, or fetch the remote if it's a new branch.",
            path.display()
        ));
    }

    let head_commit = remote_sha
        .or(local_sha)
        .unwrap_or_else(|| "unknown".to_string());

    Ok(BaseBranchInfo {
        branch,
        checked_against: path.to_string_lossy().to_string(),
        local_exists,
        remote_exists,
        head_commit,
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
