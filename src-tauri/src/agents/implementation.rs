use super::dispatch;
use super::dispatch::AiContext;
use super::tools::all_tools_def;

/// Agent 4 — Implementation Guidance: step-by-step guide for executing the plan.
#[tauri::command]
pub async fn run_implementation_guidance(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let system = "You are an implementation guidance agent. Given the ticket and agreed implementation plan, \
        produce a detailed step-by-step guide the engineer can follow while coding. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"steps\": [\n\
            {\"step\": 1, \"title\": \"<short title>\", \"file\": \"<file path>\",\n\
             \"action\": \"<what to do>\", \"details\": \"<how to do it>\",\n\
             \"code_hints\": \"<key code patterns or snippets to follow>\"}\n\
          ],\n\
          \"patterns_to_follow\": [\"<convention to observe>\", ...],\n\
          \"common_pitfalls\": [\"<thing to avoid>\", ...],\n\
          \"definition_of_done\": [\"<how to know the step is complete>\", ...]\n\
        }";
    let user = format!("Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}");
    dispatch::dispatch_streaming(
        &app,
        &client,
        &api_key,
        system,
        &user,
        6000,
        "guidance-stream",
        &AiContext::stage("implement_ticket", "implementation"),
    )
    .await
}

/// Agent 4b — Implementation: actually write code for each file in the plan.
#[tauri::command]
pub async fn run_implementation_agent(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    guidance_json: String,
) -> Result<String, String> {
    use tauri::Emitter;

    let (client, api_key) = dispatch::llm_client().await?;

    let plan: serde_json::Value =
        serde_json::from_str(&plan_json).map_err(|e| format!("Invalid plan JSON: {e}"))?;

    let files = plan["files"].as_array().cloned().unwrap_or_default();

    let emit = |msg: &str| {
        let _ = app.emit("implementation-stream", serde_json::json!({ "delta": msg }));
    };

    emit(&format!(
        "Starting implementation — {} file(s) to process\n\n",
        files.len()
    ));

    let mut files_changed: Vec<serde_json::Value> = Vec::new();
    let mut deviations: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for (idx, file_entry) in files.iter().enumerate() {
        let path = match file_entry["path"].as_str() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let action = file_entry["action"]
            .as_str()
            .unwrap_or("modify")
            .to_string();
        let description = file_entry["description"].as_str().unwrap_or("").to_string();

        emit(&format!(
            "[{}/{}] {} — {}\n",
            idx + 1,
            files.len(),
            action.to_uppercase(),
            path
        ));

        if action == "delete" {
            match crate::commands::repo::delete_repo_file_internal(&path) {
                Ok(()) => {
                    emit(&format!("  Deleted {path}\n"));
                    files_changed.push(serde_json::json!({
                        "path": path,
                        "action": "deleted",
                        "summary": "File deleted as per plan"
                    }));
                }
                Err(e) => {
                    emit(&format!("  WARNING: Could not delete {path}: {e}\n"));
                    deviations.push(format!("Could not delete {path}: {e}"));
                }
            }
            continue;
        }

        let current_content =
            crate::commands::repo::read_repo_file_internal(&path).unwrap_or_default();
        let is_new = current_content.is_empty() && action == "create";

        let file_context = if current_content.is_empty() {
            format!("File `{path}` does not exist yet — create it from scratch.")
        } else {
            format!("Current content of `{path}`:\n```\n{current_content}\n```")
        };

        let system = "You are an expert software engineer implementing a JIRA ticket. \
            You will be given:\n\
            1. The JIRA ticket\n\
            2. The agreed implementation plan\n\
            3. Step-by-step implementation guidance\n\
            4. The current content of a specific file (or a note that it is new)\n\n\
            Your task: produce the COMPLETE new content of that file, implementing ONLY the \
            changes described in the plan for this file. Follow the plan precisely. \
            Do NOT deviate without noting the deviation at the end.\n\n\
            IMPORTANT — respond with ONLY a valid JSON object (no markdown fences):\n\
            {\n\
              \"new_content\": \"<complete file content as a string>\",\n\
              \"summary\": \"<one sentence describing what changed>\",\n\
              \"deviation\": \"<describe any deviation from the plan, or null if none>\"\n\
            }";

        let guidance_section = if guidance_json.trim().is_empty() {
            String::new()
        } else {
            format!("Implementation guidance:\n{guidance_json}\n\n")
        };
        let user = format!(
            "Ticket:\n{ticket_text}\n\n\
             Implementation plan:\n{plan_json}\n\n\
             {guidance_section}\
             File to implement:\n{path}\n\
             Planned action: {action}\n\
             Plan description: {description}\n\n\
             {file_context}"
        );

        emit(&format!("  Generating new content…\n"));
        eprintln!("[meridian] implementation: calling dispatch for {path}");

        let raw = match dispatch::dispatch(
            &app,
            &client,
            &api_key,
            system,
            &user,
            8000,
            &AiContext::stage("implement_ticket", "implementation"),
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[meridian] implementation: dispatch error for {path}: {e}");
                emit(&format!("  ERROR: LLM call failed for {path}: {e}\n"));
                deviations.push(format!("LLM call failed for {path}: {e}"));
                skipped.push(path.clone());
                continue;
            }
        };
        eprintln!("[meridian] implementation: dispatch returned {} bytes for {path}", raw.len());

        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                let stripped = raw
                    .trim()
                    .trim_start_matches("```json")
                    .trim_start_matches("```")
                    .trim_end_matches("```")
                    .trim();
                match serde_json::from_str(stripped) {
                    Ok(v) => v,
                    Err(e) => {
                        emit(&format!(
                            "  ERROR: Could not parse response for {path}: {e}\n"
                        ));
                        deviations.push(format!("Could not parse response for {path}: {e}"));
                        skipped.push(path.clone());
                        continue;
                    }
                }
            }
        };

        let new_content = match parsed["new_content"].as_str() {
            Some(c) => c.to_string(),
            None => {
                emit(&format!("  ERROR: No new_content in response for {path}\n"));
                skipped.push(path.clone());
                continue;
            }
        };

        let summary = parsed["summary"]
            .as_str()
            .unwrap_or("No summary")
            .to_string();
        let deviation = parsed["deviation"]
            .as_str()
            .filter(|d| !d.is_empty() && *d != "null")
            .map(str::to_string);

        match crate::commands::repo::write_repo_file_internal(&path, &new_content) {
            Ok(()) => {
                emit(&format!("  Written: {summary}\n"));
                if let Some(ref dev) = deviation {
                    emit(&format!("  DEVIATION: {dev}\n"));
                    deviations.push(format!("{path}: {dev}"));
                }
                files_changed.push(serde_json::json!({
                    "path": path,
                    "action": if is_new { "created" } else { "modified" },
                    "summary": summary
                }));
            }
            Err(e) => {
                emit(&format!("  ERROR: Could not write {path}: {e}\n"));
                deviations.push(format!("Could not write {path}: {e}"));
                skipped.push(path.clone());
            }
        }
    }

    if let Err(e) = crate::commands::repo::git_add_all_internal() {
        emit(&format!("\n  WARNING: Could not stage changes: {e}\n"));
    }

    emit(&format!(
        "\nImplementation complete — {} file(s) changed",
        files_changed.len()
    ));
    if !skipped.is_empty() {
        emit(&format!(", {} skipped", skipped.len()));
    }
    emit("\n");

    let output = serde_json::json!({
        "summary": format!(
            "Implementation complete. {} file(s) changed{}.",
            files_changed.len(),
            if skipped.is_empty() { String::new() } else { format!(", {} skipped", skipped.len()) }
        ),
        "files_changed": files_changed,
        "deviations": deviations,
        "skipped": skipped
    });

    Ok(output.to_string())
}

