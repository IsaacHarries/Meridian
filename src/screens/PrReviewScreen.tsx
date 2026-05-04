import { APP_HEADER_TITLE, WorkflowPanelHeader } from "@/components/appHeaderLayout";
import { type ToolRequest } from "@/components/ToolRequestCard";
import { Button } from "@/components/ui/button";
import { type BitbucketComment, getPrFileContent } from "@/lib/tauri/bitbucket";
import { openUrl } from "@/lib/tauri/core";
import { type CredentialStatus, aiProviderComplete, bitbucketComplete, jiraComplete } from "@/lib/tauri/credentials";
import { uploadPrAttachment } from "@/lib/tauri/misc";
import { type ReviewLens, type ReviewReport } from "@/lib/tauri/pr-review";
import { checkoutPrReviewBranch, runInTerminal } from "@/lib/tauri/worktree";
import { enrichMessageWithUrls } from "@/lib/urlFetch";
import { usePrReviewStore } from "@/stores/prReview/store";
import { listen } from "@tauri-apps/api/event";
import {
    ArrowLeft,
    Check,
    ChevronDown,
    ChevronRight,
    ClipboardList,
    Copy,
    ExternalLink,
    Loader2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReviewProgressBanner, lineRangeToIdeSuffix, readFileAsDataUri } from "./pr-review/_shared";
import { DiffViewer } from "./pr-review/diff-viewer";
import { PrDescriptionPanel } from "./pr-review/pr-description-panel";
import { PrSelector } from "./pr-review/pr-selector";
import { ReviewChat } from "./pr-review/review-chat";
import { ReviewControls } from "./pr-review/review-controls";
import { ReviewSummary } from "./pr-review/review-summary";
import { useReviewChatCommands } from "./pr-review/use-review-chat-commands";

interface PrReviewScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function PrReviewScreen({ credStatus, onBack }: PrReviewScreenProps) {
  const claudeAvailable = aiProviderComplete(credStatus);
  const bbAvailable = bitbucketComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  // ── Store bindings (persistent state — survives navigation) ──────────────────
  const {
    selectedPr,
    sessions,
    prsForReview,
    allOpenPrs,
    loadingPrs,
    jiraBaseUrl,
    myAccountId,
    linkedIssuesByKey,
  } = usePrReviewStore();

  // Derive the current session fields from the Map (empty defaults while loading)
  const session = (selectedPr ? sessions.get(selectedPr.id) : undefined) ?? {
    diff: "", diffUpdatedOn: null, diffStale: false,
    comments: [] as import("@/lib/tauri/bitbucket").BitbucketComment[],
    commentCountAtFetch: 0, commentsLastFetchedAt: null as string | null, hasNewComments: false,
    linkedIssue: null, loadingDetails: false, checkingForUpdates: false,
    report: null, partialReport: null as Partial<import("@/lib/tauri").ReviewReport> | null,
    rawError: null, reviewing: false,
    reviewProgress: "", reviewStreamText: "", reviewChatStreamText: "",
    worktreeBranch: null, checkoutStatus: "idle" as const, checkoutError: "",
    submitAction: null, submitStatus: "idle" as const, submitError: "",
    reviewChat: [],
    myPostedCommentIds: [] as number[], postingComment: false, postCommentError: "",
    tasks: [] as import("@/lib/tauri").BitbucketTask[],
  };
  // Guard against old cache entries that are missing fields added in newer versions
  const comments = session.comments ?? [];
  const myPostedCommentIds = session.myPostedCommentIds ?? [];
  const tasks = session.tasks ?? [];
  const {
    diff, linkedIssue, loadingDetails, report, partialReport, rawError, reviewing,
    reviewProgress, reviewStreamText, worktreeBranch, checkoutStatus, checkoutError,
    submitAction, submitStatus, submitError, reviewChat, reviewChatStreamText,
    diffStale, checkingForUpdates,
  } = session;

  const store = usePrReviewStore.getState;

