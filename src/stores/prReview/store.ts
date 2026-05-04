/**
 * Zustand store for the PR Review Assistant.
 *
 * All review session state lives here so that navigating away and back
 * restores the PR list, selected PR, diff, and review report. Per-PR
 * caches (report, diff, chat, submission state) are stored in Maps keyed
 * by PR id so multiple PRs can have independent cached reviews simultaneously.
 */

import { approvePr, createPrTask, deletePrComment, getOpenPrs, getPr, getPrComments, getPrDiff, getPrsForReview, getPrTasks, postPrComment, requestChangesPr, resolvePrTask, unapprovePr, unrequestChangesPr, updatePrComment, updatePrTask, type BitbucketPr } from "@/lib/tauri/bitbucket";
import { isMockMode } from "@/lib/tauri/core";
import { getNonSecretConfig } from "@/lib/tauri/credentials";
import { getIssue } from "@/lib/tauri/jira";
import { chatPrReview, type ReviewReport } from "@/lib/tauri/pr-review";
import { cancelReview, runPrReviewWorkflow, type TriageMessage } from "@/lib/tauri/workflows";
import { checkoutPrReviewBranch, readRepoFile } from "@/lib/tauri/worktree";
import { useAiSelectionStore } from "@/stores/aiSelectionStore";
import {
    modelKey,
    useTokenUsageStore,
    type RateLimitSnapshot,
} from "@/stores/tokenUsageStore";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { emptySession } from "./constants";
import { buildReviewText } from "./helpers";
import type { PrReviewState, PrSession } from "./types";

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
            usagePartial?: { inputTokens?: number; outputTokens?: number };
            rateLimits?: { provider?: string; snapshot?: RateLimitSnapshot };
            done?: number;
            total?: number;
          };
        }>("pr-review-workflow-event", (event) => {
          if (event.payload.kind !== "progress") return;

          const rateLimits = event.payload.data?.rateLimits;
          if (
            rateLimits?.provider &&
            rateLimits.snapshot &&
            typeof rateLimits.snapshot === "object"
          ) {
            useTokenUsageStore
              .getState()
              .setRateLimits(rateLimits.provider, rateLimits.snapshot);
            return;
          }

          // Live token-usage stream from the synthesis node — keeps
          // the HeaderModelPicker dropdown count climbing as chunks
          // arrive, instead of waiting for the final result.
          const usagePartial = event.payload.data?.usagePartial;
          if (usagePartial && typeof usagePartial === "object") {
            let mk: string | undefined;
            try {
              const r = useAiSelectionStore
                .getState()
                .resolve("pr_review");
              if (r.model) mk = modelKey(r.provider, r.model);
            } catch {
              /* hydration race — panel-only bucket */
            }
            useTokenUsageStore.getState().setCurrentCallUsage(
              "pr_review",
              {
                inputTokens: usagePartial.inputTokens ?? 0,
                outputTokens: usagePartial.outputTokens ?? 0,
              },
              mk,
            );
            return;
          }

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
          const { report: parsed, usage } = await runPrReviewWorkflow(fullReviewText);
          if (usage) {
            let mk: string | undefined;
            try {
              const r = useAiSelectionStore.getState().resolve("pr_review");
              if (r.model) mk = modelKey(r.provider, r.model);
            } catch {
              /* fall back to panel-only bucket */
            }
            useTokenUsageStore.getState().addUsage("pr_review", usage, mk);
          }
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
        data?: { usagePartial?: { inputTokens?: number; outputTokens?: number } };
      }>(
        "pr-review-chat-workflow-event",
        (event) => {
          const payload = event.payload;
          if (payload.kind === "stream" && payload.delta) {
            chatAcc.text += payload.delta;
            if (chatFlushTimer !== null) return;
            chatFlushTimer = setTimeout(() => {
              chatFlushTimer = null;
              usePrReviewStore.getState()._patchSession(prId, {
                reviewChatStreamText: chatAcc.text,
              });
            }, 80);
            return;
          }
          if (payload.kind === "progress") {
            const usagePartial = payload.data?.usagePartial;
            if (usagePartial && typeof usagePartial === "object") {
              let mk: string | undefined;
              try {
                const r = useAiSelectionStore.getState().resolve("pr_review");
                if (r.model) mk = modelKey(r.provider, r.model);
              } catch {
                /* hydration race — panel-only bucket */
              }
              useTokenUsageStore.getState().setCurrentCallUsage(
                "pr_review",
                {
                  inputTokens: usagePartial.inputTokens ?? 0,
                  outputTokens: usagePartial.outputTokens ?? 0,
                },
                mk,
              );
            }
          }
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
      // Drop the recorded chat-context size so the header context ring
      // resets along with the conversation it reflects.
      useTokenUsageStore.getState().clearPanelChatLastInput("pr_review");
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
