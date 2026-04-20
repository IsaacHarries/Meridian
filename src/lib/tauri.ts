import { invoke } from "@tauri-apps/api/core";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

// ── Local LLM error detection ─────────────────────────────────────────────────

/**
 * Returns true when an error string looks like the local LLM server is not
 * reachable (i.e. Ollama is not running).
 */
function isLocalLlmConnectionError(err: string): boolean {
  const e = err.toLowerCase();
  return (
    e.includes("could not connect to local llm") ||
    e.includes("make sure ollama") ||
    e.includes("make sure lm studio") ||
    (e.includes("local llm") &&
      (e.includes("connect") || e.includes("reach") || e.includes("refused")))
  );
}

/**
 * Detect which local LLM URL is configured so we can include it in the toast.
 * We read it from the credential store key that `local_llm_url` was saved under.
 * Falls back to "localhost:11434" if unknown.
 */
let _cachedLocalLlmUrl: string | null = null;
export function setLocalLlmUrlCache(url: string) {
  _cachedLocalLlmUrl = url;
}

/**
 * Show a persistent toast explaining that the Ollama server is not running,
 * including the command needed to start it.
 */
function showLocalLlmDownToast(_err: string) {
  const urlHint = _cachedLocalLlmUrl ?? "http://localhost:11434";
  // Determine whether this looks like an Ollama URL vs LM Studio etc.
  const isOllama =
    urlHint.includes("11434") ||
    urlHint.includes("ollama") ||
    !urlHint.includes("1234");

  const startCmd = isOllama
    ? "ollama serve"
    : "Start LM Studio and enable the local server";
  const description = isOllama
    ? `Could not connect to ${urlHint}. Start the server with: ${startCmd}`
    : `Could not connect to ${urlHint}. ${startCmd}.`;

  toast.error("Local LLM server is not running", {
    description,
    duration: 12_000,
    id: "local-llm-down", // deduplicate — only show once at a time
  });
}

/**
 * Wrapper around invoke that automatically detects local-LLM-server-down errors
 * and shows a helpful toast. Re-throws the error so callers still see it.
 */
async function invokeWithLlmCheck<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = String(e);
    if (isLocalLlmConnectionError(err)) {
      showLocalLlmDownToast(err);
    }
    throw e;
  }
}

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
  copilotApiKey: boolean;
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

/** True when at least one AI provider (Anthropic, Gemini, Copilot, or local LLM) is configured. */
export function aiProviderComplete(s: CredentialStatus) {
  return (
    s.anthropicApiKey || s.geminiApiKey || s.copilotApiKey || s.localLlmUrl
  );
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
  return (
    s.bitbucketWorkspace &&
    s.bitbucketEmail &&
    s.bitbucketAccessToken &&
    s.bitbucketRepoSlug
  );
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

export async function saveCredential(
  key: string,
  value: string,
): Promise<void> {
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
  apiToken: string,
): Promise<string> {
  return invoke<string>("validate_jira", { baseUrl, email, apiToken });
}

export async function validateBitbucket(
  workspace: string,
  email: string,
  accessToken: string,
): Promise<string> {
  return invoke<string>("validate_bitbucket", {
    workspace,
    email,
    accessToken,
  });
}

/** Test the stored Anthropic key without passing it through the frontend. */
export async function testAnthropicStored(): Promise<string> {
  return invoke<string>("test_anthropic_stored");
}

/** Send a real "hello" message to Claude and verify a response comes back. */
export async function pingAnthropic(): Promise<string> {
  return invoke<string>("ping_anthropic");
}

/** Send a real "hello" message to Gemini and verify a response comes back. */
export async function pingGemini(): Promise<string> {
  return invoke<string>("ping_gemini");
}

/** Import the Claude Code CLI's OAuth token from the macOS Keychain. */
export async function importClaudeCodeToken(): Promise<string> {
  return invoke<string>("import_claude_code_token");
}

/**
 * Read the Claude Pro / Max OAuth token from the macOS keychain (where Claude Code
 * stores it after `claude /login`) and save it as the Anthropic credential.
 * Opens a browser to claude.ai, completes the OAuth PKCE flow, and stores the
 * resulting tokens. No Claude Code CLI required.
 */
export async function startClaudeOauth(): Promise<string> {
  return invoke<string>("start_claude_oauth");
}

/** Return the list of available Claude models as [id, display_label] pairs. */
export async function getClaudeModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_claude_models");
}