/// Probe the worktree root for known build system markers and return their content.
async fn probe_project_files() -> String {
    let candidates = [
        "package.json",
        "Cargo.toml",
        "Makefile",
        "makefile",
        "pyproject.toml",
        "setup.py",
        "go.mod",
        "build.gradle",
        "build.gradle.kts",
        "pom.xml",
        "CMakeLists.txt",
        "Dockerfile",
        "justfile",
    ];
    let mut found = Vec::new();
    for name in &candidates {
        if let Ok(content) = crate::commands::repo::read_repo_file_internal(name) {
            // Truncate large files (package.json can be huge)
            let excerpt = if content.len() > 2_000 {
                format!("{}\n[…truncated]", &content[..2_000])
            } else {
                content
            };
            found.push(format!("=== {} ===\n{}", name, excerpt));
        }
    }
    if found.is_empty() {
        "(no recognised build system files found in project root)".to_string()
    } else {
        found.join("\n\n")
    }
}

/// Ask the AI to choose the best build/verify command for this project.
async fn discover_build_command(
    app: &tauri::AppHandle,
    ticket_text: &str,
    plan_json: &str,
    impl_json: &str,
    project_files: &str,
) -> Result<String, String> {
    use crate::agents::dispatch;
    use tauri::Emitter;

    let (client, api_key) = dispatch::llm_client().await?;

    let system = "You are a build system expert. Given a project's build configuration files, \
        a JIRA ticket, and an implementation plan, choose the single best shell command to \
        verify the code compiles and the basic sanity checks pass.\n\n\
        Rules:\n\
        - Prefer fast commands that catch real errors: type-checks, compiles, lint with errors only.\n\
        - For Node/TypeScript projects: prefer `tsc --noEmit` or the project's `build` script.\n\
        - For Rust: prefer `cargo check` (faster than `cargo build`).\n\
        - For Go: `go build ./...`\n\
        - For Python: `python -m py_compile src/**/*.py` or the project's lint/check script.\n\
        - Do NOT choose test commands as the primary command — tests can be slow.\n\
        - The command will run with `sh -c` in the project root, so shell features work.\n\n\
        Return ONLY valid JSON (no markdown, no prose):\n\
        {\"command\": \"<the shell command>\", \"reasoning\": \"<one sentence why>\"}";

    let user = format!(
        "Project files:\n{project_files}\n\n\
        Ticket:\n{ticket_text}\n\n\
        Implementation plan:\n{plan_json}\n\n\
        Files changed:\n{impl_json}"
    );

    let raw = dispatch::dispatch(
        app,
        &client,
        &api_key,
        system,
        &user,
        512,
        &AiContext::stage("implement_ticket", "implementation"),
    )
    .await?;

    // Extract command from JSON
    let start = raw.find('{').unwrap_or(0);
    let end = raw.rfind('}').map(|i| i + 1).unwrap_or(raw.len());
    let parsed: serde_json::Value =
        serde_json::from_str(&raw[start..end]).unwrap_or_default();

    let command = parsed["command"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "AI returned no build command".to_string())?
        .to_string();

    let reasoning = parsed["reasoning"].as_str().unwrap_or("").to_string();
    let _ = app.emit(
        "build-check-stream",
        serde_json::json!({ "delta": format!("Detected build command: {command}\n({reasoning})\n") }),
    );

    Ok(command)
}

