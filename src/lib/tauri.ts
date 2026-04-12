import { invoke } from "@tauri-apps/api/core";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";

/**
 * Open a URL in the user's default system browser.
 * Must be used instead of window.open() — Tauri's webview does not handle
 * window.open or <a target="_blank"> the way a browser does.
 */
export function openUrl(url: string): void {
  tauriOpenUrl(url).catch((e) => console.error("Failed to open URL:", url, e));
}

// ── Mock mode ─────────────────────────────────────────────────────────────────
// When enabled, all JIRA and Bitbucket commands return local mock data.
// Claude / agent calls still hit the API unless Mock AI responses is enabled.

const MOCK_KEY = "meridian_mock_mode";
const MOCK_CLAUDE_KEY = "meridian_mock_claude_mode";

export function isMockMode(): boolean {
  return localStorage.getItem(MOCK_KEY) === "true";
}

export function setMockMode(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(MOCK_KEY, "true");
  } else {
    localStorage.removeItem(MOCK_KEY);
  }
}

/** When true, agent and briefing commands return canned text/JSON (no Anthropic call). */
export function isMockClaudeMode(): boolean {
  return localStorage.getItem(MOCK_CLAUDE_KEY) === "true";
}

export function setMockClaudeMode(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(MOCK_CLAUDE_KEY, "true");
  } else {
    localStorage.removeItem(MOCK_CLAUDE_KEY);
  }
}

// ── Credential / config status ────────────────────────────────────────────────

export interface CredentialStatus {
  anthropicApiKey: boolean;
  geminiApiKey: boolean;
  localLlmUrl: boolean;
  jiraBaseUrl: boolean;
  jiraEmail: boolean;
  jiraApiToken: boolean;
  jiraBoardId: boolean;
  bitbucketWorkspace: boolean;
  bitbucketEmail: boolean;
  bitbucketAccessToken: boolean;
  bitbucketRepoSlug: boolean;
}

export function credentialStatusComplete(s: CredentialStatus) {
  return (
    s.anthropicApiKey &&
    s.jiraBaseUrl &&
    s.jiraEmail &&
    s.jiraApiToken &&
    s.jiraBoardId &&
    s.bitbucketWorkspace &&
    s.bitbucketEmail &&
    s.bitbucketAccessToken &&
    s.bitbucketRepoSlug
  );
}

export function anthropicComplete(s: CredentialStatus) {
  return s.anthropicApiKey;
}

/** All three auth credentials are present (board ID not required). */
export function jiraCredentialsSet(s: CredentialStatus) {
  return s.jiraBaseUrl && s.jiraEmail && s.jiraApiToken;
}

/** All three auth credentials are present (repo slug not required). */
export function bitbucketCredentialsSet(s: CredentialStatus) {
  return s.bitbucketWorkspace && s.bitbucketEmail && s.bitbucketAccessToken;
}

/** Fully ready: credentials + board ID configured. */
export function jiraComplete(s: CredentialStatus) {
  return s.jiraBaseUrl && s.jiraEmail && s.jiraApiToken && s.jiraBoardId;
}

/** Fully ready: credentials + repo slug configured. */
export function bitbucketComplete(s: CredentialStatus) {
  return s.bitbucketWorkspace && s.bitbucketEmail && s.bitbucketAccessToken && s.bitbucketRepoSlug;
}

// ── Credential commands ───────────────────────────────────────────────────────

export async function getCredentialStatus(): Promise<CredentialStatus> {
  const status = await invoke<CredentialStatus>("credential_status");
  let merged: CredentialStatus = { ...status };
  if (isMockMode()) {
    merged = {
      ...merged,
      jiraBaseUrl: true,
      jiraEmail: true,
      jiraApiToken: true,
      jiraBoardId: true,
      bitbucketWorkspace: true,
      bitbucketEmail: true,
      bitbucketAccessToken: true,
      bitbucketRepoSlug: true,
    };
  }
  if (isMockClaudeMode()) {
    merged = {
      ...merged,
      anthropicApiKey: true,
    };
  }
  return merged;
}

