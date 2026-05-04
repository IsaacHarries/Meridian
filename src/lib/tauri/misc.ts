import { invoke } from "@tauri-apps/api/core";

export async function getDataDir(): Promise<string> {
  return invoke<string>("get_data_dir");
}

export async function dataDirectoryHasContent(path: string): Promise<boolean> {
  return invoke<boolean>("data_directory_has_content", { path });
}

export async function moveDataDirectory(from: string, to: string): Promise<void> {
  return invoke<void>("move_data_directory", { from, to });
}

export async function relaunchApp(): Promise<void> {
  return invoke<void>("relaunch_app");
}

export async function getAiDebugLogPath(): Promise<string> {
  return invoke<string>("get_ai_debug_log_path_cmd");
}

export async function clearAiDebugLogFile(): Promise<void> {
  return invoke<void>("clear_ai_debug_log_cmd");
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

// ── Ollama probe ──────────────────────────────────────────────────────────────

export type OllamaProbeStatus =
  | "available"
  | "unreachable"
  | "model_missing"
  | "not_configured";

export interface OllamaProbe {
  status: OllamaProbeStatus;
  model: string;
  dimensions: number | null;
  message: string | null;
}

export async function probeOllama(model?: string): Promise<OllamaProbe> {
  return invoke<OllamaProbe>("probe_ollama_cmd", { model });
}

// ── Bitbucket image proxy ─────────────────────────────────────────────────────
//
// Bitbucket-hosted images (PR description / comment attachments, user-content
// URLs) require Basic auth. The Tauri webview can't supply per-request auth
// headers for `<img src>`, so the backend fetches the bytes for us and we
// turn them into a `data:` URI on the frontend.

export interface ProxiedImage {
  contentType: string;
  dataBase64: string;
}

export async function fetchBitbucketImage(url: string): Promise<ProxiedImage> {
  return invoke<ProxiedImage>("fetch_bitbucket_image", { url });
}

/**
 * Same idea for JIRA-hosted attachment URLs (typically
 * `{base_url}/rest/api/3/attachment/content/{id}`). The Tauri backend
 * checks the URL prefix against the configured JIRA base URL and refuses
 * anything outside it.
 */
export async function fetchJiraImage(url: string): Promise<ProxiedImage> {
  return invoke<ProxiedImage>("fetch_jira_image", { url });
}

/**
 * Upload an image as a PR-level attachment via Bitbucket's undocumented
 * `/pullrequests/{id}/attachments` endpoint and return the resulting URL.
 * `dataBase64` is the raw image bytes base64-encoded — the data:URI prefix,
 * if any, must be stripped before calling.
 *
 * Caller is expected to surface failures clearly: this endpoint is
 * undocumented and may reject the request entirely (App Password may lack
 * the right scope, the endpoint shape may have shifted, etc.). Users can
 * flip the "Upload images as Bitbucket attachments" toggle off in Settings
 * to fall back to the data-URI embedding flow.
 */
export async function uploadPrAttachment(
  prId: number,
  filename: string,
  dataBase64: string,
  contentType?: string,
): Promise<string> {
  return invoke<string>("upload_pr_attachment", {
    prId,
    filename,
    dataBase64,
    contentType: contentType ?? null,
  });
}
