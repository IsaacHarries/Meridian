import { type TriageMessage, resumeImplementationPipelineWorkflow } from "@/lib/tauri/workflows";
import { applyWorkflowResult } from "../helpers";
import type { ImplementTicketState } from "../types";

type Set = (
  partial:
    | Partial<ImplementTicketState>
    | ((s: ImplementTicketState) => Partial<ImplementTicketState>),
) => void;
type Get = () => ImplementTicketState;

export function createTriageActions(set: Set, get: Get) {
  return {
    sendTriageMessage: async (input: string) => {
      // The pipeline workflow is paused at the triage interrupt — resume with
      // a `reply` action and the workflow's triage node will take another turn
      // with the engineer's message appended to its history. The next
      // interrupt arrives over the event channel and is mapped onto the
      // triage state slices by `applyInterruptToState`.
      const userMsg: TriageMessage = { role: "user", content: input };
      const runId = crypto.randomUUID();
      set((s) => ({
        triageHistory: [...s.triageHistory, userMsg],
        proceeding: true,
        pendingApproval: null,
        currentRunId: runId,
      }));
      try {
        const threadId = get().pipelineThreadId;
        if (!threadId) {
          throw new Error(
            "Pipeline workflow has no active thread — cannot send triage reply.",
          );
        }
        const result = await resumeImplementationPipelineWorkflow(
          threadId,
          {
            action: "reply",
            message: input,
          },
          runId,
        );
        applyWorkflowResult((updater) => set((s) => updater(s)), result);
      } catch (e) {
        set({ proceeding: false });
        get().setError("triage", String(e));
      }
    },
  };
}
