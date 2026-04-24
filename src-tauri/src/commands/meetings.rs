// Meetings — live local transcription via cpal + whisper-rs, plus CRUD for
// saved meeting records. Audio is NEVER written to disk — only the streamed
// transcription is persisted as JSON under {data_dir}/meetings/.

use crate::storage::preferences::resolve_data_dir;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// ── Constants ─────────────────────────────────────────────────────────────

const HUGGINGFACE_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
// Whisper requires 16 kHz mono f32.
const TARGET_SR: u32 = 16_000;
// Roughly 10 seconds per transcription chunk — balances latency vs context.
const CHUNK_SECONDS: f32 = 10.0;
// Model IDs we advertise to the UI. ggml-<id>.bin is the HuggingFace file name.
const SUPPORTED_MODELS: &[&str] = &["tiny.en", "base.en", "small.en", "medium.en"];

// ── Types ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MicrophoneInfo {
    pub name: String,
    pub is_default: bool,
    #[serde(rename = "sampleRate")]
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MeetingSegment {
    // `null` is tolerated on read (legacy corrupt files wrote non-finite f32
    // as JSON null); treated as 0.0 so the rest of the record still loads.
    #[serde(rename = "startSec", deserialize_with = "deserialize_f32_null_as_zero")]
    pub start_sec: f32,
    #[serde(rename = "endSec", deserialize_with = "deserialize_f32_null_as_zero")]
    pub end_sec: f32,
    pub text: String,
    // Speaker label assigned by the diarization pass. `None` until the user runs
    // diarize_meeting on the saved recording; older meetings loaded from disk
    // will also be None (hence #[serde(default)]).
    #[serde(default, rename = "speakerId", skip_serializing_if = "Option::is_none")]
    pub speaker_id: Option<String>,
}

fn deserialize_f32_null_as_zero<'de, D>(de: D) -> Result<f32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v: Option<f32> = Option::deserialize(de)?;
    Ok(v.unwrap_or(0.0))
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MeetingRecord {
    pub id: String,
    pub title: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "endedAt")]
    pub ended_at: Option<String>,
    #[serde(rename = "durationSec")]
    pub duration_sec: u32,
    #[serde(rename = "micDeviceName")]
    pub mic_device_name: String,
    pub model: String,
    pub tags: Vec<String>,
    pub segments: Vec<MeetingSegment>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default, rename = "actionItems")]
    pub action_items: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default, rename = "suggestedTitle")]
    pub suggested_title: Option<String>,
    #[serde(default, rename = "suggestedTags")]
    pub suggested_tags: Vec<String>,
    #[serde(default, rename = "chatHistory")]
    pub chat_history: Vec<ChatMessage>,
    #[serde(default)]
    pub speakers: Vec<MeetingSpeaker>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// One entry per distinct voice detected by the diarization pass. The embedding
// is a 256-dim WeSpeaker vector (averaged across all chunks assigned to this
// cluster); it's what a future cross-meeting "enrollment" step will use to
// match this voice against known named speakers. `display_name` is the label
// the user has assigned — None until they name it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MeetingSpeaker {
    pub id: String,
    // Tolerate `null` entries in the embedding vector when reading: older
    // meetings persisted before the NaN-sanitisation fix may contain `null`
    // values (serde_json's default formatter writes non-finite f32 values as
    // literal `null` rather than erroring). Treat those as 0.0.
    #[serde(deserialize_with = "deserialize_f32_vec_null_as_zero")]
    pub embedding: Vec<f32>,
    #[serde(default, rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    // Populated by the recognition pass when a cluster's top-match confidence
    // is too close to a runner-up to auto-assign. The UI surfaces these as
    // clickable choices so the user resolves the ambiguity. Cleared once a
    // display_name is assigned.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<SpeakerCandidate>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SpeakerCandidate {
    pub name: String,
    pub similarity: f32,
}

