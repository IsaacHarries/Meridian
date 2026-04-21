const TOOL_FETCH_URL: &str = "fetch_url";
const TOOL_READ_REPO_FILE: &str = "read_repo_file";
const TOOL_WRITE_REPO_FILE: &str = "write_repo_file";
const TOOL_GREP_REPO: &str = "grep_repo";
const TOOL_SEARCH_JIRA: &str = "search_jira";
const TOOL_GET_JIRA_ISSUE: &str = "get_jira_issue";
const TOOL_GET_PR_DIFF: &str = "get_pr_diff";
const TOOL_GET_PR_COMMENTS: &str = "get_pr_comments";
const TOOL_GIT_LOG: &str = "git_log";
const TOOL_SEARCH_NPM: &str = "search_npm";
const TOOL_SEARCH_CRATES: &str = "search_crates";
pub const TOOL_REQUEST_TOOL: &str = "request_tool";
pub const TOOL_EXEC_IN_WORKTREE: &str = "exec_in_worktree";
pub const TOOL_GLOB_REPO: &str = "glob_repo";
pub const TOOL_GIT_STATUS: &str = "git_status";
pub const TOOL_DELETE_REPO_FILE: &str = "delete_repo_file";
pub const TOOL_MOVE_REPO_FILE: &str = "move_repo_file";
pub const TOOL_GET_REPO_DIFF: &str = "get_repo_diff";
pub const TOOL_WEB_SEARCH: &str = "web_search";
pub const TOOL_GET_FILE_AT_BASE: &str = "get_file_at_base";
pub const TOOL_GET_PACKAGE_INFO: &str = "get_package_info";

