// Rust-side AI traffic emitter.
//
// Some LLM round-trips happen entirely in Rust (most notably the
// Ollama embedding requests for the cross-meetings RAG index — the
// background backfill loop and the per-query vector at search time).
// They never go through the sidecar, so the `AiTrafficHandler`
// LangChain callback that captures sidecar traffic doesn't see them.
//
// This module emits the same `ai-traffic-event` Tauri event with the
// same payload shape the sidecar already uses, so the debug panel
// renders embedding calls alongside chat-model calls in one
// chronological feed. The on-disk JSONL mirror gets the same line.
//
// Gating: `ai_debug_enabled()` short-circuits the entire emit. When
// capture is off this is a single bool read — zero-cost on the hot
// path.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::storage::preferences::{ai_debug_enabled, append_ai_debug_log_line};

/// AppHandle stash so emit sites don't have to thread it through. Set
/// once during setup, read by `emit_event`. We accept the global on
/// purpose — Tauri itself ships AppHandle as a clone-friendly handle
/// designed for this use, and the alternative (passing AppHandle into
/// every embed call) ripples through too many layers for what is a
/// developer-only debug feature.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiTrafficMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiTrafficUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiTrafficEvent {
    /// Type discriminator — kept for symmetry with the sidecar event
    /// shape (the sidecar's enum carries `type: "ai_traffic"`); the
    /// frontend doesn't read it but the JSONL log is easier to filter
    /// when both sources tag themselves the same way.
    #[serde(rename = "type")]
    pub event_type: &'static str,
    /// Synthetic run id. For Rust-emitted events we don't have a
    /// workflow run, so we mint one per call. Lets the panel still
    /// dedupe / group if multiple traffic events share the same id.
    pub id: String,
    pub run_id: String,
    /// Unix milliseconds when the request began.
    pub started_at: i64,
    pub latency_ms: i64,
    pub provider: String,
    pub model: String,
    /// "Workflow" name — matches the sidecar's WorkflowName field so
    /// the debug panel can group by workflow consistently. Use
    /// stable, snake_case identifiers (e.g. `meetings_index`).
    pub workflow: String,
    /// Node within the workflow — `"embed_segment"` for backfill,
    /// `"embed_query"` for search-time embeds, etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    pub messages: Vec<AiTrafficMessage>,
    pub response: String,
    pub usage: AiTrafficUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_run_id() -> String {
    // Cheap unique id without pulling in the uuid crate just for this:
    // ms timestamp + a counter. Collision is fine to ignore — the
    // panel groups by `runId` only as a UI hint, not for correctness.
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("rust-{}-{n}", now_ms())
}

/// Emit one traffic event. Drops silently when AI debug capture is
/// disabled or the AppHandle wasn't initialised (e.g. unit-test
/// builds that exercise embed code without a Tauri runtime).
pub fn emit_event(event: AiTrafficEvent) {
    if !ai_debug_enabled() {
        return;
    }
    let payload = match serde_json::to_value(&event) {
        Ok(v) => v,
        Err(_) => return,
    };
    if let Ok(line) = serde_json::to_string(&payload) {
        append_ai_debug_log_line(&line);
    }
    if let Some(app) = APP.get() {
        let _ = app.emit("ai-traffic-event", payload);
    }
}