fn deserialize_f32_vec_null_as_zero<'de, D>(de: D) -> Result<Vec<f32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw: Vec<Option<f32>> = Vec::deserialize(de)?;
    Ok(raw.into_iter().map(|v| v.unwrap_or(0.0)).collect())
}

// ── Paths ─────────────────────────────────────────────────────────────────

fn meetings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_data_dir(app)?.join("meetings");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create meetings dir: {e}"))?;
    Ok(dir)
}

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_data_dir(app)?.join("models").join("whisper");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create models dir: {e}"))?;
    Ok(dir)
}

fn model_filename(model_id: &str) -> String {
    format!("ggml-{model_id}.bin")
}

fn model_path(app: &tauri::AppHandle, model_id: &str) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(model_filename(model_id)))
}

// ── Speaker voice registry ────────────────────────────────────────────────
//
// A single JSON file holding every named voice sample the user has confirmed
// across all meetings. Used by the auto-recognition pass to label new
// clusters by cosine-similarity against remembered embeddings without having
// to rescan every meeting file.

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SpeakerRegistry {
    #[serde(default)]
    pub entries: Vec<SpeakerRegistryEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SpeakerRegistryEntry {
    pub name: String,
    #[serde(rename = "meetingId")]
    pub meeting_id: String,
    #[serde(rename = "clusterId")]
    pub cluster_id: String,
    #[serde(deserialize_with = "deserialize_f32_vec_null_as_zero")]
    pub vector: Vec<f32>,
}

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
const REGISTRY_AUTO_UPDATE_THRESHOLD: f32 = 0.80;

fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_data_dir(app)?.join("speakers");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create speakers dir: {e}"))?;
    Ok(dir.join("registry.json"))
}