/// Detect the package manager and install dependencies if the dep directory is missing.
/// Covers Node (npm/pnpm/yarn), Python (pip), and Go (go mod download).
async fn run_setup_if_needed(
    emit: &impl Fn(&str),
) {
    use crate::commands::repo::{exec_in_worktree_internal, read_repo_file_internal};
    use std::path::Path;

    let worktree = crate::storage::preferences::get_pref("repo_worktree_path")
        .unwrap_or_default();

    // ── Node.js ────────────────────────────────────────────────────────────────
    if read_repo_file_internal("package.json").is_ok() {
        let node_modules = Path::new(&worktree).join("node_modules");
        if !node_modules.exists() {
            // Detect package manager: prefer pnpm-lock.yaml > yarn.lock > package-lock.json
            let install_cmd = if Path::new(&worktree).join("pnpm-lock.yaml").exists() {
                "pnpm install"
            } else if Path::new(&worktree).join("yarn.lock").exists() {
                "yarn install --frozen-lockfile"
            } else {
                "npm ci"
            };
            emit(&format!(
                "node_modules not found — running dependency install: {install_cmd}\n"
            ));
            match exec_in_worktree_internal(install_cmd, 300).await {
                Ok((code, out)) => {
                    emit(&out);
                    if code != 0 {
                        emit(&format!("  Install exited with code {code} — continuing anyway.\n"));
                    } else {
                        emit("  Dependencies installed ✓\n");
                    }
                }
                Err(e) => emit(&format!("  Install failed: {e}\n")),
            }
        }
    }

    // ── Python ────────────────────────────────────────────────────────────────
    if read_repo_file_internal("pyproject.toml").is_ok() || read_repo_file_internal("requirements.txt").is_ok() {
        let venv = Path::new(&worktree).join(".venv");
        if !venv.exists() {
            emit("No .venv found — running: pip install -e .\n");
            let _ = exec_in_worktree_internal("pip install -e . --quiet 2>&1 || pip install -r requirements.txt --quiet 2>&1", 300).await;
        }
    }

    // ── Go ────────────────────────────────────────────────────────────────────
    if read_repo_file_internal("go.mod").is_ok() {
        let vendor = Path::new(&worktree).join("vendor");
        if !vendor.exists() {
            emit("Running: go mod download\n");
            let _ = exec_in_worktree_internal("go mod download 2>&1", 120).await;
        }
    }
}

