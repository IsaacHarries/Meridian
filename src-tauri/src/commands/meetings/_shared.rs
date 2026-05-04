// Cross-module helpers for the meetings commands. None of these are Tauri
// commands — they're the pure / IO / threading utilities shared between
// recording, whisper, persistence, and diarize.

use crate::storage::preferences::resolve_data_dir;
use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::types::{
    MeetingRecord, MeetingSegment, SpeakerCandidate, SpeakerRegistry, SpeakerRegistryEntry,
};

// ── Constants ─────────────────────────────────────────────────────────────

pub(super) const HUGGINGFACE_BASE: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
// Whisper requires 16 kHz mono f32.
pub(super) const TARGET_SR: u32 = 16_000;
// Roughly 10 seconds per transcription chunk — balances latency vs context.
pub(super) const CHUNK_SECONDS: f32 = 10.0;
// Model IDs we advertise to the UI. ggml-<id>.bin is the HuggingFace file name.
pub(super) const SUPPORTED_MODELS: &[&str] = &["tiny.en", "base.en", "small.en", "medium.en"];

// Confident auto-assign: top name's best sample is at least this similar.
const RECOGNIZE_HIGH_THRESHOLD: f32 = 0.70;
// Floor for even considering a name as a candidate in the ambiguous case.
const RECOGNIZE_LOW_THRESHOLD: f32 = 0.55;
// If top1 - top2 (across distinct names) is below this, we treat as ambiguous
// and surface the top candidates instead of auto-assigning.
const RECOGNIZE_AMBIGUITY_MARGIN: f32 = 0.05;

// Registry maintenance. The goal: bound growth per person and avoid storing
// near-duplicate samples (same mic, same room) that add no signal but pull
// the max-similarity match upward under unfavourable conditions.
const REGISTRY_MAX_PER_PERSON: usize = 20;
// New sample is averaged into the closest existing one (instead of appended)
// if cosine similarity to any existing entry meets this. Chosen so that
// typical same-voice/same-conditions samples collapse together (>0.92 is
// comfortably in "same recording context" territory for WeSpeaker), but
// distinctly different acoustic settings keep their own slot.
const REGISTRY_MERGE_THRESHOLD: f32 = 0.92;
// Auto-recognised matches are only fed back into the registry when they were
// very confident. 0.80 leaves a healthy margin above the 0.70 labelling
// threshold, so low-confidence auto-matches (which could drift the registry
// if wrong) don't contaminate future recognitions. Manual names always feed
// back regardless — the user vouched for them.
pub(super) const REGISTRY_AUTO_UPDATE_THRESHOLD: f32 = 0.80;

// Minimum usable audio length — below ~3s the pipeline produces noisy clusters
// and the speaker_count estimator often collapses to zero.
pub(super) const DIARIZE_MIN_SAMPLES: usize = TARGET_SR as usize * 3;

// ── Paths ─────────────────────────────────────────────────────────────────

pub(super) fn meetings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_data_dir(app)?.join("meetings");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create meetings dir: {e}"))?;
    Ok(dir)
}

pub(super) fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_data_dir(app)?.join("models").join("whisper");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create models dir: {e}"))?;
    Ok(dir)
}

pub(super) fn model_filename(model_id: &str) -> String {
    format!("ggml-{model_id}.bin")
}

pub(super) fn model_path(app: &tauri::AppHandle, model_id: &str) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(model_filename(model_id)))
}

// ── Speaker voice registry ────────────────────────────────────────────────

fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_data_dir(app)?.join("speakers");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create speakers dir: {e}"))?;
    Ok(dir.join("registry.json"))
}

