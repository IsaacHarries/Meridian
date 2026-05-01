/**
 * Zustand store for the PR Review Assistant.
 *
 * All review session state lives here so that navigating away and back
 * restores the PR list, selected PR, diff, and review report. Per-PR
 * caches (report, diff, chat, submission state) are stored in Maps keyed
 * by PR id so multiple PRs can have independent cached reviews simultaneously.
 */

import { create } from "zustand";
import {
  type BitbucketPr,
  type BitbucketComment,
  type BitbucketTask,
  type JiraIssue,
  type TriageMessage,
  type ReviewReport,
  getOpenPrs,
  getPrsForReview,
  getPr,
  getPrDiff,
  getPrComments,
  getPrTasks,
  getIssue,
  getNonSecretConfig,
  runPrReviewWorkflow,
  chatPrReview,
  checkoutPrReviewBranch,
  readRepoFile,
  approvePr,
  unapprovePr,
  requestChangesPr,
  unrequestChangesPr,
  postPrComment,
  createPrTask,
  resolvePrTask,
  updatePrTask,
  deletePrComment,
  updatePrComment,
  cancelReview,
  isMockMode,
} from "@/lib/tauri";
import { listen } from "@tauri-apps/api/event";

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

function emptySession(): PrSession {
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

// ── Store state shape ──────────────────────────────────────────────────────────

interface PrReviewState {
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

// ── Persistence key ────────────────────────────────────────────────────────────

export const PR_REVIEW_STORE_KEY = "meridian-pr-review-store";

// ── Store ──────────────────────────────────────────────────────────────────────

export const usePrReviewStore = create<PrReviewState>()(
  (set, get) => {
  function patchSession(prId: number, patch: Partial<PrSession>) {
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(prId, { ...(sessions.get(prId) ?? emptySession()), ...patch });
      return { sessions };
    });
  }

  return {
    // ── Initial state ─────────────────────────────────────────────────────────
    prsForReview: [],
    allOpenPrs: [],
    loadingPrs: true,
    jiraBaseUrl: "",
    myAccountId: "",
    prListLoaded: false,
    linkedIssuesByKey: new Map(),
    sessions: new Map(),
    selectedPr: null,
    isSessionActive: false,

    _set: (partial) => set(partial as Partial<PrReviewState>),
    _patchSession: patchSession,

    // ── Load PR lists ─────────────────────────────────────────────────────────
    loadPrLists: async (_jiraAvailable, bitbucketAvailable, forceSpinner = false) => {
      // Load config regardless (jiraBaseUrl etc.)
      try {
        const cfg = await getNonSecretConfig();
        set({ jiraBaseUrl: cfg["jira_base_url"] ?? "", myAccountId: cfg["jira_account_id"] ?? "" });
      } catch { /* ignore */ }

      if (!bitbucketAvailable) {
        set({ loadingPrs: false, prListLoaded: true });
        return;
      }

      // By default only show the loading spinner on the very first load; subsequent
      // panel re-mounts refresh silently so the cached list stays visible. Explicit
      // user-initiated refreshes set forceSpinner so the refresh button can animate.
      const isFirstLoad = !get().prListLoaded;
      if (isFirstLoad || forceSpinner) set({ loadingPrs: true });

      const [forReview, allOpen] = await Promise.allSettled([getPrsForReview(), getOpenPrs()]);
      const newForReview =
        forReview.status === "fulfilled" ? forReview.value.filter((pr) => !pr.draft) : get().prsForReview;
      const newAllOpen =
        allOpen.status === "fulfilled" ? allOpen.value.filter((pr) => !pr.draft) : get().allOpenPrs;
      set({
        prsForReview: newForReview,
        allOpenPrs: newAllOpen,
        loadingPrs: false,
        prListLoaded: true,
      });

      // Lazy: enrich the PR list with linked JIRA issues so we can show priority
      // and sort by it. Skip keys we already have cached. Best-effort — failures
      // just leave the priority blank for that PR.
      if (_jiraAvailable) {
        const cached = get().linkedIssuesByKey;
        const keys = new Set<string>();
        for (const pr of [...newForReview, ...newAllOpen]) {
          if (pr.jiraIssueKey && !cached.has(pr.jiraIssueKey)) {
            keys.add(pr.jiraIssueKey);
          }
        }
        if (keys.size > 0) {
          Promise.allSettled(
            [...keys].map((k) => getIssue(k).then((issue) => [k, issue] as const)),
          ).then((results) => {
            const next = new Map(get().linkedIssuesByKey);
            for (const r of results) {
              if (r.status === "fulfilled") {
                const [k, issue] = r.value;
                next.set(k, issue);
              }
            }
            set({ linkedIssuesByKey: next });
          });
        }
      }
    },

    // ── Select a PR ───────────────────────────────────────────────────────────
    selectPr: async (pr, jiraAvailable) => {
      const existing = get().sessions.get(pr.id);

      set({ selectedPr: pr, isSessionActive: true });

      // ── Re-opening a cached session ───────────────────────────────────────
      // We already have a diff. Don't re-fetch everything, but do a lightweight
      // staleness check: fetch the PR's current metadata and compare updatedOn.
      if (existing && existing.diff) {
        // Only check if not already stale (avoids redundant re-checks) and not
        // currently in the middle of a review run.
        if (!existing.diffStale && !existing.reviewing && !existing.checkingForUpdates) {
          patchSession(pr.id, { checkingForUpdates: true });
          try {
            const latest = await getPr(pr.id);
            const cachedTimestamp = existing.diffUpdatedOn;
            const hasNewCommits =
              cachedTimestamp !== null && latest.updatedOn > cachedTimestamp;
            const hasNewComments =
              latest.commentCount > (existing.commentCountAtFetch ?? 0);

            if (hasNewCommits || hasNewComments) {
              const now = new Date().toISOString();
              const [newDiff, newComments, newTasks] = await Promise.all([
                hasNewCommits ? getPrDiff(pr.id).catch(() => existing.diff) : Promise.resolve(existing.diff),
                hasNewComments ? getPrComments(pr.id).catch(() => existing.comments) : Promise.resolve(existing.comments),
                getPrTasks(pr.id).catch(() => existing.tasks ?? []),
              ]);
              patchSession(pr.id, {
                ...(hasNewCommits ? { diff: newDiff, diffUpdatedOn: latest.updatedOn, diffStale: true } : {}),
                ...(hasNewComments ? {
                  comments: newComments,
                  commentCountAtFetch: latest.commentCount,
                  commentsLastFetchedAt: now,
                  hasNewComments: true,
                } : {}),
                tasks: newTasks,
                checkingForUpdates: false,
              });
              // Update the PR object in the list so comment count etc. are fresh
              set((s) => ({
                prsForReview: s.prsForReview.map((p) => p.id === pr.id ? latest : p),
                allOpenPrs:   s.allOpenPrs.map((p)   => p.id === pr.id ? latest : p),
                selectedPr:   s.selectedPr?.id === pr.id ? latest : s.selectedPr,
              }));
            } else {
              // Always refresh tasks even when nothing else changed — tasks have no
              // count on the PR object so we can't detect them via the staleness check
              const newTasks = await getPrTasks(pr.id).catch(() => existing.tasks ?? []);
              patchSession(pr.id, { tasks: newTasks, checkingForUpdates: false });
            }
          } catch {
            patchSession(pr.id, { checkingForUpdates: false });
          }
        }
        return;
      }

      // ── First open — fetch everything fresh ───────────────────────────
      patchSession(pr.id, { ...emptySession(), loadingDetails: true });

      const now = new Date().toISOString();
      const fetches: Promise<void>[] = [
        getPrDiff(pr.id)
          .then((d) => patchSession(pr.id, { diff: d, diffUpdatedOn: pr.updatedOn }))
          .catch(() => {}),
        getPrComments(pr.id)
          .then((c) => patchSession(pr.id, {
            comments: c,
            commentCountAtFetch: pr.commentCount,
            commentsLastFetchedAt: now,
          }))
          .catch(() => {}),
        getPrTasks(pr.id)
          .then((t) => patchSession(pr.id, { tasks: t }))
          .catch(() => {}),
      ];

      if (pr.jiraIssueKey && jiraAvailable) {
        const key = pr.jiraIssueKey;
        fetches.push(
          getIssue(key)
            .then((issue) => {
              patchSession(pr.id, { linkedIssue: issue });
              const next = new Map(get().linkedIssuesByKey);
              next.set(key, issue);
              set({ linkedIssuesByKey: next });
            })
            .catch(() => {})
        );
      }

      await Promise.allSettled(fetches);
      patchSession(pr.id, { loadingDetails: false });

      // Branch checkout is intentionally omitted here.
      // It is performed at the start of runReview() so the user controls when it happens.
    },

    // ── Clear selection (go back to PR list) ──────────────────────────────────
    // Sessions are intentionally kept — all per-PR data (including reports) survives.
    clearSelection: () => set({ selectedPr: null, isSessionActive: false }),

    cancelReview: () => {
      const { selectedPr } = get();
      // Fire-and-forget — signal the Rust backend to stop between chunks
      cancelReview().catch(() => {});
      if (selectedPr) {
        patchSession(selectedPr.id, { reviewing: false, reviewProgress: "Review cancelled." });
      }
    },

    // ── Run AI review ─────────────────────────────────────────────────────────
    runReview: async () => {
      const { selectedPr, sessions } = get();
      if (!selectedPr) return;
      const session = sessions.get(selectedPr.id) ?? emptySession();
      const { linkedIssue } = session;

      patchSession(selectedPr.id, {
        reviewing: true, report: null, partialReport: null, rawError: null,
        reviewStreamText: "", reviewProgress: "Fetching latest diff…", reviewChat: [],
        diffStale: false,  // user has acknowledged any staleness by running a fresh review
      });

      // Always fetch a fresh diff from Bitbucket before running the review so the
      // AI always sees the current state of the PR, not a cached copy.
      let diff = session.diff;
      try {
        const freshDiff = await getPrDiff(selectedPr.id);
        diff = freshDiff;
        patchSession(selectedPr.id, {
          diff: freshDiff,
          diffUpdatedOn: selectedPr.updatedOn,
        });
      } catch {
        // Non-fatal — fall back to the cached diff if the fetch fails
      }

      try {
        // ── Step 1: checkout the branch (always, on every review run) ──────────
        // Checkout is REQUIRED before review — the AI must not analyse code until
        // the correct branch is checked out in the worktree. If checkout fails the
        // review is aborted immediately so the AI never sees stale/wrong code.
        //
        // Exception: if the branch is already checked out (checkoutStatus === "ready"
        // and worktreeBranch matches), skip the checkout to avoid an unnecessary stash
        // + reset cycle. The user can press "Pull branch" manually if they want to
        // refresh to the latest remote commits.
        //
        // Mock mode: skip the checkout entirely. The mocked PR refers to a repo
        // that doesn't exist locally, so `git fetch origin <branch>` would fail
        // with "'origin' does not appear to be a git repository". The mock diff
        // is enough for the AI to review.
        if (!selectedPr.sourceBranch) {
          throw new Error("PR has no source branch — cannot check out worktree.");
        }

        let worktreeBranch: string = selectedPr.sourceBranch;
        if (!isMockMode()) {
          const session = get().sessions.get(selectedPr.id);
          const alreadyCheckedOut =
            session?.checkoutStatus === "ready" &&
            session?.worktreeBranch === selectedPr.sourceBranch;

          if (alreadyCheckedOut) {
            worktreeBranch = session!.worktreeBranch!;
            patchSession(selectedPr.id, {
              reviewProgress: `Branch ${worktreeBranch} already checked out — skipping checkout…`,
            });
          } else {
            patchSession(selectedPr.id, {
              checkoutStatus: "checking-out",
              reviewProgress: `Checking out branch ${selectedPr.sourceBranch}…`,
            });

            try {
              const info = await checkoutPrReviewBranch(selectedPr.sourceBranch);
              worktreeBranch = info.branch;
              patchSession(selectedPr.id, {
                worktreeBranch: info.branch,
                checkoutStatus: "ready",
                diffUpdatedOn: selectedPr.updatedOn, // record timestamp at review time
              });
            } catch (e) {
              patchSession(selectedPr.id, { checkoutStatus: "error", checkoutError: String(e) });
              // Re-throw so the outer catch aborts the review with a visible error
              throw new Error(`Branch checkout failed — cannot review until the worktree is on the correct branch.\n\n${String(e)}`);
            }
          }
        }

        // ── Step 2: build review text enriched with full file contents ────────
        // Checkout succeeded — the worktree is now on the correct branch.
        let fullReviewText = buildReviewText(selectedPr, diff, linkedIssue);

        // ── Step 3: enrich with full file contents from the checked-out branch ──
        // Skipped in mock mode — there is no real worktree to read from.
        if (!isMockMode()) {
          patchSession(selectedPr.id, { reviewProgress: `Reading changed files from branch ${worktreeBranch}…` });
          try {
            const changedFiles = diff
              .split("\n")
              .filter((l) => l.startsWith("diff --git"))
              .map((l) => { const m = l.match(/b\/(.+)$/); return m ? m[1] : null; })
              .filter(Boolean) as string[];

            const MAX_FILE_BYTES = 30 * 1024;
            const parts: string[] = [];
            let total = 0;

            for (const f of changedFiles.slice(0, 8)) {
              try {
                const content = await readRepoFile(f);
                const chunk = `--- ${f} ---\n${content}\n`;
                if (total + chunk.length > MAX_FILE_BYTES) break;
                parts.push(chunk);
                total += chunk.length;
              } catch { /* skip individual unreadable files */ }
            }

            if (parts.length > 0) {
              fullReviewText +=
                `\n\n=== FULL FILE CONTENTS FROM BRANCH (for deeper context) ===\n` +
                `INSTRUCTION: Use these full file contents to VERIFY any finding about undefined types, ` +
                `missing definitions, duplicate fields, or compilation errors before reporting them. ` +
                `Definitions that are not visible in the diff alone (e.g. a new type added in the same ` +
                `file outside the changed hunk) WILL appear here. If the referenced identifier is ` +
                `present in these file contents, drop or downgrade the finding accordingly.\n` +
                parts.join("\n");
            }
          } catch { /* non-fatal — proceed with diff-only context */ }
        }

        // Subscribe to streaming partial-report events from the sidecar
        // synthesis. Throttle Zustand writes via a flush timer so a token-
        // heavy stream cannot flood React re-renders.
        const prId = selectedPr.id;
        let pendingPartial: Partial<ReviewReport> | null = null;
        let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const flushPartial = () => {
          partialFlushTimer = null;
          if (!pendingPartial) return;
          usePrReviewStore.getState()._patchSession(prId, {
            partialReport: pendingPartial,
          });
          pendingPartial = null;
        };
        const unlistenPartial = await listen<{
          kind?: string;
          node?: string;
          status?: "started" | "completed";
          data?: {
            partialReport?: Partial<ReviewReport>;
            done?: number;
            total?: number;
          };
        }>("pr-review-workflow-event", (event) => {
          if (event.payload.kind !== "progress") return;

          const partial = event.payload.data?.partialReport;
          if (partial && typeof partial === "object") {
            pendingPartial = partial;
            if (partialFlushTimer === null) {
              partialFlushTimer = setTimeout(flushPartial, 80);
            }
            return;
          }

          // Surface chunk-review progress so the UI doesn't sit on the
          // "Reading changed files…" message for the whole multi-chunk run.
          const { node, status, data } = event.payload;
          if (node === "chunk_review" && typeof data?.total === "number") {
            const done = typeof data.done === "number" ? data.done : 0;
            const total = data.total;
            const message = done >= total
              ? `Synthesising findings from ${total} chunk${total === 1 ? "" : "s"}…`
              : `Reviewing diff chunk ${Math.min(done + 1, total)}/${total}…`;
            usePrReviewStore.getState()._patchSession(prId, { reviewProgress: message });
          } else if (
            (node === "single_pass" || node === "synthesis") &&
            status === "started"
          ) {
            usePrReviewStore.getState()._patchSession(prId, {
              reviewProgress: "Synthesising review…",
            });
          }
        });

        try {
          const parsed = await runPrReviewWorkflow(fullReviewText);
          patchSession(selectedPr.id, { report: parsed, partialReport: null });
        } finally {
          if (partialFlushTimer !== null) clearTimeout(partialFlushTimer);
          unlistenPartial();
        }
      } catch (e) {
        const errMsg = String(e);
        // Don't show a red error panel for user-initiated cancellations
        if (!errMsg.toLowerCase().includes("cancelled by user")) {
          patchSession(selectedPr.id, { rawError: errMsg });
        }
      } finally {
        patchSession(selectedPr.id, { reviewing: false, reviewProgress: "" });
      }
    },

    // ── Submit to Bitbucket ───────────────────────────────────────────────────
    submitReview: async (action) => {
      const { selectedPr, sessions, myAccountId } = get();
      if (!selectedPr) return;
      const session = sessions.get(selectedPr.id) ?? emptySession();
      const { submitAction, submitStatus } = session;

      const isUndo = submitAction === action && submitStatus === "done";
      patchSession(selectedPr.id, { submitStatus: "submitting", submitError: "" });

      try {
        if (isUndo) {
          if (action === "approve") await unapprovePr(selectedPr.id);
          else await unrequestChangesPr(selectedPr.id);
          patchSession(selectedPr.id, { submitAction: null, submitStatus: "done" });
        } else {
          if (action === "approve") await approvePr(selectedPr.id);
          else await requestChangesPr(selectedPr.id);
          patchSession(selectedPr.id, { submitAction: action, submitStatus: "done" });
        }

        if (action === "approve") {
          const nowApproved = !isUndo;
          const patchPr = (pr: BitbucketPr): BitbucketPr => {
            if (pr.id !== selectedPr.id) return pr;
            return {
              ...pr,
              reviewers: pr.reviewers.map((r) =>
                r.user.accountId === myAccountId ? { ...r, approved: nowApproved } : r
              ),
            };
          };
          set((s) => ({
            prsForReview: s.prsForReview.map(patchPr),
            allOpenPrs: s.allOpenPrs.map(patchPr),
          }));
        }
      } catch (e) {
        patchSession(selectedPr.id, { submitStatus: "error", submitError: String(e) });
      }
    },

    // ── Post-review chat ──────────────────────────────────────────────────────
    sendReviewChatMessage: async (input) => {
      const { selectedPr, sessions } = get();
      if (!selectedPr) return "";
      const session = sessions.get(selectedPr.id) ?? emptySession();
      const { reviewChat, comments, report } = session;
      if (!report) return "";

      const userMsg: TriageMessage = { role: "user", content: input };
      const newHistory = [...reviewChat, userMsg];
      // Show user message immediately and clear any previous stream text
      patchSession(selectedPr.id, { reviewChat: newHistory, reviewChatStreamText: "" });

      const contextParts = [
        "=== PULL REQUEST ===",
        `PR #${selectedPr.id}: ${selectedPr.title}`,
        `Author: ${selectedPr.author.displayName}`,
        `Branch: ${selectedPr.sourceBranch} → ${selectedPr.destinationBranch}`,
        selectedPr.description ? `\nDescription:\n${selectedPr.description}` : "",
      ];

      const topLevel = comments.filter((c) => c.parentId == null && !c.inline);
      const inline = comments.filter((c) => c.inline);
      if (topLevel.length > 0) {
        contextParts.push("", "=== PR COMMENTS ===");
        for (const c of topLevel.slice(0, 30)) {
          const ago = c.createdOn ? new Date(c.createdOn).toLocaleDateString() : "";
          contextParts.push(`[${c.author.displayName}${ago ? ` · ${ago}` : ""}]: ${c.content}`);
        }
      }
      if (inline.length > 0) {
        contextParts.push("", "=== INLINE CODE COMMENTS ===");
        for (const c of inline.slice(0, 40)) {
          const loc = c.inline
            ? `${c.inline.path}${c.inline.toLine ? ` L${c.inline.toLine}` : ""}`
            : "";
          const ago = c.createdOn ? new Date(c.createdOn).toLocaleDateString() : "";
          contextParts.push(`[${c.author.displayName}${ago ? ` · ${ago}` : ""} on ${loc}]: ${c.content}`);
        }
      }

      contextParts.push("", "=== REVIEW REPORT ===", JSON.stringify(report, null, 2));
      const context = contextParts.join("\n");

      // Subscribe to the chat stream event. Accumulate deltas locally and
      // throttle Zustand writes to at most once per 80 ms so rapid token
      // delivery from a local model cannot flood the JS event loop.
      const prId = selectedPr.id;
      const chatAcc = { text: "" };
      let chatFlushTimer: ReturnType<typeof setTimeout> | null = null;

      const unlisten = await listen<{
        kind?: string;
        delta?: string;
      }>(
        "pr-review-chat-workflow-event",
        (event) => {
          if (event.payload.kind !== "stream" || !event.payload.delta) return;
          chatAcc.text += event.payload.delta;
          if (chatFlushTimer !== null) return;
          chatFlushTimer = setTimeout(() => {
            chatFlushTimer = null;
            usePrReviewStore.getState()._patchSession(prId, {
              reviewChatStreamText: chatAcc.text,
            });
          }, 80);
        }
      );

      try {
        const reply = await chatPrReview(context, JSON.stringify(newHistory));
        // Commit the final reply to the chat history and clear the stream text
        patchSession(prId, {
          reviewChat: [...newHistory, { role: "assistant", content: reply }],
          reviewChatStreamText: "",
        });
        return reply;
      } catch (e) {
        const errMsg = `Sorry, I couldn't respond: ${String(e)}`;
        patchSession(prId, {
          reviewChat: [...newHistory, { role: "assistant", content: errMsg }],
          reviewChatStreamText: "",
        });
        return errMsg;
      } finally {
        if (chatFlushTimer !== null) clearTimeout(chatFlushTimer);
        unlisten();
      }
    },

    clearReviewChat: () => {
      const { selectedPr } = get();
      if (!selectedPr) return;
      patchSession(selectedPr.id, { reviewChat: [], reviewChatStreamText: "" });
    },

    dropLastReviewAssistantTurn: () => {
      const { selectedPr, sessions } = get();
      if (!selectedPr) return;
      const session = sessions.get(selectedPr.id);
      if (!session) return;
      const chat = session.reviewChat;
      if (chat.length === 0 || chat[chat.length - 1].role !== "assistant") return;
      patchSession(selectedPr.id, { reviewChat: chat.slice(0, -1) });
    },

    // ── Post a comment ─────────────────────────────────────────────────────────
    postComment: async (content, inlinePath, inlineToLine, parentId) => {
      const { selectedPr } = get();
      if (!selectedPr) throw new Error("No PR selected");
      patchSession(selectedPr.id, { postingComment: true, postCommentError: "" });
      try {
        const comment = await postPrComment(selectedPr.id, content, inlinePath, inlineToLine, parentId);
        // Optimistically append the new comment and record its id
        set((s) => {
          const sessions = new Map(s.sessions);
          const cur = sessions.get(selectedPr.id) ?? emptySession();
          sessions.set(selectedPr.id, {
            ...cur,
            comments: [...cur.comments, comment],
            commentCountAtFetch: (cur.commentCountAtFetch ?? 0) + 1,
            myPostedCommentIds: [...(cur.myPostedCommentIds ?? []), comment.id],
            postingComment: false,
          });
          return { sessions };
        });
        return comment;
      } catch (e) {
        patchSession(selectedPr.id, { postingComment: false, postCommentError: String(e) });
        throw e;
      }
    },

    // ── Create a task on a comment ─────────────────────────────────────────────
    createTask: async (commentId, content) => {
      const { selectedPr } = get();
      if (!selectedPr) throw new Error("No PR selected");
      const task = await createPrTask(selectedPr.id, commentId, content);
      // Append the new task to the session
      set((s) => {
        const sessions = new Map(s.sessions);
        const cur = sessions.get(selectedPr.id) ?? emptySession();
        sessions.set(selectedPr.id, { ...cur, tasks: [...(cur.tasks ?? []), task] });
        return { sessions };
      });
      return task;
    },

    // ── Resolve / re-open a task ───────────────────────────────────────────────
    resolveTask: async (taskId, resolved) => {
      const { selectedPr } = get();
      if (!selectedPr) return;
      const updated = await resolvePrTask(selectedPr.id, taskId, resolved);
      set((s) => {
        const sessions = new Map(s.sessions);
        const cur = sessions.get(selectedPr.id) ?? emptySession();
        sessions.set(selectedPr.id, {
          ...cur,
          tasks: (cur.tasks ?? []).map((t) => t.id === taskId ? updated : t),
        });
        return { sessions };
      });
    },

    // ── Update a task's text content ──────────────────────────────────────────
    updateTask: async (taskId, content) => {
      const { selectedPr } = get();
      if (!selectedPr) return;
      const updated = await updatePrTask(selectedPr.id, taskId, content);
      set((s) => {
        const sessions = new Map(s.sessions);
        const cur = sessions.get(selectedPr.id) ?? emptySession();
        sessions.set(selectedPr.id, {
          ...cur,
          tasks: (cur.tasks ?? []).map((t) => t.id === taskId ? updated : t),
        });
        return { sessions };
      });
    },

    // ── Delete a comment ───────────────────────────────────────────────────────
    deleteComment: async (commentId) => {
      const { selectedPr } = get();
      if (!selectedPr) return;
      await deletePrComment(selectedPr.id, commentId);
      // Remove from local state optimistically
      set((s) => {
        const sessions = new Map(s.sessions);
        const cur = sessions.get(selectedPr.id) ?? emptySession();
        sessions.set(selectedPr.id, {
          ...cur,
          comments: cur.comments.filter((c) => c.id !== commentId && c.parentId !== commentId),
          commentCountAtFetch: Math.max(0, (cur.commentCountAtFetch ?? 1) - 1),
        });
        return { sessions };
      });
    },

    // ── Edit a comment ─────────────────────────────────────────────────────────
    editComment: async (commentId, newContent) => {
      const { selectedPr } = get();
      if (!selectedPr) return;
      const updated = await updatePrComment(selectedPr.id, commentId, newContent);
      set((s) => {
        const sessions = new Map(s.sessions);
        const cur = sessions.get(selectedPr.id) ?? emptySession();
        sessions.set(selectedPr.id, {
          ...cur,
          comments: cur.comments.map((c) => c.id === commentId ? updated : c),
        });
        return { sessions };
      });
    },

    // ── Refresh comments ───────────────────────────────────────────────────────
    refreshComments: async () => {      const { selectedPr } = get();
      if (!selectedPr) return;
      const now = new Date().toISOString();
      try {
        const comments = await getPrComments(selectedPr.id);
        patchSession(selectedPr.id, {
          comments,
          commentCountAtFetch: comments.length,
          commentsLastFetchedAt: now,
          hasNewComments: false,
        });
      } catch { /* non-fatal */ }
    },
  };
}
);

