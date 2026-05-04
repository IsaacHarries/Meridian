import { APP_HEADER_TITLE, WorkflowPanelHeader } from "@/components/appHeaderLayout";
import { Button } from "@/components/ui/button";
import { type SlashCommand, createGlobalCommands } from "@/lib/slashCommands";
import { type BitbucketComment, type BitbucketPr, getMyOpenPrs, getPrComments, getPrDiff } from "@/lib/tauri/bitbucket";
import { currentModelKeyFor } from "@/lib/tauri/core";
import { type CredentialStatus, aiProviderComplete, bitbucketComplete } from "@/lib/tauri/credentials";
import { analyzePrComments, chatAddressPr } from "@/lib/tauri/workflows";
import { checkoutPrAddressBranch, commitPrAddressChanges, getPrAddressDiff, pushPrAddressBranch, readPrAddressFile, writePrAddressFile } from "@/lib/tauri/worktree";
import { useChatHistoryStore } from "@/stores/chatHistoryStore";
import { useTokenUsageStore } from "@/stores/tokenUsageStore";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, ArrowLeft, GitPullRequest } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    type ChatMessage,
    EMPTY_CHAT,
    type FixProposal,
    type WorkflowStep,
    buildFixPlanFromPartial,
    parseFixPlan,
} from "./address-pr/_shared";
import { CommitPushStep } from "./address-pr/commit-push-step";
import { DiffReviewStep } from "./address-pr/diff-review-step";
import { DoneStep } from "./address-pr/done-step";
import { FixPlanStep } from "./address-pr/fix-plan-step";
import { PrListPanel } from "./address-pr/pr-list-panel";
import { ProgressStep } from "./address-pr/progress-step";

// ── Main screen ───────────────────────────────────────────────────────────────

interface Props {
  credStatus: CredentialStatus;
  onBack: () => void;
}

