import { invoke } from "@tauri-apps/api/core";
import { isMockMode } from "./core";

// ── Bitbucket types ───────────────────────────────────────────────────────────

export interface BitbucketUser {
  displayName: string;
  nickname: string;
  accountId: string | null;
}

export interface BitbucketReviewer {
  user: BitbucketUser;
  approved: boolean;
  state: string;
}

export interface BitbucketPr {
  id: number;
  title: string;
  description: string | null;
  state: string;
  author: BitbucketUser;
  reviewers: BitbucketReviewer[];
  sourceBranch: string;
  destinationBranch: string;
  createdOn: string;
  updatedOn: string;
  commentCount: number;
  taskCount: number;
  url: string;
  jiraIssueKey: string | null;
  changesRequested: boolean;
  draft: boolean;
}

export interface BitbucketTask {
  id: number;
  content: string;
  resolved: boolean;
  commentId: number | null;
}

export interface BitbucketInlineContext {
  path: string;
  fromLine: number | null;
  toLine: number | null;
}

export interface BitbucketComment {
  id: number;
  content: string;
  author: BitbucketUser;
  createdOn: string;
  updatedOn: string;
  inline: BitbucketInlineContext | null;
  parentId: number | null;
}

// ── Bitbucket commands ────────────────────────────────────────────────────────

export async function getOpenPrs(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("../mockData/prs");
    return OPEN_PRS;
  }
  return invoke<BitbucketPr[]>("get_open_prs");
}

/** Open PRs authored by the configured Bitbucket user (for the Address PR Comments workflow). */
export async function getMyOpenPrs(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("../mockData/prs");
    return OPEN_PRS;
  }
  return invoke<BitbucketPr[]>("get_my_open_prs");
}

export async function getMergedPrs(sinceIso?: string): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { MERGED_PRS } = await import("../mockData/prs");
    if (sinceIso) {
      const since = new Date(sinceIso).getTime();
      return MERGED_PRS.filter(
        (pr) => new Date(pr.updatedOn).getTime() >= since,
      );
    }
    return MERGED_PRS;
  }
  return invoke<BitbucketPr[]>("get_merged_prs", {
    sinceIso: sinceIso ?? null,
  });
}

export async function getPrsForReview(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("../mockData/prs");
    // PRs where the current user (user-1) is a reviewer and hasn't approved yet
    return OPEN_PRS.filter((pr) =>
      pr.reviewers.some((r) => r.user.nickname === "isaac.chen" && !r.approved),
    );
  }
  return invoke<BitbucketPr[]>("get_prs_for_review");
}

export async function getPr(prId: number): Promise<BitbucketPr> {
  if (isMockMode()) {
    const { OPEN_PRS, MERGED_PRS } = await import("../mockData/prs");
    const pr = [...OPEN_PRS, ...MERGED_PRS].find((p) => p.id === prId);
    if (!pr) throw new Error(`Mock: PR #${prId} not found`);
    return pr;
  }
  return invoke<BitbucketPr>("get_pr", { prId });
}

export async function getPrDiff(prId: number): Promise<string> {
  if (isMockMode()) {
    const { PR_87_DIFF } = await import("../mockData/prs");
    // Return a realistic diff for PR 87; stub for others
    if (prId === 87) return PR_87_DIFF;
    return `diff --git a/src/example.rs b/src/example.rs\nindex 0000000..1234567\n--- a/src/example.rs\n+++ b/src/example.rs\n@@ -1,3 +1,5 @@\n fn main() {\n-    println!("hello");\n+    println!("hello, world");\n+    // PR ${prId} mock diff\n }\n`;
  }
  return invoke<string>("get_pr_diff", { prId });
}

/**
 * Full contents of a file at the PR's source commit — used by the diff viewer
 * to lazy-load surrounding context around the changed hunks.
 */
export async function getPrFileContent(prId: number, path: string): Promise<string> {
  if (isMockMode()) {
    // Return a simple stub so the UI can exercise expansion in mock mode.
    const lines: string[] = [];
    for (let i = 1; i <= 120; i++) lines.push(`// ${path} line ${i} (mock, PR ${prId})`);
    return lines.join("\n");
  }
  return invoke<string>("get_pr_file_content", { prId, path });
}

export async function getPrComments(prId: number): Promise<BitbucketComment[]> {
  if (isMockMode()) {
    const { PR_87_COMMENTS } = await import("../mockData/comments");
    return prId === 87 ? PR_87_COMMENTS : [];
  }
  return invoke<BitbucketComment[]>("get_pr_comments", { prId });
}

export async function getPrTasks(prId: number): Promise<BitbucketTask[]> {
  if (isMockMode()) {
    const { PR_TASKS_BY_ID } = await import("../mockData/tasks");
    return PR_TASKS_BY_ID[prId] ?? [];
  }
  return invoke<BitbucketTask[]>("get_pr_tasks", { prId });
}

/** Approve a PR as the authenticated user. Requires pullrequest:write scope. */
export async function approvePr(prId: number): Promise<void> {
  return invoke<void>("approve_pr", { prId });
}

/** Remove your approval from a PR. */
export async function unapprovePr(prId: number): Promise<void> {
  return invoke<void>("unapprove_pr", { prId });
}

/** Mark a PR as 'Needs work' (request changes). */
export async function requestChangesPr(prId: number): Promise<void> {
  return invoke<void>("request_changes_pr", { prId });
}

/** Remove your 'Needs work' status from a PR. */
export async function unrequestChangesPr(prId: number): Promise<void> {
  return invoke<void>("unrequest_changes_pr", { prId });
}

/**
 * Post a comment on a PR.
 * - General comment: omit `inlinePath` / `inlineToLine`.
 * - Inline comment: provide `inlinePath` (file path in the diff) and `inlineToLine` (new-side line number).
 * - Reply: provide `parentId` (the comment id to reply to).
 */
export async function postPrComment(
  prId: number,
  content: string,
  inlinePath?: string,
  inlineToLine?: number,
  parentId?: number,
): Promise<BitbucketComment> {
  return invoke<BitbucketComment>("post_pr_comment", {
    prId,
    content,
    inlinePath: inlinePath ?? null,
    inlineToLine: inlineToLine ?? null,
    parentId: parentId ?? null,
  });
}

/** Create a task linked to a specific comment on a PR. */
export async function createPrTask(
  prId: number,
  commentId: number,
  content: string,
): Promise<BitbucketTask> {
  return invoke<BitbucketTask>("create_pr_task", { prId, commentId, content });
}

export async function resolvePrTask(
  prId: number,
  taskId: number,
  resolved: boolean,
): Promise<BitbucketTask> {
  return invoke<BitbucketTask>("resolve_pr_task", { prId, taskId, resolved });
}

/** Update the text of a task on a PR. */
export async function updatePrTask(
  prId: number,
  taskId: number,
  content: string,
): Promise<BitbucketTask> {
  return invoke<BitbucketTask>("update_pr_task", { prId, taskId, content });
}

export async function deletePrComment(
  prId: number,
  commentId: number,
): Promise<void> {
  return invoke<void>("delete_pr_comment", { prId, commentId });
}

export async function updatePrComment(
  prId: number,
  commentId: number,
  content: string,
): Promise<BitbucketComment> {
  return invoke<BitbucketComment>("update_pr_comment", {
    prId,
    commentId,
    newContent: content,
  });
}
