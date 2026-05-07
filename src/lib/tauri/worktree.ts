import { invoke } from "@tauri-apps/api/core";
import type { BitbucketPr } from "./bitbucket";
import type { ImplementationPlan } from "./workflows";

export async function writeRepoFile(
  path: string,
  content: string,
): Promise<void> {
  return invoke("write_repo_file", { path, content });
}

export interface VerificationStep {
  command: string;
  passed: boolean;
  notes: string;
}

/** Output of the post-implementation verification node — what shell commands
 *  the agent ran (typecheck/test/build), which files it fixed mid-loop, and
 *  whether the change ended up in a clean state. */
export interface VerificationOutput {
  summary: string;
  steps: VerificationStep[];
  files_written: string[];
  unresolved: string[];
  clean: boolean;
}

export type FileVerificationOutcome =
  | "ok"
  | "missing"
  | "empty"
  | "unchanged"
  | "still_present"
  | "read_error";

export interface FileVerification {
  path: string;
  expected_action: "create" | "modify" | "delete";
  outcome: FileVerificationOutcome;
  detail?: string;
}

/** Payload of the `replan` checkpoint interrupt. Surfaces the prior plan and
 *  per-file post-write verification failures that drove us back here. */
export interface ReplanCheckpointPayload {
  reason: "verification_failed" | "user_requested";
  verification_failures: FileVerification[];
  prior_plan: ImplementationPlan | null;
  previously_written_files: string[];
  revisions_used: number;
  revisions_remaining: number;
}

export async function execInWorktree(
  command: string,
  timeoutSecs?: number,
): Promise<[number, string]> {
  return invoke<[number, string]>("exec_in_worktree", {
    command,
    timeoutSecs,
  });
}

// ── Repo / worktree types & commands ─────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch: string;
  headCommit: string;
  headMessage: string;
}

/** Validate the configured worktree path is a valid git repository. */
export async function validateWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_worktree");
}

/** Validate the configured `repo_source_path` (auto-managed mode) — the
 *  user's working repository that the four workflow worktrees branch
 *  off. Returns the same metadata shape as the per-workflow validators. */
export async function validateSourceRepo(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_source_repo");
}

export interface BaseBranchInfo {
  branch: string;
  /** Path the branch was looked up against — source repo (auto mode)
   *  or implementation worktree (manual mode). */
  checkedAgainst: string;
  localExists: boolean;
  /** True when `origin/<branch>` resolves. The expected happy-path. */
  remoteExists: boolean;
  headCommit: string;
}

/** Validate that the configured base branch resolves in the appropriate
 *  source repo for the active worktree mode. Catches typos before any
 *  workflow tries to branch off a non-existent ref. */
export async function validateBaseBranch(): Promise<BaseBranchInfo> {
  return invoke<BaseBranchInfo>("validate_base_branch");
}

/**
 * Fetch from origin and hard-reset the worktree to the configured base branch.
 * Returns the new HEAD info.
 */
export async function syncWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("sync_worktree");
}

/** Find files matching a glob pattern (relative to the worktree root). */
export async function globRepoFiles(pattern: string): Promise<string[]> {
  return invoke<string[]>("glob_repo_files", { pattern });
}

/**
 * Search file contents with an extended regex.
 * @param path Optional subdirectory to restrict the search to.
 */
export async function grepRepoFiles(
  pattern: string,
  path?: string,
): Promise<string[]> {
  return invoke<string[]>("grep_repo_files", { pattern, path: path ?? null });
}

/** Read a single file from the worktree (path relative to root). */
export async function readRepoFile(path: string): Promise<string> {
  return invoke<string>("read_repo_file", { path });
}

/** Validate the grooming worktree (falls back to main worktree). */
export async function validateGroomingWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_grooming_worktree");
}

/** Pull latest from origin/<base_branch> in the grooming worktree. */
export async function syncGroomingWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("sync_grooming_worktree");
}

/** Glob files in the grooming worktree (falls back to main worktree). */
export async function globGroomingFiles(pattern: string): Promise<string[]> {
  return invoke<string[]>("glob_grooming_files", { pattern });
}

/** Grep files in the grooming worktree (falls back to main worktree). */
export async function grepGroomingFiles(
  pattern: string,
  path?: string,
): Promise<string[]> {
  return invoke<string[]>("grep_grooming_files", { pattern, path: path ?? null });
}

/** Read a file from the grooming worktree (falls back to main worktree). */
export async function readGroomingFile(path: string): Promise<string> {
  return invoke<string>("read_grooming_file", { path });
}

/** Get the git diff of the worktree against the configured base branch. */
export async function getRepoDiff(): Promise<string> {
  return invoke<string>("get_repo_diff");
}