export async function saveCredential(key: string, value: string): Promise<void> {
  return invoke("save_credential", { key, value });
}

export async function deleteCredential(key: string): Promise<void> {
  return invoke("delete_credential", { key });
}

/** Returns non-secret stored config values (URLs, email, workspace slug) for UI display. */
export async function getNonSecretConfig(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_non_secret_config");
}

// ── Validation commands ───────────────────────────────────────────────────────

export async function validateAnthropic(apiKey: string): Promise<string> {
  return invoke<string>("validate_anthropic", { apiKey });
}

export async function validateJira(
  baseUrl: string,
  email: string,
  apiToken: string
): Promise<string> {
  return invoke<string>("validate_jira", { baseUrl, email, apiToken });
}

export async function validateBitbucket(
  workspace: string,
  email: string,
  accessToken: string
): Promise<string> {
  return invoke<string>("validate_bitbucket", { workspace, email, accessToken });
}

/** Test the stored Anthropic key without passing it through the frontend. */
export async function testAnthropicStored(): Promise<string> {
  return invoke<string>("test_anthropic_stored");
}

/**
 * Read the Claude Pro / Max OAuth token from the macOS keychain (where Claude Code
 * stores it after `claude /login`) and save it as the Anthropic credential.
 * The token never passes through the frontend — it is read and stored entirely
 * in the Tauri backend.
 */
export async function importClaudeProToken(): Promise<string> {
  return invoke<string>("import_claude_pro_token");
}

/** Return the list of available Claude models as [id, display_label] pairs. */
export async function getClaudeModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_claude_models");
}

/** Return the list of available Gemini models as [id, display_label] pairs. */
export async function getGeminiModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_gemini_models");
}

/**
 * Validate a Gemini API key by making a lightweight models-list request.
 * Saves the key on success; throws on failure.
 */
export async function validateGemini(apiKey: string): Promise<string> {
  return invoke<string>("validate_gemini", { apiKey });
}

/** Test the already-stored Gemini API key without re-saving it. */
export async function testGeminiStored(): Promise<string> {
  return invoke<string>("test_gemini_stored");
}

/**
 * Return the model list from the configured local LLM server.
 * Returns an empty array if no server URL is configured or the server is unreachable.
 */
export async function getLocalModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_local_models");
}

/**
 * Validate a local LLM server URL (and optional API key) by connecting to it.
 * Normalises the URL to end with /v1, saves on success; throws on failure.
 */
export async function validateLocalLlm(url: string, apiKey: string): Promise<string> {
  return invoke<string>("validate_local_llm", { url, apiKey });
}

/** Test the already-stored local LLM server connection without re-saving it. */
export async function testLocalLlmStored(): Promise<string> {
  return invoke<string>("test_local_llm_stored");
}

/** Test the stored JIRA credentials without passing secrets through the frontend. */
export async function testJiraStored(): Promise<string> {
  return invoke<string>("test_jira_stored");
}

/** Test the stored Bitbucket credentials without passing secrets through the frontend. */
export async function testBitbucketStored(): Promise<string> {
  return invoke<string>("test_bitbucket_stored");
}

/** Run a full diagnostic sweep of every JIRA endpoint, returning a plain-text report. */
export async function debugJiraEndpoints(): Promise<string> {
  return invoke<string>("debug_jira_endpoints");
}

// ── Claude commands ───────────────────────────────────────────────────────────

export async function generateStandupBriefing(standupText: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_STANDUP_MARKDOWN } = await import("./mockClaudeResponses");
    return MOCK_STANDUP_MARKDOWN;
  }
  return invoke<string>("generate_standup_briefing", { standupText });
}

export async function generateSprintRetrospective(sprintText: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_SPRINT_RETRO_MARKDOWN } = await import("./mockClaudeResponses");
    return MOCK_SPRINT_RETRO_MARKDOWN;
  }
  return invoke<string>("generate_sprint_retrospective", { sprintText });
}

