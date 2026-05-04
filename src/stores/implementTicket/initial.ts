/**
 * Initial state for the Implement-a-Ticket store.
 *
 * Split out from the original `implementTicketStore.ts` so the store
 * itself can stay a thin assembly module. The `Omit<…>` keys list every
 * action key on `ImplementTicketState` — those are wired in by the
 * `create()` call in `./store.ts` via the per-domain action factories.
 */

import type { ImplementTicketState } from "./types";

export const INITIAL: Omit<
  ImplementTicketState,
  | "_set"
  | "_reloadSkills"
  | "resetSession"
  | "startPipeline"
  | "sendTriageMessage"
  | "finalizePlan"
  | "submitDraftPr"
  | "proceedFromStage"
  | "sendGroomingChatMessage"
  | "handleApproveEdit"
  | "handleDeclineEdit"
  | "handleEditSuggested"
  | "clearEditHighlight"
  | "clearAllGroomingHighlights"
  | "toggleHighlights"
  | "pushGroomingToJira"
  | "markComplete"
  | "setError"
  | "stopActivePipeline"
  | "clearError"
  | "retryStage"
  | "sendOrchestratorMessage"
  | "resolveOrchestratorProposal"
  | "triggerOrchestratorReview"
  | "sendPipelineMessage"
> = {
  selectedIssue: null,
  currentStage: "select",
  viewingStage: "grooming",
  completedStages: new Set(),
  pendingApproval: null,
  proceeding: false,
  grooming: null,
  partialGrooming: null,
  partialImpact: null,
  partialTriageTurn: null,
  partialPlan: null,
  partialGuidance: null,
  partialReview: null,
  partialPrDescription: null,
  partialRetrospective: null,
  impact: null,
  triageHistory: [],
  triageTurns: [],
  plan: null,
  guidance: null,
  implementation: null,
  implementationStreamText: "",
  implementationProgress: null,
  pipelineActivity: null,
  buildVerification: null,
  buildCheckStreamText: "",
  replanCheckpoint: null,
  testPlan: null,
  tests: null,
  review: null,
  prDescription: null,
  retrospective: null,
  featureBranch: null,
  createdPr: null,
  prSubmitStatus: "idle",
  prSubmitError: null,
  groomingBlockers: [],
  groomingEdits: [],
  clarifyingQuestions: [],
  clarifyingQuestionsInitial: [],
  groomingHighlights: { editIds: [], questions: false },
  showHighlights: true,
  filesRead: [],
  groomingChat: [],
  groomingBaseline: null,
  jiraUpdateStatus: "idle",
  jiraUpdateError: "",
  groomingProgress: "",
  groomingStreamText: "",
  impactStreamText: "",
  triageStreamText: "",
  planStreamText: "",
  testsStreamText: "",
  reviewStreamText: "",
  prStreamText: "",
  retroStreamText: "",
  checkpointStreamText: "",
  orchestratorThreadId: null,
  orchestratorThread: [],
  orchestratorStageSummaries: {},
  orchestratorUserNotes: [],
  orchestratorPendingProposal: null,
  orchestratorStreamText: "",
  orchestratorSending: false,
  orchestratorReviewedStages: [],
  errors: {},
  worktreeInfo: null,
  ticketText: "",
  skills: {},
  isSessionActive: false,
  activeSessionId: "",
  pipelineThreadId: null,
  currentRunId: null,
  pipelineFinalState: null,
  sessions: new Map(),
};
