//! Persistence for the auto work-hours tracker.
//!
//! Stores the entire tracker state — segments, manual adjustments, and
//! settings — in a single JSON file inside the user's data directory:
//!
//!     <data_dir>/time_tracking.json
//!
//! Why a dedicated file rather than the `store_cache/` directory the
//! Zustand stores normally hash into? Because the Settings "Clear Cache"
//! button wipes everything under `store_cache/`. Time-tracking data is
//! the user's only record of how many hours they've logged this week —
//! losing it to an unrelated cache flush would be a real data-loss event.
//!
//! Why under the resolved `data_dir` (not `app_data_dir` directly)? So
//! it travels with the rest of the user's generated data when they move
//! the data directory in Settings.

use std::fs;
use std::path::PathBuf;

use crate::storage::preferences::resolve_data_dir;

const FILENAME: &str = "time_tracking.json";

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_data_dir(app)?;
    Ok(dir.join(FILENAME))
}

/// Path that store_cache used to use, so we can migrate one-time on first
/// load. Built directly here (rather than depending on `store_cache::cache_dir`)
/// to avoid resurrecting a cache directory that may have been cleared.
fn legacy_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    Ok(base
        .join("store_cache")
        .join("meridian-time-tracking-store.json"))
}

pub fn save(app: &tauri::AppHandle, json: String) -> Result<(), String> {
    let p = path(app)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create time tracking dir: {e}"))?;
    }
    // Write to a sibling temp file then rename, so a partial write (power
    // loss, OOM) can't truncate the live file to zero bytes.
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("Cannot write time tracking tmp: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("Cannot finalise time tracking write: {e}"))?;
    Ok(())
}

/// Load the persisted state. Returns `None` if neither the new file nor
/// the legacy store_cache copy exists. If only the legacy copy exists,
/// migrate it across before returning so subsequent loads use the new
/// path exclusively.
pub fn load(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let p = path(app)?;
    if p.exists() {
        return fs::read_to_string(&p)
            .map(Some)
            .map_err(|e| format!("Cannot read time tracking: {e}"));
    }
    // Try migrating from the old store_cache location.
    let legacy = legacy_path(app)?;
    if legacy.exists() {
        let raw = fs::read_to_string(&legacy)
            .map_err(|e| format!("Cannot read legacy time tracking: {e}"))?;
        // Best-effort: write the new file. If that fails we still return
        // the data so the user isn't blocked.
        let _ = save(app, raw.clone());
        let _ = fs::remove_file(&legacy);
        return Ok(Some(raw));
    }
    Ok(None)
}