export async function startGeminiOauth(): Promise<string> {
  return invoke<string>("start_gemini_oauth");
}

/** Return the list of available Gemini models as [id, display_label] pairs. */
export async function getGeminiModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_gemini_models");
}

/** Return just the user-added custom Gemini model IDs. */
export async function getCustomGeminiModels(): Promise<string[]> {
  return invoke<string[]>("get_custom_gemini_models");
}

/** Persist a new custom Gemini model ID. Returns the updated custom list. */
export async function addCustomGeminiModel(modelId: string): Promise<string[]> {
  return invoke<string[]>("add_custom_gemini_model", { modelId });
}

/** Remove a user-added custom Gemini model. Returns the updated custom list. */
export async function removeCustomGeminiModel(
  modelId: string,
): Promise<string[]> {
  return invoke<string[]>("remove_custom_gemini_model", { modelId });
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

export async function startCopilotOauth(): Promise<string> {
  return invoke<string>("start_copilot_oauth");
}

export async function getCopilotModels(): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_copilot_models");
}

export async function getCustomCopilotModels(): Promise<string[]> {
  return invoke<string[]>("get_custom_copilot_models");
}

export async function addCustomCopilotModel(
  modelId: string,
): Promise<string[]> {
  return invoke<string[]>("add_custom_copilot_model", { modelId });
}

export async function removeCustomCopilotModel(
  modelId: string,
): Promise<string[]> {
  return invoke<string[]>("remove_custom_copilot_model", { modelId });
}

export async function validateCopilot(apiKey: string): Promise<string> {
  return invoke<string>("validate_copilot", { apiKey });
}

export async function testCopilotStored(): Promise<string> {
  return invoke<string>("test_copilot_stored");
}

export async function pingCopilot(): Promise<string> {
  return invoke<string>("ping_copilot");
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
export async function validateLocalLlm(
  url: string,
  apiKey: string,
): Promise<string> {
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

export async function generateStandupBriefing(
  standupText: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_STANDUP_MARKDOWN } = await import("./mockClaudeResponses");
    return MOCK_STANDUP_MARKDOWN;
  }
  return invokeWithLlmCheck<string>("generate_standup_briefing", {
    standupText,
  });
}

export async function generateSprintRetrospective(
  sprintText: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_SPRINT_RETRO_MARKDOWN } =
      await import("./mockClaudeResponses");
    return MOCK_SPRINT_RETRO_MARKDOWN;
  }
  return invokeWithLlmCheck<string>("generate_sprint_retrospective", {
    sprintText,
  });
}

export async function generateWorkloadSuggestions(
  workloadText: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_WORKLOAD_MARKDOWN } = await import("./mockClaudeResponses");
    return MOCK_WORKLOAD_MARKDOWN;
  }
  return invokeWithLlmCheck<string>("generate_workload_suggestions", {
    workloadText,
  });
}

export async function reviewPr(reviewText: string): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_PR_REVIEW_JSON } = await import("./mockClaudeResponses");
    return MOCK_PR_REVIEW_JSON;
  }
  return invokeWithLlmCheck<string>("review_pr", { reviewText });
}

/** Signal the backend to stop an in-progress PR review between chunks. */
export async function cancelReview(): Promise<void> {
  return invoke<void>("cancel_review");
}

