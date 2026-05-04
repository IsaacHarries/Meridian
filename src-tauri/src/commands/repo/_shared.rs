use std::path::{Path, PathBuf};
use std::process::Command;

use crate::storage::credentials::get_credential;
use crate::storage::preferences::get_pref;

/// Read a config value: preferences first, credential store as migration fallback.
pub(super) fn get_config(key: &str) -> Option<String> {
    get_pref(key).or_else(|| get_credential(key))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

pub(super) fn worktree_path() -> Result<PathBuf, String> {
    let raw = get_config("repo_worktree_path")
        .ok_or("Codebase worktree path not configured. Set it in Settings → Configuration.")?;
    let path = PathBuf::from(raw.trim());
    if !path.exists() {
        return Err(format!(
            "Worktree path '{}' does not exist. Check Settings → Configuration.",
            path.display()
        ));
    }
    Ok(path)
}

pub(super) fn base_branch() -> String {
    get_config("repo_base_branch").unwrap_or_else(|| "develop".to_string())
}

/// Returns the PR review–specific worktree path if configured, otherwise falls
/// back to the main worktree path. Returns an error only if neither is set.
pub(super) fn pr_review_worktree_path() -> Result<PathBuf, String> {
    let raw = get_config("pr_review_worktree_path")
        .or_else(|| get_config("repo_worktree_path"))
        .ok_or("No worktree path configured. Set one in Settings → Configuration.")?;
    let path = PathBuf::from(raw.trim());
    if !path.exists() {
        return Err(format!(
            "Worktree path '{}' does not exist. Check Settings → Configuration.",
            path.display()
        ));
    }
    Ok(path)
}

/// Returns the grooming-specific worktree path if configured, otherwise falls
/// back to the main implementation worktree path.
pub(super) fn grooming_worktree_path() -> Result<PathBuf, String> {
    let raw = get_config("grooming_worktree_path")
        .or_else(|| get_config("repo_worktree_path"))
        .ok_or("No worktree path configured. Set one in Settings → Configuration.")?;
    let path = PathBuf::from(raw.trim());
    if !path.exists() {
        return Err(format!(
            "Worktree path '{}' does not exist. Check Settings → Configuration.",
            path.display()
        ));
    }
    Ok(path)
}

/// Returns the PR address–specific worktree path if configured, falling back to
/// the PR review path, and then the main implementation worktree.
pub(super) fn pr_address_worktree_path() -> Result<PathBuf, String> {
    let raw = get_config("pr_address_worktree_path")
        .or_else(|| get_config("pr_review_worktree_path"))
        .or_else(|| get_config("repo_worktree_path"))
        .ok_or("No worktree path configured. Set one in Settings → Configuration.")?;
    let path = PathBuf::from(raw.trim());
    if !path.exists() {
        return Err(format!(
            "Worktree path '{}' does not exist. Check Settings → Configuration.",
            path.display()
        ));
    }
    Ok(path)
}

/// Run a git command inside the worktree, returning stdout as a String.
pub(super) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git error: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {} failed: {}", args.join(" "), stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Sandbox a user-supplied relative path to the worktree root.
/// Returns an absolute path and an error if the resolved path would escape the root.
pub(super) fn sandboxed(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Strip leading slashes/dots to prevent absolute-path injection
    let rel = rel.trim_start_matches('/').trim_start_matches("./");
    let full = root.join(rel);
    // Canonicalise both so symlinks can't escape
    let canon_full = full
        .canonicalize()
        .map_err(|_| format!("Path not found: {rel}"))?;
    let canon_root = root
        .canonicalize()
        .map_err(|_| "Could not canonicalise worktree root".to_string())?;
    if !canon_full.starts_with(&canon_root) {
        return Err(format!(
            "Path '{rel}' would escape the worktree root — not allowed."
        ));
    }
    Ok(canon_full)
}

// ── Shared branch-checkout logic ──────────────────────────────────────────────

/// Check out `branch` inside `path`, updating it to `origin/<branch>`.
///
/// Strategy (avoids the "branch already exists" and "dirty working tree" errors):
/// 1. `git fetch origin <branch>` — ensure the remote ref is fresh.
/// 2. Check for uncommitted changes with `git status --porcelain`. If any exist,
///    stash them with `git stash --include-untracked` so the checkout can proceed
///    cleanly. The stash is intentionally left in place (not popped) — the PR
///    review worktree is a scratch area and any local modifications are transient.
/// 3. Check whether a local branch named `<branch>` already exists with
///    `git branch --list <branch>`.
/// 4a. Branch exists locally  → `git checkout <branch>` then
///     `git reset --hard origin/<branch>` to fast-forward it.
/// 4b. Branch does not exist  → `git checkout -b <branch> --track origin/<branch>`.
///
/// Using `--list` instead of relying on checkout exit codes means we never
/// accidentally attempt `-b` on a branch that already exists (which produces
/// `fatal: a branch named '…' already exists`).
pub(super) fn checkout_branch_in(path: &Path, branch: &str) -> Result<super::types::WorktreeInfo, String> {
    let remote_ref = format!("origin/{branch}");

    // 1. Fetch
    git(path, &["fetch", "origin", branch]).map_err(|e| format!("git fetch failed: {e}"))?;

    // 2. Stash any uncommitted changes (including untracked files) so the
    //    checkout / reset cannot fail with "local changes would be overwritten".
    //    We check first to avoid creating empty stash entries unnecessarily.
    let status_out = git(path, &["status", "--porcelain"]).unwrap_or_default();
    if !status_out.trim().is_empty() {
        // --include-untracked stashes new files too; --quiet suppresses the
        // "Saved working directory…" message from appearing in error output.
        git(
            path,
            &[
                "stash",
                "push",
                "--include-untracked",
                "-m",
                "meridian: auto-stash before branch checkout",
            ],
        )
        .map_err(|e| format!("git stash failed: {e}"))?;
    }

    // 3. Does a local branch with this exact name already exist?
    let list_out = git(path, &["branch", "--list", branch]).unwrap_or_default();
    let exists_locally = !list_out.trim().is_empty();

    if exists_locally {
        // 4a. Already exists — check it out then hard-reset to the remote tip
        git(path, &["checkout", branch])
            .map_err(|e| format!("git checkout {branch} failed: {e}"))?;
        git(path, &["reset", "--hard", &remote_ref])
            .map_err(|e| format!("git reset to {remote_ref} failed: {e}"))?;
    } else {
        // 4b. New locally — create it tracking the remote
        git(path, &["checkout", "-b", branch, "--track", &remote_ref])
            .map_err(|e| format!("git checkout -b {branch} failed: {e}"))?;
    }

    let head_commit = git(path, &["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let head_message = git(path, &["log", "-1", "--format=%s"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| String::new());

    Ok(super::types::WorktreeInfo {
        path: path.to_string_lossy().to_string(),
        branch: branch.to_string(),
        head_commit,
        head_message,
    })
}
