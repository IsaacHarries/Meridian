// Meetings — live local transcription via cpal + whisper-rs, plus CRUD for
// saved meeting records. Audio is NEVER written to disk — only the streamed
// transcription is persisted as JSON under {data_dir}/meetings/.
//
// The original `commands/meetings.rs` was split into focused submodules; this
// `mod.rs` is the single re-export surface so call sites elsewhere in the
// codebase (lib.rs's `tauri::generate_handler!` and the `commands::mod.rs`
// re-exports in particular) keep working unchanged.

mod _shared;
pub mod diarize;
pub mod persistence;
pub mod recording;
pub mod types;
pub mod whisper;

// ── Public types ───────────────────────────────────────────────────────────
// Other modules (notably `storage::meeting_index`) import these directly via
// `crate::commands::meetings::{MeetingKind, MeetingRecord}`, so re-export the
// full public type surface here.
pub use types::{
    ChatMessage, MeetingKind, MeetingRecord, MeetingSegment, MeetingSpeaker, MicrophoneInfo,
    PersonSummary, SpeakerCandidate, SpeakerRegistry, SpeakerRegistryEntry, StartMeetingRequest,
    StartMeetingResult, WhisperModelStatus,
};

// ── Tauri commands ─────────────────────────────────────────────────────────
pub use diarize::{diarize_meeting, rename_meeting_speaker};
pub use persistence::{
    active_meeting_id, clear_meetings_embeddings, create_notes_meeting, delete_meeting,
    get_meetings_dir, list_meetings, load_meeting, meetings_index_status, reindex_all_meetings,
    save_meeting, update_meeting_notes,
};
pub use recording::{
    list_microphones, pause_meeting_recording, resume_meeting_recording, start_meeting_recording,
    stop_meeting_recording,
};
pub use whisper::{download_whisper_model, list_whisper_models};