/** Conversational follow-up chat about a completed PR review. */
export async function chatPrReview(
  contextText: string,
  historyJson: string,
): Promise<string> {
  return invokeWithLlmCheck<string>("chat_pr_review", {
    contextText,
    historyJson,
  });
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

export function parseReviewReport(raw: string): ReviewReport | null {
  try {
    // Strip markdown fences if present
    let cleaned = raw
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();

    // Sanitise bare unquoted line_range values produced by some models, e.g.:
    //   "line_range": L96-L127   →   "line_range": "L96-L127"
    // Matches: "line_range": followed by whitespace and a non-null, non-quote, non-digit token
    cleaned = cleaned.replace(
      /"line_range"\s*:\s*(?!null\b|")(L[\w\-]+)/g,
      '"line_range": "$1"',
    );

    return JSON.parse(cleaned) as ReviewReport;
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

export async function getAllActiveSprintIssues(): Promise<
  Array<[JiraSprint, JiraIssue[]]>
> {
  if (isMockMode()) {
    const { ACTIVE_SPRINT, SPRINT_ISSUES_BY_ID } = await import("./mockData");
    if (!ACTIVE_SPRINT) return [];
    return [[ACTIVE_SPRINT, SPRINT_ISSUES_BY_ID[23] ?? []]];
  }
  return invoke<Array<[JiraSprint, JiraIssue[]]>>(
    "get_all_active_sprint_issues",
  );
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

export async function getSprintIssuesById(
  sprintId: number,
): Promise<JiraIssue[]> {
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

export async function getCompletedSprints(
  limit: number,
): Promise<JiraSprint[]> {
  if (isMockMode()) {
    const { COMPLETED_SPRINTS } = await import("./mockData");
    return COMPLETED_SPRINTS.slice(0, limit);
  }
  return invoke<JiraSprint[]>("get_completed_sprints", { limit });
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
    const { SPRINT_ISSUES_BY_ID } = await import("./mockData");
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
  commentId: number | null;
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

/** Open PRs authored by the configured Bitbucket user (for the Address PR Comments workflow). */
export async function getMyOpenPrs(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("./mockData");
    return OPEN_PRS;
  }
  return invoke<BitbucketPr[]>("get_my_open_prs");
}

export async function getMergedPrs(sinceIso?: string): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { MERGED_PRS } = await import("./mockData");
    if (sinceIso) {
      const since = new Date(sinceIso).getTime();
      return MERGED_PRS.filter(
        (pr) => new Date(pr.updatedOn).getTime() >= since,
      );
    }
    return MERGED_PRS;
  }
  return invoke<BitbucketPr[]>("get_merged_prs", {
    sinceIso: sinceIso ?? null,
  });
}

export async function getPrsForReview(): Promise<BitbucketPr[]> {
  if (isMockMode()) {
    const { OPEN_PRS } = await import("./mockData");
    // PRs where the current user (user-1) is a reviewer and hasn't approved yet
    return OPEN_PRS.filter((pr) =>
      pr.reviewers.some((r) => r.user.nickname === "isaac.chen" && !r.approved),
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

/** Approve a PR as the authenticated user. Requires pullrequest:write scope. */
export async function approvePr(prId: number): Promise<void> {
  return invoke<void>("approve_pr", { prId });
}

/** Remove your approval from a PR. */
export async function unapprovePr(prId: number): Promise<void> {
  return invoke<void>("unapprove_pr", { prId });
}

/** Mark a PR as 'Needs work' (request changes). */
export async function requestChangesPr(prId: number): Promise<void> {
  return invoke<void>("request_changes_pr", { prId });
}

/** Remove your 'Needs work' status from a PR. */
export async function unrequestChangesPr(prId: number): Promise<void> {
  return invoke<void>("unrequest_changes_pr", { prId });
}

/**
 * Post a comment on a PR.
 * - General comment: omit `inlinePath` / `inlineToLine`.
 * - Inline comment: provide `inlinePath` (file path in the diff) and `inlineToLine` (new-side line number).
 * - Reply: provide `parentId` (the comment id to reply to).
 */
export async function postPrComment(
  prId: number,
  content: string,
  inlinePath?: string,
  inlineToLine?: number,
  parentId?: number,
): Promise<BitbucketComment> {
  return invoke<BitbucketComment>("post_pr_comment", {
    prId,
    content,
    inlinePath: inlinePath ?? null,
    inlineToLine: inlineToLine ?? null,
    parentId: parentId ?? null,
  });
}

/** Create a task linked to a specific comment on a PR. */
export async function createPrTask(
  prId: number,
  commentId: number,
  content: string,
): Promise<BitbucketTask> {
  return invoke<BitbucketTask>("create_pr_task", { prId, commentId, content });
}

export async function resolvePrTask(
  prId: number,
  taskId: number,
  resolved: boolean,
): Promise<BitbucketTask> {
  return invoke<BitbucketTask>("resolve_pr_task", { prId, taskId, resolved });
}

export async function deletePrComment(
  prId: number,
  commentId: number,
): Promise<void> {
  return invoke<void>("delete_pr_comment", { prId, commentId });
}

export async function updatePrComment(
  prId: number,
  commentId: number,
  content: string,
): Promise<BitbucketComment> {
  return invoke<BitbucketComment>("update_pr_comment", {
    prId,
    commentId,
    content,
  });
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
  suggested_edits: SuggestedEdit[];
  clarifying_questions: string[];
}

export type SuggestedEditField =
  | "description"
  | "acceptance_criteria"
  | "steps_to_reproduce"
  | "observed_behavior"
  | "expected_behavior"
  | "summary";

export type SuggestedEditStatus = "pending" | "approved" | "declined";

export interface SuggestedEdit {
  /** Stable ID used to correlate edits across chat turns */
  id: string;
  field: SuggestedEditField;
  section: string;
  /** The current text in the ticket, or null if this section is missing entirely */
  current: string | null;
  suggested: string;
  reasoning: string;
  /** Client-side status — not returned by the agent */
  status: SuggestedEditStatus;
}

export interface GroomingChatResponse {
  message: string;
  updated_edits: Omit<SuggestedEdit, "status">[];
  updated_questions: string[];
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

export interface ImplementationFileResult {
  path: string;
  action: "created" | "modified" | "deleted";
  summary: string;
}

export interface ImplementationOutput {
  summary: string;
  files_changed: ImplementationFileResult[];
  deviations: string[];
  skipped: string[];
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

export async function runGroomingAgent(
  ticketText: string,
  fileContents: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_GROOMING_JSON } = await import("./mockClaudeResponses");
    return MOCK_GROOMING_JSON;
  }
  return invokeWithLlmCheck<string>("run_grooming_agent", {
    ticketText,
    fileContents,
  });
}

/** Phase-1 probe: ask the agent which files to read before full grooming. */
export async function runGroomingFileProbe(
  ticketText: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    return JSON.stringify({ files: [], grep_patterns: [] });
  }
  return invokeWithLlmCheck<string>("run_grooming_file_probe", { ticketText });
}

/**
 * Grooming conversation turn — returns structured JSON:
 * { message, updated_edits, updated_questions }
 */
export async function runGroomingChatTurn(
  contextText: string,
  historyJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    return JSON.stringify({
      message:
        "I've updated my understanding. The suggested edits reflect the agreed wording. Feel free to ask any more questions or approve the grooming to proceed.",
      updated_edits: [],
      updated_questions: [],
    });
  }
  return invokeWithLlmCheck<string>("run_grooming_chat_turn", {
    contextText,
    historyJson,
  });
}

export async function runImpactAnalysis(
  ticketText: string,
  groomingJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_IMPACT_JSON } = await import("./mockClaudeResponses");
    return MOCK_IMPACT_JSON;
  }
  return invokeWithLlmCheck<string>("run_impact_analysis", {
    ticketText,
    groomingJson,
  });
}

export async function runTriageTurn(
  contextText: string,
  historyJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_TRIAGE_ASSISTANT_REPLY } =
      await import("./mockClaudeResponses");
    return MOCK_TRIAGE_ASSISTANT_REPLY;
  }
  return invokeWithLlmCheck<string>("run_triage_turn", {
    contextText,
    historyJson,
  });
}

export async function runCheckpointChatTurn(
  contextText: string,
  historyJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    return "Happy to help clarify. Based on the stage output, everything looks on track. Let me know if you have specific questions.";
  }
  return invokeWithLlmCheck<string>("run_checkpoint_chat_turn", {
    contextText,
    historyJson,
  });
}