export async function generateWorkloadSuggestions(workloadText: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_WORKLOAD_MARKDOWN } = await import("./mockClaudeResponses");
    return MOCK_WORKLOAD_MARKDOWN;
  }
  return invoke<string>("generate_workload_suggestions", { workloadText });
}

export async function assessTicketQuality(ticketText: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_QUALITY_JSON } = await import("./mockClaudeResponses");
    return MOCK_QUALITY_JSON;
  }
  return invoke<string>("assess_ticket_quality", { ticketText });
}

// ── Ticket quality types ──────────────────────────────────────────────────────

export interface QualityCriterion {
  name: string;
  result: "pass" | "partial" | "fail";
  feedback: string;
}

export interface QualityReport {
  overall: "ready" | "needs_work" | "not_ready";
  summary: string;
  criteria: QualityCriterion[];
  open_questions: string[];
  suggested_improvements: string;
}

export async function reviewPr(reviewText: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_PR_REVIEW_JSON } = await import("./mockClaudeResponses");
    return MOCK_PR_REVIEW_JSON;
  }
  return invoke<string>("review_pr", { reviewText });
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

export interface ReviewReport {
  overall: "approve" | "request_changes" | "needs_discussion";
  summary: string;
  lenses: {
    acceptance_criteria: ReviewLens;
    security: ReviewLens;
    logic: ReviewLens;
    quality: ReviewLens;
  };
}

export function parseReviewReport(raw: string): ReviewReport | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    return JSON.parse(cleaned) as ReviewReport;
  } catch {
    return null;
  }
}

export function parseQualityReport(raw: string): QualityReport | null {
  try {
    // Strip markdown fences if Claude added them anyway
    const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    return JSON.parse(cleaned) as QualityReport;
  } catch {
    return null;
  }
}

// ── JIRA types ────────────────────────────────────────────────────────────────

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate: string | null;
  endDate: string | null;
  goal: string | null;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string | null;
}

export interface JiraIssue {
  id: string;
  key: string;
  url: string;
  summary: string;
  description: string | null;
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
}

// ── JIRA commands ─────────────────────────────────────────────────────────────

export async function getActiveSprint(): Promise<JiraSprint | null> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT } = await import("./mockData");
    return ACTIVE_SPRINT;
  }
  return invoke<JiraSprint | null>("get_active_sprint");
}

export async function getAllActiveSprints(): Promise<JiraSprint[]> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT } = await import("./mockData");
    return ACTIVE_SPRINT ? [ACTIVE_SPRINT] : [];
  }
  return invoke<JiraSprint[]>("get_all_active_sprints");
}

export async function getAllActiveSprintIssues(): Promise<Array<[JiraSprint, JiraIssue[]]>> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT, SPRINT_ISSUES_BY_ID } = await import("./mockData");
    if (!ACTIVE_SPRINT) return [];
    return [[ACTIVE_SPRINT, SPRINT_ISSUES_BY_ID[23] ?? []]];
  }
  return invoke<Array<[JiraSprint, JiraIssue[]]>>("get_all_active_sprint_issues");
}

export async function getActiveSprintIssues(): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("./mockData");
    return SPRINT_ISSUES_BY_ID[23] ?? [];
  }
  return invoke<JiraIssue[]>("get_active_sprint_issues");
}

export async function getMySprintIssues(): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { MY_SPRINT_ISSUES } = await import("./mockData");
    return MY_SPRINT_ISSUES;
  }
  return invoke<JiraIssue[]>("get_my_sprint_issues");
}

export async function getSprintIssues(sprintId: number): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("./mockData");
    return SPRINT_ISSUES_BY_ID[sprintId] ?? [];
  }
  return invoke<JiraIssue[]>("get_sprint_issues", { sprintId });
}

export async function getSprintIssuesById(sprintId: number): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("./mockData");
    return SPRINT_ISSUES_BY_ID[sprintId] ?? [];
  }
  return invoke<JiraIssue[]>("get_sprint_issues_by_id", { sprintId });
}

