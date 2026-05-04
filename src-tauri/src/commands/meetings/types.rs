// Shared serialised types used across the meetings command modules.
// These appear in Tauri command signatures, on-disk JSON, and the
// cross-module helpers in `_shared`, so they live in one place.

use serde::{Deserialize, Serialize};

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

// Distinguishes a meeting captured by live transcription from one where the
// user typed freeform notes (e.g. company meetings where audio recording is
// not permitted). Defaults to `Transcript` so existing on-disk records load
// unchanged.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeetingKind {
    Transcript,
    Notes,
}

impl Default for MeetingKind {
    fn default() -> Self {
        MeetingKind::Transcript
    }
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
    #[serde(default, rename = "perPerson")]
    pub per_person: Vec<PersonSummary>,
    #[serde(default, rename = "suggestedTitle")]
    pub suggested_title: Option<String>,
    #[serde(default, rename = "suggestedTags")]
    pub suggested_tags: Vec<String>,
    #[serde(default, rename = "chatHistory")]
    pub chat_history: Vec<ChatMessage>,
    #[serde(default)]
    pub speakers: Vec<MeetingSpeaker>,
    #[serde(default)]
    pub kind: MeetingKind,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// One entry per person who spoke (or whose update was captured in notes-mode).
// Populated by the summarize agent for standup meetings, optional otherwise.
// `name` mirrors whatever appeared in the input — a real name when speakers
// were diarized + renamed, the raw cluster label otherwise.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PersonSummary {
    pub name: String,
    pub summary: String,
    #[serde(default, rename = "actionItems")]
    pub action_items: Vec<String>,
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WhisperModelStatus {
    pub id: String,
    pub downloaded: bool,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

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
