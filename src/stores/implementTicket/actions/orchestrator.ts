import { applyPlanEdits, chatWithOrchestrator } from "@/lib/tauri/orchestrator";
import { type PipelineResumeAction, resumeImplementationPipelineWorkflow, rewindImplementationPipelineWorkflow } from "@/lib/tauri/workflows";
import { STAGE_ORDER } from "../constants";
import {
    applyOrchestratorResult,
    buildOrchestratorContextText,
    ensureOrchestratorThreadId,
} from "../helpers";
import type { ImplementTicketState, Stage } from "../types";

type Set = (
  partial:
    | Partial<ImplementTicketState>
    | ((s: ImplementTicketState) => Partial<ImplementTicketState>),
) => void;
type Get = () => ImplementTicketState;

export function createOrchestratorActions(set: Set, get: Get) {
  return {
    sendOrchestratorMessage: async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      // Race lock: a single orchestrator thread can only have one outstanding
      // turn at a time. The sidecar's SQLite checkpointer also serialises on
      // thread_id, but coordinating concurrent invokes from the frontend
      // wastes time + tokens — refuse early.
      if (get().orchestratorSending) {
        console.warn("[orchestrator] refused: another turn is in flight");
        return;
      }
      await get()._reloadSkills();

      const s = get();
      const threadId = ensureOrchestratorThreadId(set, get);
      if (!threadId) {
        console.warn("[orchestrator] cannot send: no active ticket");
        return;
      }

      set({
        orchestratorSending: true,
        orchestratorStreamText: "",
      });

      try {
        const result = await chatWithOrchestrator({
          threadId,
          pipelineThreadId: s.pipelineThreadId ?? undefined,
          message: trimmed,
          messageKind: "user",
          currentStage: s.currentStage,
          contextText: buildOrchestratorContextText(s),
        });
        applyOrchestratorResult(
          (updater) => set((st) => updater(st)),
          result,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[orchestrator] turn failed:", msg);
        set({
          orchestratorSending: false,
          orchestratorStreamText: "",
        });
      }
    },

    resolveOrchestratorProposal: async (decision: "accepted" | "rejected") => {
      const s = get();
      const proposal = s.orchestratorPendingProposal;
      if (!proposal) return;
      if (s.orchestratorSending) {
        console.warn(
          "[orchestrator] refused proposal resolution: turn in flight",
        );
        return;
      }

      // On accept, fire the appropriate pipeline command or mutation. On
      // reject, skip and just notify the orchestrator.
      let actionDescription: string;
      // Stage summaries that became stale because of this resolution. Only
      // populated for rewind acceptance — every other resolution leaves
      // existing summaries valid.
      let dropSummariesForStages: string[] = [];
      if (decision === "accepted") {
        try {
          switch (proposal.kind) {
            case "proceed": {
              await get().proceedFromStage(s.currentStage, {
                action: proposal.action,
                ...(proposal.action === "abort" && proposal.reason
                  ? { reason: proposal.reason }
                  : {}),
              } as PipelineResumeAction);
              actionDescription = `User accepted — pipeline ${proposal.action} fired.`;
              break;
            }
            case "rewind": {
              const threadId = s.pipelineThreadId;
              if (!threadId)
                throw new Error("No active pipeline thread to rewind.");
              await rewindImplementationPipelineWorkflow(
                threadId,
                proposal.toStage,
              );
              actionDescription = `User accepted — rewound to ${proposal.toStage}.`;
              // Any summary whose stage came AFTER the rewind target is now
              // stale — its conversation referenced state that no longer
              // exists. Compute the set so the orchestrator's next turn
              // drops them via the new dropSummariesForStages channel.
              const targetIdx = STAGE_ORDER.indexOf(proposal.toStage as Stage);
              if (targetIdx >= 0) {
                dropSummariesForStages = STAGE_ORDER.slice(targetIdx).filter(
                  (st) => st !== proposal.toStage,
                );
              }
              break;
            }
            case "reply": {
              const threadId = s.pipelineThreadId;
              if (!threadId) throw new Error("No active pipeline thread.");
              await resumeImplementationPipelineWorkflow(threadId, {
                action: "reply",
                message: proposal.message,
              });
              actionDescription = `User accepted — triage reply sent.`;
              break;
            }
            case "edit_plan": {
              const threadId = s.pipelineThreadId;
              if (!threadId)
                throw new Error("No active pipeline thread to edit plan on.");
              const result = await applyPlanEdits({
                pipelineThreadId: threadId,
                edits: proposal.edits,
              });
              const fileCount = result.output?.planFileCount;
              actionDescription =
                `User accepted — applied ${proposal.edits.length} plan edit(s).` +
                (fileCount !== undefined
                  ? ` Plan now has ${fileCount} file(s).`
                  : "");
              // Mirror the new plan into local store state so the panel
              // refreshes immediately. We re-fetch via the next interrupt
              // when one fires; for now, mark the plan dirty by reading
              // the orchestrator-supplied state. Since the pipeline isn't
              // currently running, the easiest visible refresh is to
              // include a hint here for the user.
              break;
            }
            case "accept_grooming_edit": {
              if (proposal.newStatus === "approved") {
                get().handleApproveEdit(proposal.editId);
              } else {
                get().handleDeclineEdit(proposal.editId);
              }
              actionDescription = `User accepted — grooming edit ${proposal.editId} ${proposal.newStatus}.`;
              break;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          actionDescription = `User accepted but the action failed: ${msg}`;
        }
      } else {
        actionDescription = `User rejected the proposal.`;
      }

      // Notify the orchestrator so its next turn knows the outcome and
      // clears its `pendingProposal` channel.
      const threadId = ensureOrchestratorThreadId(set, get);
      if (!threadId) return;

      set({
        orchestratorSending: true,
        orchestratorStreamText: "",
      });
      try {
        const result = await chatWithOrchestrator({
          threadId,
          pipelineThreadId: get().pipelineThreadId ?? undefined,
          message: actionDescription,
          messageKind: "system_note",
          currentStage: get().currentStage,
          clearPendingProposal: true,
          dropSummariesForStages,
        });
        applyOrchestratorResult(
          (updater) => set((st) => updater(st)),
          result,
        );
      } catch (err) {
        console.error("[orchestrator] proposal-resolution turn failed:", err);
        set({
          orchestratorSending: false,
          orchestratorStreamText: "",
          // Even if the notify-turn fails, clear locally so the UI doesn't
          // leave a stale confirm card up.
          orchestratorPendingProposal: null,
        });
      }
    },

    triggerOrchestratorReview: async (stage: Stage, contextText: string) => {
      const s = get();
      if (s.orchestratorReviewedStages.includes(stage)) return; // dedup
      // If a turn is in flight, bail rather than queue. The auto-review
      // re-fires next time the user advances; a missed review is far better
      // than a malformed concurrent one.
      if (s.orchestratorSending) return;
      const threadId = ensureOrchestratorThreadId(set, get);
      if (!threadId) return;

      set((st) => ({
        orchestratorReviewedStages: [...st.orchestratorReviewedStages, stage],
        orchestratorSending: true,
        orchestratorStreamText: "",
      }));

      const reviewPrompt =
        `The ${stage} agent just produced its output. Review it briefly for ` +
        `consistency with our prior conversation and any concerns the developer ` +
        `flagged earlier. If everything looks good, say so plainly so we can move on. ` +
        `Be concise — 1 to 3 sentences.`;

      try {
        const result = await chatWithOrchestrator({
          threadId,
          pipelineThreadId: s.pipelineThreadId ?? undefined,
          message: reviewPrompt,
          messageKind: "system_note",
          currentStage: stage,
          contextText,
        });
        applyOrchestratorResult(
          (updater) => set((st) => updater(st)),
          result,
        );
      } catch (err) {
        console.error("[orchestrator] review turn failed:", err);
        set({
          orchestratorSending: false,
          orchestratorStreamText: "",
        });
      }
    },
  };
}