export interface CheckpointActionResult {
  message: string;
  /** Implementation stage: paths the agent wrote via write_repo_file tool. */
  files_written?: string[];
  /** Exact deviation strings (from implementation.deviations) that are now resolved. */
  deviations_resolved?: string[];
  /** Paths from implementation.skipped that have now been written. */
  skipped_resolved?: string[];
  /** For non-implementation stages: the complete updated stage output JSON, or null. */
  updated_output?: unknown;
}

export async function runCheckpointAction(
  stage: string,
  contextText: string,
  historyJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    return JSON.stringify({
      message: "I've reviewed the output. No changes were necessary — everything looks correct.",
      file_writes: [],
      deviations_resolved: [],
      skipped_resolved: [],
      updated_output: null,
    });
  }
  return invokeWithLlmCheck<string>("run_checkpoint_action", {
    stage,
    contextText,
    historyJson,
  });
}

export async function runToolTest(
  toolName: string,
  inputJson: string,
): Promise<string> {
  return invoke<string>("run_tool_test", { toolName, inputJson });
}

export interface LlmToolTestResult {
  ok: boolean;
  provider: string;
  tool_name: string;
  llm_response?: string;
  error?: string;
}

export async function runToolTestWithLlm(
  provider: string,
  toolName: string,
  inputJson: string,
): Promise<LlmToolTestResult> {
  const raw = await invoke<string>("run_tool_test_with_llm", { provider, toolName, inputJson });
  return JSON.parse(raw) as LlmToolTestResult;
}