export async function getIssue(issueKey: string): Promise<JiraIssue> {
  if (isMockMode()) {
    const { ALL_ISSUES_BY_KEY } = await import("./mockData");
    const issue = ALL_ISSUES_BY_KEY[issueKey];
    if (!issue) throw new Error(`Mock: issue ${issueKey} not found`);
    return issue;
  }
  return invoke<JiraIssue>("get_issue", { issueKey });
}

export async function getCompletedSprints(limit: number): Promise<JiraSprint[]> {
  if (isMockMode()) {
    const { COMPLETED_SPRINTS } = await import("./mockData");
    return COMPLETED_SPRINTS.slice(0, limit);
  }
  return invoke<JiraSprint[]>("get_completed_sprints", { limit });
}

export async function searchJiraIssues(
  jql: string,
  maxResults: number
): Promise<JiraIssue[]> {
  if (isMockMode()) {
    const { SPRINT_ISSUES_BY_ID } = await import("./mockData");
    const all = SPRINT_ISSUES_BY_ID[23] ?? [];
    const q = jql.toLowerCase();
    const filtered = all.filter(
      (i) =>
        i.summary.toLowerCase().includes(q) ||
        i.key.toLowerCase().includes(q) ||
        i.status.toLowerCase().includes(q)
    );
    return filtered.slice(0, maxResults);
  }
  return invoke<JiraIssue[]>("search_jira_issues", { jql, maxResults });
}

// ── Bitbucket types ───────────────────────────────────────────────────────────

export interface BitbucketUser {
  displayName: string;
  nickname: string;
  accountId: string | null;
}

export interface BitbucketReviewer {
  user: BitbucketUser;
  approved: boolean;
  state: string;
}

export interface BitbucketPr {
  id: number;
  title: string;
  description: string | null;
  state: string;
  author: BitbucketUser;
  reviewers: BitbucketReviewer[];
  sourceBranch: string;
  destinationBranch: string;
  createdOn: string;
  updatedOn: string;
  commentCount: number;
  taskCount: number;
  url: string;
  jiraIssueKey: string | null;
  changesRequested: boolean;
  draft: boolean;
}

export interface BitbucketTask {
  id: number;
  content: string;
  resolved: boolean;
}

export interface BitbucketInlineContext {
  path: string;
  fromLine: number | null;
  toLine: number | null;
}

export interface BitbucketComment {
  id: number;
  content: string;
  author: BitbucketUser;
  createdOn: string;
  updatedOn: string;
  inline: BitbucketInlineContext | null;
  parentId: number | null;
}

// ── Bitbucket commands ────────────────────────────────────────────────────────

export async function getOpenPrs(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("./mockData");
    return OPEN_PRS;
  }
  return invoke<BitbucketPr[]>("get_open_prs");
}

export async function getMergedPrs(sinceIso?: string): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { MERGED_PRS } = await import("./mockData");
    if (sinceIso) {
      const since = new Date(sinceIso).getTime();
      return MERGED_PRS.filter((pr) => new Date(pr.updatedOn).getTime() >= since);
    }
    return MERGED_PRS;
  }
  return invoke<BitbucketPr[]>("get_merged_prs", { sinceIso: sinceIso ?? null });
}

export async function getPrsForReview(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("./mockData");
    // PRs where the current user (user-1) is a reviewer and hasn't approved yet
    return OPEN_PRS.filter((pr) =>
      pr.reviewers.some((r) => r.user.nickname === "isaac.chen" && !r.approved)
    );
  }
  return invoke<BitbucketPr[]>("get_prs_for_review");
}

export async function getPr(prId: number): Promise<BitbucketPr> {
  if (isMockMode()) {
    const { OPEN_PRS, MERGED_PRS } = await import("./mockData");
    const pr = [...OPEN_PRS, ...MERGED_PRS].find((p) => p.id === prId);
    if (!pr) throw new Error(`Mock: PR #${prId} not found`);
    return pr;
  }
  return invoke<BitbucketPr>("get_pr", { prId });
}