pub fn all_tools_def() -> serde_json::Value {
    serde_json::json!([
        {
            "name": TOOL_FETCH_URL,
            "description": "Fetch the plain-text content of any public URL. \
                Use for API docs, library READMEs, changelogs, GitHub pages, \
                benchmark comparisons, or any live web resource.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Full https:// URL to fetch" }
                },
                "required": ["url"]
            }
        },
        {
            "name": TOOL_READ_REPO_FILE,
            "description": "Read a source file from the configured local git worktree. \
                Use when you need to see more code context beyond what was already provided, \
                e.g. to understand how a function is implemented or what a module exports.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path from the repo root, e.g. 'src/reports/index.ts'" }
                },
                "required": ["path"]
            }
        },
        {
            "name": TOOL_WRITE_REPO_FILE,
            "description": "Write or overwrite a file in the configured git worktree. \
                Use this to create new files or apply changes to existing ones. \
                Always provide the COMPLETE file content — partial content will overwrite the whole file. \
                Read the current file first with read_repo_file if you need to preserve existing content.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path":    { "type": "string", "description": "Repo-relative path, e.g. 'src/utils/helper.ts'" },
                    "content": { "type": "string", "description": "Complete new file content" }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": TOOL_GREP_REPO,
            "description": "Search the codebase for a regex pattern using git grep. \
                Use to find all usages of a function, class, constant, or identifier. \
                Returns up to 200 matching lines with file paths and line numbers.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Extended regex pattern to search for" },
                    "path":    { "type": "string", "description": "Optional subdirectory to restrict the search (e.g. 'src/reports')" }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": TOOL_SEARCH_JIRA,
            "description": "Search JIRA for related tickets by keyword or JQL. \
                Use to find duplicate tickets, dependency tickets, or related work \
                the engineer mentioned. Returns up to 10 matching tickets.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Keyword search string or JQL (e.g. 'upsertReportPage' or 'project = FJP AND summary ~ \"undo\"')" }
                },
                "required": ["query"]
            }
        },
        {
            "name": TOOL_GET_JIRA_ISSUE,
            "description": "Fetch a specific JIRA ticket by its key (e.g. FJP-1234). \
                Use when the engineer references a ticket you need to read for context.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "JIRA issue key, e.g. 'FJP-1234'" }
                },
                "required": ["key"]
            }
        },
        {
            "name": TOOL_GET_PR_DIFF,
            "description": "Fetch the full diff of a Bitbucket pull request by its numeric ID. \
                Use when the engineer mentions a related PR you need to read.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pr_id": { "type": "integer", "description": "Numeric Bitbucket PR ID" }
                },
                "required": ["pr_id"]
            }
        },
        {
            "name": TOOL_GET_PR_COMMENTS,
            "description": "Fetch the comments on a Bitbucket pull request by its numeric ID. \
                Use to read reviewer feedback on a related PR.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pr_id": { "type": "integer", "description": "Numeric Bitbucket PR ID" }
                },
                "required": ["pr_id"]
            }
        },
        {
            "name": TOOL_GIT_LOG,
            "description": "Get recent git commit history from the worktree. \
                Optionally restrict to a specific file to understand when and why it was last changed. \
                Returns the last N commits (default 20, max 50).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file":       { "type": "string",  "description": "Optional relative file path to filter history" },
                    "max_commits": { "type": "integer", "description": "Number of commits to return (default 20)" }
                },
                "required": []
            }
        },
        {
            "name": TOOL_SEARCH_NPM,
            "description": "Search the npm registry for a JavaScript/TypeScript package. \
                Returns the package description, version, weekly downloads, and homepage. \
                Use when brainstorming library choices or checking if a package exists.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "package": { "type": "string", "description": "Package name or search term" }
                },
                "required": ["package"]
            }
        },
        {
            "name": TOOL_SEARCH_CRATES,
            "description": "Search crates.io for a Rust crate. \
                Returns the crate description, version, downloads, and repository link. \
                Use when brainstorming Rust library choices.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Crate name or search term" }
                },
                "required": ["name"]
            }
        },
        {
            "name": TOOL_GLOB_REPO,
            "description": "Find files in the repo by glob pattern. Returns matching paths relative to the repo root. \
                Use this to discover what files exist — e.g. all TypeScript files, all test files, all files in a directory.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern, e.g. 'src/**/*.tsx', '**/*.test.ts', 'src/components/*'" }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": TOOL_GIT_STATUS,
            "description": "Show the current git working tree status: which files have been added, modified, or deleted \
                since the last commit. Also shows a diff --stat summary of what changed.",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": TOOL_DELETE_REPO_FILE,
            "description": "Delete a file from the repo worktree. Use when removing a file is part of the implementation \
                (e.g. removing an obsolete component, cleaning up a renamed file).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path from repo root, e.g. src/old/Component.tsx" }
                },
                "required": ["path"]
            }
        },
        {
            "name": TOOL_MOVE_REPO_FILE,
            "description": "Move or rename a file within the repo worktree. Intermediate directories are created automatically. \
                Use for refactoring that involves moving or renaming files.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "Current relative path, e.g. src/utils/old.ts" },
                    "to":   { "type": "string", "description": "New relative path, e.g. src/utils/new.ts" }
                },
                "required": ["from", "to"]
            }
        },
        {
            "name": TOOL_GET_REPO_DIFF,
            "description": "Get the full unified diff of all changes made since branching from the base branch. \
                Use this to review everything that has been changed in the current implementation session.",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": TOOL_WEB_SEARCH,
            "description": "Search the web via DuckDuckGo and return the top results (title, URL, snippet). \
                Use to look up error messages, find library documentation, research an unfamiliar API, \
                or find solutions to build/runtime errors.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query, e.g. 'TypeScript cannot find module error', 'React useEffect cleanup pattern'" }
                },
                "required": ["query"]
            }
        },
        {
            "name": TOOL_GET_FILE_AT_BASE,
            "description": "Read a file's content as it existed at the base branch before any implementation changes were made. \
                Use this to see the original version of a file you have modified, compare before/after, \
                or restore a file you accidentally overwrote.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path from repo root, e.g. src/utils/helper.ts" }
                },
                "required": ["path"]
            }
        },
        {
            "name": TOOL_GET_PACKAGE_INFO,
            "description": "Fetch detailed information about a specific npm or Rust crate package: description, \
                latest version, README, peer/dev dependencies, exports, and repository link. \
                Use this to understand a library's API before writing code that uses it.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "package":   { "type": "string", "description": "Package name, e.g. 'zustand' or 'serde'" },
                    "ecosystem": { "type": "string", "description": "'npm' for JavaScript/TypeScript packages, 'cargo' for Rust crates" }
                },
                "required": ["package", "ecosystem"]
            }
        },
        {
            "name": TOOL_EXEC_IN_WORKTREE,
            "description": "Run a shell command in the project's git worktree and return its combined stdout+stderr output. \
                Use for building the project, running the type-checker, running tests, checking linting, \
                or any other shell task needed to verify or fix the code. \
                Timeout: 5 minutes. The command runs with `sh -c` in the repo root.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to run, e.g. 'pnpm build' or 'cargo check'" },
                    "timeout_secs": { "type": "integer", "description": "Optional timeout in seconds (max 300, default 120)" }
                },
                "required": ["command"]
            }
        },
        {
            "name": TOOL_REQUEST_TOOL,
            "description": "Request that the developer add a new tool to Meridian. \
                Use this when you genuinely need a capability that none of the existing tools \
                provide and you cannot complete your task without it. \
                Be specific: describe exactly what data you need, why no existing tool covers it, \
                and how it would help you right now.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name":        { "type": "string", "description": "Short slug for the proposed tool, e.g. 'get_build_logs'" },
                    "description": { "type": "string", "description": "One sentence: what the tool would do" },
                    "why_needed":  { "type": "string", "description": "Why no existing tool covers this and what context it would unlock" },
                    "example_call":{ "type": "string", "description": "A concrete example of how you would call it, e.g. get_build_logs(branch='task/FJP-1234', last_n=50)" }
                },
                "required": ["name", "description", "why_needed"]
            }
        }
    ])
}