export async function writeRepoFile(
  path: string,
  content: string,
): Promise<void> {
  return invoke("write_repo_file", { path, content });
}

export interface BuildAttempt {
  attempt: number;
  exit_code: number;
  output: string;
  fixed: boolean;
  files_written: string[];
}

export interface BuildCheckResult {
  build_command: string;
  build_passed: boolean;
  attempts: BuildAttempt[];
}

export async function runBuildCheck(
  ticketText: string,
  planJson: string,
  implJson: string,
): Promise<string> {
  return invoke<string>("run_build_check", {
    ticketText,
    planJson,
    implJson,
  });
}

export async function execInWorktree(
  command: string,
  timeoutSecs?: number,
): Promise<[number, string]> {
  return invoke<[number, string]>("exec_in_worktree", {
    command,
    timeoutSecs,
  });
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

export async function finalizeImplementationPlan(
  contextText: string,
  conversationJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_IMPLEMENTATION_PLAN_JSON } =
      await import("./mockClaudeResponses");
    return MOCK_IMPLEMENTATION_PLAN_JSON;
  }
  return invokeWithLlmCheck<string>("finalize_implementation_plan", {
    contextText,
    conversationJson,
  });
}

export async function runImplementationAgent(
  ticketText: string,
  planJson: string,
  guidanceJson: string,
): Promise<string> {
  return invokeWithLlmCheck<string>("run_implementation_agent", {
    ticketText,
    planJson,
    guidanceJson,
  });
}

export async function runImplementationGuidance(
  ticketText: string,
  planJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_GUIDANCE_JSON } = await import("./mockClaudeResponses");
    return MOCK_GUIDANCE_JSON;
  }
  return invokeWithLlmCheck<string>("run_implementation_guidance", {
    ticketText,
    planJson,
  });
}

export async function runTestSuggestions(
  ticketText: string,
  planJson: string,
  implJson: string,
  diff: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_TESTS_JSON } = await import("./mockClaudeResponses");
    return MOCK_TESTS_JSON;
  }
  return invokeWithLlmCheck<string>("run_test_suggestions", {
    ticketText,
    planJson,
    implJson,
    diff,
  });
}

export async function runPlanReview(
  ticketText: string,
  planJson: string,
  implJson: string,
  testJson: string,
  diff: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_PLAN_REVIEW_JSON } = await import("./mockClaudeResponses");
    return MOCK_PLAN_REVIEW_JSON;
  }
  return invokeWithLlmCheck<string>("run_plan_review", {
    ticketText,
    planJson,
    implJson,
    testJson,
    diff,
  });
}

export async function runPrDescriptionGen(
  ticketText: string,
  planJson: string,
  implJson: string,
  reviewJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_PR_DESCRIPTION_JSON } = await import("./mockClaudeResponses");
    return MOCK_PR_DESCRIPTION_JSON;
  }
  return invokeWithLlmCheck<string>("run_pr_description_gen", {
    ticketText,
    planJson,
    implJson,
    reviewJson,
  });
}

