pub mod agents;
pub mod commands;
pub mod http;
pub mod integrations;
pub mod llms;
pub mod storage;

use commands::{
    start_time_tracking_poller,
    active_meeting_id,
    add_custom_copilot_model,
    add_custom_gemini_model,
    approve_pr,
    cancel_review,
    checkout_pr_address_branch,
    checkout_pr_review_branch,
    checkout_worktree_branch,
    clear_all_store_caches,
    commit_pr_address_changes,
    commit_worktree_changes,
    create_feature_branch,
    create_notes_meeting,
    create_pr_task,
    create_pull_request,
    create_task,
    credential_status,
    debug_jira_endpoints,
    delete_agent_skill,
    delete_credential,
    delete_meeting,
    delete_pr_comment,
    delete_task,
    diarize_meeting,
    rename_meeting_speaker,
    delete_preference,
    delete_store_cache,
    // URL fetch
    fetch_url_content,
    generate_multi_sprint_trends,
    // JIRA data commands
    get_active_sprint,
    get_active_sprint_issues,
    get_all_active_sprint_issues,
    get_all_active_sprints,
    get_claude_models,
    get_completed_sprints,
    get_copilot_models,
    get_custom_copilot_models,
    get_custom_gemini_models,
    get_file_history,
    fetch_jira_image,
    get_future_sprints,
    get_gemini_models,
    get_issue,
    get_jira_fields,
    get_local_models,
    get_meetings_dir,
    // Bitbucket data commands
    get_merged_prs,
    get_my_open_prs,
    get_my_sprint_issues,
    get_data_dir,
    data_directory_has_content,
    move_data_directory,
    relaunch_app,
    get_ai_debug_log_path_cmd,
    clear_ai_debug_log_cmd,
    get_non_secret_config,
    get_open_prs,
    get_pr,
    get_pr_address_diff,
    get_pr_comments,
    get_pr_diff,
    get_pr_file_content,
    get_pr_tasks,
    fetch_bitbucket_image,
    upload_pr_attachment,
    get_pr_template_path,
    // Preferences (plain JSON, survives cache clears)
    get_preferences,
    get_prs_for_review,
    // JIRA diagnostic / field discovery
    get_raw_issue_fields,
    get_file_at_base,
    get_repo_diff,
    get_repo_log,
    get_sprint_issues,
    get_sprint_issues_by_id,
    get_sprint_reports_dir,
    get_store_cache_info,
    get_system_activity_state,
    load_time_tracking_state,
    save_time_tracking_state,
    glob_grooming_files,
    glob_repo_files,
    grep_grooming_files,
    grep_repo_files,
    read_grooming_file,
    import_claude_code_token,
    // Agent skills
    load_agent_skills,
    // PR description template
    load_pr_template,
    save_pr_template,
    reveal_pr_template_dir,
    // Grooming format templates
    load_grooming_template,
    save_grooming_template,
    get_grooming_template_path,
    reveal_grooming_templates_dir,
    // Sprint reports (disk cache)
    list_cached_sprint_ids,
    list_meetings,
    list_microphones,
    list_tasks,
    list_trend_analyses,
    list_whisper_models,
    load_meeting,
    load_sprint_report,
    load_trend_analysis,
    load_store_cache,
    pause_meeting_recording,
    ping_anthropic,
    ping_copilot,
    ping_gemini,
    post_pr_comment,
    push_pr_address_branch,
    resume_meeting_recording,
    push_worktree_branch,
    squash_worktree_commits,

    read_pr_address_file,
    read_repo_file,
    remove_custom_copilot_model,
    remove_custom_gemini_model,
    request_changes_pr,
    resolve_pr_task,
    update_pr_task,
    run_grooming_chat_workflow,
    chat_with_orchestrator,
    apply_plan_edits,
    run_grooming_workflow,
    run_implementation_pipeline_workflow,
    resume_implementation_pipeline_workflow,
    rewind_implementation_pipeline_workflow,
    cancel_implementation_pipeline_workflow,
    run_pr_review_workflow,
    run_sprint_retrospective_workflow,
    run_workload_suggestions_workflow,
    run_meeting_summary_workflow,
    run_meeting_title_workflow,
    run_sprint_dashboard_chat_workflow,
    run_meeting_chat_workflow,
    run_cross_meetings_chat_workflow,
    run_analyze_pr_comments_workflow,
    run_pr_review_chat_workflow,
    run_address_pr_chat_workflow,
    run_grooming_file_probe_workflow,
    exec_in_worktree,
    run_in_terminal,
    save_agent_skill,
    save_credential,
    save_meeting,
    reindex_all_meetings,
    meetings_index_status,
    clear_meetings_embeddings,
    probe_ollama_cmd,
    search_meetings,
    get_meeting_segment,
    save_sprint_report,
    save_trend_analysis,
    delete_trend_analysis,
    download_whisper_model,
    // Store cache (file-backed persistence for Zustand stores)
    save_store_cache,
    search_jira_issues,
    set_preference,
    start_claude_oauth,
    start_copilot_oauth,
    start_gemini_oauth,
    start_meeting_recording,
    stop_meeting_recording,
    sync_grooming_worktree,
    sync_worktree,
    validate_grooming_worktree,
    test_anthropic_stored,
    test_bitbucket_stored,
    test_copilot_stored,
    test_gemini_stored,
    test_jira_stored,
    test_local_llm_stored,
    unapprove_pr,
    unrequest_changes_pr,
    update_jira_fields,
    update_jira_issue,
    update_meeting_notes,
    update_pr_comment,
    update_task,
    validate_anthropic,
    validate_bitbucket,
    validate_copilot,
    validate_gemini,
    validate_jira,
    validate_local_llm,
    validate_pr_address_worktree,
    validate_pr_review_worktree,
    // Repo / worktree
    validate_worktree,
    write_pr_address_file,
    write_repo_file,
};

