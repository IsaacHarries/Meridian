import { invoke } from "@tauri-apps/api/core";

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
