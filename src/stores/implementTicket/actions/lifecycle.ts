import { useTokenUsageStore } from "@/stores/tokenUsageStore";

import { loadAgentSkills } from "@/lib/tauri/templates";
import { cancelImplementationPipelineWorkflow, rewindImplementationPipelineWorkflow } from "@/lib/tauri/workflows";
import { STAGE_TO_REWIND_NODE } from "../constants";
import { applyWorkflowResult } from "../helpers";
import { INITIAL } from "../initial";
import type { ImplementTicketState, Stage } from "../types";

type Set = (
  partial:
    | Partial<ImplementTicketState>
    | ((s: ImplementTicketState) => Partial<ImplementTicketState>),
) => void;
type Get = () => ImplementTicketState;

export function createLifecycleActions(set: Set, get: Get) {
  return {
    _set: (partial: Partial<ImplementTicketState>) =>
      set(partial as Partial<ImplementTicketState>),

    resetSession: () => {
      set((s) => ({ ...INITIAL, sessions: s.sessions }));
      // The orchestrator chat thread is per-session — picking a new
      // ticket starts a fresh thread, so the recorded chat-context
      // size on the panel is no longer meaningful. Clear it so the
      // header context ring resets to empty until the new thread's
      // first turn lands.
      useTokenUsageStore.getState().clearPanelChatLastInput("implement_ticket");
    },

    /**
     * Reload agent skills from disk and write to state. Called at the start of
     * every stage so edits made in Agent Skills while a pipeline is paused
     * take effect on the next agent run. Disk cost is negligible (one small
     * JSON file read per stage) and failures are non-fatal — if the skills
     * file can't be read, we keep whatever was loaded previously.
     */
    _reloadSkills: async () => {
      try {
        const skills = await loadAgentSkills();
        set({ skills });
      } catch {
        /* keep existing skills */
      }
    },

    markComplete: (stage: Stage) =>
      set((s) => ({ completedStages: new Set([...s.completedStages, stage]) })),

    setError: (stage: Stage, err: string) =>
      set((s) => ({ errors: { ...s.errors, [stage]: err } })),

    stopActivePipeline: async () => {
      const runId = get().currentRunId;
      // Local-state cleanup first so the UI stops showing "thinking"
      // and the activity strip vanishes even if the cancel call hangs.
      set({
        proceeding: false,
        currentRunId: null,
        pipelineActivity: null,
      });
      if (!runId) return;
      try {
        await cancelImplementationPipelineWorkflow(runId);
      } catch (e) {
        // Cancel is best-effort — the run may have completed in the
        // window between the click and the IPC, or the sidecar may have
        // restarted. Either way the listener's stale-event guard will
        // ignore any further events that arrive for this runId.
        console.warn("[Meridian] cancel pipeline failed:", e);
      }
    },

    clearError: (stage: Stage) =>
      set((s) => {
        const errors = { ...s.errors };
        delete errors[stage];
        return { errors };
      }),

    retryStage: async (stage: Stage) => {
      const s = get();
      const errors = { ...s.errors };
      delete errors[stage];
      const completedStages = new Set(
        [...s.completedStages].filter((st) => st !== stage),
      );
      const pendingApproval =
        s.pendingApproval === stage ? null : s.pendingApproval;

      const outputResets: Partial<ImplementTicketState> = {};
      switch (stage) {
        case "grooming":
          // Keep `groomingChat` so the user's prior Q&A with the grooming
          // agent survives a retry — otherwise a single bad agent response
          // throws away context the user had already typed out. Everything
          // else is tied to a single analysis run and must reset.
          Object.assign(outputResets, {
            grooming: null,
            partialGrooming: null,
            groomingEdits: [],
            clarifyingQuestions: [],
            clarifyingQuestionsInitial: [],
            groomingHighlights: {
              editIds: [],
              questions: false,
            },
            groomingBlockers: [],
            groomingProgress: "",
            groomingStreamText: "",
            filesRead: [],
          });
          break;
        case "impact":
          Object.assign(outputResets, {
            impact: null,
            partialImpact: null,
            impactStreamText: "",
          });
          break;
        case "triage":
          Object.assign(outputResets, {
            triageHistory: [],
            triageTurns: [],
            triageStreamText: "",
            partialTriageTurn: null,
          });
          break;
        case "plan":
          Object.assign(outputResets, {
            plan: null,
            guidance: null,
            planStreamText: "",
            partialPlan: null,
            partialGuidance: null,
          });
          break;
        case "implementation":
          Object.assign(outputResets, {
            implementation: null,
            implementationStreamText: "",
            implementationProgress: null,
            pipelineActivity: null,
            buildVerification: null,
            buildCheckStreamText: "",
            guidance: null,
          });
          break;
        case "tests_plan":
          // Re-running the proposal also invalidates whatever tests were
          // written from the prior plan.
          Object.assign(outputResets, {
            testPlan: null,
            tests: null,
            testsStreamText: "",
          });
          break;
        case "tests":
          Object.assign(outputResets, { tests: null, testsStreamText: "" });
          break;
        case "review":
          Object.assign(outputResets, {
            review: null,
            partialReview: null,
            reviewStreamText: "",
          });
          break;
        case "pr":
          Object.assign(outputResets, {
            prDescription: null,
            partialPrDescription: null,
            prStreamText: "",
          });
          break;
        case "retro":
          Object.assign(outputResets, {
            retrospective: null,
            partialRetrospective: null,
            retroStreamText: "",
          });
          break;
      }

      set({
        errors,
        completedStages,
        pendingApproval,
        ...outputResets,
      });

      // Per-stage retry uses LangGraph's checkpoint history: rewind to the
      // checkpoint just before the target stage's node ran, then resume.
      // The workflow re-runs that stage and everything downstream onto a
      // new branch in the same thread.
      const threadId = get().pipelineThreadId;
      const rewindNode = STAGE_TO_REWIND_NODE[stage];
      if (threadId && rewindNode) {
        try {
          // Cancel any in-flight run for this pipeline before we
          // rewind. Retry at an earlier stage explicitly invalidates
          // the prior run — without cancelling, the orphan model call
          // keeps streaming events into the listener and can jump the
          // UI back to a later stage when its interrupt finally lands.
          // The runId guard provides defence-in-depth, but cancelling
          // also stops the sidecar from emitting any further events
          // for the orphan run.
          const priorRunId = get().currentRunId;
          if (priorRunId) {
            try {
              await cancelImplementationPipelineWorkflow(priorRunId);
            } catch (e) {
              // Cancel is best-effort — the prior run may already be
              // done, or the sidecar may have restarted.
              console.warn("[Meridian] cancel prior pipeline run failed:", e);
            }
          }
          const runId = crypto.randomUUID();
          set({ proceeding: true, currentRunId: runId });
          const result = await rewindImplementationPipelineWorkflow(
            threadId,
            rewindNode,
            runId,
          );
          applyWorkflowResult((updater) => set((s2) => updater(s2)), result);
        } catch (e) {
          set({ proceeding: false });
          get().setError(stage, String(e));
        }
        return;
      }

      // No active workflow yet (e.g. retry triggered on a stage that never
      // ran via the new path) — fall back to a fresh pipeline start.
      const issue = get().selectedIssue;
      if (issue) {
        set({ pipelineThreadId: null, currentRunId: null });
        await get().startPipeline(issue);
      }
    },

    sendPipelineMessage: async (input: string) => {
      const s = get();
      // Grooming and triage keep their dedicated chats — they're tightly
      // coupled to their sub-agent's state machine. Every other stage
      // routes through the long-lived orchestrator.
      if (s.pendingApproval === "grooming") {
        await get().sendGroomingChatMessage(input);
      } else if (s.currentStage === "triage") {
        await get().sendTriageMessage(input);
      } else {
        await get().sendOrchestratorMessage(input);
      }
    },
  };
}
