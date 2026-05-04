use std::path::Path;
use std::process::Command;

use super::_shared::{
    git, grooming_worktree_path, pr_address_worktree_path, sandboxed, worktree_path,
};
use super::types::StatResult;

pub(super) fn glob_files_in(root: &Path, pattern: &str) -> Result<Vec<String>, String> {
    let output = git(
        root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            pattern,
        ],
    )
    .unwrap_or_default();

    let mut results: Vec<String> = output
        .lines()
        .filter(|l| !l.is_empty())
        .take(500)
        .map(str::to_string)
        .collect();

    if results.is_empty() {
        let out = Command::new("find")
            .arg(root)
            .arg("-type")
            .arg("f")
            .arg("-not")
            .arg("-path")
            .arg("*/.git/*")
            .output()
            .map_err(|e| format!("find error: {e}"))?;
        let all = String::from_utf8_lossy(&out.stdout);
        let pat = glob::Pattern::new(pattern).map_err(|e| format!("Invalid glob pattern: {e}"))?;
        results = all
            .lines()
            .filter_map(|line| {
                let p = Path::new(line);
                let rel = p.strip_prefix(root).ok()?;
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

pub(super) fn grep_files_in(
    root: &Path,
    pattern: &str,
    path: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "grep",
        "-n",
        "--heading",
        "-F",
        "--max-count=50",
        pattern,
    ];
    if let Some(p) = path {
        args.push("--");
        args.push(p);
    }

    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(&args)
        .output()
        .map_err(|e| format!("git grep error: {e}"))?;

    let code = out.status.code().unwrap_or(-1);
    match code {
        0 => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            Ok(stdout.lines().take(200).map(str::to_string).collect())
        }
        1 => Ok(vec![]),
        _ => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(format!("git grep failed (exit {code}): {}", stderr.trim()))
        }
    }
}

