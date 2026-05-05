import { invoke } from "@tauri-apps/api/core";
import { isMockMode } from "./core";
import type { BitbucketPr } from "./bitbucket";

// ── JIRA types ────────────────────────────────────────────────────────────────

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null;
  goal: string | null;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string | null;
}

export interface DescriptionSection {
  heading: string | null;
  content: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  url: string;
  summary: string;
  description: string | null;
  descriptionSections: DescriptionSection[];
  status: string;
  statusCategory: string;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  issueType: string;
  priority: string | null;
  storyPoints: number | null;
  labels: string[];
  epicKey: string | null;
  epicSummary: string | null;
  created: string;
  updated: string;
  resolutionDate: string | null;
  completedInSprint: boolean | null;
  /** Auto-detected from custom field display name — no configuration required. */
  acceptanceCriteria: string | null;
  stepsToReproduce: string | null;
  observedBehavior: string | null;
  expectedBehavior: string | null;
  /**
   * All non-empty custom fields keyed by human-readable display name.
   * Only populated by get_issue (full detail fetch). Empty for list/sprint fetches.
   */
  namedFields: Record<string, string>;
  /**
   * Mapping of semantic field name → discovered JIRA field ID.
   * e.g. { "acceptance_criteria": "customfield_10034" }
   * Empty when fields were not auto-discovered. Only populated by get_issue.
   */
  discoveredFieldIds: Record<string, string>;
}

// ── JIRA commands ─────────────────────────────────────────────────────────────

export async function getActiveSprint(): Promise<JiraSprint | null> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT } = await import("../mockData/sprints");
    return ACTIVE_SPRINT;
  }
  return invoke<JiraSprint | null>("get_active_sprint");
}

export async function getAllActiveSprints(): Promise<JiraSprint[]> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT } = await import("../mockData/sprints");
    return ACTIVE_SPRINT ? [ACTIVE_SPRINT] : [];
  }
  return invoke<JiraSprint[]>("get_all_active_sprints");
}

export async function getAllActiveSprintIssues(): Promise<
  Array<[JiraSprint, JiraIssue[]]>
> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT, ACTIVE_SPRINT_2 } = await import("../mockData/sprints");
    const { SPRINT_ISSUES_BY_ID } = await import("../mockData/issues");
    if (!ACTIVE_SPRINT) return [];
    return [
      [ACTIVE_SPRINT, SPRINT_ISSUES_BY_ID[23] ?? []],
      [ACTIVE_SPRINT_2, SPRINT_ISSUES_BY_ID[24] ?? []],
    ];
  }
  return invoke<Array<[JiraSprint, JiraIssue[]]>>(
    "get_all_active_sprint_issues",
  );
}

export async function getActiveSprintIssues(): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("../mockData/issues");
    return SPRINT_ISSUES_BY_ID[23] ?? [];
  }
  return invoke<JiraIssue[]>("get_active_sprint_issues");
}

export async function getMySprintIssues(): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { MY_SPRINT_ISSUES } = await import("../mockData/issues");
    return MY_SPRINT_ISSUES;
  }
  return invoke<JiraIssue[]>("get_my_sprint_issues");
}

export async function getSprintIssues(sprintId: number): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("../mockData/issues");
    return SPRINT_ISSUES_BY_ID[sprintId] ?? [];
  }
  return invoke<JiraIssue[]>("get_sprint_issues", { sprintId });
}

export async function getSprintIssuesById(
  sprintId: number,
  completeDate?: string | null,
): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("../mockData/issues");
    return SPRINT_ISSUES_BY_ID[sprintId] ?? [];
  }
  return invoke<JiraIssue[]>("get_sprint_issues_by_id", { sprintId, completeDate: completeDate ?? null });
}

export async function getIssue(issueKey: string): Promise<JiraIssue> {
  if (isMockMode()) {
    const { ALL_ISSUES_BY_KEY } = await import("../mockData/issues");
    const issue = ALL_ISSUES_BY_KEY[issueKey];
    if (!issue) throw new Error(`Mock: issue ${issueKey} not found`);
    return issue;
  }
  return invoke<JiraIssue>("get_issue", { issueKey });
}

export async function getCompletedSprints(
  limit: number,
): Promise<JiraSprint[]> {
  if (isMockMode()) {
    const { COMPLETED_SPRINTS } = await import("../mockData/sprints");
    return COMPLETED_SPRINTS.slice(0, limit);
  }
  return invoke<JiraSprint[]>("get_completed_sprints", { limit });
}

// ── Sprint report disk cache ───────────────────────────────────────────────────

export interface SprintReportCache {
  issues: JiraIssue[];
  prs: BitbucketPr[];
  cachedAt: string;
  aiSummary?: string;
  aiSummaryGeneratedAt?: string;
}

export async function saveSprintReport(
  sprintId: number,
  data: SprintReportCache,
): Promise<void> {
  if (isMockMode()) return;
  return invoke<void>("save_sprint_report", {
    sprintId,
    dataJson: JSON.stringify(data),
  });
}

export async function loadSprintReport(
  sprintId: number,
): Promise<SprintReportCache | null> {
  if (isMockMode()) return null;
  const raw = await invoke<string | null>("load_sprint_report", { sprintId });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SprintReportCache;
  } catch {
    return null;
  }
}

export async function listCachedSprintIds(): Promise<number[]> {
  if (isMockMode()) return [];
  return invoke<number[]>("list_cached_sprint_ids");
}

export async function getSprintReportsDir(): Promise<string> {
  return invoke<string>("get_sprint_reports_dir");
}

export async function getFutureSprints(limit: number): Promise<JiraSprint[]> {
  if (isMockMode()) return [];
  return invoke<JiraSprint[]>("get_future_sprints", { limit });
}

export async function searchJiraIssues(
  jql: string,
  maxResults: number,
): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("../mockData/issues");
    const all = SPRINT_ISSUES_BY_ID[23] ?? [];
    const q = jql.toLowerCase();
    const filtered = all.filter(
      (i) =>
        i.summary.toLowerCase().includes(q) ||
        i.key.toLowerCase().includes(q) ||
        i.status.toLowerCase().includes(q),
    );
    return filtered.slice(0, maxResults);
  }
  return invoke<JiraIssue[]>("search_jira_issues", { jql, maxResults });
}

/** Diagnostic: fetch ALL fields for one issue with human-readable names.
 *  Uses ?expand=names so field IDs are mapped to display names without admin access.
 *  Returns custom fields sorted by name, standard fields first. */
export interface RawIssueField {
  id: string;
  name: string;
  value: string;
}

export async function getRawIssueFields(
  issueKey: string,
): Promise<RawIssueField[]> {
  return invoke<RawIssueField[]>("get_raw_issue_fields", { issueKey });
}

export interface JiraFieldMeta {
  id: string;
  name: string;
  fieldType: string | null;
}

/** Fetch all field definitions from the JIRA workspace (id + name + type). */
export async function getJiraFields(): Promise<JiraFieldMeta[]> {
  return invoke<JiraFieldMeta[]>("get_jira_fields");
}

export async function updateJiraIssue(
  issueKey: string,
  summary: string | null,
  description: string,
): Promise<void> {
  return invoke("update_jira_issue", { issueKey, summary, description });
}

/**
 * Update multiple fields on a JIRA issue in a single PUT request.
 * `fieldsJson` is a JSON string mapping JIRA field IDs to plain-text values.
 * e.g. { "summary": "...", "customfield_10034": "..." }
 */
export async function updateJiraFields(
  issueKey: string,
  fieldsJson: string,
): Promise<void> {
  return invoke("update_jira_fields", { issueKey, fieldsJson });
}