// ── File-backed persistence ────────────────────────────────────────────────────

import { loadCache, saveCache } from "@/lib/storeCache";

/**
 * Fields that are transient and must NOT be persisted across app restarts.
 */
function serializableState(s: PrReviewState) {
  return {
    ...s,
    loadingPrs: false,
    sessions: new Map(
      [...s.sessions.entries()].map(([id, session]) => [
        id,
        {
          ...session,
          loadingDetails: false,
          checkingForUpdates: false,
          reviewing: false,
          reviewProgress: "",
          reviewStreamText: "",
          reviewChatStreamText: "",
          partialReport: null,
          // Always reset checkout status on persist — the branch is re-checked-out
          // at the start of each review run, so a stale "error" or "ready" status
          // from a previous session should never be restored.
          checkoutStatus: "idle" as const,
          checkoutError: "",
          worktreeBranch: null,
        },
      ])
    ),
  };
}

/**
 * Hydrate the PR review store from the file cache.
 * Call this once on app startup.
 */
export async function hydratePrReviewStore(): Promise<void> {
  const cached = await loadCache<PrReviewState>(PR_REVIEW_STORE_KEY);
  if (!cached) return;
  const rawSessions =
    cached.sessions instanceof Map
      ? cached.sessions
      : new Map(Object.entries((cached.sessions ?? {}) as Record<string, PrSession>).map(([k, v]) => [Number(k), v]));

  // Merge every loaded session against emptySession() defaults so that fields
  // added in newer versions of the app are always present, even when loading a
  // cache file written by an older version that didn't have those fields.
  const sessions = new Map<number, PrSession>();
  for (const [id, session] of rawSessions) {
    sessions.set(id, {
      ...emptySession(),
      ...session,
      // Always clear transient fetch state on hydration
      checkingForUpdates: false,
      loadingDetails: false,
      // Always reset checkout status on hydration — the branch is re-checked-out
      // at the start of each review run, so a stale "error" or "ready" status
      // from a previous session should never be restored.
      checkoutStatus: "idle",
      checkoutError: "",
      worktreeBranch: null,
      // Always clear comments and tasks on hydration — they are re-fetched fresh
      // when the PR is opened, so stale cached data (e.g. missing author names)
      // never persists across app restarts.
      comments: [],
      tasks: [],
      partialReport: null,
      commentCountAtFetch: 0,
      commentsLastFetchedAt: null,
      hasNewComments: false,
    });
  }
  usePrReviewStore.setState({
    ...cached,
    sessions,
    // Always open at the PR list on app restart — per-PR session data (diff,
    // report, chat) is preserved in `sessions` so reopening a PR is instant,
    // but the user should consciously choose which PR to review each session.
    selectedPr: null,
    isSessionActive: false,
    // Reset transient flags
    loadingPrs: false,
  });
}