export async function runRetrospectiveAgent(
  ticketText: string,
  planJson: string,
  implJson: string,
  reviewJson: string,
): Promise<string> {
  if (isMockClaudeMode()) {
    const { MOCK_RETROSPECTIVE_JSON } = await import("./mockClaudeResponses");
    return MOCK_RETROSPECTIVE_JSON;
  }
  return invokeWithLlmCheck<string>("run_retrospective_agent", {
    ticketText,
    planJson,
    implJson,
    reviewJson,
  });
}

// ── Repo / worktree types & commands ─────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch: string;
  headCommit: string;
  headMessage: string;
}

/** Validate the configured worktree path is a valid git repository. */
export async function validateWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_worktree");
}

/**
 * Fetch from origin and hard-reset the worktree to the configured base branch.
 * Returns the new HEAD info.
 */
export async function syncWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("sync_worktree");
}

/** Find files matching a glob pattern (relative to the worktree root). */
export async function globRepoFiles(pattern: string): Promise<string[]> {
  return invoke<string[]>("glob_repo_files", { pattern });
}

/**
 * Search file contents with an extended regex.
 * @param path Optional subdirectory to restrict the search to.
 */
export async function grepRepoFiles(
  pattern: string,
  path?: string,
): Promise<string[]> {
  return invoke<string[]>("grep_repo_files", { pattern, path: path ?? null });
}

/** Read a single file from the worktree (path relative to root). */
export async function readRepoFile(path: string): Promise<string> {
  return invoke<string>("read_repo_file", { path });
}

/** Get the git diff of the worktree against the configured base branch. */
export async function getRepoDiff(): Promise<string> {
  return invoke<string>("get_repo_diff");
}

/** Read a file's content at the merge-base with origin/<base>. Empty string for new files. */
export async function getFileAtBase(path: string): Promise<string> {
  return invoke<string>("get_file_at_base", { path });
}

/** Get recent commits in the worktree. */
export async function getRepoLog(maxCommits: number): Promise<string> {
  return invoke<string>("get_repo_log", { maxCommits });
}

/** Get the git log for a specific file (to understand history). */
export async function getFileHistory(
  path: string,
  maxCommits: number,
): Promise<string> {
  return invoke<string>("get_file_history", { path, maxCommits });
}

/**
 * Check out a branch in the configured worktree (fetch + checkout/reset).
 * Used by the PR Review Assistant before analysis.
 */
export async function checkoutWorktreeBranch(
  branch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("checkout_worktree_branch", { branch });
}

/**
 * Validate the PR review worktree path (falls back to the main worktree if no
 * dedicated PR review path is configured).
 */
export async function validatePrReviewWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_pr_review_worktree");
}

/**
 * Check out a branch in the PR review worktree (fetch + checkout/reset).
 * Uses `pr_review_worktree_path` if set, otherwise falls back to `repo_worktree_path`.
 */
export async function checkoutPrReviewBranch(
  branch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("checkout_pr_review_branch", { branch });
}

/**
 * Open a new macOS Terminal window in the PR review worktree directory and
 * run the supplied shell command. The window stays open so the user can
 * interact with the running process.
 */
export async function runInTerminal(command: string): Promise<void> {
  return invoke<void>("run_in_terminal", { command });
}

// ── PR Address worktree commands ──────────────────────────────────────────────

/**
 * Validate the PR address worktree path.
 * Falls back to pr_review_worktree_path → repo_worktree_path.
 */
export async function validatePrAddressWorktree(): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("validate_pr_address_worktree");
}

/**
 * Check out a branch in the PR address worktree (fetch + checkout/reset).
 */
export async function checkoutPrAddressBranch(
  branch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("checkout_pr_address_branch", { branch });
}

/** Read a file from the PR address worktree (relative path). */
export async function readPrAddressFile(path: string): Promise<string> {
  return invoke<string>("read_pr_address_file", { path });
}

