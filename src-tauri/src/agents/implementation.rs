use super::dispatch;

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
        2000,
        "guidance-stream",
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

/// Agent 5 — Test Suggestions: recommend tests to write based on the actual code changes.
#[tauri::command]
pub async fn run_test_suggestions(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    impl_json: String,
    diff: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let system = "You are a test generation advisor. You will receive the ticket, implementation plan, \
        implementation summary, and the actual git diff of what was written. \
        Generate tests based on the real code changes, not just the intended plan. \
        Think independently — challenge the implementation's assumptions and verify against acceptance criteria. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"test_strategy\": \"<overall testing approach>\",\n\
          \"unit_tests\": [\n\
            {\"description\": \"<what to test>\", \"target\": \"<function/module>\",\n\
             \"cases\": [\"<test case description>\", ...]}\n\
          ],\n\
          \"integration_tests\": [\n\
            {\"description\": \"<what to test>\", \"setup\": \"<test setup notes>\",\n\
             \"cases\": [\"<test case description>\", ...]}\n\
          ],\n\
          \"edge_cases_to_test\": [\"<edge case>\", ...],\n\
          \"coverage_notes\": \"<anything deliberately not covered and why>\"\n\
        }";
    let diff_section = if diff.is_empty() {
        "(no diff available — worktree may not be configured)".to_string()
    } else {
        diff
    };
    let user = format!(
        "Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nImplementation result:\n{impl_json}\n\nCode diff:\n{diff_section}"
    );
    dispatch::dispatch_streaming(&app, &client, &api_key, system, &user, 1500, "tests-stream").await
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
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"what_went_well\": [\"<positive observation>\", ...],\n\
          \"what_could_improve\": [\"<area for improvement>\", ...],\n\
          \"patterns_identified\": [\"<reusable pattern or convention observed>\", ...],\n\
          \"agent_skill_suggestions\": [\n\
            {\"skill\": \"<skill name>\", \"suggestion\": \"<what to add/update>\"}\n\
          ],\n\
          \"knowledge_base_entries\": [\n\
            {\"type\": \"decision|pattern|learning\", \"title\": \"<title>\", \"body\": \"<content>\"}\n\
          ],\n\
          \"summary\": \"<one paragraph retrospective summary>\"\n\
        }";
    let user = format!(
        "Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nImplementation result:\n{impl_json}\n\nReview:\n{review_json}"
    );
    dispatch::dispatch_streaming(&app, &client, &api_key, system, &user, 1500, "retro-stream").await
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
        1500,
        "review-stream",
    )
    .await
}

/// Agent 7 — PR Description: generate a complete pull request description.
#[tauri::command]
pub async fn run_pr_description_gen(
    app: tauri::AppHandle,
    ticket_text: String,
    plan_json: String,
    impl_json: String,
    review_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let system = "You are a PR description writer. Produce a thorough, professional PR description \
        based on what was ACTUALLY implemented (see implementation result and review notes), \
        not just what was planned. If there were deviations from the plan, mention them. \
        Return ONLY valid JSON (no markdown fences):\n\
        {\n\
          \"title\": \"<concise PR title under 70 chars>\",\n\
          \"description\": \"<full markdown PR description including: what changed, why, how implemented, \
            testing approach, linked JIRA ticket, deviations from plan if any, anything reviewers should pay attention to>\"\n\
        }";
    let user = format!(
        "Ticket:\n{ticket_text}\n\nImplementation plan:\n{plan_json}\n\nImplementation result:\n{impl_json}\n\nReview notes:\n{review_json}"
    );
    dispatch::dispatch_streaming(&app, &client, &api_key, system, &user, 2000, "pr-stream").await
}