pub const TOOL_SYSTEM_SUFFIX: &str = "\n\n\
    === AVAILABLE TOOLS ===\n\
    You have access to the following tools. Use them when they would improve your answer.\n\
    To call a tool, output ONLY the tag on its own line — nothing else on that line.\n\
    The system will run the tool and send you the result before you continue.\n\n\
    fetch_url        — fetch a web page as plain text:\n\
        <fetch_url url=\"https://example.com\"/>\n\n\
    read_repo_file   — read a source file from the codebase:\n\
        <read_repo_file path=\"src/reports/index.ts\"/>\n\n\
    write_repo_file  — write or overwrite a file; put the COMPLETE content between the tags:\n\
        <write_repo_file path=\"src/utils/helper.ts\">\n\
        // complete file content here — can contain any characters\n\
        </write_repo_file>\n\n\
    glob_repo        — find files by glob pattern:\n\
        <glob_repo pattern=\"src/**/*.tsx\"/>\n\
        <glob_repo pattern=\"**/*.test.ts\"/>\n\n\
    grep_repo        — search codebase by regex (optional path filter):\n\
        <grep_repo pattern=\"upsertReportPage\" path=\"src/reports\"/>\n\n\
    search_jira      — search JIRA by keyword or JQL:\n\
        <search_jira query=\"undo redo reports\"/>\n\n\
    get_jira_issue   — fetch a specific JIRA ticket:\n\
        <get_jira_issue key=\"FJP-1234\"/>\n\n\
    get_pr_diff      — fetch a Bitbucket PR diff:\n\
        <get_pr_diff pr_id=\"456\"/>\n\n\
    get_pr_comments  — fetch comments on a Bitbucket PR:\n\
        <get_pr_comments pr_id=\"456\"/>\n\n\
    git_log          — recent git history (optional file and count):\n\
        <git_log file=\"src/reports/index.ts\" max_commits=\"20\"/>\n\n\
    search_npm       — search npm registry for a JS/TS package:\n\
        <search_npm package=\"zustand\"/>\n\n\
    search_crates    — search crates.io for a Rust crate:\n\
        <search_crates name=\"serde\"/>\n\n\
    git_status       — show which files have changed in the working tree:\n\
        <git_status/>\n\n\
    get_repo_diff    — get the full unified diff of all changes since branching:\n\
        <get_repo_diff/>\n\n\
    delete_repo_file — delete a file from the repo:\n\
        <delete_repo_file path=\"src/old/Component.tsx\"/>\n\n\
    move_repo_file   — move or rename a file:\n\
        <move_repo_file from=\"src/utils/old.ts\" to=\"src/utils/new.ts\"/>\n\n\
    web_search       — search the web (DuckDuckGo) and return top results:\n\
        <web_search query=\"TypeScript cannot find module error\"/>\n\n\
    get_file_at_base — read a file as it was before any implementation changes:\n\
        <get_file_at_base path=\"src/utils/helper.ts\"/>\n\n\
    get_package_info — fetch README, version, deps, and exports for a specific package:\n\
        <get_package_info package=\"zustand\" ecosystem=\"npm\"/>\n\
        <get_package_info package=\"serde\" ecosystem=\"cargo\"/>\n\n\
    exec_in_worktree — run a shell command in the repo root and return stdout+stderr (timeout 5 min):\n\
        <exec_in_worktree command=\"pnpm build\"/>\n\
        <exec_in_worktree command=\"cargo check\" timeout_secs=\"60\"/>\n\n\
    request_tool     — ask the developer to add a new Meridian tool:\n\
        <request_tool name=\"get_build_logs\" description=\"Fetch CI build logs for a branch\" why_needed=\"I need to check why the build is failing but have no way to read CI output\" example_call=\"get_build_logs(branch='task/FJP-1234', last_n=50)\"/>\n\n\
    Rules:\n\
    - Call at most one tool per response turn.\n\
    - Stop after outputting the tag — do not continue until you receive the result.\n\
    - If a tool fails, say so and answer from your existing knowledge instead.\n\
    - Do NOT call a tool if you can answer accurately from the context already provided.";

