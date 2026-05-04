/**
 * Constants and initial-state factories for the PR Review store.
 */

import type { PrSession } from "./types";

// ── Persistence key ────────────────────────────────────────────────────────────

export const PR_REVIEW_STORE_KEY = "meridian-pr-review-store";

// ── Empty session factory ──────────────────────────────────────────────────────

export function emptySession(): PrSession {
  return {
    diff: "",
    diffUpdatedOn: null,
    diffStale: false,
    comments: [],
    commentCountAtFetch: 0,
    commentsLastFetchedAt: null,
    hasNewComments: false,
    linkedIssue: null,
    loadingDetails: false,
    checkingForUpdates: false,
    report: null,
    partialReport: null,
    rawError: null,
    reviewing: false,
    reviewProgress: "",
    reviewStreamText: "",
    worktreeBranch: null,
    checkoutStatus: "idle",
    checkoutError: "",
    submitAction: null,
    submitStatus: "idle",
    submitError: "",
    reviewChat: [],
    reviewChatStreamText: "",
    myPostedCommentIds: [],
    postingComment: false,
    postCommentError: "",
    tasks: [],
  };
}
