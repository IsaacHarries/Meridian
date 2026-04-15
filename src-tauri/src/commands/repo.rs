use std::path::{Path, PathBuf};
use std::process::Command;
use serde::Serialize;

use super::credentials::get_credential;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn worktree_path() -> Result<PathBuf, String> {
    let raw = get_credential("repo_worktree_path")
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

fn base_branch() -> String {
    get_credential("repo_base_branch")
        .unwrap_or_else(|| "develop".to_string())
}

/// Returns the PR review–specific worktree path if configured, otherwise falls
/// back to the main worktree path. Returns an error only if neither is set.
fn pr_review_worktree_path() -> Result<PathBuf, String> {
    let raw = get_credential("pr_review_worktree_path")
        .or_else(|| get_credential("repo_worktree_path"))
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
fn pr_address_worktree_path() -> Result<PathBuf, String> {
    let raw = get_credential("pr_address_worktree_path")
        .or_else(|| get_credential("pr_review_worktree_path"))
        .or_else(|| get_credential("repo_worktree_path"))
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
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
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
fn sandboxed(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Strip leading slashes/dots to prevent absolute-path injection
    let rel = rel.trim_start_matches('/').trim_start_matches("./");
    let full = root.join(rel);
    // Canonicalise both so symlinks can't escape
    let canon_full = full.canonicalize()
        .map_err(|_| format!("Path not found: {rel}"))?;
    let canon_root = root.canonicalize()
        .map_err(|_| "Could not canonicalise worktree root".to_string())?;
    if !canon_full.starts_with(&canon_root) {
        return Err(format!("Path '{rel}' would escape the worktree root — not allowed."));
    }
    Ok(canon_full)
}

// ── Worktree management ───────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head_commit: String,
    pub head_message: String,
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

/// Fetch from origin and reset the worktree to the configured base branch.
/// Returns the new HEAD commit hash.
#[tauri::command]
pub async fn sync_worktree() -> Result<WorktreeInfo, String> {
    let path = worktree_path()?;
    let branch = base_branch();

    // Fetch
    git(&path, &["fetch", "origin"])
        .map_err(|e| format!("git fetch failed: {e}"))?;

    // Reset hard to origin/<branch>
    let remote_ref = format!("origin/{branch}");
    git(&path, &["reset", "--hard", &remote_ref])
        .map_err(|e| format!("git reset to {remote_ref} failed: {e}"))?;

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

// ── File access (read-only, sandboxed) ───────────────────────────────────────

/// Search files by glob pattern. Returns relative paths from the worktree root.
/// Pattern is relative to the root (e.g. "src/**/*.ts").
/// Hard-capped at 500 results to avoid flooding the context window.
#[tauri::command]
pub async fn glob_repo_files(pattern: String) -> Result<Vec<String>, String> {
    let root = worktree_path()?;

    // Use `git ls-files` with fnmatch-style patterns — respects .gitignore automatically.
    // Fall back to a plain find for patterns that don't match gitignore-aware ls-files.
    let output = git(&root, &["ls-files", "--cached", "--others", "--exclude-standard", &pattern])
        .unwrap_or_default();

    let mut results: Vec<String> = output
        .lines()
        .filter(|l| !l.is_empty())
        .take(500)
        .map(str::to_string)
        .collect();

    // git ls-files doesn't always do recursive glob; if we got nothing, try find
    if results.is_empty() {
        // Strip leading src/ or similar for the glob portion
        let out = Command::new("find")
            .arg(&root)
            .arg("-type")
            .arg("f")
            .arg("-not")
            .arg("-path")
            .arg("*/.git/*")
            .output()
            .map_err(|e| format!("find error: {e}"))?;
        let all = String::from_utf8_lossy(&out.stdout);
        let pat = glob::Pattern::new(&pattern)
            .map_err(|e| format!("Invalid glob pattern: {e}"))?;
        results = all
            .lines()
            .filter_map(|line| {
                let p = Path::new(line);
                let rel = p.strip_prefix(&root).ok()?;
                let rel_str = rel.to_string_lossy();
                if pat.matches(&rel_str) {
                    Some(rel_str.to_string())
                } else {
                    None
                }
            })
            .take(500)
            .collect();
    }

    Ok(results)
}

/// Search file contents with a regex pattern using `git grep`.
/// `path` is an optional subdirectory to restrict the search to.
/// Returns at most 200 matches as "path:line:content" strings.
#[tauri::command]
pub async fn grep_repo_files(pattern: String, path: Option<String>) -> Result<Vec<String>, String> {
    let root = worktree_path()?;

    let mut args = vec![
        "grep",
        "-n",           // line numbers
        "--heading",    // group by file
        "-E",           // extended regex
        "--max-count=50", // max 50 matches per file
        &pattern,
    ];
    let path_owned;
    if let Some(ref p) = path {
        path_owned = p.clone();
        args.push("--");
        args.push(&path_owned);
    }

    // git grep exits 0 = matches found, 1 = no matches, 2 = error.
    // Run via Command directly so we can distinguish exit codes.
    let out = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(&args)
        .output()
        .map_err(|e| format!("git grep error: {e}"))?;

    let code = out.status.code().unwrap_or(-1);
    match code {
        0 => {
            // Matches found — collect output lines
            let stdout = String::from_utf8_lossy(&out.stdout);
            let lines: Vec<String> = stdout
                .lines()
                .take(200)
                .map(str::to_string)
                .collect();
            Ok(lines)
        }
        1 => {
            // No matches — not an error
            Ok(vec![])
        }
        _ => {
            // Real error (e.g. invalid regex, bad path)
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(format!("git grep failed (exit {code}): {}", stderr.trim()))
        }
    }
}

/// Read a single file from the worktree.
/// `path` is relative to the worktree root (e.g. "src/reports/index.ts").
/// Hard-capped at 500 KB to prevent enormous files from flooding the context window.
#[tauri::command]
pub async fn read_repo_file(path: String) -> Result<String, String> {
    let root = worktree_path()?;
    let full = sandboxed(&root, &path)?;

    let content = std::fs::read_to_string(&full)
        .map_err(|e| format!("Could not read '{}': {e}", path))?;

    // Cap at ~500 KB
    const MAX_BYTES: usize = 512 * 1024;
    if content.len() > MAX_BYTES {
        let truncated = &content[..MAX_BYTES];
        return Ok(format!(
            "{truncated}\n\n[… file truncated at 500 KB — {} bytes omitted …]",
            content.len() - MAX_BYTES
        ));
    }

    Ok(content)
}

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

    let diff = git(&root, &["diff", &merge_base, "HEAD"])?;

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

// ── Shared branch-checkout logic ──────────────────────────────────────────────

/// Check out `branch` inside `path`, updating it to `origin/<branch>`.
///
/// Strategy (avoids the "branch already exists" error):
/// 1. `git fetch origin <branch>` — ensure the remote ref is fresh.
/// 2. Check whether a local branch named `<branch>` already exists with
///    `git branch --list <branch>`.
/// 3a. Branch exists locally  → `git checkout <branch>` then
///     `git reset --hard origin/<branch>` to fast-forward it.
/// 3b. Branch does not exist  → `git checkout -b <branch> --track origin/<branch>`.
///
/// Using `--list` instead of relying on checkout exit codes means we never
/// accidentally attempt `-b` on a branch that already exists (which produces
/// `fatal: a branch named '…' already exists`).
fn checkout_branch_in(path: &Path, branch: &str) -> Result<WorktreeInfo, String> {
    let remote_ref = format!("origin/{branch}");

    // 1. Fetch
    git(path, &["fetch", "origin", branch])
        .map_err(|e| format!("git fetch failed: {e}"))?;

    // 2. Does a local branch with this exact name already exist?
    let list_out = git(path, &["branch", "--list", branch]).unwrap_or_default();
    let exists_locally = !list_out.trim().is_empty();

    if exists_locally {
        // 3a. Already exists — check it out then hard-reset to the remote tip
        git(path, &["checkout", branch])
            .map_err(|e| format!("git checkout {branch} failed: {e}"))?;
        git(path, &["reset", "--hard", &remote_ref])
            .map_err(|e| format!("git reset to {remote_ref} failed: {e}"))?;
    } else {
        // 3b. New locally — create it tracking the remote
        git(path, &["checkout", "-b", branch, "--track", &remote_ref])
            .map_err(|e| format!("git checkout -b {branch} failed: {e}"))?;
    }

    let head_commit = git(path, &["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let head_message = git(path, &["log", "-1", "--format=%s"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| String::new());

    Ok(WorktreeInfo {
        path: path.to_string_lossy().to_string(),
        branch: branch.to_string(),
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

/// Open a terminal window in the PR review worktree directory and run the
/// supplied command. The terminal application is read from the
/// `pr_review_terminal` credential (defaults to "iTerm2").
/// Supported values: "iTerm2", "Terminal", or any other app name that
/// supports the standard macOS Terminal AppleScript dictionary.
#[tauri::command]
pub async fn run_in_terminal(command: String) -> Result<(), String> {
    let path = pr_review_worktree_path()?;
    let path_str = path.to_string_lossy();

    let terminal = get_credential("pr_review_terminal")
        .unwrap_or_else(|| "iTerm2".to_string());
    let terminal = terminal.trim().to_string();

    let script = if terminal.to_lowercase() == "iterm2" || terminal == "iTerm2" {
        // iTerm2 has its own richer AppleScript dictionary.
        format!(
            r#"tell application "iTerm2"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow
        write text "cd {path_str} && {command}"
    end tell
end tell"#
        )
    } else {
        // macOS Terminal.app and any other terminal that follows the standard
        // "do script" AppleScript convention.
        format!(
            r#"tell application "{terminal}"
    activate
    do script "cd {path_str} && {command}"
end tell"#
        )
    };

    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to launch {terminal}: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{terminal} launch failed: {stderr}"));
    }

    Ok(())
}

// ── PR Address worktree ───────────────────────────────────────────────────────

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

/// Read a file from the PR address worktree (path relative to worktree root).
/// Sandboxed to the worktree root.
#[tauri::command]
pub async fn read_pr_address_file(path: String) -> Result<String, String> {
    let root = pr_address_worktree_path()?;
    let full = sandboxed(&root, &path)?;
    std::fs::read_to_string(&full).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Write a file in the PR address worktree (path relative to worktree root).
/// Sandboxed to the worktree root. Creates intermediate directories as needed.
#[tauri::command]
pub async fn write_pr_address_file(path: String, content: String) -> Result<(), String> {
    let root = pr_address_worktree_path()?;
    // For new files the path won't exist yet — strip the sandbox canonicalize
    // check and just verify the resolved path starts with the root.
    let rel = path.trim_start_matches('/').trim_start_matches("./");
    let full = root.join(rel);
    let canon_root = root
        .canonicalize()
        .map_err(|_| "Could not canonicalise worktree root".to_string())?;
    // Canonicalise parent (which must exist), then re-attach the filename
    let parent = full
        .parent()
        .ok_or_else(|| format!("Invalid path: {path}"))?;
    // Create parent dirs if missing
    std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dirs for {path}: {e}"))?;
    let canon_parent = parent
        .canonicalize()
        .map_err(|_| format!("Could not resolve parent directory for {path}"))?;
    if !canon_parent.starts_with(&canon_root) {
        return Err(format!(
            "Path '{path}' would escape the worktree root — not allowed."
        ));
    }
    std::fs::write(&full, content).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Get a diff of the PR address worktree against the current HEAD (i.e. staged + unstaged changes).
#[tauri::command]
pub async fn get_pr_address_diff() -> Result<String, String> {
    let root = pr_address_worktree_path()?;
    // First try staged+unstaged vs HEAD
    let diff = git(&root, &["diff", "HEAD"])?;
    Ok(diff)
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

