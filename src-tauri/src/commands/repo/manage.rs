//! Lazy creation of the four per-workflow worktrees that Meridian uses
//! when auto-managed mode is active in Settings.
//!
//! Auto mode design: the user enters a single source-repo path; the
//! four workflow worktrees (implement / pr-review / pr-address /
//! grooming) are derived as siblings of that source and materialised
//! ON DEMAND the first time a workflow asks for them. No "Create now"
//! button — the path resolvers in `_shared.rs` call the helper here
//! whenever they're hit in auto mode and the target directory doesn't
//! yet exist, so the first IPC into any given workflow pays the
//! `git worktree add` cost (1–2 s) and every subsequent call sees
//! the existing path.
//!
//! Idempotent: if the target already exists, this is a no-op. So a
//! retry after a partial setup just creates the missing worktrees.

use std::path::Path;

use super::_shared::git;

/// Materialise a single worktree at `target` rooted off `source`'s
/// remote `origin/<branch>` if it doesn't already exist. Falls back to
/// the local `<branch>` tip when `origin/<branch>` isn't reachable
/// (offline / no remote / fresh clone). Uses a Meridian-namespaced
/// local branch (`meridian-<label>`) so the new worktree never
/// collides with a branch the user might already have checked out
/// elsewhere — the `-B` flag overwrites that local branch on each
/// invocation, which matches the "scratch worktree, branches get
/// swapped per-task" usage pattern of every workflow except grooming
/// (and grooming's `git pull` against `origin/<branch>` still works
/// because the local branch tracks it).
pub(super) fn ensure_auto_worktree(
    source: &Path,
    target: &Path,
    label: &str,
    branch: &str,
) -> Result<(), String> {
    if target.exists() {
        return Ok(());
    }
    if !source.exists() {
        return Err(format!(
            "Source repo path '{}' does not exist — cannot create '{}' worktree.",
            source.display(),
            label
        ));
    }
    if !source.join(".git").exists() {
        return Err(format!(
            "Source repo path '{}' is not a git repository (no .git directory). \
             Auto-managed worktrees need a real source repo to branch from.",
            source.display()
        ));
    }

    // Best-effort fetch so `origin/<branch>` is fresh. Failure here is
    // tolerated; the local-branch fallback below still produces a
    // usable worktree.
    let _ = git(source, &["fetch", "origin", branch]);

    let local_branch = format!("meridian-{label}");
    let target_str = target.to_str().ok_or_else(|| {
        format!(
            "Worktree target path '{}' is not valid UTF-8.",
            target.display()
        )
    })?;
    let remote_ref = format!("origin/{branch}");

    let add_args = [
        "worktree",
        "add",
        "-B",
        local_branch.as_str(),
        target_str,
        remote_ref.as_str(),
    ];
    if let Err(remote_err) = git(source, &add_args) {
        // Local-branch fallback for repos with no remote / no
        // origin/<branch>. This keeps freshly-cloned-but-not-pushed
        // repos working — the user still ends up with a usable
        // worktree they can iterate against.
        let local_args = [
            "worktree",
            "add",
            "-B",
            local_branch.as_str(),
            target_str,
            branch,
        ];
        return git(source, &local_args).map(|_| ()).map_err(|local_err| {
            format!(
                "Failed to create '{label}' worktree at '{}': \
                 git worktree add against {remote_ref} failed ({remote_err}); \
                 local fallback also failed ({local_err})",
                target.display()
            )
        });
    }
    Ok(())
}