pub async fn execute_tool(name: &str, input: &serde_json::Value) -> String {
    match name {
        TOOL_FETCH_URL => {
            let url = input["url"].as_str().unwrap_or("");
            if url.is_empty() {
                return "[fetch_url: missing url]".to_string();
            }
            match crate::commands::fetch_url::fetch_url_content(url.to_string()).await {
                Ok(c) => c,
                Err(e) => format!("[fetch_url failed: {e}]"),
            }
        }

        TOOL_READ_REPO_FILE => {
            let path = input["path"].as_str().unwrap_or("");
            if path.is_empty() {
                return "[read_repo_file: missing path]".to_string();
            }
            match crate::commands::repo::read_repo_file(path.to_string()).await {
                Ok(c) => format!("=== {path} ===\n{c}"),
                Err(e) => format!("[read_repo_file failed for '{path}': {e}]"),
            }
        }

        TOOL_WRITE_REPO_FILE => {
            let path = input["path"].as_str().unwrap_or("");
            let content = input["content"].as_str().unwrap_or("");
            if path.is_empty() {
                return "[write_repo_file: missing path]".to_string();
            }
            match crate::commands::repo::write_repo_file(path.to_string(), content.to_string()).await {
                Ok(_) => format!("[write_repo_file: wrote {} bytes to '{path}']", content.len()),
                Err(e) => format!("[write_repo_file failed for '{path}': {e}]"),
            }
        }

        TOOL_GREP_REPO => {
            let pattern = input["pattern"].as_str().unwrap_or("").to_string();
            let path = input["path"].as_str().map(str::to_string);
            if pattern.is_empty() {
                return "[grep_repo: missing pattern]".to_string();
            }
            match crate::commands::repo::grep_repo_files(pattern.clone(), path).await {
                Ok(lines) if lines.is_empty() => format!("[grep_repo: no matches for '{pattern}']"),
                Ok(lines) => {
                    const MAX_GREP_BYTES: usize = 12 * 1024;
                    let joined = lines.join("\n");
                    if joined.len() > MAX_GREP_BYTES {
                        format!(
                            "{}\n\n[… grep output truncated at 12 KB — use a more specific pattern or path to narrow results …]",
                            &joined[..MAX_GREP_BYTES]
                        )
                    } else {
                        joined
                    }
                }
                Err(e) => format!("[grep_repo failed: {e}]"),
            }
        }

        TOOL_SEARCH_JIRA => {
            let query = input["query"].as_str().unwrap_or("").to_string();
            if query.is_empty() {
                return "[search_jira: missing query]".to_string();
            }
            match crate::commands::jira::search_jira_issues(query.clone(), 10).await {
                Ok(issues) if issues.is_empty() => {
                    format!("[search_jira: no results for '{query}']")
                }
                Ok(issues) => {
                    let mut out = format!("JIRA search results for '{query}':\n\n");
                    for issue in &issues {
                        out.push_str(&format!(
                            "## {} — {}\nType: {} | Status: {} | Points: {}\n{}\n\n",
                            issue.key,
                            issue.summary,
                            issue.issue_type,
                            issue.status,
                            issue
                                .story_points
                                .map_or("?".to_string(), |p| p.to_string()),
                            issue.description.as_deref().unwrap_or("(no description)"),
                        ));
                    }
                    out
                }
                Err(e) => format!("[search_jira failed: {e}]"),
            }
        }

        TOOL_GET_JIRA_ISSUE => {
            let key = input["key"].as_str().unwrap_or("").to_string();
            if key.is_empty() {
                return "[get_jira_issue: missing key]".to_string();
            }
            match crate::commands::jira::get_issue(key.clone()).await {
                Ok(issue) => format!(
                    "## {} — {}\nType: {} | Status: {} | Points: {}\n\nDescription:\n{}\n\nAcceptance Criteria:\n{}",
                    issue.key,
                    issue.summary,
                    issue.issue_type,
                    issue.status,
                    issue.story_points.map_or("?".to_string(), |p| p.to_string()),
                    issue.description.as_deref().unwrap_or("(none)"),
                    issue.acceptance_criteria.as_deref().unwrap_or("(none)"),
                ),
                Err(e) => format!("[get_jira_issue failed for '{key}': {e}]"),
            }
        }

        TOOL_GET_PR_DIFF => {
            let pr_id = match input["pr_id"].as_i64() {
                Some(id) => id,
                None => return "[get_pr_diff: missing or invalid pr_id]".to_string(),
            };
            match crate::commands::bitbucket::get_pr_diff(pr_id).await {
                Ok(diff) => {
                    const MAX: usize = 80 * 1024;
                    if diff.len() > MAX {
                        format!("{}\n\n[diff truncated at 80 KB]", &diff[..MAX])
                    } else {
                        diff
                    }
                }
                Err(e) => format!("[get_pr_diff failed for PR {pr_id}: {e}]"),
            }
        }

        TOOL_GET_PR_COMMENTS => {
            let pr_id = match input["pr_id"].as_i64() {
                Some(id) => id,
                None => return "[get_pr_comments: missing or invalid pr_id]".to_string(),
            };
            match crate::commands::bitbucket::get_pr_comments(pr_id).await {
                Ok(comments) if comments.is_empty() => format!("[No comments on PR {pr_id}]"),
                Ok(comments) => {
                    let mut out = format!("Comments on PR {pr_id}:\n\n");
                    for c in comments.iter().take(50) {
                        let loc = c
                            .inline
                            .as_ref()
                            .map(|i| {
                                format!(
                                    " ({}{})",
                                    i.path,
                                    i.to_line.map_or(String::new(), |l| format!(" L{l}"))
                                )
                            })
                            .unwrap_or_default();
                        out.push_str(&format!(
                            "[{}{}]: {}\n\n",
                            c.author.display_name, loc, c.content,
                        ));
                    }
                    out
                }
                Err(e) => format!("[get_pr_comments failed for PR {pr_id}: {e}]"),
            }
        }

        TOOL_GIT_LOG => {
            let file = input["file"].as_str();
            let max = input["max_commits"].as_u64().unwrap_or(20).min(50) as u32;
            let result = if let Some(f) = file {
                crate::commands::repo::get_file_history(f.to_string(), max).await
            } else {
                crate::commands::repo::get_repo_log(max).await
            };
            match result {
                Ok(log) => log,
                Err(e) => format!("[git_log failed: {e}]"),
            }
        }

        TOOL_SEARCH_NPM => {
            let package = input["package"].as_str().unwrap_or("").trim().to_string();
            if package.is_empty() {
                return "[search_npm: missing package name]".to_string();
            }
            search_npm_registry(&package).await
        }

        TOOL_SEARCH_CRATES => {
            let name = input["name"].as_str().unwrap_or("").trim().to_string();
            if name.is_empty() {
                return "[search_crates: missing crate name]".to_string();
            }
            search_crates_io(&name).await
        }

        TOOL_GLOB_REPO => {
            let pattern = input["pattern"].as_str().unwrap_or("**/*");
            match crate::commands::repo::glob_repo_files(pattern.to_string()).await {
                Ok(files) if files.is_empty() => {
                    format!("[glob_repo: no files matched '{pattern}']")
                }
                Ok(files) => {
                    format!("[glob_repo: {} file(s) matched '{pattern}']\n{}", files.len(), files.join("\n"))
                }
                Err(e) => format!("[glob_repo failed: {e}]"),
            }
        }

        TOOL_GIT_STATUS => {
            match crate::commands::repo::git_status_internal().await {
                Ok(s) => s,
                Err(e) => format!("[git_status failed: {e}]"),
            }
        }

        TOOL_DELETE_REPO_FILE => {
            let path = input["path"].as_str().unwrap_or("");
            if path.is_empty() {
                return "[delete_repo_file: missing path]".to_string();
            }
            match crate::commands::repo::delete_repo_file_internal(path) {
                Ok(_) => format!("[delete_repo_file: deleted '{path}']"),
                Err(e) => format!("[delete_repo_file failed: {e}]"),
            }
        }

        TOOL_MOVE_REPO_FILE => {
            let from = input["from"].as_str().unwrap_or("");
            let to = input["to"].as_str().unwrap_or("");
            if from.is_empty() || to.is_empty() {
                return "[move_repo_file: 'from' and 'to' are required]".to_string();
            }
            match crate::commands::repo::move_repo_file_internal(from, to) {
                Ok(_) => format!("[move_repo_file: moved '{from}' → '{to}']"),
                Err(e) => format!("[move_repo_file failed: {e}]"),
            }
        }

        TOOL_GET_REPO_DIFF => {
            match crate::commands::repo::get_repo_diff().await {
                Ok(diff) if diff.trim().is_empty() => {
                    "[get_repo_diff: no changes vs base branch]".to_string()
                }
                Ok(diff) => diff,
                Err(e) => format!("[get_repo_diff failed: {e}]"),
            }
        }

        TOOL_WEB_SEARCH => {
            let query = input["query"].as_str().unwrap_or("");
            if query.is_empty() {
                return "[web_search: missing query]".to_string();
            }
            match crate::commands::fetch_url::web_search(query).await {
                Ok(results) => results,
                Err(e) => format!("[web_search failed: {e}]"),
            }
        }

        TOOL_GET_FILE_AT_BASE => {
            let path = input["path"].as_str().unwrap_or("");
            if path.is_empty() {
                return "[get_file_at_base: missing path]".to_string();
            }
            match crate::commands::repo::get_file_at_base(path.to_string()).await {
                Ok(content) if content.is_empty() => {
                    format!("[get_file_at_base: '{path}' did not exist at the base branch — it is a new file]")
                }
                Ok(content) => format!("// {path} at base branch:\n{content}"),
                Err(e) => format!("[get_file_at_base failed: {e}]"),
            }
        }

        TOOL_GET_PACKAGE_INFO => {
            let package = input["package"].as_str().unwrap_or("").trim().to_string();
            let ecosystem = input["ecosystem"].as_str().unwrap_or("").trim().to_lowercase();
            if package.is_empty() {
                return "[get_package_info: missing package name]".to_string();
            }
            match ecosystem.as_str() {
                "npm" => get_npm_package_info(&package).await,
                "cargo" => get_cargo_package_info(&package).await,
                other => format!("[get_package_info: unknown ecosystem '{other}' — use 'npm' or 'cargo']"),
            }
        }

        TOOL_EXEC_IN_WORKTREE => {
            let command = input["command"].as_str().unwrap_or("");
            if command.is_empty() {
                return "[exec_in_worktree: missing command]".to_string();
            }
            let timeout = input["timeout_secs"].as_u64().unwrap_or(120).min(300);
            match crate::commands::repo::exec_in_worktree_internal(command, timeout).await {
                Ok((code, output)) => {
                    if output.is_empty() {
                        format!("[exec_in_worktree: exit code {code} — (no output)]")
                    } else {
                        format!("[exec_in_worktree: exit code {code}]\n{output}")
                    }
                }
                Err(e) => format!("[exec_in_worktree failed: {e}]"),
            }
        }

        TOOL_REQUEST_TOOL => {
            let name = input["name"].as_str().unwrap_or("(unnamed)");
            let description = input["description"].as_str().unwrap_or("");
            let why_needed = input["why_needed"].as_str().unwrap_or("");
            let example = input["example_call"].as_str().unwrap_or("");
            format!(
                "[tool_request_received]\n\
                 Your request for the '{}' tool has been surfaced to the developer in the UI.\n\
                 Tool: {}\n\
                 Why needed: {}\n\
                 Example: {}\n\
                 Please continue your response explaining what you cannot do without this tool \
                 and what you'll do in the meantime.",
                name, description, why_needed, example
            )
        }

        other => format!("[Unknown tool: {other}]"),
    }
}