/** Read a file's content at the merge-base with origin/<base>. Empty string for new files. */
export async function getFileAtBase(path: string): Promise<string> {
  return invoke<string>("get_file_at_base", { path });
}

/** Get recent commits in the worktree. */
export async function getRepoLog(maxCommits: number): Promise<string> {
  return invoke<string>("get_repo_log", { maxCommits });
}

/** Get the git log for a specific file (to understand history). */
export async function getFileHistory(
  path: string,
  maxCommits: number,
): Promise<string> {
  return invoke<string>("get_file_history", { path, maxCommits });
}

/**
 * Check out a branch in the configured worktree (fetch + checkout/reset).
 * Used by the PR Review Assistant before analysis.
 */
export async function checkoutWorktreeBranch(
  branch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("checkout_worktree_branch", { branch });
}

/**
 * Validate the PR review worktree path (falls back to the main worktree if no
 * dedicated PR review path is configured).
 */
export async function validatePrReviewWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_pr_review_worktree");
}

/**
 * Check out a branch in the PR review worktree (fetch + checkout/reset).
 * Uses `pr_review_worktree_path` if set, otherwise falls back to `repo_worktree_path`.
 */
export async function checkoutPrReviewBranch(
  branch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("checkout_pr_review_branch", { branch });
}

/**
 * Open a new macOS Terminal window in the PR review worktree directory and
 * run the supplied shell command. The window stays open so the user can
 * interact with the running process.
 */
export async function runInTerminal(command: string): Promise<void> {
  return invoke<void>("run_in_terminal", { command });
}

// ── PR Address worktree commands ──────────────────────────────────────────────

/**
 * Validate the PR address worktree path.
 * Falls back to pr_review_worktree_path → repo_worktree_path.
 */
export async function validatePrAddressWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_pr_address_worktree");
}

/**
 * Check out a branch in the PR address worktree (fetch + checkout/reset).
 */
export async function checkoutPrAddressBranch(
  branch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("checkout_pr_address_branch", { branch });
}

/** Read a file from the PR address worktree (relative path). */
export async function readPrAddressFile(path: string): Promise<string> {
  return invoke<string>("read_pr_address_file", { path });
}

/**
 * Write a file in the PR address worktree (relative path).
 * Sandboxed to the worktree root.
 */
export async function writePrAddressFile(
  path: string,
  content: string,
): Promise<void> {
  return invoke<void>("write_pr_address_file", { path, content });
}

/** Get the current diff of the PR address worktree (staged + unstaged vs HEAD). */
export async function getPrAddressDiff(): Promise<string> {
  return invoke<string>("get_pr_address_diff");
}

/** Stage all changes and commit in the PR address worktree. Returns the new short SHA. */
export async function commitPrAddressChanges(message: string): Promise<string> {
  return invoke<string>("commit_pr_address_changes", { message });
}

/** Push the current branch of the PR address worktree to origin. */
export async function pushPrAddressBranch(): Promise<void> {
  return invoke<void>("push_pr_address_branch");
}

// ── Implementation pipeline — branch / commit / push / squash ─────────────────

/**
 * Create a feature branch in the implementation worktree for a JIRA ticket.
 * Name: `feature/<issueKey>-<slug-of-summary>`. Branch is checked out off
 * `origin/<base_branch>`. If the branch already exists it is checked out.
 */
export async function createFeatureBranch(
  issueKey: string,
  summary: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("create_feature_branch", { issueKey, summary });
}

/**
 * Stage and commit all current changes in the implementation worktree.
 * Returns the new HEAD short sha, or `null` if there was nothing to commit.
 */
export async function commitWorktreeChanges(
  message: string,
): Promise<string | null> {
  return invoke<string | null>("commit_worktree_changes", { message });
}

/**
 * Squash all commits on the current feature branch since the merge-base with
 * the base branch into a single commit with the given message.
 */
export async function squashWorktreeCommits(message: string): Promise<string> {
  return invoke<string>("squash_worktree_commits", { message });
}

/**
 * Push the current feature branch of the implementation worktree to origin
 * with `--set-upstream`. Returns the branch name that was pushed.
 */
export async function pushWorktreeBranch(): Promise<string> {
  return invoke<string>("push_worktree_branch");
}

/**
 * Create a pull request on Bitbucket. Bitbucket Cloud has no draft API, so
 * Meridian mimics it by creating the PR with no reviewers — nobody gets
 * notified until reviewers are added from the Bitbucket UI.
 */
export async function createPullRequest(
  title: string,
  description: string,
  sourceBranch: string,
  destinationBranch: string,
): Promise<BitbucketPr> {
  return invoke<BitbucketPr>("create_pull_request", {
    title,
    description,
    sourceBranch,
    destinationBranch,
  });
}
