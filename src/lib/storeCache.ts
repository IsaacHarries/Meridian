import { clearAllStoreCaches, deleteStoreCache, getStoreCacheInfo, loadStoreCache, saveStoreCache } from "@/lib/tauri/store-cache";

export { clearAllStoreCaches, deleteStoreCache, getStoreCacheInfo };

// ── Serialisation helpers ──────────────────────────────────────────────────────

/**
 * JSON replacer that converts:
 *   Set  → { __set: [...] }
 *   Map  → { __map: [[k,v]...] }
 */
export function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return { __set: [...value] };
  if (value instanceof Map) return { __map: [...value.entries()] };
  return value;
}

/**
 * JSON reviver that reconstructs Set and Map from the tagged objects above.
 */
export function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if ("__set" in v && Array.isArray(v.__set)) return new Set(v.__set);
    if ("__map" in v && Array.isArray(v.__map)) return new Map(v.__map as [unknown, unknown][]);
  }
  return value;
}

// ── Load ───────────────────────────────────────────────────────────────────────

/**
 * Load a store's state from the file cache.
 * Returns `null` if the file doesn't exist or cannot be parsed.
 */
export async function loadCache<T>(key: string): Promise<Partial<T> | null> {
  try {
    const raw = await loadStoreCache(key);
    if (!raw) return null;
    return JSON.parse(raw, reviver) as Partial<T>;
  } catch (e) {
    console.warn(`[storeCache] Failed to load cache "${key}":`, e);
    return null;
  }
}

// ── Save (debounced) ───────────────────────────────────────────────────────────

const _timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced save — waits `delayMs` (default 800ms) after the last call before
 * writing to disk. This prevents hammering the file system during rapid state
 * changes (e.g. streaming text updates).
 */
export function saveCache<T>(key: string, state: T, delayMs = 800): void {
  const existing = _timers.get(key);
  if (existing) clearTimeout(existing);

  const id = setTimeout(() => {
    _timers.delete(key);
    try {
      const json = JSON.stringify(state, replacer);
      saveStoreCache(key, json).catch((e) =>
        console.warn(`[storeCache] Failed to save cache "${key}":`, e)
      );
    } catch (e) {
      console.warn(`[storeCache] Failed to serialise cache "${key}":`, e);
    }
  }, delayMs);

  _timers.set(key, id);
}

