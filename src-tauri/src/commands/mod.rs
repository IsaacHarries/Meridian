// Tauri command handlers — grouped by domain
// Credentials are always read from the OS keychain in the backend and never returned to the frontend.

pub mod bitbucket;
pub mod claude;
pub mod credentials;
pub mod jira;
pub mod knowledge;
pub mod skills;
pub mod validate;

pub use bitbucket::{
    get_merged_prs, get_open_prs, get_pr, get_pr_comments, get_pr_diff, get_pr_tasks, get_prs_for_review,
};
pub use claude::{
    assess_ticket_quality, generate_standup_briefing, generate_sprint_retrospective,
    generate_workload_suggestions, review_pr,
    // Agent pipeline
    run_grooming_agent, run_impact_analysis, run_triage_turn, finalize_implementation_plan,
    run_implementation_guidance, run_test_suggestions, run_plan_review,
    run_pr_description_gen, run_retrospective_agent,
};
pub use credentials::{credential_status, delete_credential, save_credential, get_non_secret_config};
pub use jira::{
    get_active_sprint, get_all_active_sprints, get_all_active_sprint_issues,
    get_active_sprint_issues, get_completed_sprints, get_issue,
    get_my_sprint_issues, get_sprint_issues, get_sprint_issues_by_id, search_jira_issues,
};
pub use knowledge::{
    delete_knowledge_entry, export_knowledge_markdown, load_knowledge_entries, save_knowledge_entry,
};
pub use skills::{load_agent_skills, save_agent_skill, delete_agent_skill};
pub use validate::{validate_anthropic, validate_bitbucket, validate_jira, test_anthropic_stored, test_jira_stored, test_bitbucket_stored, debug_jira_endpoints};