async fn search_npm_registry(package: &str) -> String {
    let client = match crate::http::make_corporate_client(std::time::Duration::from_secs(10), false) {
        Ok(c) => c,
        Err(e) => return format!("[search_npm: http client error: {e}]"),
    };
    let url = format!(
        "https://registry.npmjs.org/-/v1/search?text={}&size=5",
        urlencoding_simple(package)
    );
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(json) => {
                let objects = json["objects"].as_array().cloned().unwrap_or_default();
                if objects.is_empty() {
                    return format!("[search_npm: no results for '{package}']");
                }
                let mut out = format!("npm search results for '{package}':\n\n");
                for obj in objects.iter().take(5) {
                    let p = &obj["package"];
                    let name = p["name"].as_str().unwrap_or("?");
                    let version = p["version"].as_str().unwrap_or("?");
                    let desc = p["description"].as_str().unwrap_or("(no description)");
                    let weekly = obj["score"]["detail"]["popularity"]
                        .as_f64()
                        .map(|v| format!("{:.0}%", v * 100.0))
                        .unwrap_or_else(|| "?".to_string());
                    let links = p["links"]["npm"].as_str().unwrap_or("");
                    out.push_str(&format!(
                        "**{name}** v{version}\n{desc}\nPopularity: {weekly} | {links}\n\n"
                    ));
                }
                out
            }
            Err(e) => format!("[search_npm: parse error: {e}]"),
        },
        Ok(resp) => format!("[search_npm: HTTP {}]", resp.status()),
        Err(e) => format!("[search_npm: request failed: {e}]"),
    }
}