/// Agent 4c — Build Check: auto-discover the build command then run it, fix errors, retry.
#[tauri::command]
pub async fn run_build_check(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    impl_json: String,
) -> Result<String, String> {
    use crate::agents::dispatch;
    use tauri::Emitter;

    let emit = |msg: &str| {
        let _ = app.emit("build-check-stream", serde_json::json!({ "delta": msg }));
    };

    // ── Discover build command ─────────────────────────────────────────────────
    emit("Analysing project to determine build command…\n");
    let project_files = probe_project_files().await;
    let build_command = match discover_build_command(
        &app, &ticket_text, &plan_json, &impl_json, &project_files,
    )
    .await
    {
        Ok(cmd) => cmd,
        Err(e) => {
            emit(&format!("Could not determine build command: {e}\nSkipping build verification.\n"));
            return Ok(serde_json::json!({
                "build_command": null,
                "build_passed": null,
                "attempts": []
            })
            .to_string());
        }
    };

    // ── Install dependencies if missing ───────────────────────────────────────
    run_setup_if_needed(&emit).await;

    const MAX_ATTEMPTS: u32 = 5;
    let mut attempts: Vec<serde_json::Value> = Vec::new();

    for attempt in 1..=MAX_ATTEMPTS {
        emit(&format!(
            "\n[Build attempt {attempt}/{MAX_ATTEMPTS}] Running: {build_command}\n"
        ));

        let (exit_code, output) =
            match crate::commands::repo::exec_in_worktree_internal(&build_command, 180).await {
                Ok(r) => r,
                Err(e) => {
                    emit(&format!("  ERROR launching command: {e}\n"));
                    attempts.push(serde_json::json!({
                        "attempt": attempt,
                        "exit_code": -1,
                        "output": e,
                        "fixed": false,
                        "files_written": []
                    }));
                    break;
                }
            };

        // Truncate long output so it fits in context
        const MAX_OUTPUT: usize = 8_000;
        let output_excerpt = if output.len() > MAX_OUTPUT {
            format!("[…truncated — showing last 8000 chars]\n{}", &output[output.len() - MAX_OUTPUT..])
        } else {
            output.clone()
        };

        emit(&format!("{output_excerpt}\n"));

        if exit_code == 0 {
            emit(&format!("  Build passed ✓\n"));
            attempts.push(serde_json::json!({
                "attempt": attempt,
                "exit_code": 0,
                "output": output,
                "fixed": true,
                "files_written": []
            }));
            break;
        }

        emit(&format!("  Exit code {exit_code} — asking AI to fix errors…\n"));

        // ── AI fix loop ────────────────────────────────────────────────────────
        let (client, api_key) = dispatch::llm_client().await?;

        let system = format!(
            "You are a senior software engineer fixing build/compile errors.\n\n\
            TICKET CONTEXT:\n{ticket_text}\n\n\
            IMPLEMENTATION PLAN:\n{plan_json}\n\n\
            IMPLEMENTATION SUMMARY:\n{impl_json}\n\n\
            BUILD COMMAND: {build_command}\n\n\
            BUILD OUTPUT (exit code {exit_code}):\n{output_excerpt}\n\n\
            WORKFLOW:\n\
            1. Read the files mentioned in the error output with read_repo_file.\n\
            2. Identify the root cause of each error.\n\
            3. Fix all errors by writing corrected files with write_repo_file.\n\
               Provide COMPLETE file content — do not truncate.\n\
            4. After writing all fixes, return your FINAL response.\n\n\
            FINAL RESPONSE — ONLY this JSON, no markdown fences, no prose outside it:\n\
            {{\n\
              \"explanation\": \"<one or two sentences describing what was wrong and what you fixed>\",\n\
              \"files_written\": [\"<path1>\", \"<path2>\"]\n\
            }}\n\
            files_written must list every path you wrote with write_repo_file.\n\
            If you could not determine a fix, set files_written to [] and explain why."
        );

        let history = serde_json::json!([
            { "role": "user", "content": "Please fix the build errors described above." }
        ]);
        let history_str = history.to_string();

        // Use the full tool loop so the AI can read files before writing fixes.
        let tools_def = all_tools_def();
        use crate::llms::claude;
        let provider = crate::agents::dispatch::get_ai_provider();
        let providers_to_try: Vec<String> = if provider == "auto" {
            crate::agents::dispatch::get_provider_order()
        } else {
            vec![provider]
        };

        let fix_raw = 'provider_loop: {
            let mut errs: Vec<String> = Vec::new();
            for p in &providers_to_try {
                let result = match p.as_str() {
                    "claude" => {
                        let auth = crate::storage::credentials::get_credential("claude_auth_method")
                            .unwrap_or_else(|| "api_key".to_string());
                        if auth == "oauth" {
                            let _ = claude::refresh_oauth_if_needed(&client).await;
                        }
                        let key = crate::storage::credentials::get_credential("anthropic_api_key")
                            .unwrap_or_else(|| api_key.clone());
                        if key.is_empty() {
                            errs.push("claude: not configured".to_string());
                            continue;
                        }
                        claude::complete_multi_claude_tool_loop(
                            &app, &client, &key, &claude::get_active_model(),
                            &system, &history_str, 16000, "build-check-stream",
                        ).await
                    }
                    other => {
                        claude::complete_multi_text_tool_loop(
                            &app, &client, &api_key, other,
                            &system, &history_str, 16000, "build-check-stream",
                            &AiContext::stage("implement_ticket", "implementation"),
                        ).await
                    }
                };
                match result {
                    Ok(r) => break 'provider_loop Ok(r),
                    Err(e) => errs.push(format!("{p}: {e}")),
                }
            }
            Err(errs.join("; "))
        };

        let fix_raw = match fix_raw {
            Ok(r) => r,
            Err(e) => {
                emit(&format!("  AI fix failed: {e}\n"));
                attempts.push(serde_json::json!({
                    "attempt": attempt,
                    "exit_code": exit_code,
                    "output": output,
                    "fixed": false,
                    "files_written": []
                }));
                break;
            }
        };

        // Parse the AI's JSON response
        let fix_parsed = {
            let s = fix_raw.trim();
            let start = s.find('{').unwrap_or(0);
            let end = s.rfind('}').map(|i| i + 1).unwrap_or(s.len());
            serde_json::from_str::<serde_json::Value>(&s[start..end]).unwrap_or_default()
        };

        let files_written: Vec<String> = fix_parsed["files_written"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let explanation = fix_parsed["explanation"].as_str().unwrap_or("(no explanation)").to_string();

        emit(&format!("  Fixed: {explanation}\n"));
        if !files_written.is_empty() {
            emit(&format!("  Files updated: {}\n", files_written.join(", ")));
        }

        attempts.push(serde_json::json!({
            "attempt": attempt,
            "exit_code": exit_code,
            "output": output,
            "fixed": !files_written.is_empty(),
            "files_written": files_written
        }));

        if attempt == MAX_ATTEMPTS {
            emit(&format!("\n  Reached max attempts ({MAX_ATTEMPTS}) — stopping.\n"));
        }
    }

    let passed = attempts.last()
        .and_then(|a| a["exit_code"].as_i64())
        .map(|c| c == 0)
        .unwrap_or(false);

    Ok(serde_json::json!({
        "build_command": build_command,
        "build_passed": passed,
        "attempts": attempts
    }).to_string())
}

