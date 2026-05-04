// One-shot markdown workflow scaffold + every runner that uses it.
//
// Most one-shot workflows (sprint retro, workload, trends, meeting summary,
// meeting title, sprint dashboard chat, meeting chat, cross-meetings chat,
// analyze pr comments, grooming file probe) follow the same shape: validate
// input, emit started/completed progress, run the implementation, emit a
// `result` event with `output: { markdown }`. They live in this file as
// thin wrappers around `runMarkdownWorkflow`.

import { z } from "zod";
import type { ModelSelection } from "../../../protocol.js";
import {
  runSprintRetrospective,
  SprintRetroInputSchema,
} from "../../sprint-retrospective.js";
import {
  runWorkloadSuggestions,
  WorkloadInputSchema,
} from "../../workload-suggestions.js";
import {
  runMultiSprintTrends,
  TrendsInputSchema,
} from "../../multi-sprint-trends.js";
import {
  runMeetingSummary,
  MeetingSummaryInputSchema,
} from "../../meeting-summary.js";
import {
  runMeetingTitle,
  MeetingTitleInputSchema,
} from "../../meeting-title.js";
import {
  runSprintDashboardChat,
  SprintDashboardChatInputSchema,
} from "../../sprint-dashboard-chat.js";
import {
  runMeetingChat,
  MeetingChatInputSchema,
} from "../../meeting-chat.js";
import {
  runCrossMeetingsChat,
  CrossMeetingsChatInputSchema,
} from "../../cross-meetings-chat.js";
import {
  runAnalyzePrComments,
  AnalyzePrCommentsInputSchema,
} from "../../analyze-pr-comments.js";
import {
  runGroomingFileProbe,
  GroomingFileProbeInputSchema,
} from "../../grooming-file-probe.js";
import type { Emitter } from "../types.js";

/** Shared scaffold for one-shot LLM workflows that return plain markdown
 *  (sprint retrospective, workload suggestions, multi-sprint trends, meeting
 *  summarisation, …). Validates input, emits a started/completed progress
 *  pair around the call, and emits a final `result` event with `output:
 *  { markdown }` so frontends keep a stable shape. */
async function runMarkdownWorkflow<TInput>(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  workflowName: string;
  nodeName: string;
  schema: z.ZodType<TInput>;
  run: (a: {
    input: TInput;
    model: ModelSelection;
    emit?: Emitter;
    workflowId?: string;
    nodeName?: string;
  }) => Promise<{
    markdown: string;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}): Promise<void> {
  const { workflowId, input, model, emit, workflowName, nodeName, schema, run } =
    args;

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    emit({
      id: workflowId,
      type: "error",
      message: `Invalid ${workflowName} input: ${parsed.error.message}`,
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: nodeName, status: "started" });

  let result: { markdown: string; usage: { inputTokens: number; outputTokens: number } };
  try {
    result = await run({ input: parsed.data, model, emit, workflowId, nodeName });
  } catch (err) {
    emit({
      id: workflowId,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  emit({ id: workflowId, type: "progress", node: nodeName, status: "completed" });

  emit({
    id: workflowId,
    type: "result",
    output: { markdown: result.markdown },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  });
}

// ── Sprint Retrospective runner ──────────────────────────────────────────────

export async function runSprintRetrospectiveWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "sprint_retrospective",
    nodeName: "summarise",
    schema: SprintRetroInputSchema,
    run: runSprintRetrospective,
  });
}

// ── Workload Suggestions runner ──────────────────────────────────────────────

export async function runWorkloadSuggestionsWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "workload_suggestions",
    nodeName: "analyse",
    schema: WorkloadInputSchema,
    run: runWorkloadSuggestions,
  });
}

// ── Multi-Sprint Trends runner ───────────────────────────────────────────────

export async function runMultiSprintTrendsWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "multi_sprint_trends",
    nodeName: "analyse",
    schema: TrendsInputSchema,
    run: runMultiSprintTrends,
  });
}

// ── Meeting Summary runner ───────────────────────────────────────────────────

export async function runMeetingSummaryWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "meeting_summary",
    nodeName: "summarise",
    schema: MeetingSummaryInputSchema,
    run: runMeetingSummary,
  });
}

export async function runMeetingTitleWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "meeting_title",
    nodeName: "title",
    schema: MeetingTitleInputSchema,
    run: runMeetingTitle,
  });
}

// ── Sprint Dashboard Chat runner ─────────────────────────────────────────────

export async function runSprintDashboardChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "sprint_dashboard_chat",
    nodeName: "reply",
    schema: SprintDashboardChatInputSchema,
    run: runSprintDashboardChat,
  });
}

// ── Meeting Chat runner ──────────────────────────────────────────────────────

export async function runMeetingChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "meeting_chat",
    nodeName: "reply",
    schema: MeetingChatInputSchema,
    run: runMeetingChat,
  });
}

// ── Cross-Meetings Chat runner ───────────────────────────────────────────────

export async function runCrossMeetingsChatWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "cross_meetings_chat",
    nodeName: "reply",
    schema: CrossMeetingsChatInputSchema,
    run: runCrossMeetingsChat,
  });
}

// ── Analyze PR Comments runner ───────────────────────────────────────────────

export async function runAnalyzePrCommentsWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "analyze_pr_comments",
    nodeName: "analyse",
    schema: AnalyzePrCommentsInputSchema,
    run: runAnalyzePrComments,
  });
}

// ── Grooming File Probe runner ───────────────────────────────────────────────

export async function runGroomingFileProbeWorkflow(args: {
  workflowId: string;
  input: unknown;
  model: ModelSelection;
  emit: Emitter;
  signal: AbortSignal;
}): Promise<void> {
  return runMarkdownWorkflow({
    ...args,
    workflowName: "grooming_file_probe",
    nodeName: "probe",
    schema: GroomingFileProbeInputSchema,
    run: runGroomingFileProbe,
  });
}