export async function getPrDiff(prId: number): Promise<string> {
  if (isMockMode()) {
    const { PR_87_DIFF } = await import("./mockData");
    // Return a realistic diff for PR 87; stub for others
    if (prId === 87) return PR_87_DIFF;
    return `diff --git a/src/example.rs b/src/example.rs\nindex 0000000..1234567\n--- a/src/example.rs\n+++ b/src/example.rs\n@@ -1,3 +1,5 @@\n fn main() {\n-    println!("hello");\n+    println!("hello, world");\n+    // PR ${prId} mock diff\n }\n`;
  }
  return invoke<string>("get_pr_diff", { prId });
}

export async function getPrComments(prId: number): Promise<BitbucketComment[]> {
  if (isMockMode()) {
    const { PR_87_COMMENTS } = await import("./mockData");
    return prId === 87 ? PR_87_COMMENTS : [];
  }
  return invoke<BitbucketComment[]>("get_pr_comments", { prId });
}

export async function getPrTasks(prId: number): Promise<BitbucketTask[]> {
  return invoke<BitbucketTask[]>("get_pr_tasks", { prId });
}

// ── Knowledge base types ──────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id: string;
  /** "decision" | "pattern" | "learning" */
  entryType: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  linkedJiraKey: string | null;
  linkedPrId: number | null;
}

// ── Knowledge base commands ───────────────────────────────────────────────────

export async function loadKnowledgeEntries(): Promise<KnowledgeEntry[]> {
  return invoke<KnowledgeEntry[]>("load_knowledge_entries");
}

export async function saveKnowledgeEntry(entry: KnowledgeEntry): Promise<void> {
  return invoke("save_knowledge_entry", { entry });
}

export async function deleteKnowledgeEntry(id: string): Promise<void> {
  return invoke("delete_knowledge_entry", { id });
}

export async function exportKnowledgeMarkdown(ids?: string[]): Promise<string> {
  return invoke<string>("export_knowledge_markdown", { ids: ids ?? null });
}

// ── Agent pipeline types ──────────────────────────────────────────────────────

export interface GroomingOutput {
  ticket_summary: string;
  ticket_type: string;
  acceptance_criteria: string[];
  relevant_areas: { area: string; reason: string; files_to_check: string[] }[];
  ambiguities: string[];
  dependencies: string[];
  estimated_complexity: "low" | "medium" | "high";
  grooming_notes: string;
}

export interface ImpactOutput {
  risk_level: "low" | "medium" | "high";
  risk_justification: string;
  affected_areas: string[];
  potential_regressions: string[];
  cross_cutting_concerns: string[];
  files_needing_consistent_updates: string[];
  recommendations: string;
}

export interface PlanFile {
  path: string;
  action: "create" | "modify" | "delete";
  description: string;
}

export interface ImplementationPlan {
  summary: string;
  files: PlanFile[];
  order_of_operations: string[];
  edge_cases: string[];
  do_not_change: string[];
  assumptions: string[];
  open_questions: string[];
}

export interface GuidanceStep {
  step: number;
  title: string;
  file: string;
  action: string;
  details: string;
  code_hints: string;
}

export interface GuidanceOutput {
  steps: GuidanceStep[];
  patterns_to_follow: string[];
  common_pitfalls: string[];
  definition_of_done: string[];
}

export interface TestCase {
  description: string;
  target: string;
  cases: string[];
}

export interface IntegrationTest {
  description: string;
  setup: string;
  cases: string[];
}

export interface TestOutput {
  test_strategy: string;
  unit_tests: TestCase[];
  integration_tests: IntegrationTest[];
  edge_cases_to_test: string[];
  coverage_notes: string;
}

export interface PlanReviewFinding {
  severity: "blocking" | "non_blocking" | "suggestion";
  area: string;
  feedback: string;
}

export interface PlanReviewOutput {
  confidence: "ready" | "needs_attention" | "requires_rework";
  summary: string;
  findings: PlanReviewFinding[];
  things_to_address: string[];
  things_to_watch: string[];
}