// Subscribe and save on every state change (debounced).
usePrReviewStore.subscribe((state) => {
  saveCache(PR_REVIEW_STORE_KEY, serializableState(state));
});

// ── Pure helper: build the review text sent to the AI ────────────────────────

const MAX_DIFF_CHARS = 120_000;

function isGeneratedFile(filePath: string): boolean {
  const GENERATED_NAMES = new Set(["generated", "_generated"]);
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts.some((part) => {
    const stem = part.includes(".") ? part.slice(0, part.lastIndexOf(".")) : part;
    return GENERATED_NAMES.has(stem.toLowerCase());
  });
}

/** Returns true if the file is a test/spec file that should be excluded from the Security lens. */
function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const filename = normalized.split("/").pop() ?? normalized;
  // Match filenames containing "test" or "spec" as a word boundary segment
  // e.g. foo.test.ts, foo.spec.ts, test_foo.py, foo_test.go, FooSpec.kt
  return /(?:^|\.|_|-|\/)(?:test|spec)(?:\.|_|-|$)/.test(filename) ||
    /(?:^|\.|_|-|\/)(?:test|spec)s?(?:\.|_|-|$)/.test(filename);
}

function filterGeneratedFilesFromDiff(diff: string): { filtered: string; excluded: string[] } {
  const sections = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  const excluded: string[] = [];

  for (const section of sections) {
    if (!section.startsWith("diff --git ")) {
      kept.push(section);
      continue;
    }
    const match = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    const filePath = match ? match[1].trim() : "";
    if (filePath && isGeneratedFile(filePath)) {
      excluded.push(filePath);
    } else {
      kept.push(section);
    }
  }

  return { filtered: kept.join(""), excluded };
}