/// Agent 5 — Test Writer: write actual test files for the code changes using a tool loop.
#[tauri::command]
pub async fn run_test_agent(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    impl_json: String,
    diff: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let system = "You are a test engineer. Your job is to write real test files for the code \
        changes described in the diff.\n\
        \n\
        APPROACH:\n\
        1. Use glob_repo and read_repo_file to find existing test files — understand the project's \
           test framework, file naming conventions, assertion style, and test structure.\n\
        2. Read the key implementation files from the diff to understand what needs testing.\n\
        3. Write test files using write_repo_file — follow the project's exact test patterns \
           and naming conventions.\n\
        4. Focus on unit tests for logic; add integration tests where the setup is feasible.\n\
        5. Test that acceptance criteria are met — do NOT write tests that merely verify what \
           the implementation wrote. Challenge the implementation's assumptions.\n\
        \n\
        When you have finished writing all test files, output ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"summary\": \"<one sentence describing what was tested>\",\n\
          \"files_written\": [\n\
            {\"path\": \"<relative path from repo root>\", \"description\": \"<what this file covers>\"}\n\
          ],\n\
          \"edge_cases_covered\": [\"<edge case>\", ...],\n\
          \"coverage_notes\": \"<what was deliberately not tested and why>\"\n\
        }";

    let diff_section = if diff.is_empty() {
        "(no diff available — worktree may not be configured; note this in coverage_notes)".to_string()
    } else {
        diff
    };

    let user_msg = serde_json::json!(
        format!("Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nImplementation result:\n{impl_json}\n\nCode diff:\n{diff_section}")
    );
    let history_json = serde_json::json!([{ "role": "user", "content": user_msg }]).to_string();

    dispatch::dispatch_multi_streaming_with_tools(
        &app,
        &client,
        &api_key,
        system,
        &history_json,
        8000,
        "tests-stream",
        &AiContext::stage("implement_ticket", "tests"),
    )
    .await
}

