import { type MeetingRecord, type MeetingSegment, type MeetingSummaryJson, type WhisperModelStatus } from "@/lib/tauri/meetings";

// Remembers which "new meeting" mode the user picked last from the split-button
// dropdown so reopening the panel defaults to the same option.
export type NewMeetingMode = "record" | "notes";

// Vertical leading inside the rich notes editor. Persisted as a preference
// rather than a per-meeting setting because line-height is a personal
// reading-comfort choice, not document data. The numeric values are
// resolved inside RichNotesEditor — the store just remembers the chosen
// preset. Default: "normal" (1.5).
export type NotesLineHeight = "compact" | "normal" | "relaxed";

export type RecordingState = "idle" | "recording" | "paused" | "stopping";

export interface ActiveSession {
  id: string;
  title: string;
  tags: string[];
  micDeviceName: string;
  modelId: string;
  startedAt: string;
  /** Live-updating list of segments emitted from Rust. */
  segments: MeetingSegment[];
  state: RecordingState;
  /** Monotonic elapsed seconds (tracked client-side via a timer). */
  elapsedSec: number;
  /** Error string, if anything went wrong. */
  error: string | null;
}

export interface ModelProgress {
  modelId: string;
  downloaded: number;
  total: number;
  done: boolean;
}

export interface MeetingsState {
  // ── Persistent drafts (saved across sessions) ──────────────────────────────
  draftTitle: string;
  draftTags: string[];
  micOverride: string | null;

  // ── List of saved meetings ────────────────────────────────────────────────
  meetings: MeetingRecord[];
  listLoaded: boolean;
  loading: boolean;

  // ── Detail view ───────────────────────────────────────────────────────────
  selectedId: string | null;
  /** In-flight operations keyed by meeting id (summarize, chat, etc.). */
  busy: Set<string>;
  /** Chat streaming text per meeting id (cleared when reply commits). */
  chatStreamText: Record<string, string>;
  /** Partial-parsed summary JSON per meeting id while a summary is streaming.
   *  Populated by the meeting-summary workflow's `progress` events; cleared
   *  when the final, validated summary lands on the record. */
  summaryStreamPartial: Record<string, Partial<MeetingSummaryJson>>;

  // ── Active session (only one at a time) ────────────────────────────────────
  active: ActiveSession | null;

  // ── Whisper model status + download progress ──────────────────────────────
  whisperModels: WhisperModelStatus[];
  modelProgress: Record<string, ModelProgress>;

  // ── Tag vocabulary (persisted to preferences) ─────────────────────────────
  tagVocab: string[];

  // ── Per-tag note templates (persisted to preferences) ─────────────────────
  // Map of tag → TipTap JSON string. Used to seed the body of an empty
  // notes-mode meeting when its first tag is selected.
  tagTemplates: Record<string, string>;

  // ── Last-chosen "New meeting" mode (persisted to preferences) ─────────────
  // Drives the default for the split-button dropdown in MeetingsScreen.
  newMeetingMode: NewMeetingMode;

  // ── Transcription disabled (persisted to preferences) ─────────────────────
  // When `true`, all audio-recording entry points are hidden across the app.
  transcriptionDisabled: boolean;

  // ── Notes line height (persisted to preferences) ──────────────────────────
  notesLineHeight: NotesLineHeight;

  // ── Actions ───────────────────────────────────────────────────────────────
  _set: (patch: Partial<MeetingsState>) => void;
  setDraftTitle: (title: string) => void;
  setDraftTags: (tags: string[]) => void;
  setMicOverride: (mic: string | null) => void;
  setNewMeetingMode: (mode: NewMeetingMode) => void;
  setTranscriptionDisabled: (disabled: boolean) => void;
  setNotesLineHeight: (mode: NotesLineHeight) => void;

  addTagToVocab: (tag: string) => void;
  removeTagFromVocab: (tag: string) => void;
  /**
   * Set or clear the note template associated with a tag. Pass an empty
   * string (or a TipTap doc whose plain-text projection is empty) to clear.
   */
  setTagTemplate: (tag: string, template: string) => void;

  loadMeetingsList: () => Promise<void>;
  selectMeeting: (id: string | null) => Promise<void>;
  deleteSelectedMeeting: () => Promise<void>;
  renameMeeting: (id: string, title: string) => Promise<void>;
  setMeetingTags: (id: string, tags: string[]) => Promise<void>;

  startRecording: (
    modelId: string,
    micName: string | null,
    extraTags?: string[],
  ) => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  stopRecording: () => Promise<MeetingRecord | null>;

  /** Create a notes-mode meeting (no audio) and select it. */
  createNotesMeeting: () => Promise<MeetingRecord>;
  /** Persist freeform notes for the selected notes-mode meeting. */
  saveSelectedNotes: (notes: string) => Promise<void>;
  /**
   * Persist freeform notes for a specific meeting by id. Used by the Tasks
   * panel to flip taskItem checked state on a meeting that isn't currently
   * selected.
   */
  saveNotesForMeeting: (meetingId: string, notes: string) => Promise<void>;

  summarizeSelected: () => Promise<void>;
  /**
   * Generate a short title for the currently-selected meeting. If the meeting
   * has no usable content (empty notes, no transcript) the title falls back
   * to the meeting's start date + time so the field still ends up populated
   * without a wasted LLM call.
   */
  generateTitleForSelected: () => Promise<void>;
  sendChatMessage: (input: string) => Promise<void>;
  /**
   * Run a cross-meetings RAG search inside the selected meeting's chat.
   * The user's `/search <query>` turn is appended verbatim, then the
   * hybrid retrieval result is fed to the cross-meetings chat workflow
   * and the answer (with citations) is appended as the assistant turn.
   * No-op when no meeting is selected.
   */
  sendCrossMeetingsSearch: (query: string) => Promise<void>;

  diarizeSelected: () => Promise<void>;
  renameSpeaker: (speakerId: string, displayName: string | null) => Promise<void>;

  /** Hard-clear the chat history for the selected meeting (persisted). */
  clearSelectedChat: () => Promise<void>;
  /** Drop just the last assistant turn — used by /retry to regenerate. */
  dropLastAssistantTurn: () => Promise<void>;

  refreshWhisperModels: () => Promise<void>;
  startModelDownload: (modelId: string) => Promise<void>;
}
