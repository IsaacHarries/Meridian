import { type BitbucketComment, type BitbucketPr, type BitbucketTask } from "@/lib/tauri/bitbucket";
import { type JiraIssue } from "@/lib/tauri/jira";
import { type ReviewReport } from "@/lib/tauri/pr-review";
import { type TriageMessage } from "@/lib/tauri/workflows";

// ── Per-PR cached session ─────────────────────────────────────────────────────

export interface PrSession {
  diff: string;
  /** The `updatedOn` timestamp of the PR at the time the diff was last fetched. */
  diffUpdatedOn: string | null;
  /** True when the PR has been updated since the diff was fetched. */
  diffStale: boolean;
  comments: BitbucketComment[];
  /** comment_count from the PR at the time comments were last fetched — used for new-comment detection. */
  commentCountAtFetch: number;
  /** ISO timestamp when comments were last fetched — shown in the UI. */
  commentsLastFetchedAt: string | null;
  /** True when new comments have arrived since commentsLastFetchedAt. */
  hasNewComments: boolean;
  linkedIssue: JiraIssue | null;
  loadingDetails: boolean;
  /** True while a background staleness check + diff/comment refresh is in progress. */
  checkingForUpdates: boolean;
  report: ReviewReport | null;
  /** Partially-parsed report streamed from the sidecar synthesis nodes —
   *  populated while `reviewing`, cleared when the final `report` is set. */
  partialReport: Partial<ReviewReport> | null;
  rawError: string | null;
  reviewing: boolean;
  reviewProgress: string;
  reviewStreamText: string;
  worktreeBranch: string | null;
  checkoutStatus: "idle" | "checking-out" | "ready" | "error";
  checkoutError: string;
  submitAction: "approve" | "needs_work" | null;
  submitStatus: "idle" | "submitting" | "done" | "error";
  submitError: string;
  reviewChat: TriageMessage[];
  /** Streaming text accumulating from the current chat reply (cleared when reply is committed). */
  reviewChatStreamText: string;
  /** IDs of comments posted by the current user in this session (to allow task creation). */
  myPostedCommentIds: number[];
  /** Posting state for individual comments (keyed by a draft key). */
  postingComment: boolean;
  postCommentError: string;
  /** Tasks on this PR, keyed by task id. */
  tasks: BitbucketTask[];
}

// ── Store state shape ──────────────────────────────────────────────────────────

export interface PrReviewState {
  // ── PR list (cached between visits) ─────────────────────────────────────────
  prsForReview: BitbucketPr[];
  allOpenPrs: BitbucketPr[];
  loadingPrs: boolean;
  jiraBaseUrl: string;
  myAccountId: string;
  prListLoaded: boolean;
  /**
   * Cache of linked JIRA issues keyed by issue key. Populated lazily after
   * `loadPrLists` so the PR list can show ticket priority without blocking
   * the initial render. Only the priority is currently rendered, but the full
   * issue is cached in case other fields are needed later.
   */
  linkedIssuesByKey: Map<string, JiraIssue>;

  // ── Per-PR session cache (keyed by PR id) ────────────────────────────────────
  sessions: Map<number, PrSession>;

  // ── Currently selected PR ────────────────────────────────────────────────────
  selectedPr: BitbucketPr | null;

  // ── True when a PR is open in the review view ────────────────────────────────
  isSessionActive: boolean;

  // ── Actions ──────────────────────────────────────────────────────────────────
  /** Directly write top-level state — used by event listeners outside React tree */
  _set: (partial: Partial<PrReviewState>) => void;
  /** Patch the session for a specific PR id */
  _patchSession: (prId: number, patch: Partial<PrSession>) => void;

  loadPrLists: (jiraAvailable: boolean, bitbucketAvailable: boolean, forceSpinner?: boolean) => Promise<void>;
  selectPr: (pr: BitbucketPr, jiraAvailable: boolean) => Promise<void>;
  clearSelection: () => void;
  runReview: () => Promise<void>;
  cancelReview: () => void;
  submitReview: (action: "approve" | "needs_work") => Promise<void>;
  sendReviewChatMessage: (input: string) => Promise<string>;
  /** Wipe the review chat history for the currently-selected PR. */
  clearReviewChat: () => void;
  /** Drop just the last assistant turn — used by /retry. */
  dropLastReviewAssistantTurn: () => void;
  /** Post a general or inline comment. Returns the posted comment or throws. */
  postComment: (
    content: string,
    inlinePath?: string,
    inlineToLine?: number,
    parentId?: number,
  ) => Promise<BitbucketComment>;
  /** Create a task linked to one of the user's own comments. */
  createTask: (commentId: number, content: string) => Promise<BitbucketTask>;
  /** Toggle resolved state of a task. */
  resolveTask: (taskId: number, resolved: boolean) => Promise<void>;
  /** Update the text content of a task. */
  updateTask: (taskId: number, content: string) => Promise<void>;
  /** Delete a comment the current user authored. Removes it from local state on success. */
  deleteComment: (commentId: number) => Promise<void>;
  /** Edit the content of a comment the current user authored. */
  editComment: (commentId: number, newContent: string) => Promise<void>;
  /** Re-fetch comments and clear the hasNewComments flag. */
  refreshComments: () => Promise<void>;
}