/// Agent 8 — Retrospective: capture learnings from the implementation session.
#[tauri::command]
pub async fn run_retrospective_agent(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    impl_json: String,
    review_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let system = "You are a retrospective agent. Review the full implementation session and capture learnings. \
        Pay particular attention to any deviations from the plan and what caused them. \
        \n\n\
        Any durable insight worth retaining — a decision, a codebase pattern, or a learning — \
        must be expressed as an entry in `agent_skill_suggestions`. Each suggestion targets \
        exactly one of these four skills, which feed back into future pipeline runs:\n\
          - \"grooming\"        — how to read tickets, AC conventions, scope clues, ambiguity signals\n\
          - \"patterns\"        — architectural patterns and codebase conventions\n\
          - \"implementation\"  — coding style, naming, dos and don'ts when writing changes\n\
          - \"review\"          — what good looks like when reviewing diffs in this codebase\n\
        \n\
        The `suggestion` field should be a self-contained sentence or short paragraph that \
        could be appended verbatim to the chosen skill's body and still make sense out of context.\n\
        \n\
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"what_went_well\": [\"<positive observation>\", ...],\n\
          \"what_could_improve\": [\"<area for improvement>\", ...],\n\
          \"patterns_identified\": [\"<reusable pattern or convention observed>\", ...],\n\
          \"agent_skill_suggestions\": [\n\
            {\"skill\": \"grooming|patterns|implementation|review\", \"suggestion\": \"<self-contained text to append to the skill>\"}\n\
          ],\n\
          \"summary\": \"<one paragraph retrospective summary>\"\n\
        }";
    let user = format!(
        "Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nImplementation result:\n{impl_json}\n\nReview:\n{review_json}"
    );
    dispatch::dispatch_streaming(
        &app,
        &client,
        &api_key,
        system,
        &user,
        4000,
        "retro-stream",
        &AiContext::stage("implement_ticket", "retro"),
    )
    .await
}

