// Tauri command handlers — grouped by domain
// Credentials are always read from the OS keychain in the backend and never returned to the frontend.

pub mod bitbucket;
pub mod claude;
pub mod credentials;
pub mod fetch_url;
pub mod jira;
pub mod knowledge;
pub mod preferences;
pub mod repo;
pub mod skills;
pub mod store_cache;
pub mod validate;

pub use bitbucket::{
    get_merged_prs, get_open_prs, get_pr, get_pr_comments, get_pr_diff, get_pr_tasks, get_prs_for_review,
    get_my_open_prs,
    approve_pr, unapprove_pr, request_changes_pr, unrequest_changes_pr,
    post_pr_comment, create_pr_task, resolve_pr_task, delete_pr_comment, update_pr_comment,
};
pub use claude::{
    assess_ticket_quality, generate_standup_briefing, generate_sprint_retrospective,
    generate_workload_suggestions, review_pr, cancel_review, chat_pr_review,
    analyze_pr_comments, chat_address_pr,
    get_claude_models, get_gemini_models, validate_gemini, test_gemini_stored,
    get_local_models, validate_local_llm, test_local_llm_stored,
    // Agent pipeline
    run_grooming_file_probe, run_grooming_agent, run_grooming_chat_turn,
    run_impact_analysis, run_triage_turn, finalize_implementation_plan,
    run_implementation_guidance, run_implementation_agent,
    run_test_suggestions, run_plan_review,
    run_pr_description_gen, run_retrospective_agent,
};
pub use credentials::{credential_status, delete_credential, save_credential, get_non_secret_config};
pub use jira::{
    get_active_sprint, get_all_active_sprints, get_all_active_sprint_issues,
    get_active_sprint_issues, get_completed_sprints, get_future_sprints, get_issue,
    get_my_sprint_issues, get_sprint_issues, get_sprint_issues_by_id, search_jira_issues,
    update_jira_issue, update_jira_fields,
    // Diagnostic / discovery commands
    get_raw_issue_fields, get_jira_fields,
};
pub use knowledge::{
    delete_knowledge_entry, export_knowledge_markdown, load_knowledge_entries, save_knowledge_entry,
};
pub use repo::{
    validate_worktree, sync_worktree,
    glob_repo_files, grep_repo_files, read_repo_file, write_repo_file,
    get_repo_diff, get_repo_log, get_file_history,
    checkout_worktree_branch,
    validate_pr_review_worktree, checkout_pr_review_branch,
    run_in_terminal,
    validate_pr_address_worktree, checkout_pr_address_branch,
    read_pr_address_file, write_pr_address_file,
    get_pr_address_diff, commit_pr_address_changes, push_pr_address_branch,
};
pub use preferences::{get_preferences, set_preference, delete_preference};
pub use skills::{load_agent_skills, save_agent_skill, delete_agent_skill};
pub use store_cache::{
    save_store_cache, load_store_cache, delete_store_cache,
    get_store_cache_info, clear_all_store_caches,
};
pub use validate::{validate_anthropic, validate_bitbucket, validate_jira, test_anthropic_stored, test_jira_stored, test_bitbucket_stored, debug_jira_endpoints, start_claude_oauth};
pub use fetch_url::fetch_url_content;
