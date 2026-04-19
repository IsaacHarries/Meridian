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
    approve_pr, create_pr_task, delete_pr_comment, get_merged_prs, get_my_open_prs, get_open_prs,
    get_pr, get_pr_comments, get_pr_diff, get_pr_tasks, get_prs_for_review, post_pr_comment,
    request_changes_pr, resolve_pr_task, unapprove_pr, unrequest_changes_pr, update_pr_comment,
};
pub use claude::{
    analyze_pr_comments,
    assess_ticket_quality,
    cancel_review,
    chat_address_pr,
    chat_pr_review,
    finalize_implementation_plan,
    generate_sprint_retrospective,
    generate_standup_briefing,
    generate_workload_suggestions,
    get_claude_models,
    get_gemini_models,
    get_local_models,
    review_pr,
    run_checkpoint_chat_turn,
    run_grooming_agent,
    run_grooming_chat_turn,
    // Agent pipeline
    run_grooming_file_probe,
    run_impact_analysis,
    run_implementation_agent,
    run_implementation_guidance,
    run_plan_review,
    run_pr_description_gen,
    run_retrospective_agent,
    run_test_suggestions,
    run_triage_turn,
    test_gemini_stored,
    test_local_llm_stored,
    validate_gemini,
    validate_local_llm,
};
pub use credentials::{
    credential_status, delete_credential, get_non_secret_config, save_credential,
};
pub use fetch_url::fetch_url_content;
pub use jira::{
    get_active_sprint,
    get_active_sprint_issues,
    get_all_active_sprint_issues,
    get_all_active_sprints,
    get_completed_sprints,
    get_future_sprints,
    get_issue,
    get_jira_fields,
    get_my_sprint_issues,
    // Diagnostic / discovery commands
    get_raw_issue_fields,
    get_sprint_issues,
    get_sprint_issues_by_id,
    search_jira_issues,
    update_jira_fields,
    update_jira_issue,
};
pub use knowledge::{
    delete_knowledge_entry, export_knowledge_markdown, load_knowledge_entries, save_knowledge_entry,
};
pub use preferences::{delete_preference, get_preferences, set_preference};
pub use repo::{
    checkout_pr_address_branch, checkout_pr_review_branch, checkout_worktree_branch,
    commit_pr_address_changes, get_file_history, get_pr_address_diff, get_repo_diff, get_repo_log,
    glob_repo_files, grep_repo_files, push_pr_address_branch, read_pr_address_file, read_repo_file,
    run_in_terminal, sync_worktree, validate_pr_address_worktree, validate_pr_review_worktree,
    validate_worktree, write_pr_address_file, write_repo_file,
};
pub use skills::{delete_agent_skill, load_agent_skills, save_agent_skill};
pub use store_cache::{
    clear_all_store_caches, delete_store_cache, get_store_cache_info, load_store_cache,
    save_store_cache,
};
pub use validate::{
    debug_jira_endpoints, import_claude_code_token, ping_anthropic, ping_gemini,
    start_claude_oauth, start_gemini_oauth, test_anthropic_stored, test_bitbucket_stored,
    test_jira_stored, validate_anthropic, validate_bitbucket, validate_jira,
};
