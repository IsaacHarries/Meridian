use crate::storage::store_cache;
use std::collections::HashMap;

/// Write (or overwrite) a cache entry.
#[tauri::command]
pub fn save_store_cache(app: tauri::AppHandle, key: String, json: String) -> Result<(), String> {
    store_cache::save_cache(&app, key, json)
}

/// Read a cache entry. Returns `None` if the file does not exist.
#[tauri::command]
pub fn load_store_cache(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    store_cache::load_cache(&app, key)
}

/// Delete a single cache entry. No-op if it doesn't exist.
#[tauri::command]
pub fn delete_store_cache(app: tauri::AppHandle, key: String) -> Result<(), String> {
    store_cache::delete_cache(&app, key)
}

/// Return the size in bytes of each cache file, keyed by cache key name.
/// Files that cannot be stat'd are omitted.
#[tauri::command]
pub fn get_store_cache_info(app: tauri::AppHandle) -> Result<HashMap<String, u64>, String> {
    store_cache::get_info(&app)
}

/// Delete all cache files. This is the "Clear Cache" action.
#[tauri::command]
pub fn clear_all_store_caches(app: tauri::AppHandle) -> Result<(), String> {
    store_cache::clear_all(&app)
}