  // ── Ephemeral UI state (local — reset on each visit is fine) ─────────────────
  const [splitPct, setSplitPct] = useState(58);
  const [highlightTarget, setHighlightTarget] = useState<{ path: string; line: number | null } | null>(null);
  const [reviewChatInput, setReviewChatInput] = useState("");
  const [reviewChatSending, setReviewChatSending] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [toolRequests, setToolRequests] = useState<ToolRequest[]>([]);
  const PR_RUN_CMD_KEY = "meridian-pr-review-run-command";
  const DEFAULT_RUN_CMD = "pnpm nx run flowjo:start";
  const [runCommand, setRunCommand] = useState(
    () => localStorage.getItem(PR_RUN_CMD_KEY) ?? DEFAULT_RUN_CMD
  );
  const [runningCommand, setRunningCommand] = useState(false);
  const [runCommandError, setRunCommandError] = useState("");
  const [pullingBranch, setPullingBranch] = useState(false);
  const [pullBranchError, setPullBranchError] = useState("");
  const [pullBranchSuccess, setPullBranchSuccess] = useState(false);
  const [acExpanded, setAcExpanded] = useState(true);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const diffPaneRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // ── Resizable split pane ─────────────────────────────────────────────────────
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    function onMouseMove(ev: MouseEvent) {
      if (!isDragging.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(Math.max(pct, 20), 80));
    }
    function onMouseUp() {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  // ── Backend event listeners — patch the active PR's session ──────────────────

  useEffect(() => {
    // Accumulate deltas in a plain object (not a React ref) so we never read
    // from Zustand state on every token. We throttle writes to Zustand (and
    // therefore React re-renders) to at most once every 80 ms — enough to feel
    // responsive without flooding the JS event loop when a fast local model is
    // firing tokens rapidly.
    const acc = { text: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleFlush(prId: number) {
      if (flushTimer !== null) return; // already scheduled
      flushTimer = setTimeout(() => {
        flushTimer = null;
        usePrReviewStore.getState()._patchSession(prId, { reviewStreamText: acc.text });
      }, 80);
    }

    const unlistenStream = listen<{ delta: string }>("pr-review-stream", (event) => {
      const prId = usePrReviewStore.getState().selectedPr?.id;
      if (!prId) return;
      acc.text += event.payload.delta;
      scheduleFlush(prId);
    });

    // Reset both the local accumulator and the Zustand state when a new chunk starts.
    const unlistenReset = listen("pr-review-stream-reset", () => {
      acc.text = "";
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      const prId = usePrReviewStore.getState().selectedPr?.id;
      if (prId) usePrReviewStore.getState()._patchSession(prId, { reviewStreamText: "" });
    });

    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      unlistenStream.then(f => f());
      unlistenReset.then(f => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      name: string; description: string; why_needed: string; example_call: string;
    }>("agent-tool-request", (event) => {
      const { name, description, why_needed, example_call } = event.payload;
      setToolRequests(prev => [...prev, {
        id: `${Date.now()}-${name}`,
        name,
        description,
        whyNeeded: why_needed,
        exampleCall: example_call,
        dismissed: false,
      }]);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  function dismissToolRequest(id: string) {
    setToolRequests(prev => prev.map(r => r.id === id ? { ...r, dismissed: true } : r));
  }

  // ── Refresh PR lists every time this panel mounts ────────────────────────────
  // prListLoaded is still used to avoid a flash of empty state on first hydration,
  // but we always kick off a fresh fetch on mount so new PRs assigned to the user
  // are picked up without needing to restart the app.
  useEffect(() => {
    store().loadPrLists(jiraAvailable, bbAvailable);
  }, [bbAvailable, jiraAvailable]);

  // ── Auto-scroll chat — fires on new messages AND on each streaming token ────
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [reviewChat, reviewChatStreamText]);

  // Slash commands for the post-review chat. Extracted to a hook to keep
  // this file under the per-file size budget.
  const reviewChatCommands = useReviewChatCommands({
    reviewChat,
    selectedPr,
    report,
    setReviewChatSending,
  });


  async function copySummary() {
    if (!report) return;
    const lines = [
      `## PR #${selectedPr?.id} Review`,
      `**Verdict**: ${report.overall.replace("_", " ")}`,
      `**Summary**: ${report.summary}`,
      "",
      "### Findings",
    ];
    for (const [key, label] of [
      ["acceptance_criteria", "Acceptance Criteria"],
      ["security", "Security"],
      ["logic", "Logic"],
      ["quality", "Quality"],
      ["testing", "Testing"],
    ] as const) {
      const lens = report.lenses[key];
      if (lens.findings.length > 0) {
        lines.push(`\n**${label}** — ${lens.assessment}`);
        for (const f of lens.findings) {
          lines.push(`- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${lineRangeToIdeSuffix(f.line_range)})` : ""}`);
          lines.push(`  ${f.description}`);
        }
      }
    }
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopiedSummary(true);
    setTimeout(() => setCopiedSummary(false), 2000);
  }

  // Display report: prefer the final, validated report; otherwise show the
  // partial JSON streamed from the synthesis node so the UI populates the
  // summary and per-lens cards live as the model produces them.
  const displayReport: Partial<ReviewReport> | null = report ?? partialReport;

  function safeLens(lens?: Partial<ReviewLens>): ReviewLens {
    return {
      assessment: lens?.assessment ?? "",
      findings: Array.isArray(lens?.findings)
        ? (lens!.findings as ReviewLens["findings"]).filter((f) => f && typeof f === "object")
        : [],
    };
  }

  // Count total blocking issues
  const blockingTotal = displayReport?.lenses
    ? Object.values(displayReport.lenses).flatMap((l) => safeLens(l).findings).filter((f) => f.severity === "blocking").length
    : 0;

  /**
   * Post a comment from a finding. If the finding has a file reference and a
   * parseable line number, post it as an inline comment on that line.
   * Otherwise post it as a general PR comment.
   */
  async function postFindingComment(
    content: string,
    file: string | null,
    lineRange: string | null,
  ): Promise<BitbucketComment> {
    // Try to parse a line number from line_range, e.g. "L42", "42-56", "42"
    let toLine: number | undefined;
    if (file && lineRange) {
      const m = lineRange.match(/\d+/);
      if (m) toLine = parseInt(m[0], 10);
    }
    return store().postComment(content, file ?? undefined, toLine, undefined);
  }

  // Reset highlightTarget to null first so the effect always re-fires even
  // when the same file link is clicked twice in a row.
  function jumpToFile(path: string, line?: number) {
    setHighlightTarget(null);
    requestAnimationFrame(() => setHighlightTarget({ path, line: line ?? null }));
  }

  async function handleRunInTerminal() {
    if (!runCommand.trim() || runningCommand) return;
    setRunningCommand(true);
    setRunCommandError("");
    // Persist as the new default before running so the next PR starts with it
    localStorage.setItem(PR_RUN_CMD_KEY, runCommand.trim());
    try {
      await runInTerminal(runCommand.trim());
    } catch (e) {
      setRunCommandError(String(e));
    } finally {
      setRunningCommand(false);
    }
  }

  async function handlePullBranch() {
    if (!selectedPr?.sourceBranch || pullingBranch) return;
    setPullingBranch(true);
    setPullBranchError("");
    setPullBranchSuccess(false);
    // Mark as checking-out so the worktree status indicator updates immediately
    usePrReviewStore.getState()._patchSession(selectedPr.id, { checkoutStatus: "checking-out", checkoutError: "" });
    try {
      const info = await checkoutPrReviewBranch(selectedPr.sourceBranch);
      // Update the store session so checkoutStatus becomes "ready" and unlocks the run command
      usePrReviewStore.getState()._patchSession(selectedPr.id, {
        checkoutStatus: "ready",
        worktreeBranch: info.branch,
        checkoutError: "",
      });
      setPullBranchSuccess(true);
      setTimeout(() => setPullBranchSuccess(false), 3000);
    } catch (e) {
      usePrReviewStore.getState()._patchSession(selectedPr.id, { checkoutStatus: "error", checkoutError: String(e) });
      setPullBranchError(String(e));
    } finally {
      setPullingBranch(false);
    }
  }

  // Image attach handler — used by InlineCommentBox / QuickReplyBox.
  // POSTs the picked / pasted file to Bitbucket's PR attachments endpoint
  // and returns the auth-required URL that the consumer embeds as
  // `![filename](url)` in the comment markdown. We rely on Bitbucket's
  // attachment URLs because data: URIs would only render inside Meridian —
  // teammates viewing the comment on Bitbucket's web UI would see broken
  // images.
  const onAttachImage = useCallback(
    async (file: File): Promise<string> => {
      if (!selectedPr) {
        throw new Error("No PR selected");
      }
      const dataUri = await readFileAsDataUri(file);
      const m = dataUri.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error("Could not encode image");
      const [, contentType, base64] = m;
      return uploadPrAttachment(selectedPr.id, file.name, base64, contentType);
    },
    [selectedPr],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <WorkflowPanelHeader
        panel="pr_review"
        barClassName="z-20"
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={selectedPr ? () => store().clearSelection() : onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className={`${APP_HEADER_TITLE} leading-none`}>PR Review Assistant</h1>
              {selectedPr && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  #{selectedPr.id} — {selectedPr.title}
                </p>
              )}
            </div>
          </>
        }
        trailing={
          selectedPr ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => selectedPr?.url && openUrl(selectedPr.url)}
              >
                <ExternalLink className="mr-1 h-3.5 w-3.5" /> Bitbucket
              </Button>
              {linkedIssue && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => linkedIssue.url && openUrl(linkedIssue.url)}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" /> {linkedIssue.key}
                </Button>
              )}
              {report && (
                <Button variant="ghost" size="sm" onClick={copySummary} className="gap-1">
                  {copiedSummary ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedSummary ? "Copied" : "Copy report"}
                </Button>
              )}
            </div>
          ) : null
        }
      />

      {/* Credential warnings */}
      {(!bbAvailable || !claudeAvailable) && (
        <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-200">
          {!bbAvailable && "Bitbucket credentials not configured. "}
          {!claudeAvailable && "No AI provider configured — AI review unavailable."}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 w-full bg-background/60 flex flex-col min-h-0">
        {!selectedPr ? (
          /* PR selector */
          <div className="px-6 py-6">
            <PrSelector
              prsForReview={prsForReview}
              allOpenPrs={allOpenPrs}
              loading={loadingPrs}
              onSelect={(pr) => store().selectPr(pr, jiraAvailable)}
              onRefresh={() => store().loadPrLists(jiraAvailable, bbAvailable, true)}
              jiraBaseUrl={jiraBaseUrl}
              myAccountId={myAccountId}
              cachedPrIds={new Set(
                [...sessions.entries()]
                  .filter(([, s]) => s.report !== null || s.rawError !== null)
                  .map(([id]) => id)
              )}
              stalePrIds={new Set(
                [...sessions.entries()]
                  .filter(([, s]) => s.report !== null && s.diffStale)
                  .map(([id]) => id)
              )}
              linkedIssuesByKey={linkedIssuesByKey}
            />
          </div>
        ) : (
          /* Review layout */
          <div ref={splitContainerRef} className="flex flex-1 min-h-0">
            {/* Left: diff viewer */}
            <div ref={diffPaneRef} style={{ width: `${splitPct}%` }} className="flex-none h-full overflow-y-auto border-r px-4 pb-4 space-y-3">
              {selectedPr?.description && selectedPr.description.trim() && (
                <PrDescriptionPanel description={selectedPr.description} />
              )}
              <div className="flex items-center justify-between pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Diff</p>
                {loadingDetails && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                  </span>
                )}
              </div>
              {diff ? (
                <DiffViewer
                  diff={diff}
                  highlightTarget={highlightTarget}
                  scrollContainerRef={diffPaneRef}
                  comments={comments}
                  tasks={tasks}
                  myAccountId={myAccountId}
                  myPostedCommentIds={myPostedCommentIds}
                  onFetchFileContent={selectedPr ? (path) => getPrFileContent(selectedPr.id, path) : undefined}
                  onPostInlineComment={async (path, toLine, content) => {
                    await store().postComment(content, path, toLine);
                  }}
                  onReply={async (parentId, content) => {
                    await store().postComment(content, undefined, undefined, parentId);
                  }}
                  onCreateTask={async (commentId, content) => store().createTask(commentId, content)}
                  onResolveTask={async (taskId, resolved) => store().resolveTask(taskId, resolved)}
                  onEditTask={async (taskId, content) => store().updateTask(taskId, content)}
                  onDeleteComment={async (commentId) => store().deleteComment(commentId)}
                  onEditComment={async (commentId, newContent) => store().editComment(commentId, newContent)}
                  onAttachImage={onAttachImage}
                />
              ) : loadingDetails ? null : (
                <div className="flex items-center justify-center h-48 text-sm text-muted-foreground border rounded-md border-dashed">
                  No diff available
                </div>
              )}
            </div>

            {/* Drag handle */}
            <div
              onMouseDown={onDividerMouseDown}
              className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors"
            />

            {/* Right: review panel — never scrolls as a whole; only the body below the run button scrolls */}
            <div style={{ width: `${100 - splitPct}%` }} className="flex-none h-full flex flex-col overflow-hidden">

              {/* ── Pinned top strip: run button + worktree status ── */}
              <ReviewControls
                reviewing={reviewing}
                claudeAvailable={claudeAvailable}
                loadingDetails={loadingDetails}
                diffStale={diffStale}
                report={report}
                checkoutStatus={checkoutStatus}
                checkoutError={checkoutError}
                worktreeBranch={worktreeBranch}
                selectedPr={selectedPr}
                pullingBranch={pullingBranch}
                pullBranchError={pullBranchError}
                pullBranchSuccess={pullBranchSuccess}
                checkingForUpdates={checkingForUpdates}
                runCommand={runCommand}
                setRunCommand={setRunCommand}
                runCommandError={runCommandError}
                setRunCommandError={setRunCommandError}
                runningCommand={runningCommand}
                onRunReview={() => store().runReview()}
                onCancelReview={() => store().cancelReview()}
                onPullBranch={handlePullBranch}
                onRunInTerminal={handleRunInTerminal}
              />

              {/* ── Scrollable body: review findings ── */}
              <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">

                  {/* Linked JIRA acceptance criteria (when present) */}
                  {linkedIssue?.acceptanceCriteria && linkedIssue.acceptanceCriteria.trim() && (
                    <div className="border-b">
                      <button
                        onClick={() => setAcExpanded((v) => !v)}
                        className="w-full flex items-center gap-2 px-4 py-2 bg-muted/40 hover:bg-muted/60 transition-colors text-left focus:outline-none"
                      >
                        <ClipboardList className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Acceptance Criteria
                        </span>
                        <span className="text-[10px] font-mono text-muted-foreground">{linkedIssue.key}</span>
                        <span className="ml-auto">
                          {acExpanded
                            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                        </span>
                      </button>
                      {acExpanded && (
                        <div className="px-4 py-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                          {linkedIssue.acceptanceCriteria}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Verdict + summary + Bitbucket submit + error + findings tabs */}
                  <ReviewSummary
                    displayReport={displayReport}
                    report={report}
                    blockingTotal={blockingTotal}
                    reviewing={reviewing}
                    rawError={rawError}
                    submitAction={submitAction}
                    submitStatus={submitStatus}
                    submitError={submitError}
                    onSubmitReview={(action) => store().submitReview(action)}
                    onJumpToFile={jumpToFile}
                    onPostComment={postFindingComment}
                    safeLens={safeLens}
                  />

                {/* ── Post-review chat ── */}
                {report && !reviewing && (
                  <ReviewChat
                    reviewChat={reviewChat}
                    reviewChatStreamText={reviewChatStreamText}
                    reviewChatSending={reviewChatSending}
                    reviewChatInput={reviewChatInput}
                    setReviewChatInput={setReviewChatInput}
                    onSend={async (text) => {
                      setReviewChatSending(true);
                      try {
                        const enriched = await enrichMessageWithUrls(text);
                        await store().sendReviewChatMessage(enriched);
                      } finally {
                        setReviewChatSending(false);
                      }
                    }}
                    commands={reviewChatCommands}
                    toolRequests={toolRequests}
                    onDismissToolRequest={dismissToolRequest}
                    chatBottomRef={chatBottomRef}
                  />
                )}

                {/* Empty state */}
                {!displayReport && !reviewing && !rawError && (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-6 text-center">
                    Run the AI review to see findings across four lenses
                  </div>
                )}

                {/* Reviewing progress — show the spinner banner only while we
                    don't yet have a partial report to display. Once partial
                    JSON starts arriving, the verdict/summary/lens cards above
                    take over and the banner would just be redundant chrome. */}
                {reviewing && !displayReport?.lenses && (
                  <div className="p-4 space-y-3">
                    <ReviewProgressBanner
                      message={reviewProgress || "Analysing diff…"}
                      streamText={reviewStreamText}
                    />
                  </div>
                )}

              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