async fn search_crates_io(name: &str) -> String {
    let client = match crate::http::make_corporate_client(std::time::Duration::from_secs(10), false) {
        Ok(c) => c,
        Err(e) => return format!("[search_crates: http client error: {e}]"),
    };
    let url = format!(
        "https://crates.io/api/v1/crates?q={}&per_page=5",
        urlencoding_simple(name)
    );
    match client
        .get(&url)
        .header(
            "User-Agent",
            "Meridian/1.0 (https://github.com/meridian-app)",
        )
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(json) => {
                let crates = json["crates"].as_array().cloned().unwrap_or_default();
                if crates.is_empty() {
                    return format!("[search_crates: no results for '{name}']");
                }
                let mut out = format!("crates.io search results for '{name}':\n\n");
                for c in crates.iter().take(5) {
                    let cname = c["name"].as_str().unwrap_or("?");
                    let version = c["newest_version"].as_str().unwrap_or("?");
                    let desc = c["description"].as_str().unwrap_or("(no description)");
                    let downloads = c["downloads"].as_u64().unwrap_or(0);
                    let repo = c["repository"].as_str().unwrap_or("");
                    out.push_str(&format!(
                        "**{cname}** v{version}\n{desc}\nDownloads: {downloads} | {repo}\n\n"
                    ));
                }
                out
            }
            Err(e) => format!("[search_crates: parse error: {e}]"),
        },
        Ok(resp) => format!("[search_crates: HTTP {}]", resp.status()),
        Err(e) => format!("[search_crates: request failed: {e}]"),
    }
}

async fn get_npm_package_info(package: &str) -> String {
    let client = match crate::http::make_corporate_client(std::time::Duration::from_secs(15)) {
        Ok(c) => c,
        Err(e) => return format!("[get_package_info: http client error: {e}]"),
    };
    let url = format!("https://registry.npmjs.org/{}", urlencoding_simple(package));
    let json: serde_json::Value = match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json().await {
            Ok(j) => j,
            Err(e) => return format!("[get_package_info: parse error: {e}]"),
        },
        Ok(resp) => return format!("[get_package_info: npm registry returned HTTP {}]", resp.status()),
        Err(e) => return format!("[get_package_info: request failed: {e}]"),
    };

    let latest = json["dist-tags"]["latest"].as_str().unwrap_or("unknown");
    let description = json["description"].as_str().unwrap_or("(no description)");
    let homepage = json["homepage"].as_str().unwrap_or("");
    let repo = json["repository"]["url"].as_str().unwrap_or("");

    let ver = &json["versions"][latest];
    let peer_deps = ver["peerDependencies"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| format!("  {k}: {}", v.as_str().unwrap_or("*")))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let dev_deps = ver["devDependencies"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| format!("  {k}: {}", v.as_str().unwrap_or("*")))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let exports = ver["exports"]
        .as_object()
        .map(|m| {
            m.keys()
                .take(10)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let types = ver["types"].as_str()
        .or_else(|| ver["typings"].as_str())
        .unwrap_or("");

    // README — stored at top level in the registry response, cap at 6 KB
    let readme_raw = json["readme"].as_str().unwrap_or("");
    const MAX_README: usize = 6_000;
    let readme = if readme_raw.len() > MAX_README {
        format!("{}\n\n[… README truncated at 6 KB]", &readme_raw[..MAX_README])
    } else {
        readme_raw.to_string()
    };

    let mut out = format!("**{package}** v{latest}\n{description}\n");
    if !homepage.is_empty() { out.push_str(&format!("Homepage: {homepage}\n")); }
    if !repo.is_empty() { out.push_str(&format!("Repo: {repo}\n")); }
    if !types.is_empty() { out.push_str(&format!("Types: {types}\n")); }
    if !exports.is_empty() { out.push_str(&format!("Exports: {exports}\n")); }
    if !peer_deps.is_empty() { out.push_str(&format!("\nPeer dependencies:\n{peer_deps}\n")); }
    if !dev_deps.is_empty() { out.push_str(&format!("\nDev dependencies (first 10):\n")); }
    if !readme.is_empty() { out.push_str(&format!("\n--- README ---\n{readme}\n")); }
    out
}

async fn get_cargo_package_info(name: &str) -> String {
    let client = match crate::http::make_corporate_client(std::time::Duration::from_secs(15)) {
        Ok(c) => c,
        Err(e) => return format!("[get_package_info: http client error: {e}]"),
    };
    let ua = "Meridian/1.0 (https://github.com/meridian-app)";

    // Fetch crate metadata
    let meta_url = format!("https://crates.io/api/v1/crates/{}", urlencoding_simple(name));
    let json: serde_json::Value = match client.get(&meta_url).header("User-Agent", ua).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json().await {
            Ok(j) => j,
            Err(e) => return format!("[get_package_info: parse error: {e}]"),
        },
        Ok(resp) => return format!("[get_package_info: crates.io returned HTTP {}]", resp.status()),
        Err(e) => return format!("[get_package_info: request failed: {e}]"),
    };

    let krate = &json["crate"];
    let version = krate["newest_version"].as_str().unwrap_or("unknown");
    let description = krate["description"].as_str().unwrap_or("(no description)");
    let docs = krate["documentation"].as_str().unwrap_or("");
    let repo = krate["repository"].as_str().unwrap_or("");
    let downloads = krate["downloads"].as_u64().unwrap_or(0);

    // Fetch latest version's dependencies
    let deps_url = format!("https://crates.io/api/v1/crates/{name}/{version}/dependencies");
    let deps_text = match client.get(&deps_url).header("User-Agent", ua).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(j) = resp.json::<serde_json::Value>().await {
                let deps = j["dependencies"].as_array().cloned().unwrap_or_default();
                let normal: Vec<String> = deps.iter()
                    .filter(|d| d["kind"].as_str() == Some("normal"))
                    .take(15)
                    .map(|d| format!("  {} = \"{}\"",
                        d["crate_id"].as_str().unwrap_or("?"),
                        d["req"].as_str().unwrap_or("*")))
                    .collect();
                normal.join("\n")
            } else { String::new() }
        }
        _ => String::new(),
    };

    // Fetch README (crates.io serves it at /readme endpoint)
    let readme_url = format!("https://crates.io/api/v1/crates/{name}/{version}/readme");
    let readme = match client.get(&readme_url).header("User-Agent", ua).send().await {
        Ok(resp) if resp.status().is_success() => {
            let html = resp.text().await.unwrap_or_default();
            let plain = crate::commands::fetch_url::strip_html_public(&html);
            const MAX_README: usize = 6_000;
            if plain.len() > MAX_README {
                format!("{}\n\n[… README truncated at 6 KB]", &plain[..MAX_README])
            } else {
                plain
            }
        }
        _ => String::new(),
    };

    let mut out = format!("**{name}** v{version}\n{description}\n");
    out.push_str(&format!("Downloads: {downloads}\n"));
    if !docs.is_empty() { out.push_str(&format!("Docs: {docs}\n")); }
    if !repo.is_empty() { out.push_str(&format!("Repo: {repo}\n")); }
    if !deps_text.is_empty() { out.push_str(&format!("\nDependencies:\n{deps_text}\n")); }
    if !readme.is_empty() { out.push_str(&format!("\n--- README ---\n{readme}\n")); }
    out
}

