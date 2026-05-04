import {
    createGlobalCommands,
    type SlashCommand,
} from "@/lib/slashCommands";
import { type OrchestratorMessage } from "@/lib/tauri/orchestrator";
import { type TriageMessage } from "@/lib/tauri/workflows";
import { useImplementTicketStore } from "@/stores/implementTicket/store";
import { type Stage } from "@/stores/implementTicket/types";
import { useMemo } from "react";

interface PipelineChatCommandsParams {
  currentStage: Stage;
  pendingApproval: Stage | null;
  triageHistory: TriageMessage[];
  groomingChat: TriageMessage[];
  orchestratorThread: OrchestratorMessage[];
  sendChatMessage: (text?: string) => Promise<void>;
  handleFinalizePlan: () => Promise<void>;
}

export function usePipelineChatCommands({
  currentStage,
  pendingApproval,
  triageHistory,
  groomingChat,
  orchestratorThread,
  sendChatMessage,
  handleFinalizePlan,
}: PipelineChatCommandsParams): SlashCommand[] {
  return useMemo(() => {
    // The "current" history depends on which slot is active. We merge every
    // active thread so /clear / /retry operate on whatever the user is
    // looking at — the pipeline UI shows all sections in one scrolling pane.
    const isCheckpointActive =
      pendingApproval !== null && pendingApproval !== "grooming";
    const activeStage: Stage | "triage" | "grooming" = isCheckpointActive
      ? (pendingApproval as Stage)
      : currentStage === "triage"
        ? "triage"
        : currentStage === "grooming" || pendingApproval === "grooming"
          ? "grooming"
          : "triage";
    // The orchestrator thread is the source of truth for every stage past
    // grooming/triage. Adapt its richer entry shape to the {role,content}
    // pair the slash-command helpers expect; tool-call entries don't map to
    // a chat role, so they're skipped here.
    const orchestratorAsTriage: TriageMessage[] = orchestratorThread
      .map((m): TriageMessage | null => {
        if (m.kind === "user") return { role: "user", content: m.content };
        if (m.kind === "assistant")
          return { role: "assistant", content: m.content };
        if (m.kind === "system_note")
          return { role: "assistant", content: `[${m.content}]` };
        return null; // tool_call — not part of the slash-command history
      })
      .filter((m): m is TriageMessage => m !== null);

    const history: TriageMessage[] =
      activeStage === "triage"
        ? triageHistory
        : activeStage === "grooming"
          ? groomingChat
          : orchestratorAsTriage;

    const clearActive = () => {
      // The chat panel is unified — it shows the grooming, triage, and the
      // orchestrator thread in one scroll. "/clear" matches that mental
      // model and wipes them all so the user actually sees the chat empty.
      // Stage outputs (grooming, plan, impact, etc.) are preserved; only the
      // back-and-forth conversations are cleared. The orchestrator's
      // persisted thread on the sidecar isn't reset — that requires a new
      // session — but the local mirror is so the UI matches expectation.
      useImplementTicketStore.setState({
        groomingChat: [],
        triageHistory: [],
        triageTurns: [],
        orchestratorThread: [],
        orchestratorPendingProposal: null,
        orchestratorStreamText: "",
      });
    };

    const dropLastAssistant = () => {
      useImplementTicketStore.setState((s) => {
        if (activeStage === "triage") {
          const h = s.triageHistory;
          if (h.length === 0 || h[h.length - 1].role !== "assistant") return s;
          return { ...s, triageHistory: h.slice(0, -1) };
        }
        if (activeStage === "grooming") {
          const h = s.groomingChat;
          if (h.length === 0 || h[h.length - 1].role !== "assistant") return s;
          return { ...s, groomingChat: h.slice(0, -1) };
        }
        // Orchestrator: drop trailing assistant entry (and any tool_call
        // entries immediately preceding it) so the user can re-prompt.
        const t = s.orchestratorThread;
        let cut = t.length;
        while (cut > 0 && t[cut - 1].kind === "assistant") cut--;
        // Also drop trailing tool_call entries that belonged to that turn.
        while (cut > 0 && t[cut - 1].kind === "tool_call") cut--;
        if (cut === t.length) return s;
        return { ...s, orchestratorThread: t.slice(0, cut) };
      });
    };

    const isTriageActive =
      currentStage === "triage" && pendingApproval === null;

    const baseCommands: SlashCommand[] = [
      ...createGlobalCommands({
        history,
        clearHistory: clearActive,
        sendMessage: (text: string) => sendChatMessage(text),
        removeLastAssistantMessage: dropLastAssistant,
      }),
    ];

    // Stage-specific commands. We expose everything unconditionally —
    // commands that don't apply to the current stage still resolve and
    // produce a contextual message. Filtering by stage would feel more
    // opinionated but also hide the capability from users exploring via /.
    const triageCommands: SlashCommand[] = [
      {
        name: "plan",
        description: "Show the current implementation plan",
        execute: async () => {
          await sendChatMessage(
            "Please share the current implementation plan in its latest form.",
          );
        },
      },
      {
        name: "files",
        description: "Glob the worktree for files matching a pattern",
        args: "<pattern>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a pattern, e.g. /files src/**/*.tsx");
            return;
          }
          await sendChatMessage(
            `Use glob_repo_files to list files matching \`${args.trim()}\`. Summarise the key ones.`,
          );
        },
      },
      {
        name: "grep",
        description: "Grep the worktree",
        args: "<pattern>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a pattern, e.g. /grep TODO");
            return;
          }
          await sendChatMessage(
            `Use grep_repo_files to find \`${args.trim()}\` in the worktree. Report top matches.`,
          );
        },
      },
      {
        name: "risk",
        description: "Ask the AI to summarise impact/risk findings",
        execute: async () => {
          await sendChatMessage(
            "Summarise the impact-analysis findings — what's risky about this change?",
          );
        },
      },
      {
        name: "finalize",
        description: "Finalise the plan (advances past Triage)",
        execute: async ({ toast: t }) => {
          if (!isTriageActive) {
            t.info("Finalise is only available during Triage");
            return;
          }
          await handleFinalizePlan();
        },
      },
    ];

    const checkpointCommands: SlashCommand[] = [
      {
        name: "approve",
        aliases: ["next"],
        description: "Approve the current stage (use the button above)",
        execute: ({ toast: t }) => {
          t.info("Use the Approve button to confirm this stage", {
            description:
              "Approval commits output to disk — surfaced as a button so it's unambiguous.",
          });
        },
      },
      {
        name: "reject",
        description: "Reject this stage with a reason",
        args: "<reason>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a reason, e.g. /reject needs more tests");
            return;
          }
          await sendChatMessage(
            `I'm rejecting this stage: ${args.trim()}. Please revise.`,
          );
        },
      },
      {
        name: "diff",
        description: "Ask the AI to summarise the current diff",
        execute: async () => {
          await sendChatMessage(
            "Summarise the current diff from the worktree — files touched and key changes.",
          );
        },
      },
      {
        name: "stage",
        description: "Show which pipeline stage is active",
        execute: ({ toast: t }) => {
          const label = pendingApproval
            ? `Pending approval: ${pendingApproval}`
            : `Current stage: ${currentStage}`;
          t("Stage", { description: label });
        },
      },
    ];

    return [...baseCommands, ...triageCommands, ...checkpointCommands];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentStage,
    pendingApproval,
    triageHistory,
    groomingChat,
    orchestratorThread,
  ]);
}
