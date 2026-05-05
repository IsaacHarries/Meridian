import {
    APP_HEADER_BAR,
    APP_HEADER_ROW_PANEL,
    APP_HEADER_TITLE,
} from "@/components/appHeaderLayout";
import { HeaderModelPicker } from "@/components/HeaderModelPicker";
import { HeaderRecordButton } from "@/components/HeaderRecordButton";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { HeaderTimeTracker } from "@/components/HeaderTimeTracker";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import { PipelineProgress } from "@/components/PipelineProgress";
import { type ToolRequest } from "@/components/ToolRequestCard";
import { Button } from "@/components/ui/button";
import { openUrl } from "@/lib/tauri/core";
import { type CredentialStatus, aiProviderComplete, jiraComplete } from "@/lib/tauri/credentials";
import { type JiraIssue, getMySprintIssues } from "@/lib/tauri/jira";
import { enrichMessageWithUrls } from "@/lib/urlFetch";
import { cn } from "@/lib/utils";
import type { StageId as ImplementStageId } from "@/stores/aiSelectionStore";
import { consumePendingResume, snapshotSession } from "@/stores/implementTicket/helpers";
import { useImplementTicketStore } from "@/stores/implementTicket/store";
import { type Stage } from "@/stores/implementTicket/types";
import {
    ArrowLeft,
    CheckCircle2,
    ExternalLink,
    PanelLeftClose,
    PanelLeftOpen,
    RefreshCw,
    Search,
    X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyButton, STAGE_LABELS, stageToStep } from "./implement-ticket/_shared";
import { usePipelineChatCommands } from "./implement-ticket/pipeline-chat-commands";
import { PipelineChatPanel } from "./implement-ticket/pipeline-chat-panel";
import { usePipelineEventListeners } from "./implement-ticket/pipeline-event-listeners";
import { PipelineSidebar } from "./implement-ticket/pipeline-sidebar";
import { StageContent } from "./implement-ticket/stage-content";
import { TicketSelector } from "./implement-ticket/ticket-selector";