fn urlencoding_simple(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_string(),
            c => format!("%{:02X}", c as u32),
        })
        .collect()
}

pub struct TextToolCall {
    pub name: String,
    pub input: serde_json::Value,
    pub tag: String,
}

pub fn extract_text_tool_call(text: &str) -> Option<TextToolCall> {
    fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
        let dq = format!(r#"{}=""#, name);
        let sq = format!(r#"{}='"#, name);
        if let Some(start) = tag.find(&dq) {
            let rest = &tag[start + dq.len()..];
            rest.find('"').map(|end| &rest[..end])
        } else if let Some(start) = tag.find(&sq) {
            let rest = &tag[start + sq.len()..];
            rest.find('\'').map(|end| &rest[..end])
        } else {
            None
        }
    }

    // write_repo_file uses element form to safely carry arbitrary file content:
    //   <write_repo_file path="...">
    //   ...complete file content...
    //   </write_repo_file>
    {
        let open_prefix = "<write_repo_file ";
        let close_tag = "</write_repo_file>";
        if let Some(start) = text.find(open_prefix) {
            // Find the end of the opening tag (first > after the prefix)
            if let Some(rel_gt) = text[start..].find('>') {
                let open_end = start + rel_gt + 1;
                let opening = &text[start..open_end];
                // Must not be self-closing (no />)
                if !opening.trim_end().ends_with("/>") {
                    let path = attr(opening, "path").unwrap_or("").to_string();
                    if !path.is_empty() {
                        if let Some(rel_close) = text[open_end..].find(close_tag) {
                            let content = text[open_end..open_end + rel_close].to_string();
                            let full = text[start..open_end + rel_close + close_tag.len()].to_string();
                            return Some(TextToolCall {
                                name: TOOL_WRITE_REPO_FILE.to_string(),
                                input: serde_json::json!({ "path": path, "content": content }),
                                tag: full,
                            });
                        }
                    }
                }
            }
        }
    }

    let tools = [
        TOOL_FETCH_URL,
        TOOL_READ_REPO_FILE,
        // TOOL_WRITE_REPO_FILE handled above via element form
        TOOL_GREP_REPO,
        TOOL_SEARCH_JIRA,
        TOOL_GET_JIRA_ISSUE,
        TOOL_GET_PR_DIFF,
        TOOL_GET_PR_COMMENTS,
        TOOL_GIT_LOG,
        TOOL_SEARCH_NPM,
        TOOL_SEARCH_CRATES,
        TOOL_GLOB_REPO,
        TOOL_GIT_STATUS,
        TOOL_DELETE_REPO_FILE,
        TOOL_MOVE_REPO_FILE,
        TOOL_GET_REPO_DIFF,
        TOOL_WEB_SEARCH,
        TOOL_GET_FILE_AT_BASE,
        TOOL_GET_PACKAGE_INFO,
        TOOL_EXEC_IN_WORKTREE,
        TOOL_REQUEST_TOOL,
    ];

    for tool in &tools {
        let open = format!("<{tool}");
        if let Some(start) = text.find(&open) {
            if let Some(rel_end) = text[start..].find("/>") {
                let end = start + rel_end + 2;
                let tag_str = &text[start..end];

                let input = match *tool {
                    TOOL_FETCH_URL => {
                        let url = attr(tag_str, "url").unwrap_or("");
                        serde_json::json!({ "url": url })
                    }
                    TOOL_READ_REPO_FILE => {
                        let path = attr(tag_str, "path").unwrap_or("");
                        serde_json::json!({ "path": path })
                    }
                    TOOL_GREP_REPO => {
                        let pattern = attr(tag_str, "pattern").unwrap_or("");
                        let path = attr(tag_str, "path");
                        serde_json::json!({ "pattern": pattern, "path": path })
                    }
                    TOOL_SEARCH_JIRA => {
                        let query = attr(tag_str, "query").unwrap_or("");
                        serde_json::json!({ "query": query })
                    }
                    TOOL_GET_JIRA_ISSUE => {
                        let key = attr(tag_str, "key").unwrap_or("");
                        serde_json::json!({ "key": key })
                    }
                    TOOL_GET_PR_DIFF | TOOL_GET_PR_COMMENTS => {
                        let pr_id: i64 = attr(tag_str, "pr_id")
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0);
                        serde_json::json!({ "pr_id": pr_id })
                    }
                    TOOL_GIT_LOG => {
                        let file = attr(tag_str, "file");
                        let max: u64 = attr(tag_str, "max_commits")
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(20);
                        serde_json::json!({ "file": file, "max_commits": max })
                    }
                    TOOL_SEARCH_NPM => {
                        let package = attr(tag_str, "package").unwrap_or("");
                        serde_json::json!({ "package": package })
                    }
                    TOOL_SEARCH_CRATES => {
                        let name = attr(tag_str, "name").unwrap_or("");
                        serde_json::json!({ "name": name })
                    }
                    TOOL_GLOB_REPO => {
                        let pattern = attr(tag_str, "pattern").unwrap_or("**/*");
                        serde_json::json!({ "pattern": pattern })
                    }
                    TOOL_GIT_STATUS | TOOL_GET_REPO_DIFF => {
                        serde_json::json!({})
                    }
                    TOOL_DELETE_REPO_FILE => {
                        let path = attr(tag_str, "path").unwrap_or("");
                        serde_json::json!({ "path": path })
                    }
                    TOOL_MOVE_REPO_FILE => {
                        let from = attr(tag_str, "from").unwrap_or("");
                        let to = attr(tag_str, "to").unwrap_or("");
                        serde_json::json!({ "from": from, "to": to })
                    }
                    TOOL_WEB_SEARCH => {
                        let query = attr(tag_str, "query").unwrap_or("");
                        serde_json::json!({ "query": query })
                    }
                    TOOL_GET_FILE_AT_BASE => {
                        let path = attr(tag_str, "path").unwrap_or("");
                        serde_json::json!({ "path": path })
                    }
                    TOOL_GET_PACKAGE_INFO => {
                        let package = attr(tag_str, "package").unwrap_or("");
                        let ecosystem = attr(tag_str, "ecosystem").unwrap_or("npm");
                        serde_json::json!({ "package": package, "ecosystem": ecosystem })
                    }
                    TOOL_EXEC_IN_WORKTREE => {
                        let command = attr(tag_str, "command").unwrap_or("");
                        let timeout: Option<u64> = attr(tag_str, "timeout_secs")
                            .and_then(|s| s.parse().ok());
                        serde_json::json!({ "command": command, "timeout_secs": timeout })
                    }
                    TOOL_REQUEST_TOOL => {
                        let name = attr(tag_str, "name").unwrap_or("");
                        let description = attr(tag_str, "description").unwrap_or("");
                        let why_needed = attr(tag_str, "why_needed").unwrap_or("");
                        let example = attr(tag_str, "example_call").unwrap_or("");
                        serde_json::json!({
                            "name": name,
                            "description": description,
                            "why_needed": why_needed,
                            "example_call": example
                        })
                    }
                    _ => serde_json::json!({}),
                };

                return Some(TextToolCall {
                    name: tool.to_string(),
                    input,
                    tag: tag_str.to_string(),
                });
            }
        }
    }
    None
}

