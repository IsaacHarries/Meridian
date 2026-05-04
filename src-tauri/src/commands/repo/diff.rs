use super::_shared::{base_branch, git, pr_address_worktree_path, sandboxed, worktree_path};

/// Get the git diff of the worktree against the configured base branch.
/// Used by the PR Description agent to summarise what changed.
#[tauri::command]
pub async fn get_repo_diff() -> Result<String, String> {
    let root = worktree_path()?;
    let branch = base_branch();
    let remote_ref = format!("origin/{branch}");

    // diff against the merge-base so we only see changes since branching
    let merge_base = git(&root, &["merge-base", "HEAD", &remote_ref])
        .map(|s| s.trim().to_string())
        .unwrap_or(remote_ref.clone());

    // Compare working tree to merge-base so uncommitted implementation changes are included
    let diff = git(&root, &["diff", &merge_base])?;

    // Cap at 1 MB
    const MAX_BYTES: usize = 1024 * 1024;
    if diff.len() > MAX_BYTES {
        return Ok(format!(
            "{}\n\n[… diff truncated at 1 MB …]",
            &diff[..MAX_BYTES]
        ));
    }

    Ok(diff)
}

/// Read a file's content at the base branch (merge-base with origin/<base>).
/// Returns an empty string if the file did not exist at that point (new file).
#[tauri::command]
pub async fn get_file_at_base(path: String) -> Result<String, String> {
    let root = worktree_path()?;
    let branch = base_branch();
    let remote_ref = format!("origin/{branch}");
    let merge_base = git(&root, &["merge-base", "HEAD", &remote_ref])
        .map(|s| s.trim().to_string())
        .unwrap_or(remote_ref);
    // git show <ref>:<path> — returns error if file is new, which we treat as empty
    match git(&root, &["show", &format!("{merge_base}:{path}")]) {
        Ok(content) => Ok(content),
        Err(_) => Ok(String::new()), // new file — no original content
    }
}

/// Run `git log` on the worktree against the base branch.
/// Returns the last N commits as a plain-text log.
#[tauri::command]
pub async fn get_repo_log(max_commits: u32) -> Result<String, String> {
    let root = worktree_path()?;
    let n = max_commits.min(100).to_string();
    let log = git(
        &root,
        &[
            "log",
            &format!("-{n}"),
            "--oneline",
            "--decorate",
            "--no-merges",
        ],
    )?;
    Ok(log)
}

/// Run `git log` on a specific file to get its history.
/// Used by Impact Analysis to understand why code was written the way it was.
#[tauri::command]
pub async fn get_file_history(path: String, max_commits: u32) -> Result<String, String> {
    let root = worktree_path()?;
    let _ = sandboxed(&root, &path)?;
    let n = max_commits.min(20).to_string();
    let log = git(
        &root,
        &[
            "log",
            &format!("-{n}"),
            "--oneline",
            "--follow",
            "--",
            &path,
        ],
    )?;
    Ok(log)
}

/// Get a diff of the PR address worktree against the current HEAD (i.e. staged + unstaged changes).
#[tauri::command]
pub async fn get_pr_address_diff() -> Result<String, String> {
    let root = pr_address_worktree_path()?;
    // First try staged+unstaged vs HEAD
    let diff = git(&root, &["diff", "HEAD"])?;
    Ok(diff)
}
