use std::path::{Path, PathBuf};
use std::process::Command;

use crate::storage::credentials::get_credential;
use crate::storage::preferences::get_pref;

/// Read a config value: preferences first, credential store as migration fallback.
pub(super) fn get_config(key: &str) -> Option<String> {
    get_pref(key).or_else(|| get_credential(key))
}

// ── Auto-managed worktree mode ────────────────────────────────────────────────
//
// Two modes for sourcing worktree paths:
//   - "manual" (default, legacy): the user enters each worktree path
//     individually in Settings; the path resolvers below read those
//     keys directly.
//   - "auto": the user enters a single source-repo path; Meridian
//     derives all four workflow worktrees as siblings of the source
//     directory and the resolvers below ignore the per-workflow
//     `*_worktree_path` keys entirely.
//
// The four neighbour suffixes are stable and sandbox-friendly: a fresh
// `git worktree add` lands the directories at predictable paths next to
// the source repo, and re-running the setup is idempotent because we
// derive the same paths every time.
pub(super) const AUTO_SUFFIX_IMPLEMENT: &str = "-meridian-implement";
pub(super) const AUTO_SUFFIX_PR_REVIEW: &str = "-meridian-pr-review";
pub(super) const AUTO_SUFFIX_PR_ADDRESS: &str = "-meridian-pr-address";
pub(super) const AUTO_SUFFIX_GROOMING: &str = "-meridian-grooming";

fn worktree_mode() -> String {
    get_config("worktree_mode")
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_else(|| "manual".to_string())
}

fn auto_source_path() -> Option<PathBuf> {
    let raw = get_config("repo_source_path")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Build a sibling path of `source` whose directory name is the source's
/// directory name + `suffix`. Returns `None` only when the source path
/// has no parent or no file-name component (effectively "/" — which we
/// can't pick a sibling of). Public to the repo module so the
/// auto-create command can reuse the same derivation.
pub(super) fn derive_auto_neighbour(source: &Path, suffix: &str) -> Option<PathBuf> {
    let parent = source.parent()?;
    let name = source.file_name()?.to_string_lossy().to_string();
    Some(parent.join(format!("{name}{suffix}")))
}

/// Returns the four auto-derived worktree paths if auto mode is active
/// AND a source path is set. None otherwise — callers fall back to the
/// per-key manual lookup.
pub(super) fn auto_worktree_paths() -> Option<AutoWorktreePaths> {
    if worktree_mode() != "auto" {
        return None;
    }
    let source = auto_source_path()?;
    Some(AutoWorktreePaths {
        implement: derive_auto_neighbour(&source, AUTO_SUFFIX_IMPLEMENT)?,
        pr_review: derive_auto_neighbour(&source, AUTO_SUFFIX_PR_REVIEW)?,
        pr_address: derive_auto_neighbour(&source, AUTO_SUFFIX_PR_ADDRESS)?,
        grooming: derive_auto_neighbour(&source, AUTO_SUFFIX_GROOMING)?,
        source,
    })
}

pub(super) struct AutoWorktreePaths {
    pub source: PathBuf,
    pub implement: PathBuf,
    pub pr_review: PathBuf,
    pub pr_address: PathBuf,
    pub grooming: PathBuf,
}

// ── Per-workflow path resolvers ───────────────────────────────────────────────
//
// Each resolver checks auto mode first (returns the derived neighbour
// when active), then falls through to the manual-mode behaviour: the
// per-workflow key plus the legacy fallback chain that mirrors the UI's
// "Optional dedicated worktree" copy.

pub(super) fn worktree_path() -> Result<PathBuf, String> {
    if let Some(auto) = auto_worktree_paths() {
        return ensure_auto_path(&auto, "implement", auto.implement.clone());
    }
    let raw = get_config("repo_worktree_path")
        .ok_or("Codebase worktree path not configured. Set it in Settings → Configuration.")?;
    ensure_exists(PathBuf::from(raw.trim()))
}

pub(super) fn base_branch() -> String {
    get_config("repo_base_branch").unwrap_or_else(|| "develop".to_string())
}

/// Returns the PR review–specific worktree path if configured, otherwise falls
/// back to the main worktree path. Returns an error only if neither is set.
pub(super) fn pr_review_worktree_path() -> Result<PathBuf, String> {
    if let Some(auto) = auto_worktree_paths() {
        return ensure_auto_path(&auto, "pr-review", auto.pr_review.clone());
    }
    let raw = get_config("pr_review_worktree_path")
        .or_else(|| get_config("repo_worktree_path"))
        .ok_or("No worktree path configured. Set one in Settings → Configuration.")?;
    ensure_exists(PathBuf::from(raw.trim()))
}

/// Returns the grooming-specific worktree path if configured, otherwise falls
/// back to the main implementation worktree path.
pub(super) fn grooming_worktree_path() -> Result<PathBuf, String> {
    if let Some(auto) = auto_worktree_paths() {
        return ensure_auto_path(&auto, "grooming", auto.grooming.clone());
    }
    let raw = get_config("grooming_worktree_path")
        .or_else(|| get_config("repo_worktree_path"))
        .ok_or("No worktree path configured. Set one in Settings → Configuration.")?;
    ensure_exists(PathBuf::from(raw.trim()))
}

/// Returns the PR address–specific worktree path if configured, falling back to
/// the PR review path, and then the main implementation worktree.
pub(super) fn pr_address_worktree_path() -> Result<PathBuf, String> {
    if let Some(auto) = auto_worktree_paths() {
        return ensure_auto_path(&auto, "pr-address", auto.pr_address.clone());
    }
    let raw = get_config("pr_address_worktree_path")
        .or_else(|| get_config("pr_review_worktree_path"))
        .or_else(|| get_config("repo_worktree_path"))
        .ok_or("No worktree path configured. Set one in Settings → Configuration.")?;
    ensure_exists(PathBuf::from(raw.trim()))
}

fn ensure_exists(path: PathBuf) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!(
            "Worktree path '{}' does not exist. Check Settings → Configuration.",
            path.display()
        ));
    }
    Ok(path)
}

/// Auto-mode resolver: lazy-create the worktree on first access via
/// `git worktree add` from the source repo, then return it. Subsequent
/// calls skip the create branch because the path now exists. The
/// branch the worktree initially anchors to is the configured
/// `repo_base_branch` (with `origin/<branch>` preferred and a local
/// fallback) — workflows that need a feature/PR branch then check it
/// out via the existing `checkout_branch_in` machinery.
fn ensure_auto_path(
    auto: &AutoWorktreePaths,
    label: &str,
    target: PathBuf,
) -> Result<PathBuf, String> {
    let branch = base_branch();
    super::manage::ensure_auto_worktree(&auto.source, &target, label, &branch)?;
    Ok(target)
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
