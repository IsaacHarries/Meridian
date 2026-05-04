import { invoke } from "@tauri-apps/api/core";
import { invokeWithLlmCheck, isMockClaudeMode } from "./core";

// ── Trend analyses (multi-sprint AI) ──────────────────────────────────────────

/** One sprint summary that the trend analysis covered — enough to rehydrate labels in the UI. */
export interface TrendAnalysisSprintRef {
  id: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

export interface AssigneePoints {
  name: string;
  points: number;
}

/** Per-sprint hard stats computed server-side; drives both the AI prompt and the UI charts. */
export interface SprintStats {
  name: string;
  committedPoints: number;
  completedPoints: number;
  velocityPct: number;
  totalIssues: number;
  completedIssues: number;
  completionRatePct: number;
  carryoverCount: number;
  carryoverPct: number;
  bugCount: number;
  storyCount: number;
  taskCount: number;
  otherIssueCount: number;
  blockerCount: number;
  bugStoryRatio: number | null;
  prsTotal: number;
  prsMerged: number;
  avgCycleHours: number | null;
  avgCommentsPerPr: number | null;
  uniquePrAuthors: number;
  assigneeAssignedPoints: AssigneePoints[];
  assigneeCompletedPoints: AssigneePoints[];
}

export interface TrendAnalysisResult {
  markdown: string;
  stats: SprintStats[];
}

export interface TrendAnalysisRecord {
  id: string;
  createdAt: string;
  sprints: TrendAnalysisSprintRef[];
  markdown: string;
  /** Present on records saved after the Rust side started returning stats. */
  stats?: SprintStats[];
}

/** Trimmed-down shape sent to the Rust trend agent (one entry per sprint). */
export interface TrendSprintInput {
  name: string;
  startDate: string | null;
  endDate: string | null;
  goal: string | null;
  issues: TrendIssueInput[];
  /** PRs already filtered to this sprint's window by the caller. */
  prs: TrendPrInput[];
}

export interface TrendIssueInput {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  issueType: string;
  priority: string | null;
  storyPoints: number | null;
  assignee: string | null;
  completedInSprint: boolean | null;
  labels: string[];
}

export interface TrendPrInput {
  id: number;
  title: string;
  state: string;
  author: string | null;
  createdOn: string;
  updatedOn: string;
  /** Hours between createdOn and updatedOn, pre-computed client-side. */
  cycleHours: number | null;
  commentCount: number;
}

export async function generateMultiSprintTrends(
  sprints: TrendSprintInput[],
): Promise<TrendAnalysisResult> {
  if (isMockClaudeMode()) {
    const { MOCK_SPRINT_RETRO_MARKDOWN } = await import("../mockClaudeResponses");
    return { markdown: MOCK_SPRINT_RETRO_MARKDOWN, stats: [] };
  }
  return invokeWithLlmCheck<TrendAnalysisResult>("generate_multi_sprint_trends", {
    sprints,
  });
}

// Trend analyses are one-shot AI outputs (no re-fetch source), so unlike sprint
// reports the storage helpers persist in both mock and real modes. The disk
// is still the real data dir — users can delete unwanted entries via the UI.
export async function saveTrendAnalysis(
  record: TrendAnalysisRecord,
): Promise<void> {
  return invoke<void>("save_trend_analysis", {
    id: record.id,
    dataJson: JSON.stringify(record),
  });
}

export async function loadTrendAnalysis(
  id: string,
): Promise<TrendAnalysisRecord | null> {
  const raw = await invoke<string | null>("load_trend_analysis", { id });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TrendAnalysisRecord;
  } catch {
    return null;
  }
}

export async function listTrendAnalyses(): Promise<string[]> {
  return invoke<string[]>("list_trend_analyses");
}

export async function deleteTrendAnalysis(id: string): Promise<void> {
  return invoke<void>("delete_trend_analysis", { id });
}