export interface PrDescriptionOutput {
  title: string;
  description: string;
}

export interface RetroSkillSuggestion {
  skill: string;
  suggestion: string;
}

export interface RetroKbEntry {
  type: "decision" | "pattern" | "learning";
  title: string;
  body: string;
}

export interface RetrospectiveOutput {
  what_went_well: string[];
  what_could_improve: string[];
  patterns_identified: string[];
  agent_skill_suggestions: RetroSkillSuggestion[];
  knowledge_base_entries: RetroKbEntry[];
  summary: string;
}

export interface TriageMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Agent pipeline commands ───────────────────────────────────────────────────

export async function runGroomingAgent(ticketText: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_GROOMING_JSON } = await import("./mockClaudeResponses");
    return MOCK_GROOMING_JSON;
  }
  return invoke<string>("run_grooming_agent", { ticketText });
}

export async function runImpactAnalysis(ticketText: string, groomingJson: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_IMPACT_JSON } = await import("./mockClaudeResponses");
    return MOCK_IMPACT_JSON;
  }
  return invoke<string>("run_impact_analysis", { ticketText, groomingJson });
}

export async function runTriageTurn(contextText: string, historyJson: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_TRIAGE_ASSISTANT_REPLY } = await import("./mockClaudeResponses");
    return MOCK_TRIAGE_ASSISTANT_REPLY;
  }
  return invoke<string>("run_triage_turn", { contextText, historyJson });
}

export async function finalizeImplementationPlan(contextText: string, conversationJson: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_IMPLEMENTATION_PLAN_JSON } = await import("./mockClaudeResponses");
    return MOCK_IMPLEMENTATION_PLAN_JSON;
  }
  return invoke<string>("finalize_implementation_plan", { contextText, conversationJson });
}

export async function runImplementationGuidance(ticketText: string, planJson: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_GUIDANCE_JSON } = await import("./mockClaudeResponses");
    return MOCK_GUIDANCE_JSON;
  }
  return invoke<string>("run_implementation_guidance", { ticketText, planJson });
}

export async function runTestSuggestions(planJson: string, guidanceJson: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_TESTS_JSON } = await import("./mockClaudeResponses");
    return MOCK_TESTS_JSON;
  }
  return invoke<string>("run_test_suggestions", { planJson, guidanceJson });
}

export async function runPlanReview(planJson: string, guidanceJson: string, testJson: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_PLAN_REVIEW_JSON } = await import("./mockClaudeResponses");
    return MOCK_PLAN_REVIEW_JSON;
  }
  return invoke<string>("run_plan_review", { planJson, guidanceJson, testJson });
}

export async function runPrDescriptionGen(ticketText: string, planJson: string, reviewJson: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_PR_DESCRIPTION_JSON } = await import("./mockClaudeResponses");
    return MOCK_PR_DESCRIPTION_JSON;
  }
  return invoke<string>("run_pr_description_gen", { ticketText, planJson, reviewJson });
}

export async function runRetrospectiveAgent(ticketText: string, planJson: string, reviewJson: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_RETROSPECTIVE_JSON } = await import("./mockClaudeResponses");
    return MOCK_RETROSPECTIVE_JSON;
  }
  return invoke<string>("run_retrospective_agent", { ticketText, planJson, reviewJson });
}

// ── Agent skills commands ─────────────────────────────────────────────────────

export type SkillType = "grooming" | "patterns" | "implementation" | "review";

export async function loadAgentSkills(): Promise<Record<SkillType, string>> {
  return invoke<Record<SkillType, string>>("load_agent_skills");
}

export async function saveAgentSkill(skillType: SkillType, content: string): Promise<void> {
  return invoke("save_agent_skill", { skillType, content });
}

export async function deleteAgentSkill(skillType: SkillType): Promise<void> {
  return invoke("delete_agent_skill", { skillType });
}

export function parseAgentJson<T>(raw: string): T | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