interface ImplementTicketScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function ImplementTicketScreen({
  credStatus,
  onBack,
}: ImplementTicketScreenProps) {
  const claudeAvailable = aiProviderComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  // ── Store bindings (persistent state — survives navigation) ──────────────────
  const {
    selectedIssue,
    currentStage,
    viewingStage,
    completedStages,
    pendingApproval,
    proceeding,
    grooming,
    impact,
    triageHistory,
    triageTurns,
    plan,
    implementation,
    implementationStreamText,
    implementationProgress,
    pipelineActivity,
    buildVerification,
    buildCheckStreamText,
    replanCheckpoint,
    testPlan,
    tests,
    review,
    prDescription,
    createdPr,
    prSubmitStatus,
    prSubmitError,
    retrospective,
    partialGrooming,
    partialImpact,
    partialPlan,
    partialReview,
    partialPrDescription,
    partialRetrospective,
    groomingBlockers,

    groomingEdits,
    clarifyingQuestions,
    clarifyingQuestionsInitial,
    groomingHighlights,
    showHighlights,
    filesRead,
    groomingChat,
    groomingBaseline,
    jiraUpdateStatus,
    jiraUpdateError,
    groomingProgress,
    groomingStreamText,
    triageStreamText,
    testsStreamText,
    orchestratorThread,
    orchestratorPendingProposal,
    orchestratorStreamText,
    orchestratorSending,
    errors,
    sessions: implementSessions,
  } = useImplementTicketStore();

  const store = useImplementTicketStore.getState;

  // ── Find-in-page search ──────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<"" | "no-match">("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isFind = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f";
      if (isFind) {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.select(), 0);
      } else if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchStatus("");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  function findNext(direction: "forward" | "backward") {
    if (!searchQuery.trim()) return;
    // window.find is non-standard but supported in WebKit/Chromium webviews.
    const found = (window as unknown as {
      find: (
        s: string,
        caseSensitive: boolean,
        backwards: boolean,
        wrap: boolean,
      ) => boolean;
    }).find(searchQuery, false, direction === "backward", true);
    setSearchStatus(found ? "" : "no-match");
  }

  // Auto-resume a stage that was interrupted when the app was closed last session.
  // consumePendingResume() returns the stage once and clears it, so this only fires once.
  useEffect(() => {
    const interrupted = consumePendingResume();
    if (interrupted) {
      store().retryStage(interrupted);
    }
  }, []);

  // Set of issue keys with cached (or active) pipeline sessions
  const sessionKeys = useMemo(
    () =>
      new Set([
        ...implementSessions.keys(),
        ...(selectedIssue ? [selectedIssue.key] : []),
      ]),
    [implementSessions, selectedIssue],
  );

  // ── Ephemeral UI state (local — reset on each visit is fine) ─────────────────
  const [sprintIssues, setSprintIssues] = useState<JiraIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [planFinalizing, setPlanFinalizing] = useState(false);
  const [meridianHeaderVisible, setMeridianHeaderVisible] = useState(false);
  const [splitPct, setSplitPct] = useState(62);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [toolRequests, setToolRequests] = useState<ToolRequest[]>([]);
  const [implementationTab, setImplementationTab] = useState<"status" | "diff">("status");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ── Resizable split pane (percentage-based) ───────────────────────────────────
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMouseMove = (ev: MouseEvent) => {
      const x = ev.clientX - rect.left;
      const pct = Math.min(80, Math.max(30, (x / rect.width) * 100));
      setSplitPct(pct);
    };
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  // ── Backend event listeners — write directly to store ────────────────────────
  // Each listener captures the session ID at event time and drops writes for stale sessions.
  usePipelineEventListeners(setToolRequests);

  // ── Load sprint issues ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!jiraAvailable) {
      setLoadingIssues(false);
      return;
    }
    getMySprintIssues()
      .then(setSprintIssues)
      .catch(() => {})
      .finally(() => setLoadingIssues(false));
  }, [jiraAvailable]);

  useEffect(() => {
    const t = window.setTimeout(() => setMeridianHeaderVisible(true), 0);
    return () => clearTimeout(t);
  }, []);

  const cancelledRef = useRef(false);

  function cancelChat() {
    cancelledRef.current = true;
    setChatSending(false);
  }

  // ── Unified chat send — routes to store based on current pipeline stage ───────
  // Accepts the text directly so slash-commands can send synthetic prompts
  // (e.g. /plan sends "Show the current implementation plan") without going
  // through the chatInput state, which SlashCommandInput may have already
  // cleared before invoking the callback.
  async function sendChatMessage(text?: string) {
    const msg = (text ?? chatInput).trim();
    if (!msg) return;
    if (text === undefined) setChatInput("");
    cancelledRef.current = false;
    setChatSending(true);
    try {
      const enriched = await enrichMessageWithUrls(msg);
      await store().sendPipelineMessage(enriched);
    } catch {
      /* handled in store */
    } finally {
      if (!cancelledRef.current) setChatSending(false);
    }
  }

  async function handleFinalizePlan() {
    setPlanFinalizing(true);
    try {
      await store().finalizePlan();
    } finally {
      setPlanFinalizing(false);
    }
  }

  const pipelineChatCommands = usePipelineChatCommands({
    currentStage,
    pendingApproval,
    triageHistory,
    groomingChat,
    orchestratorThread,
    sendChatMessage,
    handleFinalizePlan,
  });

  function dismissToolRequest(id: string) {
    setToolRequests((prev) =>
      prev.map((r) => (r.id === id ? { ...r, dismissed: true } : r)),
    );
  }

  // Start pipeline — delegate entirely to store
  const startPipeline = useCallback((issue: JiraIssue) => {
    store().startPipeline(issue);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      <header className={cn(APP_HEADER_BAR, "z-20 shrink-0")}>
        <div className={cn(APP_HEADER_ROW_PANEL, "relative")}>
          {/* Back + title — left (same slot as other panels). `flex-1 min-w-0`
              lets the title shrink/truncate when the workspace narrows so the
              right-side icons (settings, tasks, etc.) never get pushed off
              the row. */}
          <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={
                currentStage === "select"
                  ? onBack
                  : () => {
                      const cur = store();
                      // Save current session unless grooming never completed (stale in-flight run)
                      if (
                        cur.selectedIssue &&
                        cur.currentStage !== "select" &&
                        !(
                          cur.currentStage === "grooming" &&
                          cur.grooming === null
                        )
                      ) {
                        const newSessions = new Map(cur.sessions);
                        newSessions.set(
                          cur.selectedIssue.key,
                          snapshotSession(cur),
                        );
                        cur._set({ sessions: newSessions });
                      }
                      cur._set({
                        selectedIssue: null,
                        currentStage: "select",
                        isSessionActive: false,
                      });
                    }
              }
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className={APP_HEADER_TITLE}>
              Implement a Ticket
            </span>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="relative z-30 shrink-0"
            onClick={() => {
              setSearchOpen((v) => !v);
              if (!searchOpen) {
                setTimeout(() => searchInputRef.current?.select(), 0);
              }
            }}
            title="Search this panel (⌘/Ctrl+F)"
          >
            <Search className="h-4 w-4" />
          </Button>
          <HeaderModelPicker
            panel="implement_ticket"
            stage={
              currentStage === "select" || viewingStage === "complete"
                ? null
                : (viewingStage as ImplementStageId)
            }
            className="relative z-30"
          />
          <HeaderTimeTracker className="relative z-30" />
          <HeaderRecordButton className="relative z-30" />
          <HeaderSettingsButton className="relative z-30 shrink-0" />

          {/* Meridian mark centred in header; morphs to pipeline ring when a ticket run is active */}
          <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <div
              className={cn(
                "absolute bottom-0 left-1/2 flex h-14 min-h-0 -translate-x-1/2 justify-center overflow-hidden",
                currentStage !== "select"
                  ? "w-1/2 max-w-md"
                  : "w-auto max-w-md",
                meridianHeaderVisible ? "opacity-100" : "opacity-0",
              )}
              style={{
                transition:
                  "width 700ms ease-in-out, max-width 700ms ease-in-out, opacity 1000ms ease-out",
              }}
            >
              <PipelineProgress
                activeStep={
                  currentStage === "select"
                    ? undefined
                    : stageToStep(viewingStage)
                }
                logoAlign="center"
                className={`block h-full min-h-0 opacity-100 transition-opacity duration-300 ease-out ${
                  currentStage === "select" ? "w-auto max-h-14" : "w-full"
                }`}
              />
            </div>
          </div>
        </div>
      </header>

      {/* Find-in-page search bar */}
      {searchOpen && (
        <div className="shrink-0 border-b bg-muted/30 px-4 py-2 flex items-center gap-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchStatus("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                findNext(e.shiftKey ? "backward" : "forward");
              } else if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchStatus("");
              }
            }}
            placeholder="Find in panel… (Enter for next, Shift+Enter for previous)"
            className="flex-1 min-w-0 bg-background border border-input rounded-md px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          {searchStatus === "no-match" && searchQuery && (
            <span className="text-xs text-amber-600 dark:text-amber-400 shrink-0">
              No matches
            </span>
          )}
          <button
            onClick={() => findNext("backward")}
            disabled={!searchQuery.trim()}
            className="text-xs px-2 py-0.5 rounded border hover:bg-muted disabled:opacity-40 transition-colors"
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={() => findNext("forward")}
            disabled={!searchQuery.trim()}
            className="text-xs px-2 py-0.5 rounded border hover:bg-muted disabled:opacity-40 transition-colors"
            title="Next match (Enter)"
          >
            ↓
          </button>
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchStatus("");
            }}
            className="text-xs text-muted-foreground hover:text-foreground p-1"
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Ticket info bar — shown once a ticket is selected */}
      {selectedIssue && (
        <div className="shrink-0 px-4 py-1.5 border-b bg-muted/20 flex items-center gap-2 min-w-0">
          <JiraTicketLink
            ticketKey={selectedIssue.key}
            url={selectedIssue.url}
          />
          <span className="text-xs text-muted-foreground truncate flex-1">
            — {selectedIssue.summary}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => selectedIssue.url && openUrl(selectedIssue.url)}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1" /> JIRA
          </Button>
        </div>
      )}

      {/* Credential warnings */}
      {(!jiraAvailable || !claudeAvailable) && (
        <div className="shrink-0 px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-200">
          {!jiraAvailable && "JIRA credentials not configured. "}
          {!claudeAvailable &&
            "No AI provider configured — add an Anthropic key, Gemini key, or local LLM URL in Settings."}
        </div>
      )}

      {/* Body — full-width card; fills viewport below chrome so only the stage panel scrolls */}
      <div
        className={`flex min-h-0 flex-1 flex-col overflow-hidden ${currentStage === "select" ? "p-4" : "px-2 py-2"}`}
      >
        <div
          className={`flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl bg-background/60 ${currentStage === "select" ? "mx-auto max-w-3xl" : ""}`}
        >
          {currentStage === "select" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <TicketSelector
                sprintIssues={sprintIssues}
                loading={loadingIssues}
                onSelect={startPipeline}
                sessionKeys={sessionKeys}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {!sidebarCollapsed && (
                <PipelineSidebar
                  currentStage={currentStage}
                  completedStages={completedStages}
                  activeStage={viewingStage}
                  pendingApproval={pendingApproval}
                  onClickStage={(s) =>
                    store()._set({ viewingStage: s as Exclude<Stage, "select"> })
                  }
                />
              )}

              {/* ── Split container: stage content | divider | chat panel ── */}
              <div
                ref={splitContainerRef}
                className="flex min-h-0 flex-1 overflow-hidden"
              >
                {/* Left: stage content */}
                <div
                  style={{ width: `${splitPct}%` }}
                  className="flex-none flex flex-col min-h-0 overflow-hidden"
                >
                  <div className="shrink-0 px-5 pt-5">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setSidebarCollapsed((c) => !c)}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title={sidebarCollapsed ? "Show pipeline sidebar" : "Hide pipeline sidebar"}
                        >
                          {sidebarCollapsed ? (
                            <PanelLeftOpen className="h-4 w-4" />
                          ) : (
                            <PanelLeftClose className="h-4 w-4" />
                          )}
                        </button>
                        <h2 className="text-base font-semibold">
                          {viewingStage === "triage" &&
                          !completedStages.has("plan")
                            ? "Triage"
                            : viewingStage === "triage" ||
                                viewingStage === "plan"
                              ? "Implementation Plan"
                              : STAGE_LABELS[
                                  viewingStage as keyof typeof STAGE_LABELS
                                ]}
                        </h2>
                        {viewingStage !== "complete" && (
                          <button
                            onClick={() =>
                              store().retryStage(viewingStage as Stage)
                            }
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            title={`Re-run the ${
                              STAGE_LABELS[
                                viewingStage as keyof typeof STAGE_LABELS
                              ] ?? viewingStage
                            } agent`}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {viewingStage === "implementation" && implementation && (
                          <div className="flex gap-0.5">
                            {(["status", "diff"] as const).map((t) => (
                              <button
                                key={t}
                                onClick={() => setImplementationTab(t)}
                                className={cn(
                                  "text-xs px-2.5 py-0.5 rounded font-medium capitalize",
                                  implementationTab === t
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                                )}
                              >
                                {t === "status" ? "Status" : "Diff"}
                              </button>
                            ))}
                          </div>
                        )}
                        {currentStage === "complete" &&
                          viewingStage === "retro" && (
                            <p className="flex items-center gap-1 text-xs font-medium text-green-600">
                              <CheckCircle2 className="h-3 w-3" /> Pipeline
                              complete
                            </p>
                          )}
                      </div>
                      {completedStages.has(viewingStage as Stage) &&
                        (viewingStage === "grooming" ||
                          viewingStage === "impact" ||
                          viewingStage === "tests" ||
                          viewingStage === "review") && (
                          <CopyButton
                            text={
                              JSON.stringify(
                                viewingStage === "grooming"
                                  ? grooming
                                  : viewingStage === "impact"
                                    ? impact
                                    : viewingStage === "tests"
                                      ? tests
                                      : review,
                                null,
                                2,
                              ) ?? ""
                            }
                            label="Copy JSON"
                          />
                        )}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
                    <StageContent
                      stage={viewingStage}
                      selectedIssue={selectedIssue}
                      errors={errors}
                      completedStages={completedStages}
                      proceeding={proceeding}
                      grooming={grooming}
                      partialGrooming={partialGrooming}
                      impact={impact}
                      partialImpact={partialImpact}
                      plan={plan}
                      partialPlan={partialPlan}
                      implementation={implementation}
                      implementationStreamText={implementationStreamText}
                      implementationProgress={implementationProgress}
                      buildVerification={buildVerification}
                      buildCheckStreamText={buildCheckStreamText}
                      replanCheckpoint={replanCheckpoint}
                      testPlan={testPlan}
                      tests={tests}
                      testsStreamText={testsStreamText}
                      review={review}
                      partialReview={partialReview}
                      prDescription={prDescription}
                      partialPrDescription={partialPrDescription}
                      createdPr={createdPr}
                      prSubmitStatus={prSubmitStatus}
                      prSubmitError={prSubmitError}
                      retrospective={retrospective}
                      partialRetrospective={partialRetrospective}
                      groomingEdits={groomingEdits}
                      clarifyingQuestions={clarifyingQuestions}
                      clarifyingQuestionsInitial={clarifyingQuestionsInitial}
                      groomingHighlights={groomingHighlights}
                      showHighlights={showHighlights}
                      filesRead={filesRead}
                      groomingBaseline={groomingBaseline}
                      jiraUpdateStatus={jiraUpdateStatus}
                      jiraUpdateError={jiraUpdateError}
                      groomingProgress={groomingProgress}
                      groomingStreamText={groomingStreamText}
                      groomingBlockers={groomingBlockers}
                      triageHistory={triageHistory}
                      triageTurns={triageTurns}
                      triageStreamText={triageStreamText}
                      planFinalizing={planFinalizing}
                      implementationTab={implementationTab}
                      currentStage={currentStage}
                    />
                  </div>
                </div>

                {/* Drag divider */}
                <div
                  onMouseDown={onDividerMouseDown}
                  className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/30 active:bg-primary/50 transition-colors"
                />

                {/* Right: persistent chat panel */}
                <div
                  style={{ width: `${100 - splitPct}%` }}
                  className="flex-none min-h-0 overflow-hidden"
                >
                  <PipelineChatPanel
                    grooming={grooming}
                    groomingChat={groomingChat}
                    triageHistory={triageHistory}
                    orchestratorThread={orchestratorThread}
                    orchestratorPendingProposal={orchestratorPendingProposal}
                    onAcceptProposal={() =>
                      store().resolveOrchestratorProposal("accepted")
                    }
                    onRejectProposal={() =>
                      store().resolveOrchestratorProposal("rejected")
                    }
                    currentStage={currentStage}
                    pendingApproval={pendingApproval}
                    toolRequests={toolRequests}
                    onDismissToolRequest={dismissToolRequest}
                    chatInput={chatInput}
                    onChatInputChange={setChatInput}
                    onSend={sendChatMessage}
                    onCancel={cancelChat}
                    onFinalizePlan={handleFinalizePlan}
                    sending={chatSending || orchestratorSending}
                    finalizing={planFinalizing}
                    proceeding={proceeding}
                    streamingText={
                      currentStage === "triage"
                        ? triageStreamText
                        : orchestratorStreamText
                    }
                    commands={pipelineChatCommands}
                    pipelineActivity={pipelineActivity}
                    onStopPipeline={() => void store().stopActivePipeline()}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
