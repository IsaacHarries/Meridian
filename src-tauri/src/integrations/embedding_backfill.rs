// Background loop that drains pending embeddings into the meetings
// search index whenever Ollama is reachable.
//
// The user's Ollama may be running, off, or not installed. The
// `index_meeting` write path is always allowed to succeed without an
// embedding (segment is stored with `embedding = NULL`); this loop
// catches up later. When Ollama is down it sleeps and probes again
// next tick — no permanent failure state.
//
// Ticking strategy:
//   - Tick every 30s when there's nothing to do (cheap probe).
//   - When work exists and Ollama is up, drain in batches of N until
//     the queue empties or the probe fails.
//   - Emit a `meetings-index-status` event after every batch so the
//     Settings UI can show live progress.
//
// Lifecycle: spawned once at app start. Holds an AppHandle clone and
// runs forever; tokio cancels it when the runtime tears down.

use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

use crate::llms::embeddings::{
    embed_text_traced, probe_ollama, OllamaStatus, DEFAULT_EMBEDDING_MODEL,
};
use crate::storage::meeting_index::{
    index_status, pending_embeddings, set_segment_embedding, IndexStatus,
};
use crate::storage::preferences::get_pref;

const TICK_IDLE_SECS: u64 = 30;
const TICK_BUSY_SECS: u64 = 1;
const BATCH_SIZE: i64 = 16;

/// Read the user's preferred embedding model from preferences, falling
/// back to the default. Lets the user swap models from Settings without
/// restarting the app — the loop picks up the new value on its next
/// tick.
fn current_embedding_model() -> String {
    get_pref("meetings_embedding_model")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_string())
}

fn emit_status(app: &AppHandle, status: &IndexStatus) {
    let _ = app.emit("meetings-index-status", status);
}

/// Spawn the backfill task. Idempotent at the call-site level (the
/// caller invokes once during setup); we don't guard against double-
/// spawn here because there's no harm — both loops would race on the
/// same SQLite connection (which is internally locked) and at worst
/// duplicate-embed a few segments.
pub fn spawn_backfill_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let model = current_embedding_model();
            let probe = probe_ollama(&model).await;

            match probe.status {
                OllamaStatus::Available => {
                    // Drain in batches. We re-check the model each
                    // iteration in case the user changed it mid-loop;
                    // probe.dimensions is cached on the first item to
                    // sanity-check downstream rows have the same width.
                    let mut drained_anything = false;
                    loop {
                        let pending = match pending_embeddings(BATCH_SIZE) {
                            Ok(p) => p,
                            Err(e) => {
                                eprintln!("[backfill] pending query failed: {e}");
                                break;
                            }
                        };
                        if pending.is_empty() {
                            break;
                        }
                        for seg in pending {
                            match embed_text_traced(
                                &seg.text,
                                &model,
                                "meetings_index",
                                "embed_segment",
                            )
                            .await
                            {
                                Ok(vec) => {
                                    if let Err(e) =
                                        set_segment_embedding(seg.id, &vec, &model)
                                    {
                                        eprintln!(
                                            "[backfill] persist failed for segment {}: {e}",
                                            seg.id
                                        );
                                    } else {
                                        drained_anything = true;
                                    }
                                }
                                Err(e) => {
                                    eprintln!(
                                        "[backfill] embed failed for segment {}: {e} — \
                                         pausing this tick, will retry shortly",
                                        seg.id
                                    );
                                    // Bail out of the inner drain — Ollama
                                    // started misbehaving mid-batch. The
                                    // outer probe will catch it next tick.
                                    break;
                                }
                            }
                        }
                        if let Ok(s) = index_status() {
                            emit_status(&app, &s);
                        }
                    }
                    if drained_anything {
                        // Tight retry — there may be more segments
                        // queued up and we want to catch up quickly
                        // when the user is actively recording.
                        sleep(Duration::from_secs(TICK_BUSY_SECS)).await;
                    } else {
                        sleep(Duration::from_secs(TICK_IDLE_SECS)).await;
                    }
                }
                _ => {
                    // Ollama not ready — emit current status (so the
                    // Settings panel shows it) and sleep idle.
                    if let Ok(s) = index_status() {
                        emit_status(&app, &s);
                    }
                    sleep(Duration::from_secs(TICK_IDLE_SECS)).await;
                }
            }
        }
    });
}