/// Build and attach the application menu. Currently a single
/// developer-facing entry — View → AI Debug Panel — with a Cmd/Ctrl-
/// Shift-D shortcut. Clicking the item (or hitting the shortcut)
/// triggers a `menu-action` event the frontend consumes via
/// `aiDebugListener` to flip the panel's dock mode.
///
/// We add an Edit submenu with the standard cut/copy/paste/select-all
/// roles too, because Tauri 2 only wires the OS clipboard shortcuts
/// when the app has a menu — without it, ⌘C / ⌘V stop working in
/// every text input on macOS the moment we install our own menu.
fn install_app_menu(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{
        AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
    };
    use tauri::Emitter;

    let about = PredefinedMenuItem::about(
        app,
        Some("About Meridian"),
        Some(AboutMetadataBuilder::new().build()),
    )?;
    let app_submenu = SubmenuBuilder::new(app, "Meridian")
        .item(&about)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // Standard Edit menu — restores the OS clipboard accelerators that
    // a custom menu would otherwise replace.
    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let toggle_debug = MenuItemBuilder::new("AI Debug Panel")
        .id("ai_debug_toggle")
        .accelerator("CmdOrCtrl+Shift+D")
        .build(app)?;
    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&toggle_debug)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .build()?;
    app.set_menu(menu)?;

    // Forward menu clicks to the frontend. We use a single event with
    // the item id as payload so future menu items don't need a new
    // listener each — the frontend dispatches by id.
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu-action", event.id().0.as_str());
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install a panic hook that prints the full backtrace to stderr before the
    // process exits. On macOS the output appears in Console.app and in the
    // terminal when running `pnpm tauri dev`.
    std::panic::set_hook(Box::new(|info| {
        eprintln!("[MERIDIAN PANIC] {info}");
        eprintln!(
            "[MERIDIAN PANIC] backtrace:\n{:?}",
            std::backtrace::Backtrace::capture()
        );
    }));

    eprintln!("[MERIDIAN] run() called — building Tauri app");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(crate::integrations::sidecar::SidecarState::new())
        .setup(|app| {
            storage::credentials::init_store_path(app.handle());
            storage::preferences::init_prefs_path(app.handle());
            storage::meeting_index::init_index_path(app.handle());
            integrations::ai_traffic::init(app.handle().clone());
            integrations::embedding_backfill::spawn_backfill_loop(app.handle().clone());
            // Start the macOS lock/idle poller. Emits `time-tracker:state`
            // events that the frontend's time-tracking store consumes to
            // open and close work segments.
            start_time_tracking_poller(app.handle().clone());

            // Build the native menu — currently just one developer item:
            // View → AI Debug Panel (Cmd/Ctrl+Shift+D). The accelerator
            // doubles as a global keyboard shortcut while the app has
            // focus. Clicking the item emits `menu-action` events with
            // the menu id; the frontend's debug listener flips the
            // dock mode in response.
            install_app_menu(app.handle())?;

            eprintln!("[MERIDIAN] setup hook complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Claude
            generate_multi_sprint_trends,
            run_pr_review_workflow,
            run_sprint_retrospective_workflow,
            run_workload_suggestions_workflow,
            run_sprint_dashboard_chat_workflow,
            run_analyze_pr_comments_workflow,
            run_pr_review_chat_workflow,
            run_address_pr_chat_workflow,
            cancel_review,
            get_claude_models,
            get_gemini_models,
            get_custom_gemini_models,
            add_custom_gemini_model,
            remove_custom_gemini_model,
            get_copilot_models,
            get_custom_copilot_models,
            add_custom_copilot_model,
            remove_custom_copilot_model,
            validate_copilot,
            test_copilot_stored,
            start_copilot_oauth,
            ping_copilot,
            validate_gemini,
            test_gemini_stored,
            get_local_models,
            validate_local_llm,
            test_local_llm_stored,
            // Agent pipeline
            run_grooming_file_probe_workflow,
            run_grooming_chat_workflow,
            run_grooming_workflow,
            run_implementation_pipeline_workflow,
            resume_implementation_pipeline_workflow,
            rewind_implementation_pipeline_workflow,
            cancel_implementation_pipeline_workflow,
            chat_with_orchestrator,
            apply_plan_edits,
            exec_in_worktree,
            // Credentials
            credential_status,
            save_credential,
            delete_credential,
            get_non_secret_config,
            // Preferences
            get_preferences,
            set_preference,
            delete_preference,
            // Validation
            validate_anthropic,
            validate_jira,
            validate_bitbucket,
            test_anthropic_stored,
            ping_anthropic,
            ping_gemini,
            import_claude_code_token,
            test_jira_stored,
            test_bitbucket_stored,
            debug_jira_endpoints,
            start_claude_oauth,
            start_gemini_oauth,
            // JIRA
            get_active_sprint,
            get_all_active_sprints,
            get_all_active_sprint_issues,
            get_active_sprint_issues,
            get_my_sprint_issues,
            get_sprint_issues,
            get_sprint_issues_by_id,
            get_issue,
            get_completed_sprints,
            get_future_sprints,
            search_jira_issues,
            update_jira_issue,
            update_jira_fields,
            get_raw_issue_fields,
            get_jira_fields,
            // Bitbucket
            get_open_prs,
            get_merged_prs,
            get_prs_for_review,
            get_my_open_prs,
            get_pr,
            get_pr_diff,
            get_pr_file_content,
            get_pr_comments,
            get_pr_tasks,
            fetch_bitbucket_image,
            upload_pr_attachment,
            approve_pr,
            unapprove_pr,
            request_changes_pr,
            unrequest_changes_pr,
            post_pr_comment,
            create_pr_task,
            create_pull_request,
            resolve_pr_task,
            update_pr_task,
            delete_pr_comment,
            update_pr_comment,
            // Agent skills
            load_agent_skills,
            save_agent_skill,
            delete_agent_skill,
            // PR description template
            load_pr_template,
            save_pr_template,
            get_pr_template_path,
            reveal_pr_template_dir,
            // Grooming format templates
            load_grooming_template,
            save_grooming_template,
            get_grooming_template_path,
            reveal_grooming_templates_dir,
            // Store cache
            save_store_cache,
            load_store_cache,
            delete_store_cache,
            get_store_cache_info,
            clear_all_store_caches,
            // Sprint reports (persistent disk cache)
            save_sprint_report,
            load_sprint_report,
            list_cached_sprint_ids,
            get_sprint_reports_dir,
            // Trend analyses (persistent disk cache)
            save_trend_analysis,
            load_trend_analysis,
            list_trend_analyses,
            delete_trend_analysis,
            get_data_dir,
            data_directory_has_content,
            move_data_directory,
            relaunch_app,
            get_ai_debug_log_path_cmd,
            clear_ai_debug_log_cmd,
            // Repo / worktree
            validate_worktree,
            sync_worktree,
            glob_repo_files,
            grep_repo_files,
            read_repo_file,
            write_repo_file,
            get_file_at_base,
            get_repo_diff,
            get_repo_log,
            get_file_history,
            fetch_jira_image,
            checkout_worktree_branch,
            validate_pr_review_worktree,
            checkout_pr_review_branch,
            run_in_terminal,
            validate_grooming_worktree,
            sync_grooming_worktree,
            glob_grooming_files,
            grep_grooming_files,
            read_grooming_file,
            validate_pr_address_worktree,
            checkout_pr_address_branch,
            read_pr_address_file,
            write_pr_address_file,
            get_pr_address_diff,
            commit_pr_address_changes,
            push_pr_address_branch,
            // Implementation pipeline branch / commit / push
            create_feature_branch,
            commit_worktree_changes,
            squash_worktree_commits,
            push_worktree_branch,
            // URL fetch
            fetch_url_content,
            // Meetings
            list_microphones,
            list_whisper_models,
            download_whisper_model,
            start_meeting_recording,
            pause_meeting_recording,
            resume_meeting_recording,
            stop_meeting_recording,
            active_meeting_id,
            save_meeting,
            create_notes_meeting,
            update_meeting_notes,
            load_meeting,
            list_meetings,
            delete_meeting,
            get_meetings_dir,
            reindex_all_meetings,
            meetings_index_status,
            clear_meetings_embeddings,
            probe_ollama_cmd,
            search_meetings,
            get_meeting_segment,
            run_meeting_summary_workflow,
            run_meeting_title_workflow,
            run_meeting_chat_workflow,
    run_cross_meetings_chat_workflow,
            diarize_meeting,
            rename_meeting_speaker,
            // Manual tasks (Tasks panel)
            list_tasks,
            create_task,
            update_task,
            delete_task,
            // Time tracking
            get_system_activity_state,
            save_time_tracking_state,
            load_time_tracking_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
