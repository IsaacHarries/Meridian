import { invoke } from "@tauri-apps/api/core";

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
