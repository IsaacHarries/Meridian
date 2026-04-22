// Tauri command handlers — grouped by domain
// Credentials are always read from the OS keychain in the backend and never returned to the frontend.

pub mod bitbucket;
pub mod credentials;
pub mod fetch_url;
pub mod jira;
pub mod knowledge;
pub mod preferences;
pub mod pr_template;
pub mod repo;
pub mod skills;
pub mod sprint_reports;
pub mod store_cache;
pub mod validate;

use crate::agents;
use crate::llms;

pub use agents::briefing::{
    generate_sprint_retrospective, generate_standup_briefing, generate_workload_suggestions,
};
pub use agents::dispatch::llm_client;
pub use agents::grooming::{
    assess_ticket_quality, run_grooming_agent, run_grooming_chat_turn, run_grooming_file_probe,
};
pub use agents::implementation::{
    run_build_check, run_implementation_agent, run_implementation_guidance, run_plan_review,
    run_pr_description_gen, run_retrospective_agent, run_test_agent,
};
pub use agents::planning::{
    finalize_implementation_plan, run_checkpoint_action, run_checkpoint_chat_turn,
    run_impact_analysis, run_tool_test, run_tool_test_with_llm, run_triage_turn,
};
pub use agents::review::{
    analyze_pr_comments, chat_address_pr, chat_pr_review, review_pr as review_pr_agent,
};
pub use bitbucket::{
    approve_pr, create_pr_task, create_pull_request, delete_pr_comment, get_merged_prs,
    get_my_open_prs, get_open_prs, get_pr, get_pr_comments, get_pr_diff, get_pr_tasks,
    get_prs_for_review, post_pr_comment, request_changes_pr, resolve_pr_task, unapprove_pr,
    unrequest_changes_pr, update_pr_comment,
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
pub use llms::claude::{cancel_review, get_claude_models};
pub use llms::copilot::{
    add_custom_copilot_model, get_copilot_models, get_custom_copilot_models,
    remove_custom_copilot_model, test_copilot_stored, validate_copilot,
};
pub use llms::gemini::{
    add_custom_gemini_model, get_custom_gemini_models, get_gemini_models,
    remove_custom_gemini_model, test_gemini_stored, validate_gemini,
};
pub use llms::local_llm::{get_local_models, test_local_llm_stored, validate_local_llm};
pub use preferences::{delete_preference, get_preferences, set_preference};
pub use pr_template::{
    get_pr_template_path, load_pr_template, reveal_pr_template_dir, save_pr_template,
};
pub use repo::{
    checkout_pr_address_branch, checkout_pr_review_branch, checkout_worktree_branch,
    commit_pr_address_changes, commit_worktree_changes, create_feature_branch, exec_in_worktree,
    get_file_at_base, get_file_history, get_pr_address_diff, get_repo_diff, get_repo_log,
    glob_repo_files, grep_repo_files, push_pr_address_branch, push_worktree_branch,
    read_pr_address_file, read_repo_file, run_in_terminal, squash_worktree_commits, sync_worktree,
    validate_pr_address_worktree, validate_pr_review_worktree, validate_worktree,
    write_pr_address_file, write_repo_file,
};
pub use skills::{delete_agent_skill, load_agent_skills, save_agent_skill};
pub use sprint_reports::{
    get_sprint_reports_dir, list_cached_sprint_ids, load_sprint_report, save_sprint_report,
};
pub use store_cache::{
    clear_all_store_caches, delete_store_cache, get_store_cache_info, load_store_cache,
    save_store_cache,
};
pub use validate::{
    debug_jira_endpoints, import_claude_code_token, ping_anthropic, ping_copilot, ping_gemini,
    start_claude_oauth, start_copilot_oauth, start_gemini_oauth, test_anthropic_stored,
    test_bitbucket_stored, test_jira_stored, validate_anthropic, validate_bitbucket, validate_jira,
};
