pub mod bitbucket;
pub mod commands;
pub mod http;
pub mod jira;

use commands::{
    credential_status, delete_credential, save_credential, get_non_secret_config,     validate_anthropic, validate_bitbucket,
    validate_jira, test_anthropic_stored, test_jira_stored, test_bitbucket_stored, debug_jira_endpoints, assess_ticket_quality, generate_standup_briefing, generate_sprint_retrospective,
    import_claude_pro_token,
    generate_workload_suggestions, review_pr,
    get_claude_models, get_gemini_models, validate_gemini, test_gemini_stored,
    get_local_models, validate_local_llm, test_local_llm_stored,
    // Agent pipeline
    run_grooming_agent, run_impact_analysis, run_triage_turn, finalize_implementation_plan,
    run_implementation_guidance, run_test_suggestions, run_plan_review,
    run_pr_description_gen, run_retrospective_agent,
    // JIRA data commands
    get_active_sprint, get_all_active_sprints, get_all_active_sprint_issues,
    get_active_sprint_issues, get_completed_sprints, get_issue,
    get_my_sprint_issues, get_sprint_issues, get_sprint_issues_by_id, search_jira_issues,
    // Bitbucket data commands
    get_open_prs, get_merged_prs, get_pr, get_pr_comments, get_pr_diff, get_pr_tasks, get_prs_for_review,
    // Knowledge base
    load_knowledge_entries, save_knowledge_entry, delete_knowledge_entry, export_knowledge_markdown,
    // Agent skills
    load_agent_skills, save_agent_skill, delete_agent_skill,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            commands::credentials::init_credentials_path(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Claude
            assess_ticket_quality,
            generate_standup_briefing,
            generate_sprint_retrospective,
            generate_workload_suggestions,
            review_pr,
            get_claude_models,
            get_gemini_models,
            validate_gemini,
            test_gemini_stored,
            get_local_models,
            validate_local_llm,
            test_local_llm_stored,
            // Agent pipeline
            run_grooming_agent,
            run_impact_analysis,
            run_triage_turn,
            finalize_implementation_plan,
            run_implementation_guidance,
            run_test_suggestions,
            run_plan_review,
            run_pr_description_gen,
            run_retrospective_agent,
            // Credentials
            credential_status,
            save_credential,
            delete_credential,
            get_non_secret_config,
            // Validation
            validate_anthropic,
            validate_jira,
            validate_bitbucket,
            test_anthropic_stored,
            test_jira_stored,
            test_bitbucket_stored,
            debug_jira_endpoints,
            import_claude_pro_token,
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
            search_jira_issues,
            // Bitbucket
            get_open_prs,
            get_merged_prs,
            get_prs_for_review,
            get_pr,
            get_pr_diff,
            get_pr_comments,
            get_pr_tasks,
            // Knowledge base
            load_knowledge_entries,
            save_knowledge_entry,
            delete_knowledge_entry,
            export_knowledge_markdown,
            // Agent skills
            load_agent_skills,
            save_agent_skill,
            delete_agent_skill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
