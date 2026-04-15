/**
 * User preferences — non-secret configuration stored in preferences.json
 * in the app data directory.
 *
 * Separate from:
 *   - The credential store (encrypted, for API keys/tokens)
 *   - The Zustand store cache (clearable, for ephemeral UI state)
 *
 * Preferences survive cache clears and are never encrypted.
 */

import { invoke } from "@tauri-apps/api/core";

export async function getPreferences(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_preferences");
}

/**
 * Set a preference. Pass an empty string to remove the key.
 */
export async function setPreference(key: string, value: string): Promise<void> {
  return invoke("set_preference", { key, value });
}

export async function deletePreference(key: string): Promise<void> {
  return invoke("delete_preference", { key });
}

// ── Ignored developers ────────────────────────────────────────────────────────
// Stored as a JSON array of display names under the "ignored_devs" preference key.

const IGNORED_DEVS_KEY = "ignored_devs";

export async function getIgnoredDevs(): Promise<Set<string>> {
  try {
    const prefs = await getPreferences();
    const raw = prefs[IGNORED_DEVS_KEY];
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export async function setIgnoredDevs(names: Set<string>): Promise<void> {
  await setPreference(IGNORED_DEVS_KEY, JSON.stringify([...names]));
}

