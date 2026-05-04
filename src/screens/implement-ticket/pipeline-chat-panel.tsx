import { MarkdownBlock } from "@/components/MarkdownBlock";
import {
    OrchestratorEntry,
    ProposalCard,
    groupOrchestratorThreadByStage,
} from "@/components/OrchestratorPanel";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import {
    ToolRequestCard,
    type ToolRequest,
} from "@/components/ToolRequestCard";
import { Button } from "@/components/ui/button";
import type { SlashCommand } from "@/lib/slashCommands";
import { type OrchestratorMessage, type OrchestratorPendingProposal } from "@/lib/tauri/orchestrator";
import { type GroomingOutput, type TriageMessage } from "@/lib/tauri/workflows";
import { type ImplementTicketState, type Stage } from "@/stores/implementTicket/types";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { PipelineActivityStrip } from "./_shared";

interface PipelineChatPanelProps {
  grooming: GroomingOutput | null;
  groomingChat: TriageMessage[];
  triageHistory: TriageMessage[];
  /** Long-lived orchestrator thread that spans every post-triage stage.
   *  Each entry is one user/assistant/tool/system_note. */
  orchestratorThread: OrchestratorMessage[];
  /** Outstanding proposal awaiting user accept/reject (renders as a confirm
   *  card at the bottom of the thread). */
  orchestratorPendingProposal: OrchestratorPendingProposal | null;
  onAcceptProposal: () => void;
  onRejectProposal: () => void;
  currentStage: Stage;
  pendingApproval: Stage | null;
  toolRequests: ToolRequest[];
  onDismissToolRequest: (id: string) => void;
  chatInput: string;
  onChatInputChange: (v: string) => void;
  /** Send text through the unified pipeline send function. */
  onSend: (text: string) => void;
  onCancel: () => void;
  onFinalizePlan: () => void;
  sending: boolean;
  finalizing: boolean;
  proceeding: boolean;
  streamingText: string;
  /** Slash-command set. Built by the caller based on which stage is active. */
  commands: SlashCommand[];
  /** Live "what is the agent doing" snapshot from pipeline progress
   *  events. Drives the activity strip above the chat input — null
   *  when no pipeline run is active. */
  pipelineActivity: ImplementTicketState["pipelineActivity"];
  /** User-initiated abort of the active pipeline run. */
  onStopPipeline: () => void;
}

const CHAT_STAGE_LABEL: Partial<Record<Stage, string>> = {
  grooming: "Grooming",
  triage: "Triage",
  impact: "Impact Analysis",
  plan: "Implementation Plan",
  implementation: "Implementation",
  replan: "Plan Revision",
  tests_plan: "Test Plan",
  tests: "Tests",
  review: "Code Review",
  pr: "PR Description",
  retro: "Retrospective",
};

