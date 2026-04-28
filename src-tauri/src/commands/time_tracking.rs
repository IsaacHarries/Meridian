//! Time tracking — macOS system-state poller.
//!
//! Spawns a single background thread that, every `POLL_INTERVAL_SEC`, reads
//! two pieces of system state:
//!
//! 1. Whether the screen is currently locked (or the user is at the login
//!    screen) — via `CGSessionCopyCurrentDictionary` and the
//!    `CGSSessionScreenIsLocked` key.
//! 2. How many seconds have elapsed since any HID input event — via
//!    `CGEventSourceSecondsSinceLastEventType`. The frontend decides whether
//!    that crosses its idle threshold; we just report the raw number so the
//!    user can change the threshold without restarting the app.
//!
//! The thread emits a single `time-tracker:state` Tauri event with the latest
//! `{ isLocked, idleSec }` payload on every tick. The frontend store
//! (`timeTrackingStore`) listens and translates state transitions into
//! work-segment opens and closes.
//!
//! Why polling vs. NSWorkspace notifications? Notifications would be the
//! right call for a system-wide daemon, but in-app we'd still need a tick to
//! refresh the running stopwatch — and a single 5s poll is plenty cheap. It
//! also avoids the objc2/AppKit dependency footprint and the lifecycle
//! quirks of registering Cocoa observers from a Tauri-spawned thread.

use core_foundation::{
    base::{CFType, TCFType},
    boolean::CFBoolean,
    dictionary::CFDictionary,
    string::CFString,
};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Emitter;

const POLL_INTERVAL_SEC: u64 = 5;

// macOS system constants ------------------------------------------------------
//
// `kCGEventSourceStateCombinedSessionState` (= 1) gives us idle time
// across both HID and software-injected events. `kCGAnyInputEventType` is
// represented as the all-ones u32 (0xFFFFFFFF) per the CoreGraphics headers.
const CG_EVENT_SOURCE_STATE_COMBINED: i32 = 1;
const CG_ANY_INPUT_EVENT_TYPE: u32 = 0xFFFFFFFF;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(
        source_state_id: i32,
        event_type: u32,
    ) -> f64;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSessionCopyCurrentDictionary() -> *const c_void;
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Spawn the polling thread. Idempotent — repeated calls after the first are
/// no-ops, since the thread runs for the lifetime of the process.
pub fn start_time_tracking_poller(app: tauri::AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        loop {
            let snapshot = read_system_state();
            let _ = app.emit(
                "time-tracker:state",
                serde_json::json!({
                    "isLocked": snapshot.is_locked,
                    "idleSec": snapshot.idle_sec,
                }),
            );
            std::thread::sleep(Duration::from_secs(POLL_INTERVAL_SEC));
        }
    });
}

/// One-shot snapshot of the system's current state. Exposed as a Tauri command
/// so the frontend can read state synchronously on hydration without waiting
/// for the next poll tick.
#[tauri::command]
pub fn get_system_activity_state() -> Result<SystemActivitySnapshot, String> {
    Ok(read_system_state())
}

/// Persist the time-tracking store state to disk. Stored under the user's
/// resolved data directory in `time_tracking.json` — outside the
/// `store_cache/` tree so it survives the Settings "Clear Cache" action.
#[tauri::command]
pub fn save_time_tracking_state(app: tauri::AppHandle, json: String) -> Result<(), String> {
    crate::storage::time_tracking::save(&app, json)
}

/// Load the persisted time-tracking state. Migrates one-time from the old
/// store_cache location if the new file doesn't exist yet.
#[tauri::command]
pub fn load_time_tracking_state(app: tauri::AppHandle) -> Result<Option<String>, String> {
    crate::storage::time_tracking::load(&app)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemActivitySnapshot {
    pub is_locked: bool,
    pub idle_sec: f64,
}

// ── Internals ────────────────────────────────────────────────────────────────

fn read_system_state() -> SystemActivitySnapshot {
    SystemActivitySnapshot {
        is_locked: is_screen_locked(),
        idle_sec: idle_seconds(),
    }
}

fn idle_seconds() -> f64 {
    // Safe: the function takes two scalar arguments and returns a double; no
    // Rust references cross the FFI boundary.
    unsafe {
        CGEventSourceSecondsSinceLastEventType(
            CG_EVENT_SOURCE_STATE_COMBINED,
            CG_ANY_INPUT_EVENT_TYPE,
        )
    }
}

fn is_screen_locked() -> bool {
    // CGSessionCopyCurrentDictionary returns a CFDictionary owned by the
    // caller (Copy rule). Wrapping it via TCFType::wrap_under_create_rule
    // takes ownership and releases on drop.
    let dict_ref = unsafe { CGSessionCopyCurrentDictionary() };
    if dict_ref.is_null() {
        // No active GUI session — treat as locked. Happens at the login
        // window before the user signs in.
        return true;
    }

    let dict: CFDictionary<CFString, CFType> = unsafe {
        CFDictionary::wrap_under_create_rule(dict_ref as *const _)
    };

    // `CGSSessionScreenIsLocked` is only present (and `true`) while the
    // screen is locked. Absence means unlocked.
    let key = CFString::new("CGSSessionScreenIsLocked");
    match dict.find(&key) {
        Some(value_item) => {
            // The value is a CFBoolean. Anything else we treat as "not
            // locked" rather than panicking — Apple has been known to add
            // keys with other shapes over time.
            let value: &CFType = &*value_item;
            if let Some(b) = value.downcast::<CFBoolean>() {
                bool::from(b)
            } else {
                false
            }
        }
        None => false,
    }
}