/**
 * Write a file in the PR address worktree (relative path).
 * Sandboxed to the worktree root.
 */
export async function writePrAddressFile(
  path: string,
  content: string,
): Promise<void> {
  return invoke<void>("write_pr_address_file", { path, content });
}

/** Get the current diff of the PR address worktree (staged + unstaged vs HEAD). */
export async function getPrAddressDiff(): Promise<string> {
  return invoke<string>("get_pr_address_diff");
}

/** Stage all changes and commit in the PR address worktree. Returns the new short SHA. */
export async function commitPrAddressChanges(message: string): Promise<string> {
  return invoke<string>("commit_pr_address_changes", { message });
}

/** Push the current branch of the PR address worktree to origin. */
export async function pushPrAddressBranch(): Promise<void> {
  return invoke<void>("push_pr_address_branch");
}

// ── Address PR Comments — Claude commands ─────────────────────────────────────

/**
 * Analyse reviewer comments on a PR and produce a structured fix plan.
 * Streams reasoning to the `address-pr-stream` event.
 * Returns a JSON array of fix proposals.
 */
export async function analyzePrComments(reviewText: string): Promise<string> {
  return invoke<string>("analyze_pr_comments", { reviewText });
}

/**
 * Multi-turn chat for the Address PR Comments workflow.
 */
export async function chatAddressPr(
  contextText: string,
  historyJson: string,
): Promise<string> {
  return invoke<string>("chat_address_pr", { contextText, historyJson });
}

export type SkillType = "grooming" | "patterns" | "implementation" | "review";

export async function loadAgentSkills(): Promise<Record<SkillType, string>> {
  return invoke<Record<SkillType, string>>("load_agent_skills");
}

export async function saveAgentSkill(
  skillType: SkillType,
  content: string,
): Promise<void> {
  return invoke("save_agent_skill", { skillType, content });
}

export async function deleteAgentSkill(skillType: SkillType): Promise<void> {
  return invoke("delete_agent_skill", { skillType });
}

export function parseAgentJson<T>(raw: string): T | null {
  // 1. Direct parse
  try { return JSON.parse(raw.trim()) as T; } catch { /* fall through */ }

  // 2. Strip a single ```json ... ``` fence
  try {
    const fenced = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    return JSON.parse(fenced) as T;
  } catch { /* fall through */ }

  // 3. Extract the outermost {...} or [...] block from prose-wrapped responses
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");
  const start =
    firstBrace === -1 ? firstBracket
    : firstBracket === -1 ? firstBrace
    : Math.min(firstBrace, firstBracket);
  if (start !== -1) {
    const opener = raw[start];
    const closer = opener === "{" ? "}" : "]";
    const end = raw.lastIndexOf(closer);
    if (end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)) as T; } catch { /* fall through */ }
    }
  }

  return null;
}

// ── Store cache (file-backed persistence) ─────────────────────────────────────

/**
 * Write a store's serialised JSON to a file in the app data directory.
 * Replaces localStorage — no size limit.
 */
export async function saveStoreCache(key: string, json: string): Promise<void> {
  return invoke("save_store_cache", { key, json });
}

/**
 * Read a previously saved store cache. Returns null if the file doesn't exist yet.
 */
export async function loadStoreCache(key: string): Promise<string | null> {
  return invoke<string | null>("load_store_cache", { key });
}

/**
 * Delete a single store cache file.
 */
export async function deleteStoreCache(key: string): Promise<void> {
  return invoke("delete_store_cache", { key });
}

/**
 * Return the size in bytes of each cache file, keyed by cache key name.
 * Used to display cache usage in Settings.
 */
export async function getStoreCacheInfo(): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("get_store_cache_info");
}

/**
 * Delete all store cache files. This is the "Clear Cache" action.
 */
export async function clearAllStoreCaches(): Promise<void> {
  return invoke("clear_all_store_caches");
}

// ── URL fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch the text content of a URL from the Tauri backend.
 * HTML pages are stripped to plain text. Content is capped at ~100 KB.
 * Throws a string error message on failure.
 */
export async function fetchUrlContent(url: string): Promise<string> {
  return invoke<string>("fetch_url_content", { url });
}
