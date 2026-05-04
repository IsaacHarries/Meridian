/**
 * Module-level constants for the Meetings store: storage keys, preference
 * keys, and default values for the persisted slices of state.
 */

import type { NewMeetingMode, NotesLineHeight } from "./types";

export const MEETINGS_STORE_KEY = "meridian-meetings-store";

// Seed used on first run (no persisted vocab yet). Editable by the user from
// the moment it loads — these aren't "built-ins" that come back if deleted.
export const DEFAULT_TAG_VOCAB = ["standup", "planning", "retro", "1:1", "other"];
export const TAG_VOCAB_PREF_KEY = "meeting_tag_vocab";

// Per-tag note template: a TipTap JSON string that gets dropped into a
// notes-mode meeting's body the first time the user selects a tag, provided
// the body is still empty. Stored as a JSON-encoded `{ tag: jsonString }`
// map under this preference key.
export const TAG_TEMPLATES_PREF_KEY = "meeting_tag_templates";

export const NEW_MEETING_MODE_PREF_KEY = "meeting_default_new_kind";
export const DEFAULT_NEW_MEETING_MODE: NewMeetingMode = "record";

// When `true`, every entry point to live audio recording is hidden — the
// header record button, the "Record audio" option in the split-button
// dropdown, and the Microphone / Whisper Model cards in Settings. Notes-mode
// is still available. Set by the user in Settings → Meetings; persisted under
// this preference key. Default: enabled (transcription on).
export const TRANSCRIPTION_DISABLED_PREF_KEY = "meeting_transcription_disabled";

export const NOTES_LINE_HEIGHT_PREF_KEY = "meeting_notes_line_height";
export const DEFAULT_NOTES_LINE_HEIGHT: NotesLineHeight = "normal";
