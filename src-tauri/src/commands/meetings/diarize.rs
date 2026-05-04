// Offline speaker diarization for the meeting that just finished recording.
// Consumes the in-memory PCM buffer stashed by `stop_meeting_recording`,
// labels each whisper segment with a speaker cluster, computes averaged
// 256-dim embeddings per cluster, and runs the cross-meeting voice
// registry against them so confident matches auto-fill display names.

use std::fs;
use tauri::Emitter;

use super::_shared::{
    best_per_name, decide_recognition, dominant_overlap_speaker, enroll_registry_entry,
    load_registry, meeting_path, remove_registry_entry, save_registry, write_meeting,
    DIARIZE_MIN_SAMPLES, LAST_AUDIO, REGISTRY_AUTO_UPDATE_THRESHOLD, TARGET_SR,
};
use super::types::{MeetingRecord, MeetingSpeaker};

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