export function AddressPrCommentsScreen({ credStatus, onBack }: Props) {
  // ── PR list state ──────────────────────────────────────────────────────────
  const [prs, setPrs] = useState<BitbucketPr[]>([]);
  const [prsLoading, setPrsLoading] = useState(false);
  const [prsError, setPrsError] = useState<string | null>(null);

  // ── Selected PR ────────────────────────────────────────────────────────────
  const [selectedPr, setSelectedPr] = useState<BitbucketPr | null>(null);
  const [comments, setComments] = useState<BitbucketComment[]>([]);

  // ── Workflow step ──────────────────────────────────────────────────────────
  const [step, setStep] = useState<WorkflowStep>("pr-list");
  const [stepMessage, setStepMessage] = useState("");
  const [stepError, setStepError] = useState<string | null>(null);

  // ── Analysis streaming ─────────────────────────────────────────────────────
  const [streamBuffer, setStreamBuffer] = useState("");

  // ── Fix plan ───────────────────────────────────────────────────────────────
  const [fixPlan, setFixPlan] = useState<FixProposal[]>([]);

  // ── Diff review ───────────────────────────────────────────────────────────
  const [finalDiff, setFinalDiff] = useState("");

  // ── Commit/push ───────────────────────────────────────────────────────────
  const [commitMessage, setCommitMessage] = useState("");
  const [commitSha, setCommitSha] = useState("");

  // ── Chat ──────────────────────────────────────────────────────────────────
  // Chat lives in the chat-history store keyed by PR id, so navigating
  // away from this screen and coming back to the same PR preserves the
  // running conversation. Local state holds only ephemerals (input,
  // busy spinner, scroll anchor).
  const chatKey = selectedPr ? String(selectedPr.id) : "";
  const chatHistory = useChatHistoryStore((s) =>
    chatKey ? s.histories.address_pr?.[chatKey] ?? EMPTY_CHAT : EMPTY_CHAT,
  );
  const setStoredChat = useChatHistoryStore((s) => s.setHistory);
  const setChatHistory = useCallback(
    (next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      if (!chatKey) return;
      const current =
        useChatHistoryStore.getState().histories.address_pr?.[chatKey] ?? [];
      const resolved = typeof next === "function" ? next(current) : next;
      setStoredChat("address_pr", chatKey, resolved);
    },
    [chatKey, setStoredChat],
  );
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatStreamReply, setChatStreamReply] = useState("");

  const streamRef = useRef<string>("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const canFetch = bitbucketComplete(credStatus);
  const hasAi = aiProviderComplete(credStatus);

  // ── Load PR list ───────────────────────────────────────────────────────────
  const loadPrs = useCallback(async () => {
    if (!canFetch) return;
    setPrsLoading(true);
    setPrsError(null);
    try {
      const all = await getMyOpenPrs();
      // Only show PRs that have reviewer comments
      const withComments = all;
      setPrs(withComments);
    } catch (e) {
      setPrsError(String(e));
    } finally {
      setPrsLoading(false);
    }
  }, [canFetch]);

  useEffect(() => { loadPrs(); }, [loadPrs]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // ── Select PR → fetch comments + diff → checkout ───────────────────────────
  async function handleSelectPr(pr: BitbucketPr) {
    setSelectedPr(pr);
    setStep("checkout");
    setStepError(null);
    setStepMessage("Fetching PR comments and diff…");
    setStreamBuffer("");
    setFixPlan([]);
    // Chat history is keyed by PR id in the store, so switching PRs
    // automatically swaps the rendered conversation. Don't clear here
    // — that would erase the prior PR's history that we want preserved
    // for when the user comes back to it.

    try {
      const [fetchedComments, fetchedDiff] = await Promise.all([
        getPrComments(pr.id),
        getPrDiff(pr.id),
      ]);
      setComments(fetchedComments);

      setStepMessage(`Checking out branch: ${pr.sourceBranch}…`);
      await checkoutPrAddressBranch(pr.sourceBranch);

      setStepMessage("Branch checked out. Ready to analyse.");
      // Move straight to analysis
      await runAnalysis(pr, fetchedComments, fetchedDiff);
    } catch (e) {
      setStepError(String(e));
    }
  }

  // ── Run agent analysis ─────────────────────────────────────────────────────
  async function runAnalysis(
    pr: BitbucketPr,
    fetchedComments: BitbucketComment[],
    fetchedDiff: string,
  ) {
    setStep("analyzing");
    setStepError(null);
    setStreamBuffer("");
    streamRef.current = "";

    // Build reviewer-only comments (filter out PR author's own comments)
    const reviewerComments = fetchedComments.filter(
      (c) => c.author.nickname.toLowerCase() !== pr.author.nickname.toLowerCase()
    );

    // Try to read files referenced in inline comments
    const fileContentsMap: Record<string, string> = {};
    for (const c of reviewerComments) {
      if (c.inline?.path && !fileContentsMap[c.inline.path]) {
        try {
          fileContentsMap[c.inline.path] = await readPrAddressFile(c.inline.path);
        } catch {
          // File may not be accessible — skip
        }
      }
    }

    const fileContentsSection = Object.entries(fileContentsMap)
      .map(([path, content]) => `### File: ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join("\n\n");

    const inlineCommentsText = reviewerComments
      .map((c) => {
        const location = c.inline
          ? ` [${c.inline.path}${c.inline.toLine ? `:${c.inline.toLine}` : ""}]`
          : "";
        return `Comment #${c.id}${location} by ${c.author.nickname}:\n${c.content}`;
      })
      .join("\n\n---\n\n");

    const reviewText = [
      `## PR: ${pr.title}`,
      `Branch: ${pr.sourceBranch} → ${pr.destinationBranch}`,
      "",
      "## PR Diff",
      "```diff",
      fetchedDiff,
      "```",
      "",
      "## Reviewer Comments",
      inlineCommentsText || "(No reviewer comments found)",
      "",
      fileContentsSection ? `## Referenced File Contents\n${fileContentsSection}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Subscribe to streaming events
    const unlisten = await listen<string>("address-pr-stream", (event) => {
      streamRef.current += event.payload;
      setStreamBuffer(streamRef.current);
    });
    // Subscribe to partial-parsed JSON from the sidecar so the fix cards
    // populate live as the model produces them.
    const unlistenPartial = await listen<{
      kind?: string;
      data?: {
        partial?: unknown;
        usagePartial?: { inputTokens?: number; outputTokens?: number };
      };
    }>("analyze-pr-comments-workflow-event", (event) => {
      if (event.payload.kind !== "progress") return;
      const usagePartial = event.payload.data?.usagePartial;
      if (usagePartial && typeof usagePartial === "object") {
        useTokenUsageStore
          .getState()
          .setCurrentCallUsage(
            "address_pr",
            {
              inputTokens: usagePartial.inputTokens ?? 0,
              outputTokens: usagePartial.outputTokens ?? 0,
            },
            currentModelKeyFor("address_pr"),
          );
        return;
      }
      const partial = event.payload.data?.partial;
      if (!Array.isArray(partial)) return;
      setFixPlan(buildFixPlanFromPartial(partial));
    });

    try {
      const raw = await analyzePrComments(reviewText);
      const plan = parseFixPlan(raw);
      setFixPlan(plan);
      setChatHistory([
        {
          role: "assistant",
          content: plan.length > 0
            ? `I've analysed ${reviewerComments.length} reviewer comment${reviewerComments.length !== 1 ? "s" : ""} and produced ${plan.length} proposed fix${plan.length !== 1 ? "es" : ""}. Review them below — you can approve, skip, or annotate each one before I apply the fixes.`
            : "I analysed the reviewer comments but couldn't identify specific code fixes to apply automatically. You may need to address these manually.",
        },
      ]);
      setStep("fix-plan");
    } catch (e) {
      setStepError(String(e));
    } finally {
      unlisten();
      unlistenPartial();
    }
  }

  // ── Apply approved fixes ───────────────────────────────────────────────────
  async function handleApplyFixes() {
    const approved = fixPlan.filter((f) => f.approved && !f.skipped && f.newContent);
    if (approved.length === 0) {
      // Nothing to apply automatically — go straight to diff review
      await loadDiff();
      return;
    }

    setStep("applying");
    setStepError(null);
    setStepMessage(`Applying ${approved.length} fix${approved.length !== 1 ? "es" : ""}…`);

    try {
      for (const fix of approved) {
        if (!fix.newContent) continue;
        // Pick the primary affected file
        const targetFile = fix.affectedFiles[0] ?? fix.file;
        if (!targetFile) continue;
        setStepMessage(`Writing ${targetFile}…`);
        await writePrAddressFile(targetFile, fix.newContent);
      }
      setStepMessage("Fixes applied. Loading diff…");
      await loadDiff();
    } catch (e) {
      setStepError(String(e));
      setStep("fix-plan");
    }
  }

  async function loadDiff() {
    try {
      const d = await getPrAddressDiff();
      setFinalDiff(d);
      setStep("diff-review");
      // Suggest a commit message
      const approvedSummaries = fixPlan
        .filter((f) => f.approved && !f.skipped)
        .map((f) => f.commentSummary)
        .slice(0, 3)
        .join("; ");
      setCommitMessage(
        approvedSummaries
          ? `Address PR review comments: ${approvedSummaries}`
          : `Address PR review comments on ${selectedPr?.sourceBranch ?? "branch"}`
      );
    } catch (e) {
      setStepError(String(e));
      setStep("fix-plan");
    }
  }

  // ── Commit ─────────────────────────────────────────────────────────────────
  async function handleCommit() {
    if (!commitMessage.trim()) return;
    setStep("committing");
    setStepError(null);
    setStepMessage("Committing changes…");
    try {
      const sha = await commitPrAddressChanges(commitMessage.trim());
      setCommitSha(sha);
      setStep("pushing");
      setStepMessage(`Committed at ${sha}. Ready to push.`);
    } catch (e) {
      setStepError(String(e));
      setStep("diff-review");
    }
  }

  // ── Push ───────────────────────────────────────────────────────────────────
  async function handlePush() {
    setStepMessage("Pushing to origin…");
    setStepError(null);
    try {
      await pushPrAddressBranch();
      setStep("done");
    } catch (e) {
      setStepError(String(e));
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  // Raw send that runs the PR-address chat turn. Shared by both the
  // SlashCommandInput and any commands that want to ask the agent something.
  async function sendChatRaw(text: string) {
    if (!selectedPr || chatLoading) return;
    const newHistory: ChatMessage[] = [...chatHistory, { role: "user", content: text }];
    setChatHistory(newHistory);
    setChatLoading(true);

    const contextText = [
      `PR: ${selectedPr.title} (${selectedPr.sourceBranch} → ${selectedPr.destinationBranch})`,
      "",
      "Fix plan:",
      fixPlan
        .map((f, i) => `${i + 1}. [${f.confidence}] ${f.commentSummary} — ${f.proposedFix}`)
        .join("\n"),
    ].join("\n");

    const historyJson = JSON.stringify(
      newHistory.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] })),
    );

    let response = "";
    const unlisten = await listen<{
      kind?: string;
      delta?: string;
      data?: { usagePartial?: { inputTokens?: number; outputTokens?: number } };
    }>("address-pr-chat-workflow-event", (event) => {
      const payload = event.payload;
      if (payload.kind === "stream" && payload.delta) {
        response += payload.delta;
        // Surface the streaming reply to the chat UI live so the user
        // sees the agent typing rather than waiting for the final reply
        // to land in one shot.
        setChatStreamReply(response);
        return;
      }
      if (payload.kind === "progress") {
        const usagePartial = payload.data?.usagePartial;
        if (usagePartial && typeof usagePartial === "object") {
          useTokenUsageStore
            .getState()
            .setCurrentCallUsage(
              "address_pr",
              {
                inputTokens: usagePartial.inputTokens ?? 0,
                outputTokens: usagePartial.outputTokens ?? 0,
              },
              currentModelKeyFor("address_pr"),
            );
        }
      }
    });

    try {
      const result = await chatAddressPr(contextText, historyJson);
      const finalMsg = result || response;
      setChatHistory((prev) => [...prev, { role: "assistant", content: finalMsg }]);
    } catch (e) {
      setChatHistory((prev) => [...prev, { role: "assistant", content: `Error: ${String(e)}` }]);
    } finally {
      unlisten();
      setChatStreamReply("");
      setChatLoading(false);
    }
  }

  const addressChatCommands: SlashCommand[] = useMemo(
    () => [
      ...createGlobalCommands({
        history: chatHistory,
        clearHistory: () => {
          setChatHistory([]);
          useTokenUsageStore.getState().clearPanelChatLastInput("address_pr");
        },
        sendMessage: (text: string) => sendChatRaw(text),
        removeLastAssistantMessage: () =>
          setChatHistory((prev) => {
            if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") {
              return prev;
            }
            return prev.slice(0, -1);
          }),
      }),
      {
        name: "fix",
        description: "Re-propose a fix for a specific file",
        args: "<file>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a file path, e.g. /fix src/foo.ts");
            return;
          }
          await sendChatRaw(
            `Re-examine your proposed fix for ${args.trim()} and suggest a revised version.`,
          );
        },
      },
      {
        name: "diff",
        description: "Ask the AI to describe the current worktree diff",
        execute: async () => {
          await sendChatRaw(
            "Describe the current worktree diff at a high level — files touched and notable changes.",
          );
        },
      },
      {
        name: "revert",
        description: "Discard the current fix attempt (not yet implemented)",
        execute: ({ toast: t }) => {
          t.info("Revert isn't wired yet", {
            description:
              "To reset, close this PR flow and re-open — the worktree will be freshly checked out.",
          });
        },
      },
      {
        name: "commit",
        description: "Commit accumulated fixes",
        args: "[message]",
        execute: async ({ args, toast: t }) => {
          const msg = args.trim() || commitMessage.trim();
          if (!msg) {
            t.error("No commit message available", {
              description: "Pass one via /commit <message> or fill in the commit box.",
            });
            return;
          }
          setCommitMessage(msg);
          await handleCommit();
        },
      },
      {
        name: "push",
        description: "Push the fix branch",
        execute: async () => {
          await handlePush();
        },
      },
      {
        name: "branch",
        description: "Show the checked-out branch",
        execute: ({ toast: t }) => {
          if (!selectedPr) {
            t.info("No PR selected");
            return;
          }
          t("Current branch", {
            description: `${selectedPr.sourceBranch} → ${selectedPr.destinationBranch}`,
          });
        },
      },
    ],
    // handleCommit and handlePush are stable functions closing over state,
    // but their behaviour depends on commitMessage/fixPlan/chatHistory — we
    // rebuild the array when those change.
    [chatHistory, selectedPr, commitMessage, fixPlan],
  );

  // ── Fix plan mutators ──────────────────────────────────────────────────────
  function toggleApprove(i: number) {
    setFixPlan((prev) =>
      prev.map((f, idx) =>
        idx === i ? { ...f, approved: !f.approved, skipped: false } : f
      )
    );
  }

  function toggleSkip(i: number) {
    setFixPlan((prev) =>
      prev.map((f, idx) =>
        idx === i ? { ...f, skipped: !f.skipped, approved: f.skipped } : f
      )
    );
  }

  function setAnnotation(i: number, text: string) {
    setFixPlan((prev) =>
      prev.map((f, idx) => (idx === i ? { ...f, annotation: text } : f))
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col">
      <WorkflowPanelHeader
        panel="address_pr_comments"
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className={APP_HEADER_TITLE}>Address PR Tasks & Comments</h1>
          </>
        }
      />

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-6 space-y-4">
        {/* Missing credentials */}
        {!canFetch && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Bitbucket credentials are required. Configure them in Settings.
          </div>
        )}
        {!hasAi && step !== "pr-list" && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            No AI provider configured — add an Anthropic key or other provider in Settings to enable agent features.
          </div>
        )}

        {/* ── Step: PR List ────────────────────────────────────────────────── */}
        {step === "pr-list" && (
          <div className="rounded-xl border bg-card/60 p-4">
            <div className="flex items-center gap-2 mb-4">
              <GitPullRequest className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Your Open PRs</h2>
            </div>
            <PrListPanel
              prs={prs}
              loading={prsLoading}
              error={prsError}
              onSelect={handleSelectPr}
              onRefresh={loadPrs}
            />
          </div>
        )}

        {/* ── Step: Checkout / Analyzing ───────────────────────────────────── */}
        {(step === "checkout" || step === "analyzing" || step === "applying") && (
          <ProgressStep
            step={step}
            stepMessage={stepMessage}
            streamBuffer={streamBuffer}
            stepError={stepError}
          />
        )}

        {/* ── Step: Fix Plan ───────────────────────────────────────────────── */}
        {step === "fix-plan" && selectedPr && (
          <FixPlanStep
            selectedPr={selectedPr}
            comments={comments}
            chatHistory={chatHistory}
            chatLoading={chatLoading}
            chatStreamReply={chatStreamReply}
            chatInput={chatInput}
            setChatInput={setChatInput}
            sendChatRaw={sendChatRaw}
            addressChatCommands={addressChatCommands}
            chatEndRef={chatEndRef}
            fixPlan={fixPlan}
            toggleApprove={toggleApprove}
            toggleSkip={toggleSkip}
            setAnnotation={setAnnotation}
            stepError={stepError}
            handleApplyFixes={handleApplyFixes}
            loadDiff={loadDiff}
            onBackToList={() => {
              setSelectedPr(null);
              setStep("pr-list");
              setFixPlan([]);
            }}
          />
        )}

        {/* ── Step: Diff Review ────────────────────────────────────────────── */}
        {step === "diff-review" && (
          <DiffReviewStep
            finalDiff={finalDiff}
            commitMessage={commitMessage}
            setCommitMessage={setCommitMessage}
            stepError={stepError}
            onCommit={handleCommit}
            onBack={() => setStep("fix-plan")}
          />
        )}

        {/* ── Step: Committing → Pushing ───────────────────────────────────── */}
        {(step === "committing" || step === "pushing") && (
          <CommitPushStep
            step={step}
            stepMessage={stepMessage}
            commitSha={commitSha}
            stepError={stepError}
            onPush={handlePush}
            onBack={onBack}
          />
        )}

        {/* ── Step: Done ───────────────────────────────────────────────────── */}
        {step === "done" && (
          <DoneStep
            selectedPr={selectedPr}
            onAddressAnother={() => {
              setSelectedPr(null);
              setStep("pr-list");
              setFixPlan([]);
              setFinalDiff("");
              loadPrs();
            }}
            onBack={onBack}
          />
        )}
      </main>
    </div>
  );
}