/// Agent 6 — Code Review: review the actual diff produced by the implementation agent.
#[tauri::command]
pub async fn run_plan_review(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    impl_json: String,
    test_json: String,
    diff: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let system = "You are a code review agent. You will receive the ticket, implementation plan, \
        implementation summary, proposed tests, and the actual git diff of what was written. \
        Review the REAL CODE CHANGES in the diff — not just the plan. \
        Check for: correctness vs acceptance criteria, security issues, logic errors, \
        deviations from the agreed plan, missing edge case handling, and code quality. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"confidence\": \"ready|needs_attention|requires_rework\",\n\
          \"summary\": \"<one sentence overall assessment of the actual changes>\",\n\
          \"findings\": [\n\
            {\"severity\": \"blocking|non_blocking|suggestion\",\n\
             \"area\": \"<file or area>\", \"feedback\": \"<specific feedback with line references where possible>\"}\n\
          ],\n\
          \"things_to_address\": [\"<must-fix before merging>\", ...],\n\
          \"things_to_watch\": [\"<notable observations for the PR reviewer>\", ...]\n\
        }";
    let diff_section = if diff.is_empty() {
        "(no diff available — worktree may not be configured)".to_string()
    } else {
        diff
    };
    let user = format!(
        "Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nImplementation result:\n{impl_json}\n\nTest plan:\n{test_json}\n\nCode diff:\n{diff_section}"
    );
    dispatch::dispatch_streaming(
        &app,
        &client,
        &api_key,
        system,
        &user,
        6000,
        "review-stream",
        &AiContext::stage("implement_ticket", "review"),
    )
    .await
}

/// Agent 7 — PR Description: generate a complete pull request description.
///
/// Honours a user-supplied Markdown template read from disk
/// (`<app_data_dir>/templates/pr_description.md`). The `pr_template_mode`
/// preference (`guide` | `strict`, default `guide`) controls whether the
/// agent must follow the template verbatim or may adapt when the ticket
/// doesn't map cleanly onto the template sections.
#[tauri::command]
pub async fn run_pr_description_gen(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    impl_json: String,
    review_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let base_system = "You are a PR description writer. Produce a thorough, professional PR description \
        based on what was ACTUALLY implemented (see implementation result and review notes), \
        not just what was planned. If there were deviations from the plan, mention them. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"title\": \"<concise PR title under 70 chars>\",\n\
          \"description\": \"<full markdown PR description including: what changed, why, how implemented, \
            testing approach, linked JIRA ticket, deviations from plan if any, anything reviewers should pay attention to>\"\n\
        }";

    let template = crate::commands::pr_template::read_pr_template(&app);
    let system = if let Some(tmpl) = template {
        let strict = crate::storage::preferences::get_pref("pr_template_mode")
            .as_deref()
            == Some("strict");
        let mode_instruction = if strict {
            "The `description` field MUST follow this Markdown template exactly — keep the same \
             headings in the same order, do not add or remove sections. Fill each section with \
             content relevant to this PR; if a section genuinely has no content for this PR, \
             write \"N/A\" under it rather than omitting the heading."
        } else {
            "Use the following Markdown template as a guide for the `description` field — \
             follow the structure and headings where they fit, but you may adapt or omit sections \
             when the PR doesn't warrant them (e.g. a one-line fix doesn't need every section)."
        };
        format!(
            "{base_system}\n\n\
             === PR DESCRIPTION TEMPLATE ===\n\
             {mode_instruction}\n\n\
             {tmpl}"
        )
    } else {
        base_system.to_string()
    };

    let user = format!(
        "Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nImplementation result:\n{impl_json}\n\nReview notes:\n{review_json}"
    );
    dispatch::dispatch_streaming(
        &app,
        &client,
        &api_key,
        &system,
        &user,
        4000,
        "pr-stream",
        &AiContext::stage("implement_ticket", "pr"),
    )
    .await
}