pub(super) fn load_registry(app: &tauri::AppHandle) -> Result<SpeakerRegistry, String> {
    let path = registry_path(app)?;
    if !path.exists() {
        return Ok(SpeakerRegistry::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Read {}: {e}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Parse {}: {e}", path.display()))
}

pub(super) fn save_registry(app: &tauri::AppHandle, reg: &SpeakerRegistry) -> Result<(), String> {
    let path = registry_path(app)?;
    let json = serde_json::to_string_pretty(reg)
        .map_err(|e| format!("Serialise registry: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Write {}: {e}", path.display()))
}

// Enroll a voice sample for a named person. Drops any prior entry at the
// same (meeting_id, cluster_id) first so a rename moves the sample rather
// than duplicating it; then either merges into a near-duplicate (avg in
// place) or appends as a distinct sample; finally enforces a per-person
// cap by collapsing the closest existing pair if needed. Returns true when
// the registry changed (caller saves the file in that case).
pub(super) fn enroll_registry_entry(
    reg: &mut SpeakerRegistry,
    name: &str,
    meeting_id: &str,
    cluster_id: &str,
    vector: Vec<f32>,
) {
    // Drop any previous entry keyed to this cluster (rename case).
    reg.entries
        .retain(|e| !(e.meeting_id == meeting_id && e.cluster_id == cluster_id));

    // Near-duplicate merge: if the incoming vector is very similar to any
    // existing sample for this name, average it into that slot rather than
    // appending. Keeps the registry rich without accumulating redundancy.
    if let Some((idx, _sim)) = reg
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.name == name)
        .map(|(i, e)| (i, cosine_similarity(&e.vector, &vector)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .filter(|(_, sim)| *sim >= REGISTRY_MERGE_THRESHOLD)
    {
        average_vector_in_place(&mut reg.entries[idx].vector, &vector);
        return;
    }

    // New distinct sample.
    reg.entries.push(SpeakerRegistryEntry {
        name: name.to_string(),
        meeting_id: meeting_id.to_string(),
        cluster_id: cluster_id.to_string(),
        vector,
    });

    // Enforce cap: if this name now has too many samples, collapse the
    // most-similar pair into one. Operates only on this name's entries so
    // other people are untouched.
    let person_indices: Vec<usize> = reg
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.name == name)
        .map(|(i, _)| i)
        .collect();
    if person_indices.len() > REGISTRY_MAX_PER_PERSON {
        let mut best: Option<(usize, usize, f32)> = None;
        for i in 0..person_indices.len() {
            for j in (i + 1)..person_indices.len() {
                let sim = cosine_similarity(
                    &reg.entries[person_indices[i]].vector,
                    &reg.entries[person_indices[j]].vector,
                );
                if best.map_or(true, |(_, _, bs)| sim > bs) {
                    best = Some((person_indices[i], person_indices[j], sim));
                }
            }
        }
        if let Some((keep, drop, _)) = best {
            // Average the dropped entry's vector into the kept one before
            // removing, so the pair's information isn't lost — just fused.
            let donor = reg.entries[drop].vector.clone();
            average_vector_in_place(&mut reg.entries[keep].vector, &donor);
            // `drop > keep` by construction (nested loop), remove is safe.
            reg.entries.remove(drop);
        }
    }
}

fn average_vector_in_place(existing: &mut [f32], incoming: &[f32]) {
    let n = existing.len().min(incoming.len());
    for i in 0..n {
        existing[i] = (existing[i] + incoming[i]) * 0.5;
    }
}

pub(super) fn remove_registry_entry(
    reg: &mut SpeakerRegistry,
    meeting_id: &str,
    cluster_id: &str,
) {
    reg.entries
        .retain(|e| !(e.meeting_id == meeting_id && e.cluster_id == cluster_id));
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom <= f32::EPSILON {
        0.0
    } else {
        (dot / denom).clamp(-1.0, 1.0)
    }
}

// For a single query embedding, return (name, best_similarity) for every
// distinct name in the registry, sorted descending by best similarity.
pub(super) fn best_per_name(
    registry: &SpeakerRegistry,
    query: &[f32],
) -> Vec<(String, f32)> {
    use std::collections::BTreeMap;
    let mut best: BTreeMap<String, f32> = BTreeMap::new();
    for entry in &registry.entries {
        let sim = cosine_similarity(query, &entry.vector);
        let slot = best.entry(entry.name.clone()).or_insert(f32::MIN);
        if sim > *slot {
            *slot = sim;
        }
    }
    let mut out: Vec<(String, f32)> = best.into_iter().collect();
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    out
}

// Decide how to label a single cluster based on its scored name list.
// Returns (display_name, candidates):
//   - confident match  → (Some(name), [])
//   - ambiguous        → (None,       [top candidates above the floor])
//   - no useful match  → (None,       [])
pub(super) fn decide_recognition(
    scored: &[(String, f32)],
) -> (Option<String>, Vec<SpeakerCandidate>) {
    let top1 = match scored.first() {
        Some(t) => t,
        None => return (None, Vec::new()),
    };
    if top1.1 < RECOGNIZE_LOW_THRESHOLD {
        return (None, Vec::new());
    }
    let top2 = scored.get(1);
    let margin = top2.map(|t| top1.1 - t.1).unwrap_or(f32::INFINITY);
    if top1.1 >= RECOGNIZE_HIGH_THRESHOLD && margin >= RECOGNIZE_AMBIGUITY_MARGIN {
        return (Some(top1.0.clone()), Vec::new());
    }
    // Ambiguous: surface the top names that are plausibly this speaker.
    let candidates: Vec<SpeakerCandidate> = scored
        .iter()
        .take(4)
        .filter(|(_, sim)| *sim >= RECOGNIZE_LOW_THRESHOLD)
        .map(|(name, sim)| SpeakerCandidate {
            name: name.clone(),
            similarity: *sim,
        })
        .collect();
    (None, candidates)
}

// ── Recording session state ───────────────────────────────────────────────

pub(super) struct ActiveSession {
    pub meeting_id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub mic_device_name: String,
    pub model_id: String,
    pub started_at: String,
    pub started_instant: Instant,
    pub stop_flag: Arc<AtomicBool>,
    pub pause_flag: Arc<AtomicBool>,
    pub segments: Arc<Mutex<Vec<MeetingSegment>>>,
    // Full mono 16kHz PCM buffer captured during the session, kept in RAM (not
    // on disk) so the post-stop diarization pass has the raw audio to analyse.
    // Shared with the recording thread. Released when the session ends.
    pub audio_buffer: Arc<Mutex<Vec<f32>>>,
    pub handle: Option<thread::JoinHandle<Result<(), String>>>,
}

// Keep the last recorded session's audio buffer available for diarize_meeting,
// which the frontend invokes after stop_meeting_recording resolves. We stash
// only one buffer at a time, keyed by meeting id — a new recording replaces it.
pub(super) static LAST_AUDIO: Mutex<Option<(String, Vec<f32>)>> = Mutex::new(None);

pub(super) static ACTIVE: Mutex<Option<ActiveSession>> = Mutex::new(None);

// ── Recording thread ──────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_recording_thread(
    app: tauri::AppHandle,
    meeting_id: String,
    model_path: PathBuf,
    device: cpal::Device,
    sample_format: SampleFormat,
    stream_config: StreamConfig,
    sample_rate: u32,
    channels: u16,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    segments: Arc<Mutex<Vec<MeetingSegment>>>,
    audio_buffer: Arc<Mutex<Vec<f32>>>,
) -> Result<thread::JoinHandle<Result<(), String>>, String> {
    let handle = thread::Builder::new()
        .name("meridian-meetings".into())
        .spawn(move || -> Result<(), String> {
            let (tx, rx) = mpsc::channel::<Vec<f32>>();

            let err_cb = |err| eprintln!("[meetings] cpal stream error: {err}");
            let tx_cb = tx.clone();
            let stream = match sample_format {
                SampleFormat::F32 => device
                    .build_input_stream(
                        &stream_config,
                        move |data: &[f32], _| {
                            let _ = tx_cb.send(data.to_vec());
                        },
                        err_cb,
                        None,
                    )
                    .map_err(|e| format!("build_input_stream(f32): {e}")),
                SampleFormat::I16 => device
                    .build_input_stream(
                        &stream_config,
                        move |data: &[i16], _| {
                            let converted: Vec<f32> =
                                data.iter().map(|&s| s as f32 / 32768.0).collect();
                            let _ = tx_cb.send(converted);
                        },
                        err_cb,
                        None,
                    )
                    .map_err(|e| format!("build_input_stream(i16): {e}")),
                SampleFormat::U16 => device
                    .build_input_stream(
                        &stream_config,
                        move |data: &[u16], _| {
                            let converted: Vec<f32> = data
                                .iter()
                                .map(|&s| (s as f32 - 32768.0) / 32768.0)
                                .collect();
                            let _ = tx_cb.send(converted);
                        },
                        err_cb,
                        None,
                    )
                    .map_err(|e| format!("build_input_stream(u16): {e}")),
                other => Err(format!("Unsupported sample format: {other:?}")),
            }?;
            stream.play().map_err(|e| format!("stream.play: {e}"))?;

            // Initialise whisper context once per session.
            let ctx = WhisperContext::new_with_params(
                &model_path.to_string_lossy(),
                WhisperContextParameters::default(),
            )
            .map_err(|e| format!("WhisperContext: {e}"))?;

            let chunk_samples = (sample_rate as f32 * CHUNK_SECONDS) as usize * channels as usize;
            let mut buffer: Vec<f32> = Vec::with_capacity(chunk_samples * 2);
            let mut offset_sec: f32 = 0.0;

            loop {
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(samples) => {
                        if !pause_flag.load(Ordering::Relaxed) {
                            buffer.extend_from_slice(&samples);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                if buffer.len() >= chunk_samples {
                    let chunk: Vec<f32> = buffer.drain(..chunk_samples).collect();
                    let mono = downmix_to_mono(&chunk, channels);
                    let resampled = resample_to_16k(&mono, sample_rate);
                    // Append to the full-session buffer used by diarization on stop.
                    // We keep the paused-state check identical to the Whisper path so
                    // the transcript and the diarization timeline stay aligned.
                    if let Ok(mut g) = audio_buffer.lock() {
                        g.extend_from_slice(&resampled);
                    }
                    let produced = transcribe_chunk(
                        &ctx,
                        &resampled,
                        offset_sec,
                        &app,
                        &meeting_id,
                        &segments,
                    );
                    offset_sec += CHUNK_SECONDS;
                    if let Err(e) = produced {
                        eprintln!("[meetings] transcription error: {e}");
                    }
                }
            }

            // Drain any tail samples still sitting in the channel.
            while let Ok(samples) = rx.try_recv() {
                if !pause_flag.load(Ordering::Relaxed) {
                    buffer.extend_from_slice(&samples);
                }
            }
            // Flush final partial chunk (≥ 1 second worth to avoid noise).
            let min_samples = (sample_rate as usize) * channels as usize;
            if buffer.len() >= min_samples {
                let mono = downmix_to_mono(&buffer, channels);
                let resampled = resample_to_16k(&mono, sample_rate);
                if let Ok(mut g) = audio_buffer.lock() {
                    g.extend_from_slice(&resampled);
                }
                let _ = transcribe_chunk(
                    &ctx,
                    &resampled,
                    offset_sec,
                    &app,
                    &meeting_id,
                    &segments,
                );
            }

            drop(stream);
            Ok(())
        })
        .map_err(|e| format!("Cannot spawn recording thread: {e}"))?;

    Ok(handle)
}

fn transcribe_chunk(
    ctx: &WhisperContext,
    samples: &[f32],
    offset_sec: f32,
    app: &tauri::AppHandle,
    meeting_id: &str,
    segments: &Mutex<Vec<MeetingSegment>>,
) -> Result<(), String> {
    let mut state = ctx.create_state().map_err(|e| format!("create_state: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_translate(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_no_context(true);
    params.set_single_segment(false);

    state
        .full(params, samples)
        .map_err(|e| format!("whisper full: {e}"))?;

    let n = state
        .full_n_segments()
        .map_err(|e| format!("full_n_segments: {e}"))?;
    for i in 0..n {
        let text = state
            .full_get_segment_text(i)
            .map_err(|e| format!("segment_text: {e}"))?;
        let t0 = state
            .full_get_segment_t0(i)
            .map_err(|e| format!("segment_t0: {e}"))? as f32
            / 100.0; // whisper timestamps are in hundredths of a second
        let t1 = state
            .full_get_segment_t1(i)
            .map_err(|e| format!("segment_t1: {e}"))? as f32
            / 100.0;
        let seg = MeetingSegment {
            start_sec: offset_sec + t0,
            end_sec: offset_sec + t1,
            text: text.trim().to_string(),
            speaker_id: None,
        };
        if seg.text.is_empty() {
            continue;
        }
        if let Ok(mut guard) = segments.lock() {
            guard.push(seg.clone());
        }
        let _ = app.emit(
            "meetings-segment",
            serde_json::json!({
                "meetingId": meeting_id,
                "startSec": seg.start_sec,
                "endSec": seg.end_sec,
                "text": seg.text,
            }),
        );
    }
    Ok(())
}

// ── DSP helpers ───────────────────────────────────────────────────────────

fn downmix_to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let ch = channels as usize;
    let frames = interleaved.len() / ch;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut sum = 0.0f32;
        for c in 0..ch {
            sum += interleaved[f * ch + c];
        }
        out.push(sum / ch as f32);
    }
    out
}

fn resample_to_16k(samples: &[f32], from_sr: u32) -> Vec<f32> {
    if from_sr == TARGET_SR {
        return samples.to_vec();
    }
    let target_len =
        (samples.len() as u64 * TARGET_SR as u64 / from_sr as u64) as usize;
    if target_len == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(target_len);
    let ratio = from_sr as f64 / TARGET_SR as f64;
    for i in 0..target_len {
        let src = i as f64 * ratio;
        let low = src.floor() as usize;
        let high = (low + 1).min(samples.len().saturating_sub(1));
        let frac = (src - low as f64) as f32;
        let s_low = samples.get(low).copied().unwrap_or(0.0);
        let s_high = samples.get(high).copied().unwrap_or(s_low);
        out.push(s_low * (1.0 - frac) + s_high * frac);
    }
    out
}

// ── ID / time helpers ─────────────────────────────────────────────────────

pub(super) fn new_meeting_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("meeting-{ms}")
}

pub(super) fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso_from_epoch_secs(secs)
}

// Minimal UTC ISO-8601 formatter — avoids pulling in chrono.
fn iso_from_epoch_secs(secs: i64) -> String {
    // Days since 1970-01-01
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400) as u32;
    let h = sod / 3600;
    let m = (sod % 3600) / 60;
    let s = sod % 60;
    // Gregorian calendar math (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, d, h, m, s
    )
}