pub(super) fn read_file_in(root: &Path, path: &str) -> Result<String, String> {
    let full = sandboxed(root, path)?;
    let content =
        std::fs::read_to_string(&full).map_err(|e| format!("Could not read '{}': {e}", path))?;
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

/// Search files by glob pattern. Returns relative paths from the worktree root.
/// Pattern is relative to the root (e.g. "src/**/*.ts").
/// Hard-capped at 500 results to avoid flooding the context window.
#[tauri::command]
pub async fn glob_repo_files(pattern: String) -> Result<Vec<String>, String> {
    glob_files_in(&worktree_path()?, &pattern)
}

/// Search file contents with a regex pattern using `git grep`.
/// `path` is an optional subdirectory to restrict the search to.
/// Returns at most 200 matches as "path:line:content" strings.
#[tauri::command]
pub async fn grep_repo_files(pattern: String, path: Option<String>) -> Result<Vec<String>, String> {
    grep_files_in(&worktree_path()?, &pattern, path.as_deref())
}

/// Non-command helper used by the implementation agent in claude.rs.
/// Reads a file from the main implementation worktree without size-capping.
pub fn read_repo_file_internal(path: &str) -> Result<String, String> {
    let root = worktree_path()?;
    let full = sandboxed(&root, path)?;
    std::fs::read_to_string(&full).map_err(|_| String::new()) // empty on missing file
}

/// Lightweight file existence + size check used by the implementation node
/// to verify what the agent actually did on disk after a per-file iteration.
/// Crucially distinguishes "missing" from "empty" — `read_repo_file_internal`
/// can't, since it returns empty string for both.
///
/// Performs the same path-resolution trick as `write_repo_file`: canonicalise
/// the worktree root, then component-walk the relative path so we don't fail
/// on files that don't exist yet (the `create` case wants to confirm absence
/// pre-write).
pub fn stat_repo_file_internal(path: &str) -> Result<StatResult, String> {
    let root = worktree_path()?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve worktree root: {e}"))?;
    let mut resolved = canonical_root.clone();
    for component in std::path::Path::new(path).components() {
        use std::path::Component;
        match component {
            Component::Normal(c) => resolved.push(c),
            Component::ParentDir => {
                if !resolved.pop() {
                    return Err(format!("Path '{}' escapes the worktree root", path));
                }
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    if !resolved.starts_with(&canonical_root) {
        return Err(format!("Path '{}' is outside the worktree root", path));
    }
    match std::fs::metadata(&resolved) {
        Ok(md) => Ok(StatResult {
            exists: md.is_file(),
            size_bytes: md.len(),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StatResult {
            exists: false,
            size_bytes: 0,
        }),
        Err(e) => Err(format!("Could not stat '{}': {e}", path)),
    }
}

/// Non-command helper used by the implementation agent in claude.rs.
/// Writes a file to the main implementation worktree, creating parent dirs as needed.
pub fn write_repo_file_internal(path: &str, content: &str) -> Result<(), String> {
    let root = worktree_path()?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve worktree root: {e}"))?;
    let mut resolved = canonical_root.clone();
    for component in std::path::Path::new(path).components() {
        use std::path::Component;
        match component {
            Component::Normal(c) => resolved.push(c),
            Component::ParentDir => {
                if !resolved.pop() {
                    return Err(format!("Path '{}' escapes the worktree root", path));
                }
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    if !resolved.starts_with(&canonical_root) {
        return Err(format!("Path '{}' is outside the worktree root", path));
    }
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create directories for '{}': {e}", path))?;
    }
    std::fs::write(&resolved, content).map_err(|e| format!("Could not write '{}': {e}", path))
}

/// Non-command helper used by the implementation agent in claude.rs.
/// Stages all changes in the main implementation worktree (`git add -A`).
pub fn git_add_all_internal() -> Result<(), String> {
    let root = worktree_path()?;
    git(&root, &["add", "-A"])?;
    Ok(())
}

/// Non-command helper used by the implementation agent in claude.rs.
/// Deletes a file from the main implementation worktree.
pub fn delete_repo_file_internal(path: &str) -> Result<(), String> {
    let root = worktree_path()?;
    let full = sandboxed(&root, path)?;
    std::fs::remove_file(&full).map_err(|e| format!("Could not delete '{}': {e}", path))
}

/// Move (rename) a file within the main implementation worktree.
pub fn move_repo_file_internal(from: &str, to: &str) -> Result<(), String> {
    let root = worktree_path()?;
    let full_from = sandboxed(&root, from)?;
    // Destination may not exist yet so we can't canonicalise it; validate manually.
    let to_clean = to.trim_start_matches('/').trim_start_matches("./");
    let full_to = root.join(to_clean);
    if let Some(parent) = full_to.parent() {
        if parent != root.as_path() {
            // Create intermediate directories if needed
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create destination directory: {e}"))?;
            let canon_parent = parent
                .canonicalize()
                .map_err(|e| format!("Destination directory invalid: {e}"))?;
            let canon_root = root
                .canonicalize()
                .map_err(|_| "Could not canonicalise worktree root".to_string())?;
            if !canon_parent.starts_with(&canon_root) {
                return Err(format!("Destination '{to}' would escape the worktree root."));
            }
        }
    }
    std::fs::rename(&full_from, &full_to)
        .map_err(|e| format!("Could not move '{}' to '{}': {e}", from, to))
}

/// Run `git status --short` plus `git diff --stat` in the worktree.
pub async fn git_status_internal() -> Result<String, String> {
    let root = worktree_path()?;
    let status = git(&root, &["status", "--short"]).unwrap_or_default();
    let stat = git(&root, &["diff", "--stat", "HEAD"]).unwrap_or_default();
    if status.trim().is_empty() && stat.trim().is_empty() {
        return Ok("Working tree is clean — no uncommitted changes.".to_string());
    }
    let mut out = String::new();
    if !status.trim().is_empty() {
        out.push_str("=== git status ===\n");
        out.push_str(&status);
    }
    if !stat.trim().is_empty() {
        out.push_str("\n=== git diff --stat HEAD ===\n");
        out.push_str(&stat);
    }
    Ok(out.trim().to_string())
}

#[tauri::command]
pub async fn read_repo_file(path: String) -> Result<String, String> {
    read_file_in(&worktree_path()?, &path)
}

/// Glob files in the grooming worktree (falls back to main worktree).
#[tauri::command]
pub async fn glob_grooming_files(pattern: String) -> Result<Vec<String>, String> {
    glob_files_in(&grooming_worktree_path()?, &pattern)
}

/// Grep files in the grooming worktree (falls back to main worktree).
#[tauri::command]
pub async fn grep_grooming_files(
    pattern: String,
    path: Option<String>,
) -> Result<Vec<String>, String> {
    grep_files_in(&grooming_worktree_path()?, &pattern, path.as_deref())
}

/// Read a file from the grooming worktree (falls back to main worktree).
#[tauri::command]
pub async fn read_grooming_file(path: String) -> Result<String, String> {
    read_file_in(&grooming_worktree_path()?, &path)
}

/// Write a file in the implementation worktree, sandboxed to the worktree root.
/// Used exclusively by the Implementation agent to apply code changes.
#[tauri::command]
pub async fn write_repo_file(path: String, content: String) -> Result<(), String> {
    let root = worktree_path()?;
    // For new files the path won't exist yet — do a prefix check instead of canonicalize.
    let full = root.join(&path);
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve worktree root: {e}"))?;
    // Resolve any .. components without requiring the file to exist.
    let mut resolved = canonical_root.clone();
    for component in std::path::Path::new(&path).components() {
        use std::path::Component;
        match component {
            Component::Normal(c) => resolved.push(c),
            Component::ParentDir => {
                if !resolved.pop() {
                    return Err(format!("Path '{}' escapes the worktree root", path));
                }
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    if !resolved.starts_with(&canonical_root) {
        return Err(format!("Path '{}' is outside the worktree root", path));
    }
    // Create parent directories if they don't exist.
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create directories for '{}': {e}", path))?;
    }
    std::fs::write(&full, content).map_err(|e| format!("Could not write '{}': {e}", path))?;
    Ok(())
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
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create dirs for {path}: {e}"))?;
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