export function PipelineChatPanel({
  grooming,
  groomingChat,
  triageHistory,
  orchestratorThread,
  orchestratorPendingProposal,
  onAcceptProposal,
  onRejectProposal,
  currentStage,
  pendingApproval,
  toolRequests,
  onDismissToolRequest,
  chatInput,
  onChatInputChange,
  onSend,
  onCancel,
  onFinalizePlan,
  sending,
  finalizing,
  proceeding,
  streamingText,
  commands,
  pipelineActivity,
  onStopPipeline,
}: PipelineChatPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [groomingChat, triageHistory, orchestratorThread, sending]);

  useEffect(() => {
    if (!sending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || (e.key === "c" && e.ctrlKey)) {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sending, onCancel]);

  // Build the unified message thread.
  //   - Grooming chat: dedicated TriageMessage[] (sub-agent state).
  //   - Triage history: dedicated TriageMessage[] (sub-agent state),
  //     dropping the seeded "please analyse" user prompt that leaks
  //     sub-agent plumbing.
  //   - Everything past triage: one continuous orchestrator thread the
  //     orchestrator persists across stages. We slice it by `stage` field
  //     so the UI can still draw stage dividers.
  type LegacySection = { kind: "legacy"; stage: Stage; messages: TriageMessage[] };
  type OrchSection = { kind: "orchestrator"; stage: Stage; messages: OrchestratorMessage[] };
  const sections: Array<LegacySection | OrchSection> = [];
  if (groomingChat.length > 0)
    sections.push({ kind: "legacy", stage: "grooming", messages: groomingChat });
  if (triageHistory.length > 0) {
    const turnsForChat = triageHistory.slice(
      triageHistory[0]?.role === "user" ? 1 : 0,
    );
    if (turnsForChat.length > 0) {
      sections.push({ kind: "legacy", stage: "triage", messages: turnsForChat });
    }
  }
  // Group orchestrator entries by `stage` (preserving order) so the UI can
  // draw stage dividers between switches. Entries with no stage tag fall
  // back to "implementation" for the divider label only — the underlying
  // entry still renders untagged.
  if (orchestratorThread.length > 0) {
    for (const g of groupOrchestratorThreadByStage(orchestratorThread)) {
      sections.push({
        kind: "orchestrator",
        stage: (g.stage ?? "implementation") as Stage,
        messages: g.entries,
      });
    }
  }

  // Determine if input is active
  const isGroomingActive =
    pendingApproval === "grooming" ||
    (currentStage === "grooming" && grooming !== null);
  const isCheckpointActive =
    pendingApproval !== null && pendingApproval !== "grooming";
  const isTriageActive = currentStage === "triage" && pendingApproval === null;
  const inputActive = isGroomingActive || isCheckpointActive || isTriageActive;
  const agentRunning =
    !inputActive && currentStage !== "select" && currentStage !== "complete";

  const placeholder = isGroomingActive
    ? "Suggest changes to the ticket or ask questions…"
    : isTriageActive
      ? "Respond to the agent's proposal or provide clarification…"
      : isCheckpointActive
        ? "Ask about these findings…"
        : agentRunning
          ? "Agent is running…"
          : "Pipeline complete";

  const showFinalize = isTriageActive && triageHistory.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0 border-l bg-background/40">
      {/* Panel header */}
      <div className="shrink-0 px-4 py-2.5 border-b flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Agent Chat
        </p>
        {agentRunning && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Running…
          </div>
        )}
      </div>

      {/* Chat thread — scrollable */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-1">
        {sections.length === 0 && !sending && (
          <p className="text-xs text-muted-foreground italic text-center pt-6">
            No messages yet. The conversation will appear here once the grooming
            stage completes.
          </p>
        )}

        {sections.map((section, sectionIdx) => (
          <div key={`${section.kind}-${section.stage}-${sectionIdx}`}>
            {/* Stage divider */}
            <div className="flex items-center gap-2 py-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground px-1">
                {CHAT_STAGE_LABEL[section.stage] ?? section.stage}
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="space-y-2">
              {section.kind === "legacy"
                ? section.messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                          msg.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-foreground"
                        }`}
                      >
                        {msg.role === "assistant" ? (
                          <MarkdownBlock
                            text={
                              section.stage === "grooming"
                                ? msg.content
                                    .replace(/```json[\s\S]*?```/g, "")
                                    .trim() || msg.content
                                : msg.content
                            }
                          />
                        ) : (
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                        )}
                      </div>
                    </div>
                  ))
                : section.messages.map((m, i) => (
                    <OrchestratorEntry key={i} entry={m} />
                  ))}
            </div>
          </div>
        ))}

        {/* Live confirm card for any outstanding orchestrator proposal —
            sits at the very bottom of the thread so the user always sees it
            after scrolling to the latest turn. */}
        {orchestratorPendingProposal && (
          <ProposalCard
            proposal={orchestratorPendingProposal}
            onAccept={onAcceptProposal}
            onReject={onRejectProposal}
            disabled={sending || proceeding}
          />
        )}

        {/* Tool requests */}
        {toolRequests
          .filter((r) => !r.dismissed)
          .map((r) => (
            <ToolRequestCard
              key={r.id}
              request={r}
              onDismiss={onDismissToolRequest}
            />
          ))}

        {/* Sending indicator — shows streaming text as it arrives, falls back to spinner */}
        {sending && (
          <div className="flex justify-start pt-1">
            {streamingText ? (
              <pre className="text-xs font-mono bg-muted rounded-lg px-3 py-2 whitespace-pre-wrap max-w-full overflow-x-auto text-foreground">
                {streamingText}
              </pre>
            ) : (
              <div className="bg-muted rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area — pinned to bottom */}
      <div className="shrink-0 px-4 pb-4 pt-2 border-t space-y-2">
        {pipelineActivity && (
          <PipelineActivityStrip
            activity={pipelineActivity}
            onStop={onStopPipeline}
          />
        )}
        {showFinalize && (
          <Button
            size="sm"
            variant="outline"
            className="w-full gap-2"
            onClick={onFinalizePlan}
            disabled={finalizing || sending}
          >
            {finalizing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finalising
                plan…
              </>
            ) : (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> Finalise Plan
              </>
            )}
          </Button>
        )}
        <SlashCommandInput
          value={chatInput}
          onChange={onChatInputChange}
          onSend={(text) => {
            if (inputActive) onSend(text);
          }}
          commands={commands}
          busy={!inputActive || sending || finalizing || proceeding}
          placeholder={placeholder}
        />
        {sending ? (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">AI is thinking…</p>
            <button
              onClick={onCancel}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <span className="font-mono bg-muted px-1 rounded">Esc</span> cancel
            </button>
          </div>
        ) : inputActive ? (
          <p className="text-xs text-muted-foreground">Enter to send · Shift+Enter for newline</p>
        ) : null}
      </div>
    </div>
  );
}
