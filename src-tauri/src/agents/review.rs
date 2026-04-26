use super::dispatch;
use crate::llms::claude;
use tauri::Emitter;

/// Sort findings by severity (blocking first, then non_blocking, then nitpick)
/// and greedily include them up to `max_chars`. Returns the capped JSON array
/// string and the count of findings that were dropped.
fn cap_findings_by_severity(findings_json: &str, max_chars: usize) -> (String, usize) {
    let Ok(arr) = serde_json::from_str::<serde_json::Value>(findings_json) else {
        // Can't parse — return as-is, truncated hard if necessary
        let truncated = if findings_json.len() > max_chars {
            &findings_json[..max_chars]
        } else {
            findings_json
        };
        return (truncated.to_string(), 0);
    };

    let Some(findings) = arr.as_array() else {
        return (findings_json.to_string(), 0);
    };

    // Severity ordering: blocking = 0, non_blocking = 1, nitpick = 2, unknown = 3
    let severity_rank = |f: &serde_json::Value| -> u8 {
        match f.get("severity").and_then(|s| s.as_str()).unwrap_or("") {
            "blocking" => 0,
            "non_blocking" => 1,
            "nitpick" => 2,
            _ => 3,
        }
    };

    let mut sorted = findings.clone();
    sorted.sort_by_key(|f| severity_rank(f));

    let mut kept: Vec<serde_json::Value> = Vec::new();
    let mut running_chars = 2usize; // for the outer `[` and `]`

    for finding in &sorted {
        let s = serde_json::to_string(finding).unwrap_or_default();
        let needed = s.len() + if kept.is_empty() { 0 } else { 2 }; // `, ` separator
        if running_chars + needed > max_chars {
            break;
        }
        running_chars += needed;
        kept.push(finding.clone());
    }

    let dropped = findings.len() - kept.len();
    let out = serde_json::to_string(&kept).unwrap_or_else(|_| "[]".to_string());
    (out, dropped)
}

