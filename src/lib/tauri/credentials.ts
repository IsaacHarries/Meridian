import { invoke } from "@tauri-apps/api/core";
import { isMockMode, isMockClaudeMode } from "./core";

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
