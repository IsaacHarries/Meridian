// Tauri commands for managing the on-disk whisper.cpp model files.
// Models are downloaded from HuggingFace on demand and cached under
// {data_dir}/models/whisper/.

use futures_util::StreamExt;
use std::fs;
use std::io::Write;
use std::time::{Duration, Instant};
use tauri::Emitter;

use super::_shared::{model_filename, models_dir, HUGGINGFACE_BASE, SUPPORTED_MODELS};
use super::types::WhisperModelStatus;

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
