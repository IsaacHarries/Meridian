import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { ArrowLeft, GitPullRequest, MessageSquare, CheckSquare, RefreshCw, GitBranch, Loader2, Check, X, ChevronDown, ChevronRight, ThumbsUp, ThumbsDown, AlertTriangle, GitCommit, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import { createGlobalCommands, type SlashCommand } from "@/lib/slashCommands";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import {
  type CredentialStatus,
  type BitbucketPr,
  type BitbucketComment,
  bitbucketComplete,
  aiProviderComplete,
  getMyOpenPrs,
  getPrComments,
  getPrDiff,
  checkoutPrAddressBranch,
  readPrAddressFile,
  writePrAddressFile,
  analyzePrComments,
  chatAddressPr,
  getPrAddressDiff,
  commitPrAddressChanges,
  pushPrAddressBranch,
} from "@/lib/tauri";
import { listen } from "@tauri-apps/api/event";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FixProposal {
  commentId: number;
  file: string | null;
  fromLine: number | null;
  toLine: number | null;
  reviewerName: string;
  commentSummary: string;
  proposedFix: string;
  confidence: "High" | "Medium" | "Needs human judgment";
  affectedFiles: string[];
  newContent: string | null;
  skippable: boolean;
  // UI-only state
  approved: boolean;
  skipped: boolean;
  annotation: string;
}

type WorkflowStep =
  | "pr-list"       // Selecting which PR to work on
  | "checkout"      // Checking out the branch
  | "analyzing"     // Agent reading diff + comments
  | "fix-plan"      // User reviews fix plan
  | "applying"      // Agent applies approved fixes
  | "diff-review"   // User reviews diff before commit
  | "committing"    // User enters commit message
  | "pushing"       // Pushing to origin
  | "done";         // Complete

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prAge(createdOn: string): string {
  const ms = Date.now() - new Date(createdOn).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function confidenceBadgeVariant(confidence: FixProposal["confidence"]) {
  if (confidence === "High") return "success";
  if (confidence === "Medium") return "warning";
  return "destructive";
}

function buildFixPlanFromPartial(arr: unknown[]): FixProposal[] {
  return arr
    .filter((item): item is Record<string, unknown> =>
      item != null && typeof item === "object",
    )
    .map((item) => ({
      commentId: Number(item.commentId ?? 0),
      file: (item.file as string) ?? null,
      fromLine: item.fromLine != null ? Number(item.fromLine) : null,
      toLine: item.toLine != null ? Number(item.toLine) : null,
      reviewerName: String(item.reviewerName ?? "Reviewer"),
      commentSummary: String(item.commentSummary ?? ""),
      proposedFix: String(item.proposedFix ?? ""),
      confidence: (item.confidence as FixProposal["confidence"]) ?? "Medium",
      affectedFiles: Array.isArray(item.affectedFiles)
        ? (item.affectedFiles as string[])
        : item.file ? [item.file as string] : [],
      newContent: (item.newContent as string) ?? null,
      skippable: Boolean(item.skippable),
      approved: (item.confidence as string) !== "Needs human judgment",
      skipped: false,
      annotation: "",
    }));
}

function parseFixPlan(raw: string): FixProposal[] {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) return [];
    return arr.map((item: Record<string, unknown>) => ({
      commentId: Number(item.commentId ?? 0),
      file: (item.file as string) ?? null,
      fromLine: item.fromLine != null ? Number(item.fromLine) : null,
      toLine: item.toLine != null ? Number(item.toLine) : null,
      reviewerName: String(item.reviewerName ?? "Reviewer"),
      commentSummary: String(item.commentSummary ?? ""),
      proposedFix: String(item.proposedFix ?? ""),
      confidence: (item.confidence as FixProposal["confidence"]) ?? "Medium",
      affectedFiles: Array.isArray(item.affectedFiles)
        ? (item.affectedFiles as string[])
        : item.file ? [item.file as string] : [],
      newContent: (item.newContent as string) ?? null,
      skippable: Boolean(item.skippable),
      approved: (item.confidence as string) !== "Needs human judgment",
      skipped: false,
      annotation: "",
    }));
  } catch {
    return [];
  }
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function PrListPanel({
  prs,
  loading,
  error,
  onSelect,
  onRefresh,
}: {
  prs: BitbucketPr[];
  loading: boolean;
  error: string | null;
  onSelect: (pr: BitbucketPr) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Select one of your open PRs to address tasks and reviewer comments.
        </p>
        <Button variant="ghost" size="icon" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : prs.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground text-sm">
          No open PRs found.
        </div>
      ) : (
        <div className="space-y-2">
          {prs.map((pr) => (
            <button
              key={pr.id}
              onClick={() => onSelect(pr)}
              className="w-full text-left rounded-lg border bg-card/60 hover:bg-accent/60 transition-colors p-3 space-y-1"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium leading-snug flex-1">{pr.title}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {pr.taskCount > 0 && (
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <CheckSquare className="h-2.5 w-2.5" />
                      {pr.taskCount} task{pr.taskCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                  {pr.commentCount > 0 && (
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <MessageSquare className="h-2.5 w-2.5" />
                      {pr.commentCount} comment{pr.commentCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  {pr.sourceBranch}
                </span>
                <span>{prAge(pr.createdOn)}</span>
                {pr.jiraIssueKey && <span className="font-mono">{pr.jiraIssueKey}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FixPlanCard({
  fix,
  index,
  onToggleApprove,
  onToggleSkip,
  onAnnotationChange,
}: {
  fix: FixProposal;
  index: number;
  onToggleApprove: (i: number) => void;
  onToggleSkip: (i: number) => void;
  onAnnotationChange: (i: number, text: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className={`rounded-lg border ${fix.skipped ? "opacity-40" : ""} ${fix.approved && !fix.skipped ? "border-primary/30 bg-primary/5" : "border-border bg-card/60"}`}>
      <button
        className="w-full flex items-start gap-2 p-3 text-left"
        onClick={() => setExpanded((p) => !p)}
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-muted-foreground shrink-0">#{fix.commentId}</span>
            <Badge variant={confidenceBadgeVariant(fix.confidence)} className="text-[10px]">
              {fix.confidence}
            </Badge>
            {fix.file && (
              <span className="text-xs font-mono text-muted-foreground truncate">{fix.file}</span>
            )}
          </div>
          <p className="text-sm font-medium leading-snug">{fix.commentSummary}</p>
          <p className="text-xs text-muted-foreground">by {fix.reviewerName}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant={fix.approved && !fix.skipped ? "default" : "outline"}
            className="h-6 w-6 p-0"
            onClick={() => onToggleApprove(index)}
            title="Approve this fix"
          >
            <ThumbsUp className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant={fix.skipped ? "destructive" : "outline"}
            className="h-6 w-6 p-0"
            onClick={() => onToggleSkip(index)}
            title="Skip this fix"
          >
            <ThumbsDown className="h-3 w-3" />
          </Button>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t pt-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Proposed fix</p>
            <p className="text-sm leading-relaxed">{fix.proposedFix}</p>
          </div>
          {fix.affectedFiles.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Files</p>
              <div className="flex flex-wrap gap-1">
                {fix.affectedFiles.map((f) => (
                  <code key={f} className="text-xs bg-muted rounded px-1.5 py-0.5">{f}</code>
                ))}
              </div>
            </div>
          )}
          {fix.confidence === "Needs human judgment" && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              This fix requires human judgment. Annotate below with instructions if you want the agent to attempt it.
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Additional instructions (optional)</p>
            <Textarea
              value={fix.annotation}
              onChange={(e) => onAnnotationChange(index, e.target.value)}
              placeholder="Leave blank to follow the proposed fix as-is, or add notes to guide the agent…"
              className="text-xs min-h-[60px] resize-none"
              disabled={fix.skipped}
            />
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

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
    setChatHistory([]);

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
      data?: { partial?: unknown };
    }>("analyze-pr-comments-workflow-event", (event) => {
      if (event.payload.kind !== "progress") return;
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
    const unlisten = await listen<{ kind?: string; delta?: string }>(
      "address-pr-chat-workflow-event",
      (event) => {
        if (event.payload.kind !== "stream" || !event.payload.delta) return;
        response += event.payload.delta;
      },
    );

    try {
      const result = await chatAddressPr(contextText, historyJson);
      const finalMsg = result || response;
      setChatHistory((prev) => [...prev, { role: "assistant", content: finalMsg }]);
    } catch (e) {
      setChatHistory((prev) => [...prev, { role: "assistant", content: `Error: ${String(e)}` }]);
    } finally {
      unlisten();
      setChatLoading(false);
    }
  }

  const addressChatCommands: SlashCommand[] = useMemo(
    () => [
      ...createGlobalCommands({
        history: chatHistory,
        clearHistory: () => setChatHistory([]),
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
          <div className="rounded-xl border bg-card/60 p-6 flex flex-col items-center justify-center gap-4 min-h-[300px]">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-center space-y-1">
              <p className="text-sm font-medium">{stepMessage}</p>
              {step === "analyzing" && streamBuffer && (
                <div className="mt-3 max-w-2xl text-left bg-muted/50 rounded p-3 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
                  {streamBuffer}
                </div>
              )}
            </div>
            {stepError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <X className="h-4 w-4 shrink-0" />
                {stepError}
              </div>
            )}
          </div>
        )}

        {/* ── Step: Fix Plan ───────────────────────────────────────────────── */}
        {step === "fix-plan" && selectedPr && (
          <div className="space-y-4">
            {/* PR info header */}
            <div className="rounded-xl border bg-card/60 p-4 flex items-center gap-3">
              <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{selectedPr.title}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedPr.sourceBranch} → {selectedPr.destinationBranch}
                </p>
              </div>
              <Badge variant="outline">{comments.length} comment{comments.length !== 1 ? "s" : ""}</Badge>
            </div>

            {/* Chat / assistant message */}
            {chatHistory.length > 0 && (
              <div className="rounded-xl border bg-card/60 p-4 space-y-3">
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {chatHistory.map((msg, i) => (
                    <div
                      key={i}
                      className={`text-sm rounded-lg px-3 py-2 ${
                        msg.role === "assistant"
                          ? "bg-muted/50 text-foreground"
                          : "bg-primary/10 text-primary ml-auto max-w-[80%]"
                      }`}
                    >
                      <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="bg-muted/50 rounded-lg px-3 py-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
                {/* Chat input */}
                <div className="pt-1 border-t">
                  <SlashCommandInput
                    value={chatInput}
                    onChange={setChatInput}
                    onSend={(text) => sendChatRaw(text)}
                    commands={addressChatCommands}
                    busy={chatLoading}
                    placeholder="Ask about the fix plan. Enter to send. / for commands."
                  />
                </div>
              </div>
            )}

            {/* Fix proposals */}
            {fixPlan.length > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">
                    {fixPlan.length} Proposed Fix{fixPlan.length !== 1 ? "es" : ""}
                  </h3>
                  <div className="flex gap-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <ThumbsUp className="h-3 w-3" />
                      {fixPlan.filter((f) => f.approved && !f.skipped).length} approved
                    </span>
                    <span className="flex items-center gap-1">
                      <ThumbsDown className="h-3 w-3" />
                      {fixPlan.filter((f) => f.skipped).length} skipped
                    </span>
                  </div>
                </div>

                {fixPlan.map((fix, i) => (
                  <FixPlanCard
                    key={fix.commentId}
                    fix={fix}
                    index={i}
                    onToggleApprove={toggleApprove}
                    onToggleSkip={toggleSkip}
                    onAnnotationChange={setAnnotation}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border bg-card/60 p-6 text-center text-muted-foreground text-sm">
                No automatic fixes could be generated. The comments may require manual attention.
              </div>
            )}

            {stepError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <X className="h-4 w-4 shrink-0" /> {stepError}
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button onClick={handleApplyFixes} disabled={fixPlan.filter((f) => f.approved && !f.skipped).length === 0 && fixPlan.length > 0}>
                Apply {fixPlan.filter((f) => f.approved && !f.skipped).length} Approved Fix{fixPlan.filter((f) => f.approved && !f.skipped).length !== 1 ? "es" : ""}
              </Button>
              <Button
                variant="outline"
                onClick={loadDiff}
              >
                Skip to Diff Review
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setSelectedPr(null);
                  setStep("pr-list");
                  setFixPlan([]);
                  setChatHistory([]);
                }}
              >
                Back to PR List
              </Button>
            </div>
          </div>
        )}

        {/* ── Step: Diff Review ────────────────────────────────────────────── */}
        {step === "diff-review" && (
          <div className="space-y-4">
            <div className="rounded-xl border bg-card/60 p-4">
              <h2 className="text-sm font-semibold mb-3">Review Changes Before Committing</h2>
              {finalDiff ? (
                <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-[500px] overflow-y-auto bg-muted/50 rounded p-3">
                  {finalDiff}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No changes detected in the worktree.</p>
              )}
            </div>

            <div className="rounded-xl border bg-card/60 p-4 space-y-3">
              <h2 className="text-sm font-semibold">Commit Message</h2>
              <Textarea
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Enter a commit message…"
                className="font-mono text-sm min-h-[80px]"
              />
              {stepError && (
                <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <X className="h-4 w-4 shrink-0" /> {stepError}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  onClick={handleCommit}
                  disabled={!commitMessage.trim() || !finalDiff}
                  className="gap-1.5"
                >
                  <GitCommit className="h-4 w-4" />
                  Commit Changes
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setStep("fix-plan")}
                >
                  Back to Fix Plan
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step: Committing → Pushing ───────────────────────────────────── */}
        {(step === "committing" || step === "pushing") && (
          <div className="rounded-xl border bg-card/60 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <GitCommit className="h-5 w-5 text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium">{stepMessage}</p>
                {commitSha && (
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">sha: {commitSha}</p>
                )}
              </div>
            </div>

            {stepError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <X className="h-4 w-4 shrink-0" /> {stepError}
              </div>
            )}

            {step === "pushing" && (
              <div className="flex gap-2">
                <Button onClick={handlePush} className="gap-1.5">
                  <Upload className="h-4 w-4" />
                  Push to Origin
                </Button>
                <Button variant="ghost" onClick={onBack}>
                  Done for now (don't push yet)
                </Button>
              </div>
            )}
          </div>
        )}

        {/* ── Step: Done ───────────────────────────────────────────────────── */}
        {step === "done" && (
          <div className="rounded-xl border bg-card/60 p-8 flex flex-col items-center gap-4 text-center">
            <div className="rounded-full bg-green-500/15 p-4">
              <Check className="h-8 w-8 text-green-500" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Done!</h2>
              <p className="text-sm text-muted-foreground">
                Your fixes have been committed and pushed to{" "}
                <code className="font-mono">{selectedPr?.sourceBranch}</code>.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setSelectedPr(null);
                  setStep("pr-list");
                  setFixPlan([]);
                  setChatHistory([]);
                  setFinalDiff("");
                  loadPrs();
                }}
              >
                Address Another PR
              </Button>
              <Button variant="ghost" onClick={onBack}>
                Back to Home
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}