fn load_registry(app: &tauri::AppHandle) -> Result<SpeakerRegistry, String> {
    let path = registry_path(app)?;
    if !path.exists() {
        return Ok(SpeakerRegistry::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Read {}: {e}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Parse {}: {e}", path.display()))
}

fn save_registry(app: &tauri::AppHandle, reg: &SpeakerRegistry) -> Result<(), String> {
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
fn enroll_registry_entry(
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

fn remove_registry_entry(reg: &mut SpeakerRegistry, meeting_id: &str, cluster_id: &str) {
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
fn best_per_name(
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
fn decide_recognition(scored: &[(String, f32)]) -> (Option<String>, Vec<SpeakerCandidate>) {
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

// ── Mic enumeration ───────────────────────────────────────────────────────

#[tauri::command]
pub fn list_microphones() -> Result<Vec<MicrophoneInfo>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    let mut out = Vec::new();
    let devices = host
        .input_devices()
        .map_err(|e| format!("Cannot enumerate input devices: {e}"))?;
    for device in devices {
        let name = match device.name() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let (sample_rate, channels) = match device.default_input_config() {
            Ok(cfg) => (cfg.sample_rate().0, cfg.channels()),
            Err(_) => continue,
        };
        let is_default = name == default_name;
        out.push(MicrophoneInfo {
            name,
            is_default,
            sample_rate,
            channels,
        });
    }
    Ok(out)
}

// ── Model download ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WhisperModelStatus {
    pub id: String,
    pub downloaded: bool,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[tauri::command]
pub fn list_whisper_models(app: tauri::AppHandle) -> Result<Vec<WhisperModelStatus>, String> {
    let dir = models_dir(&app)?;
    let mut out = Vec::new();
    for id in SUPPORTED_MODELS {
        let path = dir.join(model_filename(id));
        let (downloaded, size_bytes) = match fs::metadata(&path) {
            Ok(m) => (m.is_file(), m.len()),
            Err(_) => (false, 0),
        };
        out.push(WhisperModelStatus {
            id: (*id).to_string(),
            downloaded,
            size_bytes,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn download_whisper_model(
    app: tauri::AppHandle,
    model_id: String,
) -> Result<String, String> {
    if !SUPPORTED_MODELS.contains(&model_id.as_str()) {
        return Err(format!("Unsupported whisper model: {model_id}"));
    }
    let dir = models_dir(&app)?;
    let filename = model_filename(&model_id);
    let tmp = dir.join(format!("{filename}.part"));
    let path = dir.join(&filename);
    let url = format!("{HUGGINGFACE_BASE}/{filename}");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = fs::File::create(&tmp)
        .map_err(|e| format!("Cannot create {}: {e}", tmp.display()))?;

    let _ = app.emit(
        "meetings-model-progress",
        serde_json::json!({
            "modelId": &model_id,
            "downloaded": 0u64,
            "total": total,
            "done": false,
        }),
    );

    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Write error: {e}"))?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            last_emit = Instant::now();
            let _ = app.emit(
                "meetings-model-progress",
                serde_json::json!({
                    "modelId": &model_id,
                    "downloaded": downloaded,
                    "total": total,
                    "done": false,
                }),
            );
        }
    }
    file.flush().map_err(|e| format!("Flush error: {e}"))?;
    drop(file);
    fs::rename(&tmp, &path)
        .map_err(|e| format!("Rename {} → {}: {e}", tmp.display(), path.display()))?;

    let _ = app.emit(
        "meetings-model-progress",
        serde_json::json!({
            "modelId": &model_id,
            "downloaded": downloaded,
            "total": total,
            "done": true,
        }),
    );
    Ok(path.to_string_lossy().into_owned())
}

// ── Recording session state ───────────────────────────────────────────────

struct ActiveSession {
    meeting_id: String,
    title: String,
    tags: Vec<String>,
    mic_device_name: String,
    model_id: String,
    started_at: String,
    started_instant: Instant,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    segments: Arc<Mutex<Vec<MeetingSegment>>>,
    // Full mono 16kHz PCM buffer captured during the session, kept in RAM (not
    // on disk) so the post-stop diarization pass has the raw audio to analyse.
    // Shared with the recording thread. Released when the session ends.
    audio_buffer: Arc<Mutex<Vec<f32>>>,
    handle: Option<thread::JoinHandle<Result<(), String>>>,
}

// Keep the last recorded session's audio buffer available for diarize_meeting,
// which the frontend invokes after stop_meeting_recording resolves. We stash
// only one buffer at a time, keyed by meeting id — a new recording replaces it.
static LAST_AUDIO: Mutex<Option<(String, Vec<f32>)>> = Mutex::new(None);

static ACTIVE: Mutex<Option<ActiveSession>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StartMeetingRequest {
    pub title: String,
    pub tags: Vec<String>,
    #[serde(rename = "micName")]
    pub mic_name: Option<String>,
    #[serde(rename = "modelId")]
    pub model_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StartMeetingResult {
    pub id: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "micDeviceName")]
    pub mic_device_name: String,
    #[serde(rename = "sampleRate")]
    pub sample_rate: u32,
    pub channels: u16,
}

#[tauri::command]
pub fn start_meeting_recording(
    app: tauri::AppHandle,
    req: StartMeetingRequest,
) -> Result<StartMeetingResult, String> {
    {
        let guard = ACTIVE.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
        if guard.is_some() {
            return Err("A meeting is already being recorded. Stop it before starting another.".into());
        }
    }

    let model_path = model_path(&app, &req.model_id)?;
    if !model_path.exists() {
        return Err(format!(
            "Whisper model '{}' not found. Download it from Settings.",
            req.model_id
        ));
    }

    let host = cpal::default_host();
    let device = if let Some(name) = req.mic_name.as_ref().filter(|n| !n.trim().is_empty()) {
        host.input_devices()
            .map_err(|e| format!("Cannot enumerate input devices: {e}"))?
            .find(|d| d.name().ok().as_deref() == Some(name.as_str()))
            .ok_or_else(|| format!("Microphone '{name}' not found"))?
    } else {
        host.default_input_device()
            .ok_or_else(|| "No default input device".to_string())?
    };
    let device_name = device.name().unwrap_or_else(|_| "(unknown)".into());
    let default_cfg = device
        .default_input_config()
        .map_err(|e| format!("Cannot get default input config: {e}"))?;
    let sample_rate = default_cfg.sample_rate().0;
    let channels = default_cfg.channels();
    let sample_format = default_cfg.sample_format();

    let meeting_id = new_meeting_id();
    let started_at = now_iso();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let pause_flag = Arc::new(AtomicBool::new(false));
    let segments: Arc<Mutex<Vec<MeetingSegment>>> = Arc::new(Mutex::new(Vec::new()));
    let audio_buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let handle = spawn_recording_thread(
        app.clone(),
        meeting_id.clone(),
        model_path,
        device,
        sample_format,
        default_cfg.into(),
        sample_rate,
        channels,
        stop_flag.clone(),
        pause_flag.clone(),
        segments.clone(),
        audio_buffer.clone(),
    )?;

    let started_instant = Instant::now();

    {
        let mut guard = ACTIVE.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
        *guard = Some(ActiveSession {
            meeting_id: meeting_id.clone(),
            title: req.title.clone(),
            tags: req.tags.clone(),
            mic_device_name: device_name.clone(),
            model_id: req.model_id.clone(),
            started_at: started_at.clone(),
            started_instant,
            stop_flag,
            pause_flag,
            segments,
            audio_buffer,
            handle: Some(handle),
        });
    }

    let _ = app.emit(
        "meetings-status",
        serde_json::json!({
            "meetingId": &meeting_id,
            "state": "recording",
        }),
    );

    Ok(StartMeetingResult {
        id: meeting_id,
        started_at,
        mic_device_name: device_name,
        sample_rate,
        channels,
    })
}

#[tauri::command]
pub fn pause_meeting_recording(app: tauri::AppHandle) -> Result<(), String> {
    let guard = ACTIVE.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    let sess = guard.as_ref().ok_or("No active meeting")?;
    sess.pause_flag.store(true, Ordering::Relaxed);
    let _ = app.emit(
        "meetings-status",
        serde_json::json!({ "meetingId": &sess.meeting_id, "state": "paused" }),
    );
    Ok(())
}

#[tauri::command]
pub fn resume_meeting_recording(app: tauri::AppHandle) -> Result<(), String> {
    let guard = ACTIVE.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    let sess = guard.as_ref().ok_or("No active meeting")?;
    sess.pause_flag.store(false, Ordering::Relaxed);
    let _ = app.emit(
        "meetings-status",
        serde_json::json!({ "meetingId": &sess.meeting_id, "state": "recording" }),
    );
    Ok(())
}

#[tauri::command]
pub fn stop_meeting_recording(app: tauri::AppHandle) -> Result<MeetingRecord, String> {
    let sess = {
        let mut guard = ACTIVE.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
        guard.take().ok_or("No active meeting")?
    };

    sess.stop_flag.store(true, Ordering::Relaxed);
    // Wait for the recording thread to drain any remaining audio.
    if let Some(h) = sess.handle {
        match h.join() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("[meetings] recording thread ended with error: {e}"),
            Err(_) => eprintln!("[meetings] recording thread panicked"),
        }
    }

    let duration_sec = sess.started_instant.elapsed().as_secs() as u32;
    let ended_at = now_iso();
    let segments = {
        let g = sess.segments.lock().map_err(|e| format!("Segments poisoned: {e}"))?;
        g.clone()
    };

    // Move the captured audio into LAST_AUDIO so diarize_meeting can pick it
    // up. Takes ownership — the session's Arc is dropped next.
    {
        let audio = {
            let mut g = sess
                .audio_buffer
                .lock()
                .map_err(|e| format!("Audio buffer poisoned: {e}"))?;
            std::mem::take(&mut *g)
        };
        if let Ok(mut last) = LAST_AUDIO.lock() {
            *last = Some((sess.meeting_id.clone(), audio));
        }
    }

    let record = MeetingRecord {
        id: sess.meeting_id.clone(),
        title: sess.title,
        started_at: sess.started_at,
        ended_at: Some(ended_at),
        duration_sec,
        mic_device_name: sess.mic_device_name,
        model: sess.model_id,
        tags: sess.tags,
        segments,
        summary: None,
        action_items: Vec::new(),
        decisions: Vec::new(),
        suggested_title: None,
        suggested_tags: Vec::new(),
        chat_history: Vec::new(),
        speakers: Vec::new(),
    };

    write_meeting(&app, &record)?;

    let _ = app.emit(
        "meetings-status",
        serde_json::json!({
            "meetingId": &record.id,
            "state": "stopped",
            "durationSec": record.duration_sec,
        }),
    );

    Ok(record)
}

// ── Recording thread ──────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn spawn_recording_thread(
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

fn new_meeting_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("meeting-{ms}")
}

fn now_iso() -> String {
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

// ── Persistence ───────────────────────────────────────────────────────────

fn meeting_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("Invalid meeting id: {id}"));
    }
    Ok(meetings_dir(app)?.join(format!("{id}.json")))
}

fn write_meeting(app: &tauri::AppHandle, record: &MeetingRecord) -> Result<(), String> {
    let path = meeting_path(app, &record.id)?;
    let json = serde_json::to_string_pretty(record)
        .map_err(|e| format!("Serialise meeting: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Write {}: {e}", path.display()))
}

#[tauri::command]
pub fn save_meeting(app: tauri::AppHandle, record: MeetingRecord) -> Result<(), String> {
    write_meeting(&app, &record)
}

#[tauri::command]
pub fn load_meeting(app: tauri::AppHandle, id: String) -> Result<MeetingRecord, String> {
    let path = meeting_path(&app, &id)?;
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Read {}: {e}", path.display()))?;
    serde_json::from_str(&content).map_err(|e| format!("Parse {}: {e}", path.display()))
}

#[tauri::command]
pub fn list_meetings(app: tauri::AppHandle) -> Result<Vec<MeetingRecord>, String> {
    let dir = meetings_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if !s.ends_with(".json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(entry.path()) {
            if let Ok(record) = serde_json::from_str::<MeetingRecord>(&content) {
                out.push(record);
            }
        }
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

#[tauri::command]
pub fn delete_meeting(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = meeting_path(&app, &id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_meetings_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(meetings_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn active_meeting_id() -> Result<Option<String>, String> {
    let guard = ACTIVE.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    Ok(guard.as_ref().map(|s| s.meeting_id.clone()))
}

// ── Diarization ───────────────────────────────────────────────────────────
//
// Runs offline speaker diarization over the PCM captured by the previous
// recording session. Emits speaker labels per existing whisper segment
// (by dominant overlap) and averaged 256-dim embeddings per cluster.
// The user invokes this right after stop_meeting_recording; the buffer is
// held in RAM only (never written to disk) and released once consumed.

// Minimum usable audio length — below ~3s the pipeline produces noisy clusters
// and the speaker_count estimator often collapses to zero.
const DIARIZE_MIN_SAMPLES: usize = TARGET_SR as usize * 3;

#[tauri::command]
pub fn diarize_meeting(
    app: tauri::AppHandle,
    meeting_id: String,
) -> Result<MeetingRecord, String> {
    use speakrs::{ExecutionMode, OwnedDiarizationPipeline};

    // Pull the audio buffer that stop_meeting_recording stashed. If the id
    // doesn't match, the user either stopped another meeting first or the app
    // was reloaded — in which case we can't reconstruct audio and must bail.
    let audio: Vec<f32> = {
        let mut guard = LAST_AUDIO
            .lock()
            .map_err(|e| format!("LAST_AUDIO poisoned: {e}"))?;
        match guard.take() {
            Some((id, buf)) if id == meeting_id => buf,
            Some((id, buf)) => {
                // Put it back so a later call with the matching id still works.
                *guard = Some((id, buf));
                return Err(
                    "Raw audio for this meeting is no longer in memory. Diarization must run immediately after the recording stops.".into(),
                );
            }
            None => {
                return Err(
                    "No audio buffer available for diarization. Start a recording, then run diarization after stopping.".into(),
                );
            }
        }
    };

    if audio.len() < DIARIZE_MIN_SAMPLES {
        return Err(format!(
            "Recording is too short for diarization ({:.1}s captured, need ≥ 3s).",
            audio.len() as f32 / TARGET_SR as f32
        ));
    }

    let mut record = {
        let path = meeting_path(&app, &meeting_id)?;
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Read {}: {e}", path.display()))?;
        serde_json::from_str::<MeetingRecord>(&content)
            .map_err(|e| format!("Parse {}: {e}", path.display()))?
    };

    let _ = app.emit(
        "meetings-diarize-progress",
        serde_json::json!({ "meetingId": &meeting_id, "stage": "loading-models" }),
    );

    // CoreMl for Apple Silicon. speakrs falls back gracefully on other platforms
    // via its Cpu mode; we force that path on non-macOS targets at compile time.
    #[cfg(target_os = "macos")]
    let mode = ExecutionMode::CoreMl;
    #[cfg(not(target_os = "macos"))]
    let mode = ExecutionMode::Cpu;

    let mut pipeline = OwnedDiarizationPipeline::from_pretrained(mode)
        .map_err(|e| format!("Diarization pipeline init failed: {e}"))?;

    let _ = app.emit(
        "meetings-diarize-progress",
        serde_json::json!({ "meetingId": &meeting_id, "stage": "running" }),
    );

    let result = pipeline
        .run(&audio)
        .map_err(|e| format!("Diarization run failed: {e}"))?;

    // 1) Assign a speaker to each whisper segment by dominant-overlap. speakrs
    //    returns `Vec<Segment>` already merged into speaker turns, keyed by
    //    labels like "SPEAKER_00".
    for seg in record.segments.iter_mut() {
        let best = dominant_overlap_speaker(
            &result.segments,
            seg.start_sec as f64,
            seg.end_sec as f64,
        );
        seg.speaker_id = best;
    }

    // 2) Compute one averaged embedding per cluster. hard_clusters has shape
    //    (chunks, speakers_per_chunk) → cluster_id; embeddings has shape
    //    (chunks, speakers_per_chunk, 256). -1 means "unassigned" — skip.
    let clusters = &result.hard_clusters;
    let embeddings = &result.embeddings;
    let (n_chunks, n_spk) = clusters.dim();
    let emb_dim = embeddings.shape().get(2).copied().unwrap_or(0);

    let mut sums: std::collections::BTreeMap<i32, (Vec<f32>, usize)> =
        std::collections::BTreeMap::new();

    for c in 0..n_chunks {
        for s in 0..n_spk {
            let cluster_id = clusters[[c, s]];
            if cluster_id < 0 {
                continue;
            }
            // Skip chunk-speaker pairs whose embedding contains any non-finite
            // values — they'd poison the running sum with NaN and we'd end up
            // serialising null into the meeting file.
            let mut has_nonfinite = false;
            for d in 0..emb_dim {
                if !embeddings[[c, s, d]].is_finite() {
                    has_nonfinite = true;
                    break;
                }
            }
            if has_nonfinite {
                continue;
            }
            let entry = sums
                .entry(cluster_id)
                .or_insert_with(|| (vec![0.0; emb_dim], 0));
            for d in 0..emb_dim {
                entry.0[d] += embeddings[[c, s, d]];
            }
            entry.1 += 1;
        }
    }

    let mut speakers: Vec<MeetingSpeaker> = sums
        .into_iter()
        .map(|(cluster_id, (mut sum, count))| {
            if count > 0 {
                let inv = 1.0 / count as f32;
                for v in sum.iter_mut() {
                    *v *= inv;
                }
            }
            // Belt-and-braces: even with the NaN filter above, any stray
            // non-finite value here would serialise as JSON `null` and break
            // the next load. Replace with 0.0 so the file stays parseable.
            for v in sum.iter_mut() {
                if !v.is_finite() {
                    *v = 0.0;
                }
            }
            MeetingSpeaker {
                id: format!("SPEAKER_{cluster_id:02}"),
                embedding: sum,
                display_name: None,
                candidates: Vec::new(),
            }
        })
        .collect();

    // Auto-recognize against the cross-meeting voice registry before writing
    // the record out. Confident matches populate display_name directly;
    // ambiguous clusters get a short list of candidates for the user to pick.
    let registry = load_registry(&app).unwrap_or_default();
    if !registry.entries.is_empty() {
        let mut reg_mut = registry.clone();
        let mut registry_changed = false;

        for sp in speakers.iter_mut() {
            let scored = best_per_name(&registry, &sp.embedding);
            let top_sim = scored.first().map(|(_, s)| *s).unwrap_or(0.0);
            let (auto_name, candidates) = decide_recognition(&scored);
            if let Some(name) = auto_name {
                sp.display_name = Some(name.clone());
                // Only feed very confident matches back into the registry.
                // A merely-labelled match (~0.70) is good enough to annotate
                // the transcript but not confident enough to contaminate the
                // registry if it happened to be wrong.
                if top_sim >= REGISTRY_AUTO_UPDATE_THRESHOLD {
                    enroll_registry_entry(
                        &mut reg_mut,
                        &name,
                        &meeting_id,
                        &sp.id,
                        sp.embedding.clone(),
                    );
                    registry_changed = true;
                }
            } else {
                sp.candidates = candidates;
            }
        }

        if registry_changed {
            save_registry(&app, &reg_mut)?;
        }
    }

    record.speakers = speakers;

    write_meeting(&app, &record)?;

    let _ = app.emit(
        "meetings-diarize-progress",
        serde_json::json!({
            "meetingId": &meeting_id,
            "stage": "done",
            "speakerCount": record.speakers.len(),
        }),
    );

    Ok(record)
}

#[tauri::command]
pub fn rename_meeting_speaker(
    app: tauri::AppHandle,
    meeting_id: String,
    speaker_id: String,
    display_name: Option<String>,
) -> Result<MeetingRecord, String> {
    let mut record = {
        let path = meeting_path(&app, &meeting_id)?;
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Read {}: {e}", path.display()))?;
        serde_json::from_str::<MeetingRecord>(&content)
            .map_err(|e| format!("Parse {}: {e}", path.display()))?
    };
    let trimmed = display_name.and_then(|s| {
        let t = s.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    });

    // Pull the vector before mutating so we can push it into the registry.
    let vector: Option<Vec<f32>> = record
        .speakers
        .iter()
        .find(|sp| sp.id == speaker_id)
        .map(|sp| sp.embedding.clone());

    for sp in record.speakers.iter_mut() {
        if sp.id == speaker_id {
            sp.display_name = trimmed.clone();
            // Assigning (or clearing) a name resolves any prior ambiguity.
            sp.candidates.clear();
        }
    }
    write_meeting(&app, &record)?;

    // Update the cross-meeting registry. A manually-confirmed name is always
    // trusted (the user vouched for it), so enroll unconditionally — with
    // near-duplicate merging and per-person cap handled inside the helper.
    // Clearing the name just removes whatever entry was keyed to this
    // cluster. Don't error if the registry file is missing.
    if let Ok(mut reg) = load_registry(&app) {
        match (&trimmed, vector) {
            (Some(name), Some(vec)) => {
                enroll_registry_entry(&mut reg, name, &meeting_id, &speaker_id, vec);
            }
            _ => {
                remove_registry_entry(&mut reg, &meeting_id, &speaker_id);
            }
        }
        let _ = save_registry(&app, &reg);
    }

    Ok(record)
}

// Pick the diarization speaker that overlaps a whisper segment for the most
// cumulative time. Returns None if the whisper segment does not overlap any
// diarized speech (e.g. entirely inside an unclassified gap).
fn dominant_overlap_speaker(
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