/** Extract the list of test/spec file paths from a diff string. */
function extractTestFilesFromDiff(diff: string): string[] {
  const testFiles: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = line.match(/b\/(.+)$/);
    if (match) {
      const filePath = match[1].trim();
      if (isTestFile(filePath)) testFiles.push(filePath);
    }
  }
  return testFiles;
}

export function buildReviewText(
  pr: BitbucketPr,
  diff: string,
  issue: JiraIssue | null
): string {
  const lines: string[] = [];

  lines.push("=== PULL REQUEST ===");
  lines.push(`PR #${pr.id}: ${pr.title}`);
  lines.push(`Author: ${pr.author.displayName}`);
  lines.push(`Branch: ${pr.sourceBranch} → ${pr.destinationBranch}`);
  lines.push(`Created: ${pr.createdOn.slice(0, 10)} | Updated: ${pr.updatedOn.slice(0, 10)}`);
  if (pr.description) {
    lines.push("", "Description:", pr.description);
  }

  if (issue) {
    lines.push("", "=== LINKED JIRA TICKET ===");
    lines.push(`${issue.key}: ${issue.summary}`);
    lines.push(`Type: ${issue.issueType}`);
    if (issue.description) lines.push(issue.description);
    if (issue.acceptanceCriteria) {
      // For Story-type tickets, acceptanceCriteria may have been extracted from
      // the Requirements column of the description table (User Story | Requirements
      // layout) rather than a dedicated custom field.
      const acLabel =
        issue.issueType.toLowerCase() === "story"
          ? "Acceptance Criteria (derived from Requirements column of description table)"
          : "Acceptance Criteria";
      lines.push("", `${acLabel}:`, issue.acceptanceCriteria);
    } else {
      lines.push("", "Acceptance Criteria: [NONE PROVIDED — this ticket has no acceptance criteria defined]");
    }
  } else {
    lines.push("", "=== LINKED JIRA TICKET ===");
    lines.push("[No linked JIRA ticket — acceptance criteria unavailable]");
  }

  const { filtered: filteredDiff, excluded } = filterGeneratedFilesFromDiff(diff);
  if (excluded.length > 0) {
    lines.push("", "=== EXCLUDED FROM REVIEW (auto-generated files — do not review) ===");
    for (const f of excluded) lines.push(`  ${f}`);
    lines.push("These files are machine-generated and must not be reviewed or commented on.");
  }

  // Test/spec files must be excluded from the Security lens.
  // They may still appear in the diff for the testing and quality lenses.
  const testFiles = extractTestFilesFromDiff(filteredDiff);
  if (testFiles.length > 0) {
    lines.push("", "=== TEST / SPEC FILES IN THIS DIFF ===");
    for (const f of testFiles) lines.push(`  ${f}`);
    lines.push(
      "SECURITY LENS INSTRUCTION: Do NOT raise any security findings for the test/spec files " +
      "listed above. Test files are not production code and are explicitly excluded from the " +
      "Security review lens. They may still be reviewed under the Testing and Quality lenses."
    );
  }

  lines.push("", "=== DIFF ===");
  lines.push(
    "The diff is in standard unified format. The backend annotates each line: " +
    "[Lnnn] = added/context line at new-file line number nnn (present in the new code), " +
    "[del] = deleted line (removed, no longer exists in the new code). " +
    "Only [Lnnn] and bare context lines reflect the current state of the file."
  );
  const trimmedDiff =
    filteredDiff.length > MAX_DIFF_CHARS
      ? filteredDiff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated — showing first 120k characters]"
      : filteredDiff;
  lines.push(trimmedDiff);

  return lines.join("\n");
}








































