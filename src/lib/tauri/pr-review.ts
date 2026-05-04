import {
  invokeWithLlmCheck,
  reportPanelUsage,
  reportPanelChatContext,
} from "./core";
import type { SidecarUsage } from "./workflows";

/** Conversational follow-up chat about a completed PR review. Streams reply
 *  tokens through the workflow event channel `pr-review-chat-workflow-event`
 *  — subscribers should filter for `kind === "stream"` and read `delta`. */
export async function chatPrReview(
  contextText: string,
  historyJson: string,
): Promise<string> {
  const result = await invokeWithLlmCheck<{
    output?: { reply?: string } | null;
    usage?: SidecarUsage;
  }>("run_pr_review_chat_workflow", {
    contextText,
    historyJson,
  });
  reportPanelUsage("pr_review", result?.usage);
  reportPanelChatContext("pr_review", result?.usage);
  return result?.output?.reply ?? "";
}

// ── PR review report types ────────────────────────────────────────────────────

export interface ReviewFinding {
  severity: "blocking" | "non_blocking" | "nitpick";
  title: string;
  description: string;
  file: string | null;
  line_range: string | null;
}

export interface ReviewLens {
  assessment: string;
  findings: ReviewFinding[];
}

export interface BugTestSteps {
  description: string;
  happy_path: string[];
  sad_path: string[];
}

export interface ReviewReport {
  overall: "approve" | "request_changes" | "needs_discussion";
  summary: string;
  bug_test_steps?: BugTestSteps | null;
  lenses: {
    acceptance_criteria: ReviewLens;
    security: ReviewLens;
    logic: ReviewLens;
    quality: ReviewLens;
    testing: ReviewLens;
  };
}
