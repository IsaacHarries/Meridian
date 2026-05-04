use std::process::Command;

use super::_shared::{get_config, pr_review_worktree_path, worktree_path};

/// Open a terminal window in the PR review worktree directory and run the
/// supplied command. The terminal application is read from the
/// `pr_review_terminal` credential (defaults to "iTerm2").
/// Supported values: "iTerm2", "Terminal", or any other app name that
/// supports the standard macOS Terminal AppleScript dictionary.
#[tauri::command]
pub async fn run_in_terminal(command: String) -> Result<(), String> {
    let path = pr_review_worktree_path()?;
    let path_str = path.to_string_lossy();

    let terminal = get_config("pr_review_terminal").unwrap_or_else(|| "iTerm2".to_string());
    let terminal = terminal.trim().to_string();

    let script = if terminal.to_lowercase() == "iterm2" || terminal == "iTerm2" {
        // iTerm2: open a new tab in the existing window, or a new window if none is open.
        format!(
            r#"tell application "iTerm2"
    activate
    if (count of windows) > 0 then
        tell current window
            set newTab to (create tab with default profile)
            tell current session of newTab
                write text "cd {path_str} && {command}"
            end tell
        end tell
    else
        set newWindow to (create window with default profile)
        tell current session of newWindow
            write text "cd {path_str} && {command}"
        end tell
    end if
end tell"#
        )
    } else {
        // Terminal.app: open a new tab in the front window, or a new window if none is open.
        format!(
            r#"tell application "{terminal}"
    activate
    if (count of windows) > 0 then
        tell front window
            do script "cd {path_str} && {command}" in front window
        end tell
    else
        do script "cd {path_str} && {command}"
    end if
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

/// Run an arbitrary shell command in the configured implementation worktree and
/// capture its combined stdout+stderr. Returns the exit code and output so the
/// caller can decide how to handle failures.
/// `timeout_secs` caps execution time (clamped to 300 s).
#[tauri::command]
pub async fn exec_in_worktree(
    command: String,
    timeout_secs: Option<u64>,
) -> Result<(i32, String), String> {
    let root = worktree_path()?;
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(120).min(300));

    let child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

    let result = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "Command timed out after {} seconds",
                timeout.as_secs()
            )
        })?
        .map_err(|e| format!("Command execution failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&result.stdout).to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).to_string();
    let combined = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (true, true) => "(no output)".to_string(),
        (true, false) => stderr,
        (false, true) => stdout,
        (false, false) => format!("{stdout}\n{stderr}"),
    };
    let exit_code = result.status.code().unwrap_or(-1);
    Ok((exit_code, combined))
}

/// Internal version callable from other backend modules.
pub async fn exec_in_worktree_internal(command: &str, timeout_secs: u64) -> Result<(i32, String), String> {
    exec_in_worktree(command.to_string(), Some(timeout_secs)).await
}
