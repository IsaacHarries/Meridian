// Tauri commands for worktree-sandboxed repo operations.
// Split from a single repo.rs for size; submodules group related concerns:
//   - validate : worktree validation commands
//   - sync     : fetch/reset and branch checkout commands
//   - files    : glob/grep/read/write file commands + internal helpers
//   - diff     : diff / log / file-history / file-at-base commands
//   - git      : feature-branch / commit / squash / push commands
//   - exec     : exec_in_worktree + run_in_terminal
//   - types    : shared serializable structs (WorktreeInfo, StatResult)
//   - _shared  : non-public helpers (config lookup, sandbox path, git runner)

mod _shared;
pub mod diff;
pub mod exec;
pub mod files;
pub mod git;
pub mod sync;
pub mod types;
pub mod validate;

// Re-export the public types so existing `use crate::commands::repo::WorktreeInfo` etc. keep working.
pub use types::{StatResult, WorktreeInfo};

// Re-export every Tauri command and internal helper so existing call sites at
// `crate::commands::repo::<name>` continue to resolve unchanged.
pub use diff::{get_file_at_base, get_file_history, get_pr_address_diff, get_repo_diff, get_repo_log};
pub use exec::{exec_in_worktree, exec_in_worktree_internal, run_in_terminal};
pub use files::{
    delete_repo_file_internal, git_add_all_internal, git_status_internal, glob_grooming_files,
    glob_repo_files, grep_grooming_files, grep_repo_files, move_repo_file_internal,
    read_grooming_file, read_pr_address_file, read_repo_file, read_repo_file_internal,
    stat_repo_file_internal, write_pr_address_file, write_repo_file, write_repo_file_internal,
};
pub use git::{
    commit_pr_address_changes, commit_worktree_changes, create_feature_branch,
    push_pr_address_branch, push_worktree_branch, squash_worktree_commits,
};
pub use sync::{
    checkout_pr_address_branch, checkout_pr_review_branch, checkout_worktree_branch,
    sync_grooming_worktree, sync_worktree,
};
pub use validate::{
    validate_grooming_worktree, validate_pr_address_worktree, validate_pr_review_worktree,
    validate_worktree,
};
