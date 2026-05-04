// Tauri commands for the recording lifecycle: list available microphones,
// start/pause/resume/stop a session. The actual capture + transcription
// thread lives in `_shared::spawn_recording_thread`.

use cpal::traits::{DeviceTrait, HostTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Emitter;

use super::_shared::{
    model_path, new_meeting_id, now_iso, spawn_recording_thread, write_meeting, ActiveSession,
    ACTIVE, LAST_AUDIO,
};
use super::types::{
    MeetingKind, MeetingRecord, MeetingSegment, MicrophoneInfo, StartMeetingRequest,
    StartMeetingResult,
};

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
        per_person: Vec::new(),
        suggested_title: None,
        suggested_tags: Vec::new(),
        chat_history: Vec::new(),
        speakers: Vec::new(),
        kind: MeetingKind::Transcript,
        notes: None,
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