/// Annotate every line of a unified diff with its actual new-file line number.
fn annotate_diff_with_line_numbers(diff: &str) -> String {
    let mut out = String::with_capacity(diff.len() + diff.lines().count() * 8);
    let mut new_line: u32 = 0; // current line number in the new file

    for line in diff.lines() {
        if line.starts_with("@@") {
            if let Some(plus_pos) = line.find('+') {
                let rest = &line[plus_pos + 1..];
                let end = rest
                    .find(|c: char| !c.is_ascii_digit())
                    .unwrap_or(rest.len());
                if let Ok(n) = rest[..end].parse::<u32>() {
                    new_line = n;
                }
            }
            out.push_str(line);
        } else if line.starts_with('+') && !line.starts_with("+++") {
            out.push_str(&format!("[L{}] {}", new_line, &line[1..]));
            new_line += 1;
        } else if line.starts_with(' ') {
            out.push_str(&format!("[L{}] {}", new_line, &line[1..]));
            new_line += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            out.push_str(&format!("[del] {}", &line[1..]));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

fn split_review_into_chunks(review_text: &str, chunk_chars: usize) -> Vec<String> {
    let (header, diff_body) = if let Some(pos) = review_text.find("=== DIFF ===") {
        let h = &review_text[..pos + "=== DIFF ===".len()];
        let d = &review_text[pos + "=== DIFF ===".len()..];
        (h.to_string(), d.to_string())
    } else {
        return vec![review_text.to_string()];
    };

    let annotated_diff = annotate_diff_with_line_numbers(&diff_body);

    let mut file_sections: Vec<String> = vec![];
    let mut current = String::new();
    for line in annotated_diff.lines() {
        if line.starts_with("diff --git") && !current.is_empty() {
            file_sections.push(current.clone());
            current.clear();
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        file_sections.push(current);
    }

    if file_sections.is_empty() {
        return vec![review_text.to_string()];
    }

    let mut chunks: Vec<String> = vec![];
    let mut chunk_diff = String::new();

    for section in &file_sections {
        let candidate_len = header.len() + "\n".len() + chunk_diff.len() + section.len();
        if candidate_len > chunk_chars && !chunk_diff.is_empty() {
            chunks.push(format!("{header}\n{chunk_diff}"));
            chunk_diff.clear();
        }
        if header.len() + section.len() > chunk_chars {
            let max_section = chunk_chars.saturating_sub(header.len() + 100);
            let truncated = &section[..max_section.min(section.len())];
            chunk_diff.push_str(truncated);
            chunk_diff.push_str("\n[file diff truncated — too large for one chunk]\n");
        } else {
            chunk_diff.push_str(section);
        }
    }
    if !chunk_diff.trim().is_empty() {
        chunks.push(format!("{header}\n{chunk_diff}"));
    }
    chunks
}

const CHUNK_SYSTEM: &str = "You are a senior engineer reviewing one chunk of a PR diff. \
    Identify REAL issues a human expert would flag — not noise.\n\
    \n\
    === REVIEW POSTURE ===\n\
    You are reviewing work from a senior engineer who WANTS critical feedback. \
    Under-reporting is a failure mode: if a human expert reviewing by hand would comment on \
    something, you should too. The cost of a nitpick is small; the cost of shipping \
    non-idiomatic or fragile code that spreads through the codebase is large. Prefer raising a \
    well-grounded non_blocking finding over suppressing it.\n\
    \n\
    Return ONLY a valid JSON array of findings — no markdown, no text outside the JSON.\n\
    Each finding: { \"lens\": \"acceptance_criteria\"|\"security\"|\"logic\"|\"quality\"|\"testing\",\n\
      \"severity\": \"blocking\"|\"non_blocking\"|\"nitpick\",\n\
      \"title\": \"<short title>\",\n\
      \"description\": \"<specific reasoning grounded in the diff — not generic advice>\",\n\
      \"file\": \"<path string or null>\",\n\
      \"line_range\": \"<e.g. \\\"L12-L34\\\" or null>\" }\n\
    \n\
    === SEVERITY ===\n\
    - blocking: demonstrably wrong — causes bugs, crashes, data loss, or security vulnerabilities.\n\
    - non_blocking: real concern worth fixing, but no immediate breakage.\n\
    - nitpick: style, naming, minor readability.\n\
    Compilable code is not blocking on style grounds alone, but genuine anti-patterns and \
    non-idiomatic code for the language/framework in use SHOULD be surfaced as non_blocking — \
    don't silently accept code just because it runs.\n\
    \n\
    === LENS RULES ===\n\
    \n\
    LOGIC:\n\
    - Only flag blocking if you can describe a concrete scenario producing wrong output or a crash.\n\
    - Do NOT flag code that looks unusual but compiles correctly and whose intent is inferrable.\n\
    - Deliberate design choices (renamed labels, changed test expectations) are not logic errors \
      unless they demonstrably conflict with stated requirements.\n\
    \n\
    QUALITY:\n\
    - Flag: typos in identifiers/strings/comments; mixed indentation within a file; missing error \
      handling; O(n) scans where direct lookup is available; hard-to-follow structure; new public \
      API without doc comments.\n\
    - IDIOMATIC CODE: Infer the language and primary framework from file extensions, imports, and \
      surrounding patterns in the full file contents. Flag code that works but isn't idiomatic for \
      that stack: manual loops where an iterator/comprehension is standard (Rust iter chains, TS \
      map/filter/reduce, Python comprehensions); unnecessary allocations/clones/re-renders; \
      imperative patterns where the ecosystem prefers declarative; inconsistent naming vs. the \
      surrounding code; non-standard error handling (swallowed errors, .unwrap()/! where Result \
      propagation is idiomatic, throwing generic Error); framework anti-patterns (React: hooks \
      inside conditionals, missing deps, missing keys, state mutations; Rust: needless clones, \
      ignoring Result, blocking calls in async; TS: any/ts-ignore without justification, missing \
      await on Promise, loose types on exported APIs; Go: ignored errors, missing defer). \
      Severity: non_blocking by default for idiomatic drift; nitpick only for trivial style; \
      blocking only when the anti-pattern causes a concrete bug (e.g. React hook-in-condition \
      that breaks render order).\n\
    - Do NOT flag test framework function choice (test/it/describe/expect etc.) as inconsistency.\n\
    - DUPLICATE/REDUNDANT CODE: only raise this if you can cite the [Lnnn] labels of BOTH \
      occurrences. A variable fetched on one line and filtered/transformed on another is NOT a \
      duplicate. If you cannot cite two distinct lines performing the same operation, drop it.\n\
    \n\
    TESTING:\n\
    - Only flag if non-trivial business logic has no corresponding test anywhere in the diff.\n\
    - Do NOT flag config, build, or asset files (*.json/yaml/toml, Makefile, Dockerfile, lock \
      files, *.css/svg/md, generated files, type-only definitions) — they need no unit tests.\n\
    - Missing tests = non_blocking unless safety-critical or tests were explicitly promised.\n\
    - Bug ticket @tags: if the linked ticket is a Bug with a key, check that new/modified unit \
      tests carry a \\\"@tags <KEY>\\\" annotation. If missing, raise non_blocking. Skip if: not \
      a Bug, no key, annotation already present, or no unit tests in diff.\n\
    \n\
    SECURITY:\n\
    - Flag injection, auth bypass, credential exposure, insecure randomness, unsafe deserialization.\n\
    - Only flag concrete exploitable paths — not theoretical risks.\n\
    - Never flag test/spec files (*.test.ts, *.spec.js, test_*.py, *_test.go etc.).\n\
    \n\
    ACCEPTANCE CRITERIA:\n\
    - If criteria are blank or not provided, return ZERO findings for this lens.\n\
    - Only check against explicitly stated criteria.\n\
    \n\
    === FULL FILE VERIFICATION ===\n\
    The input may include === FULL FILE CONTENTS FROM BRANCH ===.\n\
    Before flagging an undefined type, missing import, duplicate field, type mismatch, or \
    compilation error: scan that section. Definitions outside the changed hunk only appear \
    there, not in the diff. If the identifier IS present, drop the finding or downgrade to \
    a nitpick. Only raise compilation/type findings when absent from both the diff AND the \
    full file contents.\n\
    \n\
    === SELF-CHECK (apply before outputting) ===\n\
    For each finding, answer:\n\
    1. Can I cite the exact [Lnnn] line(s) where I observed this?\n\
    2. For type/compilation claims: have I confirmed the identifier is absent from the full file?\n\
    3. For duplicate-code claims: have I cited two distinct [Lnnn] labels showing the same op?\n\
    If any answer is NO — drop or downgrade the finding. Return [] if nothing passes.\n\
    \n\
    === LINE NUMBERS ===\n\
    Added/context lines: [Lnnn] <content> — nnn is the exact new-file line number.\n\
    Deleted lines: [del] — never cite these in line_range.\n\
    Read the label directly. Do NOT count or estimate.";

const SYNTHESIS_SYSTEM: &str = "You are a senior engineer synthesising a thorough, balanced \
    pull request review. Produce a final, calibrated review report.\n\
    \n\
    === REVIEW POSTURE ===\n\
    You are reviewing work from a senior engineer who WANTS critical feedback. Under-reporting \
    is a failure mode: if a human expert reviewing by hand would comment on something, it \
    belongs in the report. The cost of a nitpick is small; the cost of shipping non-idiomatic \
    or fragile code that spreads is large. Preserve well-grounded non_blocking findings from \
    the chunk reviews rather than pruning them for tidiness.\n\
    \n\
    Return ONLY a valid JSON object — no markdown fences, no text outside the JSON.\n\
    Schema:\n\
    {\n\
      \"overall\": \"approve\" | \"request_changes\" | \"needs_discussion\",\n\
      \"summary\": \"<two to four sentences: verdict, key strengths, key concerns>\",\n\
      \"bug_test_steps\": null | {\n\
        \"description\": \"<one sentence: what the bug was and what the fix addresses>\",\n\
        \"happy_path\": [\"<step 1>\", ...],\n\
        \"sad_path\": [\"<step 1>\", ...]\n\
      },\n\
      \"lenses\": {\n\
        \"acceptance_criteria\": { \"assessment\": \"...\", \"findings\": [\n\
          { \"severity\": \"blocking\"|\"non_blocking\"|\"nitpick\",\n\
            \"title\": \"...\", \"description\": \"...\",\n\
            \"file\": \"<path string or null>\",\n\
            \"line_range\": \"<\\\"L12-L34\\\" or null>\" }] },\n\
        \"security\": { \"assessment\": \"...\", \"findings\": [...] },\n\
        \"logic\":    { \"assessment\": \"...\", \"findings\": [...] },\n\
        \"quality\":  { \"assessment\": \"...\", \"findings\": [...] },\n\
        \"testing\":  { \"assessment\": \"...\", \"findings\": [...] }\n\
      }\n\
    }\n\
    \n\
    === SYNTHESIS RULES ===\n\
    \n\
    BUG TEST STEPS:\n\
    - Only populate when the linked JIRA ticket type is Bug. Set null for all other types.\n\
    - happy_path: concrete numbered steps to verify the fix works (UI interactions, not code).\n\
    - sad_path: edge-case steps confirming adjacent behaviour is unbroken.\n\
    - Each step must be specific and actionable by a human tester. Aim for 3–6 per path.\n\
    \n\
    SUMMARY:\n\
    - Lead with the verdict. Note what is done WELL, then the most important concerns.\n\
    \n\
    VERIFICATION PASS (apply to every logic and security finding before including it):\n\
    The input includes === FULL FILE CONTENTS FROM BRANCH ===.\n\
    For any finding that claims a type is undefined, a field is duplicated, an import is missing, \
    or a compilation error will occur: check that section. If the identifier is present there, \
    DROP the finding or downgrade it to a nitpick. Only retain compilation/type claims when the \
    identifier is absent from both the diff and the full file contents.\n\
    \n\
    DEDUPLICATION:\n\
    - Merge findings about the same root issue across chunks into one.\n\
    - DROP duplicate/redundant-code findings that cite only one location, or where the diff \
      shows the second reference is a derivation/usage of a value already fetched — not a \
      second fetch. Both occurrences must be cited at distinct line numbers.\n\
    \n\
    SEVERITY CALIBRATION:\n\
    - blocking only if you can articulate a concrete runtime failure, data corruption, or \
      security vulnerability. Downgrade everything else.\n\
    - Do not inflate severity to justify a finding. A genuine nitpick beats a false blocker.\n\
    \n\
    TESTING lens:\n\
    - If tests are present for the new/changed code, say so in the assessment.\n\
    - Non_blocking (never blocking) for missing tests unless safety-critical or explicitly promised.\n\
    - DROP any testing finding for config/build/asset files: *.json/yaml/toml, Makefile, \
      Dockerfile, lock files, *.css/svg/md, generated files, type-only definitions.\n\
    - Bug @tags: if a Bug ticket key is present, check new/modified unit tests carry \
      \\\"@tags <KEY>\\\". If missing, one consolidated non_blocking finding. Skip if: not Bug, \
      no key, annotation present, or no unit tests.\n\
    \n\
    ACCEPTANCE CRITERIA lens:\n\
    - If criteria are blank/not provided: empty findings array, assessment states none available.\n\
    \n\
    QUALITY lens:\n\
    - DROP findings about test framework function choice (test/it/describe/expect etc.).\n\
    - PRESERVE idiomaticity findings (non-idiomatic loops, framework anti-patterns, \
      inconsistent error handling, unnecessary allocations/clones, React hook misuse, missing \
      awaits, etc.) at their chunk-assigned severity. These are legitimate quality signals — \
      do not downgrade them unless the chunk finding lacks concrete grounding.\n\
    \n\
    SECURITY lens:\n\
    - DROP findings whose file is listed under TEST / SPEC FILES IN THIS DIFF.\n\
    \n\
    FORMAT:\n\
    - overall: request_changes if any blocking finding remains, approve if none, \
      needs_discussion if uncertain.\n\
    - file and line_range must be a quoted JSON string or literal null — never a bare word.\n\
    \n\
    LINE NUMBERS:\n\
    - Single-chunk mode: lines are pre-labelled [Lnnn]. Read the label — do not count.\n\
    - Multi-chunk mode: preserve line_range values from chunk findings exactly.\n\
    - Never cite [del] lines.\n\
    \n\
    === SELF-CHECK (apply before outputting) ===\n\
    For each finding in the final report:\n\
    1. Is it grounded in something visible in the diff or full file contents — not inferred?\n\
    2. Type/compilation claims: verified absent from the full file contents section?\n\
    3. Duplicate-code claims: two distinct line numbers cited?\n\
    4. Severity: can I articulate the concrete failure mode for any blocking finding?\n\
    Drop or downgrade any finding where an answer is NO.";

fn build_review_system_prompt(app: &tauri::AppHandle) -> String {
    let mut prompt = SYNTHESIS_SYSTEM.to_string();

    let review_skill = crate::commands::skills::get_skill(app, "review");
    let impl_skill = crate::commands::skills::get_skill(app, "implementation");

    if review_skill.is_some() || impl_skill.is_some() {
        prompt.push_str("\n\n=== PROJECT-SPECIFIC REVIEW STANDARDS (Agent Skills) ===\n");
        prompt.push_str(
            "The following conventions are specific to this codebase. \
            Apply them when evaluating findings — they take precedence over generic heuristics.\n",
        );
        if let Some(s) = review_skill {
            prompt.push_str("\n--- Review Standards ---\n");
            prompt.push_str(&s);
        }
        if let Some(s) = impl_skill {
            prompt.push_str("\n--- Implementation Standards ---\n");
            prompt.push_str(&s);
        }
    }
    prompt
}

#[tauri::command]
pub async fn review_pr(app: tauri::AppHandle, review_text: String) -> Result<String, String> {
    claude::reset_cancellation();
    let (client, api_key) = dispatch::llm_client().await?;

    let provider = dispatch::get_ai_provider();
    let effective_provider = if provider == "auto" {
        dispatch::get_provider_order()
            .into_iter()
            .next()
            .unwrap_or_else(|| "claude".to_string())
    } else {
        provider
    };
    let chunk_chars: usize = if effective_provider == "local" {
        12_000
    } else {
        80_000
    };

    let chunks = split_review_into_chunks(&review_text, chunk_chars);
    let needs_chunking = chunks.len() > 1;

    let all_findings_json: String = if needs_chunking {
        let total = chunks.len();
        let _ = app.emit("pr-review-progress", serde_json::json!({
            "phase": "analysis",
            "message": format!("Large diff detected — reviewing {total} file chunk{} separately…",
                if total == 1 { "" } else { "s" })
        }));

        let mut all_findings: Vec<serde_json::Value> = vec![];

        for (i, chunk) in chunks.iter().enumerate() {
            if claude::is_cancelled() {
                let _ = app.emit(
                    "pr-review-progress",
                    serde_json::json!({
                        "phase": "cancelled",
                        "message": "Review cancelled."
                    }),
                );
                return Err("Review cancelled by user.".to_string());
            }

            let _ = app.emit(
                "pr-review-progress",
                serde_json::json!({
                    "phase": "analysis",
                    "message": format!("Reviewing chunk {}/{total} ({} chars)…", i + 1, chunk.len())
                }),
            );
            let _ = app.emit("pr-review-stream-reset", serde_json::json!({}));

            let user = format!("Find all review findings in this diff chunk:\n\n{chunk}");
            match dispatch::dispatch_streaming(
                &app,
                &client,
                &api_key,
                CHUNK_SYSTEM,
                &user,
                2000,
                "pr-review-stream",
            )
            .await
            {
                Ok(raw) => {
                    let cleaned = raw
                        .trim()
                        .trim_start_matches("```json")
                        .trim_start_matches("```")
                        .trim_end_matches("```")
                        .trim();
                    if let Ok(arr) = serde_json::from_str::<serde_json::Value>(cleaned) {
                        if let Some(findings) = arr.as_array() {
                            all_findings.extend(findings.iter().cloned());
                        }
                    }
                }
                Err(e) => {
                    let _ = app.emit("pr-review-progress", serde_json::json!({
                        "phase": "analysis",
                        "message": format!("Warning: chunk {}/{total} failed ({e}) — continuing…", i + 1)
                    }));
                }
            }
        }
        serde_json::to_string(&all_findings).unwrap_or_else(|_| "[]".to_string())
    } else {
        "[]".to_string()
    };

    if claude::is_cancelled() {
        let _ = app.emit(
            "pr-review-progress",
            serde_json::json!({
                "phase": "cancelled",
                "message": "Review cancelled."
            }),
        );
        return Err("Review cancelled by user.".to_string());
    }

    let synthesis_user = if needs_chunking {
        let _ = app.emit("pr-review-stream-reset", serde_json::json!({}));
        let findings_budget: usize = if effective_provider == "local" {
            4_000
        } else {
            40_000
        };
        let (capped_findings_json, dropped_count) =
            cap_findings_by_severity(&all_findings_json, findings_budget);

        let drop_note = if dropped_count > 0 {
            format!("\n\nNote: {dropped_count} lower-severity finding(s) were omitted to fit the model context window. All blocking and non-blocking findings are included.")
        } else {
            String::new()
        };

        let _ = app.emit("pr-review-progress", serde_json::json!({
            "phase": "analysis",
            "message": if dropped_count > 0 {
                format!("Synthesising findings ({dropped_count} low-severity finding(s) trimmed to fit context)…")
            } else {
                "Synthesising findings into final report…".to_string()
            }
        }));

        let header = if let Some(pos) = review_text.find("=== DIFF ===") {
            review_text[..pos + "=== DIFF ===".len()].to_string()
                + "\n[diff reviewed in chunks — findings collected above]"
        } else {
            review_text.clone()
        };

        format!(
            "Pull request context:\n{header}\n\n\
             Findings collected from reviewing all diff chunks:{drop_note}\n{capped_findings_json}\n\n\
             Produce the final review report JSON."
        )
    } else {
        let _ = app.emit(
            "pr-review-progress",
            serde_json::json!({
                "phase": "analysis",
                "message": "Analysing diff across five review lenses…"
            }),
        );
        let annotated_text = if let Some(pos) = review_text.find("=== DIFF ===") {
            let header = &review_text[..pos + "=== DIFF ===".len()];
            let diff_body = &review_text[pos + "=== DIFF ===".len()..];
            format!("{header}{}", annotate_diff_with_line_numbers(diff_body))
        } else {
            review_text.clone()
        };
        format!(
            "Review this pull request across five lenses: acceptance_criteria, security, \
             logic, quality, and testing. Apply the severity calibration rules from your \
             system prompt carefully — do not inflate severity. Note what is done well in \
             the summary. Produce the final review report JSON.\n\n{annotated_text}"
        )
    };

    let result = dispatch::dispatch_streaming(
        &app,
        &client,
        &api_key,
        &build_review_system_prompt(&app),
        &synthesis_user,
        4000,
        "pr-review-stream",
    )
    .await;

    let _ = app.emit(
        "pr-review-progress",
        serde_json::json!({
            "phase": "done",
            "message": if result.is_ok() { "Review complete." } else { "Review failed." }
        }),
    );
    result
}

#[tauri::command]
pub async fn chat_pr_review(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let review_skill = crate::commands::skills::get_skill(&app, "review");
    let impl_skill = crate::commands::skills::get_skill(&app, "implementation");
    let mut skills_block = String::new();
    if review_skill.is_some() || impl_skill.is_some() {
        skills_block = String::from(
            "\n\n=== PROJECT-SPECIFIC CONVENTIONS (Agent Skills) ===\n\
            These codebase-specific standards must inform any code you write or suggest:\n",
        );
        if let Some(s) = review_skill {
            skills_block.push_str("\n--- Review Standards ---\n");
            skills_block.push_str(&s);
        }
        if let Some(s) = impl_skill {
            skills_block.push_str("\n--- Implementation Standards ---\n");
            skills_block.push_str(&s);
        }
    }

    let system = format!(
        "You are an expert code reviewer who has just completed a structured review of a pull \
        request. The review report, PR comments, and PR context are below.\n\n\
        {context_text}\n\n\
        The engineer is now asking you follow-up questions about your findings. Your role:\n\
        - Explain your reasoning clearly when asked why you raised a finding\n\
        - When a finding was informed by a PR comment from another reviewer, say so explicitly: \
          cite the comment author by name and quote the relevant part of their comment. \
          Do not present their observation as your own independent conclusion.\n\
        - When a finding comes from your own analysis of the diff (not from any comment), \
          say so clearly: explain which lines or patterns led you to the conclusion.\n\
        - Reconsider or soften a finding if the engineer provides additional context that \
          changes its relevance\n\
        - Point to specific parts of the diff or specific comments when relevant\n\
        - Be concise and direct — this is a conversation, not another report\n\
        - Do NOT produce JSON — reply in plain prose only\n\
        - When writing or suggesting code examples, follow the project-specific conventions \
          below. For example: if the standards specify Vitest, use Vitest syntax — not Jest \
          or any other framework.\n\
        \n\
        TOOLS — USE THEM PROACTIVELY:\n\
        You have access to repo-inspection tools that read the local git worktree. Whenever a \
        question requires knowledge of files, build setup, tests, or configuration that is not \
        already in the diff or report above, you MUST call the relevant tool before answering. \
        Do NOT speculate or answer from general knowledge when the answer can be verified from \
        the codebase. Do NOT announce that you are about to use tools — just use them, then \
        answer.\n\
        - glob_repo — find files by pattern (e.g. '**/*.test.cpp', 'CMakeLists.txt', \
          'engine-socket/**/*')\n\
        - grep_repo — search file contents for a regex (e.g. test framework imports, target \
          names, build flags)\n\
        - read_repo_file — read a specific file when you need its full contents\n\
        - get_repo_diff — get the diff between branches if the report's diff is insufficient\n\
        - git_log — recent commit history, optionally filtered to a path\n\
        Typical pattern for a codebase question: glob_repo to locate candidates → grep_repo or \
        read_repo_file to inspect → answer with concrete file paths and line references.{skills_block}"
    );
    dispatch::dispatch_multi_streaming_with_tools(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        4096,
        "pr-review-chat-stream",
    )
    .await
}

#[tauri::command]
pub async fn analyze_pr_comments(
    app: tauri::AppHandle,
    review_text: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let system = "You are an expert software engineer helping the PR author address code review \
        comments left by their team. You will be given:\n\
        1. The full PR diff\n\
        2. All reviewer comments (inline comments annotated with file/line context)\n\
        3. The content of files referenced in inline comments\n\n\
        Your task is to produce a structured fix plan. Analyse every reviewer comment carefully. \
        For each comment, decide:\n\
        - What is the reviewer asking for?\n\
        - What specific code change would address it?\n\
        - How confident are you in the fix? (High / Medium / Needs human judgment)\n\n\
        You MUST respond with ONLY a valid JSON array — no markdown fences, no explanation outside the JSON.\n\
        Schema for each element:\n\
        {\n\
          \"commentId\": <number — the Bitbucket comment id>,\n\
          \"file\": \"<relative file path or null for general comments>\",\n\
          \"fromLine\": <number or null>,\n\
          \"toLine\": <number or null>,\n\
          \"reviewerName\": \"<commenter display name>\",\n\
          \"commentSummary\": \"<one sentence: what the reviewer wants>\",\n\
          \"proposedFix\": \"<concrete description of the change to make>\",\n\
          \"confidence\": \"High\" | \"Medium\" | \"Needs human judgment\",\n\
          \"affectedFiles\": [\"<relative path>\"],\n\
          \"newContent\": \"<the exact replacement file content if confidence is High or Medium, otherwise null>\",\n\
          \"skippable\": false\n\
        }\n\
        Set `newContent` only when you can produce the full replacement content for the affected file. \
        For general architectural or design comments where the fix is open-ended, set confidence to \
        'Needs human judgment' and leave newContent null.\n\
        Do not invent problems. Only address comments that are actually present.";

    dispatch::dispatch_streaming(
        &app,
        &client,
        &api_key,
        system,
        &review_text,
        4096,
        "address-pr-stream",
    )
    .await
}

#[tauri::command]
pub async fn chat_address_pr(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;
    let system = format!(
        "You are an expert software engineer helping the PR author address code review comments. \
        The PR diff, reviewer comments, and fix plan are below.\n\n\
        {context_text}\n\n\
        The engineer is now conversing with you about the fix plan. Your role:\n\
        - Explain your reasoning for any proposed fix\n\
        - Revise a proposed fix if the engineer asks you to approach it differently\n\
        - When revising, describe the new approach clearly\n\
        - Be concise and direct — this is a conversation, not another report\n\
        - Do NOT produce JSON unless the engineer explicitly asks you to regenerate the full fix plan"
    );
    dispatch::dispatch_multi_streaming_with_tools(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        4096,
        "address-pr-chat-stream",
    )
    .await
}