// ── Persistence helpers ───────────────────────────────────────────────────

pub(super) fn meeting_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("Invalid meeting id: {id}"));
    }
    Ok(meetings_dir(app)?.join(format!("{id}.json")))
}

pub(super) fn write_meeting(app: &tauri::AppHandle, record: &MeetingRecord) -> Result<(), String> {
    let path = meeting_path(app, &record.id)?;
    let json = serde_json::to_string_pretty(record)
        .map_err(|e| format!("Serialise meeting: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Write {}: {e}", path.display()))?;
    // Mirror every write — save_meeting, create_notes, update_notes,
    // diarise, summarise, etc. all funnel through here, so wiring
    // here means every code path that touches a meeting keeps the
    // index in sync without each call site having to remember.
    if let Err(e) = crate::storage::meeting_index::index_meeting(record) {
        eprintln!("[meeting-index] failed to index {}: {e}", record.id);
    }
    Ok(())
}

// ── Diarization helper ────────────────────────────────────────────────────

// Pick the diarization speaker that overlaps a whisper segment for the most
// cumulative time. Returns None if the whisper segment does not overlap any
// diarized speech (e.g. entirely inside an unclassified gap).
pub(super) fn dominant_overlap_speaker(
    segments: &[speakrs::Segment],
    start: f64,
    end: f64,
) -> Option<String> {
    use std::collections::BTreeMap;
    let mut totals: BTreeMap<&str, f64> = BTreeMap::new();
    for seg in segments {
        let overlap = (seg.end.min(end) - seg.start.max(start)).max(0.0);
        if overlap > 0.0 {
            *totals.entry(seg.speaker.as_str()).or_insert(0.0) += overlap;
        }
    }
    totals
        .into_iter()
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(sp, _)| sp.to_string())
}

