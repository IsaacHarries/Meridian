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
    #[serde(rename = "startSec")]
    pub start_sec: f32,
    #[serde(rename = "endSec")]
    pub end_sec: f32,
    pub text: String,
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
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
    handle: Option<thread::JoinHandle<Result<(), String>>>,
}

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