pub fn strip_tool_tag(text: &str, tag: &str) -> String {
    text.replace(tag, "").trim().to_string()
}

pub fn tool_progress_label(name: &str, input: &serde_json::Value) -> String {
    match name {
        TOOL_FETCH_URL => format!("Fetching {}…", input["url"].as_str().unwrap_or("URL")),
        TOOL_READ_REPO_FILE => format!("Reading {}…", input["path"].as_str().unwrap_or("file")),
        TOOL_WRITE_REPO_FILE => format!("Writing {}…", input["path"].as_str().unwrap_or("file")),
        TOOL_GREP_REPO => format!(
            "Searching for '{}'…",
            input["pattern"].as_str().unwrap_or("pattern")
        ),
        TOOL_SEARCH_JIRA => format!(
            "Searching JIRA for '{}'…",
            input["query"].as_str().unwrap_or("query")
        ),
        TOOL_GET_JIRA_ISSUE => format!(
            "Fetching JIRA {}…",
            input["key"].as_str().unwrap_or("issue")
        ),
        TOOL_GET_PR_DIFF => format!(
            "Fetching diff for PR {}…",
            input["pr_id"].as_i64().unwrap_or(0)
        ),
        TOOL_GET_PR_COMMENTS => format!(
            "Fetching comments for PR {}…",
            input["pr_id"].as_i64().unwrap_or(0)
        ),
        TOOL_GIT_LOG => format!(
            "Fetching git log{}…",
            input["file"]
                .as_str()
                .map(|f| format!(" for {}", f))
                .unwrap_or_default()
        ),
        TOOL_SEARCH_NPM => format!(
            "Searching npm for '{}'…",
            input["package"].as_str().unwrap_or("package")
        ),
        TOOL_SEARCH_CRATES => format!(
            "Searching crates.io for '{}'…",
            input["name"].as_str().unwrap_or("crate")
        ),
        TOOL_REQUEST_TOOL => format!(
            "Requesting tool '{}'…",
            input["name"].as_str().unwrap_or("tool")
        ),
        _ => "Running tool…".to_string(),
    }
}
