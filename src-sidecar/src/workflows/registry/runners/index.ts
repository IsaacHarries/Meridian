// Workflow dispatch table — assembles every per-workflow runner into the
// `workflows` map keyed by the workflow name the frontend sends in
// `WorkflowStart.workflow`.

import type { WorkflowRunner } from "../types.js";
import { runGrooming } from "./grooming.js";
import {
  runPrReview,
  runImplementationPipeline,
} from "./pipeline.js";
import {
  runImplementTicketOrchestrator,
  runApplyPlanEditsWorkflow,
} from "./orchestrator.js";
import {
  runPrReviewChatWorkflow,
  runGroomingChatWorkflow,
  runAddressPrChatWorkflow,
} from "./chats.js";
import {
  runSprintRetrospectiveWorkflow,
  runWorkloadSuggestionsWorkflow,
  runMultiSprintTrendsWorkflow,
  runMeetingSummaryWorkflow,
  runMeetingTitleWorkflow,
  runSprintDashboardChatWorkflow,
  runMeetingChatWorkflow,
  runCrossMeetingsChatWorkflow,
  runAnalyzePrCommentsWorkflow,
  runGroomingFileProbeWorkflow,
} from "./markdown.js";

export const workflows: Record<string, WorkflowRunner> = {
  grooming: runGrooming,
  pr_review: runPrReview,
  implementation_pipeline: runImplementationPipeline,
  sprint_retrospective: runSprintRetrospectiveWorkflow,
  workload_suggestions: runWorkloadSuggestionsWorkflow,
  multi_sprint_trends: runMultiSprintTrendsWorkflow,
  meeting_summary: runMeetingSummaryWorkflow,
  meeting_title: runMeetingTitleWorkflow,
  sprint_dashboard_chat: runSprintDashboardChatWorkflow,
  meeting_chat: runMeetingChatWorkflow,
  cross_meetings_chat: runCrossMeetingsChatWorkflow,
  analyze_pr_comments: runAnalyzePrCommentsWorkflow,
  pr_review_chat: runPrReviewChatWorkflow,
  address_pr_chat: runAddressPrChatWorkflow,
  grooming_chat: runGroomingChatWorkflow,
  implement_ticket_orchestrator: runImplementTicketOrchestrator,
  apply_plan_edits: runApplyPlanEditsWorkflow,
  grooming_file_probe: runGroomingFileProbeWorkflow,
};
