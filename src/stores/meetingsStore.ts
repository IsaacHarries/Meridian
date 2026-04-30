/**
 * Zustand store for the Meetings workflow.
 *
 * Responsibilities:
 *   - Keep the list of on-disk meeting records in memory.
 *   - Track the single active recording session (title, tags, streaming
 *     segments, elapsed time, paused/recording status). The backend is the
 *     source of truth; this store mirrors what it emits.
 *   - Track the currently-selected past meeting for the detail view.
 *   - Expose actions that wrap the Tauri commands.
 *
 * Note: active recording state is NOT persisted — the Rust thread owns the
 * cpal stream and cannot survive an app reload. On boot we only rehydrate
 * draft metadata (title / tags / mic override) so the user's next recording
 * starts with their preferred defaults.
 */

import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  type MeetingRecord,
  type MeetingSegment,
  type MeetingChatMessage,
  type MeetingSummaryJson,
  type WhisperModelStatus,
  listMeetings,
  loadMeeting,
  saveMeeting,
  deleteMeeting,
  startMeetingRecording,
  pauseMeetingRecording,
  resumeMeetingRecording,
  stopMeetingRecording,
  activeMeetingId,
  listWhisperModels,
  downloadWhisperModel,
  summarizeMeeting,
  generateMeetingTitle,
  chatMeeting,
  diarizeMeeting,
  renameMeetingSpeaker,
  createNotesMeeting as createNotesMeetingCmd,
  updateMeetingNotes,
  parseAgentJson,
} from "@/lib/tauri";
import { getPreferences, setPreference } from "@/lib/preferences";
import { loadCache, saveCache } from "@/lib/storeCache";
import { extractTiptapPlainText } from "@/lib/tiptapText";
import { subscribeWorkflowStream } from "@/lib/workflowStream";

export const MEETINGS_STORE_KEY = "meridian-meetings-store";

// Seed used on first run (no persisted vocab yet). Editable by the user from
// the moment it loads — these aren't "built-ins" that come back if deleted.
const DEFAULT_TAG_VOCAB = ["standup", "planning", "retro", "1:1", "other"];
const TAG_VOCAB_PREF_KEY = "meeting_tag_vocab";

// Per-tag note template: a TipTap JSON string that gets dropped into a
// notes-mode meeting's body the first time the user selects a tag, provided
// the body is still empty. Stored as a JSON-encoded `{ tag: jsonString }`
// map under this preference key.
const TAG_TEMPLATES_PREF_KEY = "meeting_tag_templates";

// Remembers which "new meeting" mode the user picked last from the split-button
// dropdown so reopening the panel defaults to the same option.
export type NewMeetingMode = "record" | "notes";
const NEW_MEETING_MODE_PREF_KEY = "meeting_default_new_kind";
const DEFAULT_NEW_MEETING_MODE: NewMeetingMode = "record";

// When `true`, every entry point to live audio recording is hidden — the
// header record button, the "Record audio" option in the split-button
// dropdown, and the Microphone / Whisper Model cards in Settings. Notes-mode
// is still available. Set by the user in Settings → Meetings; persisted under
// this preference key. Default: enabled (transcription on).
const TRANSCRIPTION_DISABLED_PREF_KEY = "meeting_transcription_disabled";

// Vertical leading inside the rich notes editor. Persisted as a preference
// rather than a per-meeting setting because line-height is a personal
// reading-comfort choice, not document data. The numeric values are
// resolved inside RichNotesEditor — the store just remembers the chosen
// preset. Default: "normal" (1.5).
export type NotesLineHeight = "compact" | "normal" | "relaxed";
const NOTES_LINE_HEIGHT_PREF_KEY = "meeting_notes_line_height";
const DEFAULT_NOTES_LINE_HEIGHT: NotesLineHeight = "normal";

// ── Types ────────────────────────────────────────────────────────────────────

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

interface MeetingsState {
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

  diarizeSelected: () => Promise<void>;
  renameSpeaker: (speakerId: string, displayName: string | null) => Promise<void>;

  /** Hard-clear the chat history for the selected meeting (persisted). */
  clearSelectedChat: () => Promise<void>;
  /** Drop just the last assistant turn — used by /retry to regenerate. */
  dropLastAssistantTurn: () => Promise<void>;

  refreshWhisperModels: () => Promise<void>;
  startModelDownload: (modelId: string) => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTranscriptText(record: MeetingRecord): string {
  if (record.segments.length === 0) return "(no transcript available)";

  // Resolve speaker id → user-assigned name so the AI agent sees real names
  // instead of anonymous "SPEAKER_00" labels. Falls back to the raw cluster
  // id when no name has been assigned yet, and omits the prefix entirely
  // for segments that were never diarized.
  const nameById = new Map<string, string>();
  for (const sp of record.speakers ?? []) {
    nameById.set(sp.id, sp.displayName?.trim() || sp.id);
  }

  return record.segments
    .map((s) => {
      const t = formatTimestamp(s.startSec);
      const speaker = s.speakerId ? nameById.get(s.speakerId) ?? s.speakerId : null;
      return speaker ? `[${t}] ${speaker}: ${s.text}` : `[${t}] ${s.text}`;
    })
    .join("\n");
}

// The text we feed to the summarize / chat agents. For transcript-mode meetings
// this is the joined segment text; for notes-mode it's the rich-editor
// document flattened to markdown-ish plain text (TipTap stores JSON, but the
// agents speak text — see extractTiptapPlainText). Either may be empty
// (caller should guard).
function buildAgentInputText(record: MeetingRecord): string {
  if (record.kind === "notes") {
    return extractTiptapPlainText(record.notes);
  }
  return buildTranscriptText(record);
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function replaceOrInsert(
  list: MeetingRecord[],
  record: MeetingRecord,
): MeetingRecord[] {
  const idx = list.findIndex((m) => m.id === record.id);
  if (idx === -1) {
    return [record, ...list].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
  }
  const next = list.slice();
  next[idx] = record;
  return next;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useMeetingsStore = create<MeetingsState>()((set, get) => ({
  draftTitle: "",
  draftTags: [],
  micOverride: null,

  meetings: [],
  listLoaded: false,
  loading: false,

  selectedId: null,
  busy: new Set(),
  chatStreamText: {},
  summaryStreamPartial: {},

  active: null,

  whisperModels: [],
  modelProgress: {},

  tagVocab: DEFAULT_TAG_VOCAB,

  tagTemplates: {},

  newMeetingMode: DEFAULT_NEW_MEETING_MODE,

  transcriptionDisabled: false,

  notesLineHeight: DEFAULT_NOTES_LINE_HEIGHT,

  _set: (patch) => set(patch as Partial<MeetingsState>),

  setDraftTitle: (title) => set({ draftTitle: title }),
  setDraftTags: (tags) => set({ draftTags: tags }),
  setMicOverride: (mic) => set({ micOverride: mic }),
  setNewMeetingMode: (mode) => {
    set({ newMeetingMode: mode });
    void setPreference(NEW_MEETING_MODE_PREF_KEY, mode);
  },
  setTranscriptionDisabled: (disabled) => {
    set({ transcriptionDisabled: disabled });
    void setPreference(TRANSCRIPTION_DISABLED_PREF_KEY, disabled ? "true" : "false");
    // When the user disables transcription, force the "New meeting" default
    // to notes so reopening the Meetings panel doesn't surface the now-hidden
    // record path.
    if (disabled) {
      set({ newMeetingMode: "notes" });
      void setPreference(NEW_MEETING_MODE_PREF_KEY, "notes");
    }
  },
  setNotesLineHeight: (mode) => {
    set({ notesLineHeight: mode });
    void setPreference(NOTES_LINE_HEIGHT_PREF_KEY, mode);
  },

  addTagToVocab: (tag) => {
    const normalized = tag.trim().toLowerCase();
    if (!normalized) return;
    set((s) => {
      if (s.tagVocab.includes(normalized)) return s;
      const next = [...s.tagVocab, normalized];
      void setPreference(TAG_VOCAB_PREF_KEY, JSON.stringify(next));
      return { tagVocab: next };
    });
  },

  removeTagFromVocab: (tag) => {
    set((s) => {
      if (!s.tagVocab.includes(tag)) return s;
      const nextVocab = s.tagVocab.filter((t) => t !== tag);
      void setPreference(TAG_VOCAB_PREF_KEY, JSON.stringify(nextVocab));
      // Drop any associated template — keeping it would resurrect on re-add,
      // which would be surprising after the user explicitly deleted the tag.
      let nextTemplates = s.tagTemplates;
      if (tag in s.tagTemplates) {
        nextTemplates = { ...s.tagTemplates };
        delete nextTemplates[tag];
        void setPreference(
          TAG_TEMPLATES_PREF_KEY,
          JSON.stringify(nextTemplates),
        );
      }
      return { tagVocab: nextVocab, tagTemplates: nextTemplates };
    });
  },

  setTagTemplate: (tag, template) => {
    const normalized = tag.trim().toLowerCase();
    if (!normalized) return;
    set((s) => {
      // Treat a doc whose plain-text projection is empty as "no template" so
      // an editor showing only the empty placeholder doc doesn't count.
      const isEmpty = extractTiptapPlainText(template).length === 0;
      const next = { ...s.tagTemplates };
      if (isEmpty) {
        if (!(normalized in next)) return s;
        delete next[normalized];
      } else {
        if (next[normalized] === template) return s;
        next[normalized] = template;
      }
      void setPreference(TAG_TEMPLATES_PREF_KEY, JSON.stringify(next));
      return { tagTemplates: next };
    });
  },

  loadMeetingsList: async () => {
    set({ loading: true });
    try {
      const list = await listMeetings();
      set({ meetings: list, listLoaded: true, loading: false });
    } catch (e) {
      console.error("[meetings] loadMeetingsList", e);
      set({ loading: false, listLoaded: true });
    }
  },

  selectMeeting: async (id) => {
    if (id === null) {
      set({ selectedId: null });
      return;
    }
    set({ selectedId: id });
    try {
      const fresh = await loadMeeting(id);
      set((s) => ({ meetings: replaceOrInsert(s.meetings, fresh) }));
    } catch (e) {
      console.error("[meetings] selectMeeting load", e);
    }
  },

  deleteSelectedMeeting: async () => {
    const { selectedId, meetings } = get();
    if (!selectedId) return;
    await deleteMeeting(selectedId);
    set({
      meetings: meetings.filter((m) => m.id !== selectedId),
      selectedId: null,
    });
  },

  renameMeeting: async (id, title) => {
    const record = get().meetings.find((m) => m.id === id);
    if (!record) return;
    const updated = { ...record, title };
    await saveMeeting(updated);
    set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
  },

  setMeetingTags: async (id, tags) => {
    const { meetings, tagTemplates } = get();
    const record = meetings.find((m) => m.id === id);
    if (!record) return;
    // Apply a per-tag note template the FIRST time a notes-mode meeting goes
    // from "no tags" to "≥ 1 tag" with an empty body. Only the first tag in
    // the new selection counts — adding later tags doesn't replace an
    // already-templated (or already-edited) body. If the first tag has no
    // template configured, nothing is inserted (we don't fall through to the
    // second tag's template — that would violate "first selected tag" only).
    let nextNotes = record.notes;
    const wasEmptyTagSet = record.tags.length === 0;
    const isNotesMode = record.kind === "notes";
    if (wasEmptyTagSet && isNotesMode && tags.length > 0) {
      const bodyEmpty =
        extractTiptapPlainText(record.notes ?? "").length === 0;
      if (bodyEmpty) {
        const firstTagTemplate = tagTemplates[tags[0]];
        if (firstTagTemplate && firstTagTemplate.trim() !== "") {
          nextNotes = firstTagTemplate;
        }
      }
    }
    const updated = { ...record, tags, notes: nextNotes };
    await saveMeeting(updated);
    set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
  },

  startRecording: async (modelId, micName, extraTags) => {
    if (get().active) throw new Error("A meeting is already recording.");
    const { draftTitle, draftTags } = get();
    // Merge any screen-context tags (e.g. "standup" when started from the
    // Standup screen) with the user's draft tags, de-duplicated.
    const tags = extraTags && extraTags.length > 0
      ? Array.from(new Set([...draftTags, ...extraTags]))
      : draftTags;
    const req = {
      // Leave the title empty when the user didn't type one — the AI will
      // suggest one during summary and we'll auto-apply it.
      title: draftTitle.trim(),
      tags,
      micName,
      modelId,
    };
    const result = await startMeetingRecording(req);
    set({
      active: {
        id: result.id,
        title: req.title,
        tags: req.tags,
        micDeviceName: result.micDeviceName,
        modelId,
        startedAt: result.startedAt,
        segments: [],
        state: "recording",
        elapsedSec: 0,
        error: null,
      },
    });
  },

  pauseRecording: async () => {
    await pauseMeetingRecording();
    set((s) =>
      s.active ? { active: { ...s.active, state: "paused" } } : s,
    );
  },

  resumeRecording: async () => {
    await resumeMeetingRecording();
    set((s) =>
      s.active ? { active: { ...s.active, state: "recording" } } : s,
    );
  },

  createNotesMeeting: async () => {
    const { draftTitle, draftTags } = get();
    const record = await createNotesMeetingCmd(draftTitle.trim(), draftTags);
    set((s) => ({
      meetings: replaceOrInsert(s.meetings, record),
      selectedId: record.id,
      // Clear the staged title so the next freshly-opened meeting starts blank,
      // mirroring the behaviour after stopRecording() finishes.
      draftTitle: "",
      draftTags: [],
    }));
    return record;
  },

  saveSelectedNotes: async (notes) => {
    const { selectedId } = get();
    if (!selectedId) return;
    const updated = await updateMeetingNotes(selectedId, notes);
    set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
  },

  saveNotesForMeeting: async (meetingId, notes) => {
    const updated = await updateMeetingNotes(meetingId, notes);
    set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
  },

  stopRecording: async () => {
    const active = get().active;
    if (!active) return null;
    set({ active: { ...active, state: "stopping" } });
    try {
      const record = await stopMeetingRecording();
      set((s) => ({
        active: null,
        meetings: replaceOrInsert(s.meetings, record),
        selectedId: record.id,
        draftTitle: "",
      }));
      // The raw PCM buffer only lives in RAM until the NEXT recording replaces
      // it, so diarization has to fire here. Run it eagerly (before summary)
      // since the user may trigger another recording quickly. Summary doesn't
      // need the audio, so it's fine to kick off in parallel.
      if (record.segments.length > 0) {
        void get().diarizeSelected();
        void get().summarizeSelected();
      }
      return record;
    } catch (e) {
      set((s) =>
        s.active ? { active: { ...s.active, error: String(e), state: "idle" } } : s,
      );
      throw e;
    }
  },

  generateTitleForSelected: async () => {
    const { selectedId, meetings } = get();
    if (!selectedId) return;
    const record = meetings.find((m) => m.id === selectedId);
    if (!record) return;
    set((s) => ({ busy: new Set(s.busy).add(selectedId) }));
    try {
      const content = buildAgentInputText(record).trim();
      // Pure-fallback path: when there's nothing meaningful to feed the model,
      // skip the LLM call entirely and use the meeting's start date+time as
      // the title. Cheaper, faster, and avoids an "Untitled" round-trip.
      let nextTitle: string;
      if (!content || content === "(no transcript available)") {
        const d = new Date(record.startedAt);
        const date = d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const time = d.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });
        nextTitle = `${date} · ${time}`;
      } else {
        const generated = await generateMeetingTitle(content, record.tags);
        nextTitle = generated.trim() || "Untitled";
      }
      // Re-read the freshest record before saving — diarization or notes
      // edits may have completed while we were waiting on the AI call.
      const latest = await loadMeeting(selectedId).catch(() => record);
      const updated: MeetingRecord = { ...latest, title: nextTitle };
      await saveMeeting(updated);
      set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
    } finally {
      set((s) => {
        const next = new Set(s.busy);
        next.delete(selectedId);
        return { busy: next };
      });
    }
  },

  summarizeSelected: async () => {
    const { selectedId, meetings } = get();
    if (!selectedId) return;
    const record = meetings.find((m) => m.id === selectedId);
    if (!record) return;
    set((s) => ({
      busy: new Set(s.busy).add(selectedId),
      summaryStreamPartial: { ...s.summaryStreamPartial, [selectedId]: {} },
    }));
    const stream = await listen<{
      kind?: string;
      data?: { partial?: Partial<MeetingSummaryJson> };
    }>("meeting-summary-workflow-event", (event) => {
      if (event.payload.kind !== "progress") return;
      const partial = event.payload.data?.partial;
      if (!partial || typeof partial !== "object") return;
      set((s) => ({
        summaryStreamPartial: {
          ...s.summaryStreamPartial,
          [selectedId]: partial,
        },
      }));
    });
    try {
      const raw = await summarizeMeeting(
        buildAgentInputText(record),
        record.title,
        record.tags,
      );
      const parsed = parseAgentJson<MeetingSummaryJson>(raw);
      if (!parsed) throw new Error("Could not parse summary JSON");
      // Diarization runs concurrently with this call after stopRecording. If
      // it finished first, the on-disk record now has .speakers and
      // .segments[*].speakerId that are NOT in `record` (captured before the
      // AI call). Re-read the freshest record so those fields aren't clobbered
      // when we write the summary back.
      const latest = await loadMeeting(selectedId).catch(() => record);
      const autoTitle =
        !latest.title.trim() && parsed.suggestedTitle
          ? parsed.suggestedTitle
          : latest.title;
      const updated: MeetingRecord = {
        ...latest,
        title: autoTitle,
        summary: parsed.summary ?? null,
        actionItems: parsed.actionItems ?? [],
        decisions: parsed.decisions ?? [],
        perPerson: parsed.perPerson ?? [],
        suggestedTitle: parsed.suggestedTitle ?? null,
        suggestedTags: parsed.suggestedTags ?? [],
      };
      await saveMeeting(updated);
      set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
    } finally {
      stream();
      set((s) => {
        const nextBusy = new Set(s.busy);
        nextBusy.delete(selectedId);
        const nextPartial = { ...s.summaryStreamPartial };
        delete nextPartial[selectedId];
        return { busy: nextBusy, summaryStreamPartial: nextPartial };
      });
    }
  },

  sendChatMessage: async (input) => {
    const { selectedId, meetings } = get();
    if (!selectedId) return;
    const record = meetings.find((m) => m.id === selectedId);
    if (!record) return;

    const userMsg: MeetingChatMessage = { role: "user", content: input };
    const nextHistory: MeetingChatMessage[] = [
      ...(record.chatHistory ?? []),
      userMsg,
    ];
    // Optimistically append the user message
    const optimistic = { ...record, chatHistory: nextHistory };
    set((s) => ({
      meetings: replaceOrInsert(s.meetings, optimistic),
      busy: new Set(s.busy).add(selectedId),
      chatStreamText: { ...s.chatStreamText, [selectedId]: "" },
    }));

    const stream = await subscribeWorkflowStream(
      "meeting-chat-workflow-event",
      (text) => {
        set((s) => ({
          chatStreamText: { ...s.chatStreamText, [selectedId]: text },
        }));
      },
    );
    try {
      const reply = await chatMeeting(
        buildAgentInputText(record),
        JSON.stringify(nextHistory),
      );
      const assistantMsg: MeetingChatMessage = {
        role: "assistant",
        content: reply.trim(),
      };
      const finalHistory = [...nextHistory, assistantMsg];
      const updated: MeetingRecord = { ...record, chatHistory: finalHistory };
      await saveMeeting(updated);
      set((s) => {
        const nextStream = { ...s.chatStreamText };
        delete nextStream[selectedId];
        return {
          meetings: replaceOrInsert(s.meetings, updated),
          chatStreamText: nextStream,
        };
      });
    } finally {
      await stream.dispose();
      set((s) => {
        const nextBusy = new Set(s.busy);
        nextBusy.delete(selectedId);
        const nextStream = { ...s.chatStreamText };
        delete nextStream[selectedId];
        return { busy: nextBusy, chatStreamText: nextStream };
      });
    }
  },

  diarizeSelected: async () => {
    const { selectedId } = get();
    if (!selectedId) return;
    set((s) => ({ busy: new Set(s.busy).add(selectedId) }));
    try {
      const updated = await diarizeMeeting(selectedId);
      set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
    } catch (e) {
      // Expected failure modes (raw audio no longer in RAM, too-short clip)
      // surface as plain Error strings; don't treat them as app-breaking.
      console.error("[meetings] diarizeSelected", e);
      throw e;
    } finally {
      set((s) => {
        const next = new Set(s.busy);
        next.delete(selectedId);
        return { busy: next };
      });
    }
  },

  renameSpeaker: async (speakerId, displayName) => {
    const { selectedId } = get();
    if (!selectedId) return;
    const updated = await renameMeetingSpeaker(selectedId, speakerId, displayName);
    set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
  },

  clearSelectedChat: async () => {
    const { selectedId, meetings } = get();
    if (!selectedId) return;
    const record = meetings.find((m) => m.id === selectedId);
    if (!record || (record.chatHistory ?? []).length === 0) return;
    const updated: MeetingRecord = { ...record, chatHistory: [] };
    await saveMeeting(updated);
    set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
  },

  dropLastAssistantTurn: async () => {
    const { selectedId, meetings } = get();
    if (!selectedId) return;
    const record = meetings.find((m) => m.id === selectedId);
    if (!record) return;
    const history = record.chatHistory ?? [];
    if (history.length === 0 || history[history.length - 1].role !== "assistant") {
      return;
    }
    const updated: MeetingRecord = {
      ...record,
      chatHistory: history.slice(0, -1),
    };
    await saveMeeting(updated);
    set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
  },

  refreshWhisperModels: async () => {
    try {
      const models = await listWhisperModels();
      set({ whisperModels: models });
    } catch (e) {
      console.error("[meetings] refreshWhisperModels", e);
    }
  },

  startModelDownload: async (modelId) => {
    try {
      await downloadWhisperModel(modelId);
      const models = await listWhisperModels();
      set((s) => {
        const next = { ...s.modelProgress };
        delete next[modelId];
        return { whisperModels: models, modelProgress: next };
      });
    } catch (e) {
      console.error("[meetings] downloadWhisperModel", e);
      throw e;
    }
  },
}));

// ── Event listeners (live segments, status, model download progress) ─────────

let listenersAttached = false;
const unlistenFns: UnlistenFn[] = [];

async function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  unlistenFns.push(
    await listen<{
      meetingId: string;
      startSec: number;
      endSec: number;
      text: string;
    }>("meetings-segment", (e) => {
      const { meetingId, startSec, endSec, text } = e.payload;
      useMeetingsStore.setState((s) => {
        if (!s.active || s.active.id !== meetingId) return s;
        return {
          active: {
            ...s.active,
            segments: [...s.active.segments, { startSec, endSec, text }],
          },
        };
      });
    }),
  );

  unlistenFns.push(
    await listen<{
      meetingId: string;
      state: string;
      durationSec?: number;
    }>("meetings-status", (e) => {
      const { meetingId, state } = e.payload;
      useMeetingsStore.setState((s) => {
        if (!s.active || s.active.id !== meetingId) return s;
        if (state === "recording" || state === "paused") {
          return { active: { ...s.active, state: state as RecordingState } };
        }
        return s;
      });
    }),
  );

  unlistenFns.push(
    await listen<{
      modelId: string;
      downloaded: number;
      total: number;
      done: boolean;
    }>("meetings-model-progress", (e) => {
      const { modelId, downloaded, total, done } = e.payload;
      useMeetingsStore.setState((s) => ({
        modelProgress: {
          ...s.modelProgress,
          [modelId]: { modelId, downloaded, total, done },
        },
      }));
    }),
  );
}

// ── Elapsed-time ticker (frontend-driven, 1Hz) ───────────────────────────────

let tickerHandle: number | null = null;

function ensureTicker() {
  if (tickerHandle !== null) return;
  tickerHandle = window.setInterval(() => {
    useMeetingsStore.setState((s) => {
      if (!s.active || s.active.state !== "recording") return s;
      return { active: { ...s.active, elapsedSec: s.active.elapsedSec + 1 } };
    });
  }, 1000);
}

// Ensure ticker runs after boot (idempotent). A React component could also
// manage this, but piggybacking on the store means it works regardless of
// which screen is mounted.
if (typeof window !== "undefined") {
  ensureTicker();
}

// ── Persistence ──────────────────────────────────────────────────────────────

function serializableState(s: MeetingsState) {
  return {
    draftTitle: s.draftTitle,
    draftTags: s.draftTags,
    micOverride: s.micOverride,
    // Everything else is transient / re-derived from disk or the backend.
  };
}

export async function hydrateMeetingsStore(): Promise<void> {
  // Load persisted draft metadata from storeCache.
  const cached = await loadCache<MeetingsState>(MEETINGS_STORE_KEY);
  if (cached) {
    useMeetingsStore.setState({
      draftTitle: cached.draftTitle ?? "",
      draftTags: cached.draftTags ?? [],
      micOverride: cached.micOverride ?? null,
    });
  }

  // Pull the default mic + tag vocab from preferences. Tag vocab is seeded
  // with DEFAULT_TAG_VOCAB on first run (no key present yet); once the user
  // edits the vocabulary, the preference file takes over as the source of
  // truth and the defaults are never re-injected.
  try {
    const prefs = await getPreferences();
    const prefMic = prefs["meeting_mic"] ?? "";
    if (prefMic && !useMeetingsStore.getState().micOverride) {
      // Don't set as override — micOverride means per-meeting override. The
      // fallback ordering (override → pref → system default) is handled at
      // recording start time.
    }
    const rawVocab = prefs[TAG_VOCAB_PREF_KEY];
    if (rawVocab) {
      try {
        const parsed = JSON.parse(rawVocab);
        if (Array.isArray(parsed)) {
          useMeetingsStore.setState({
            tagVocab: parsed.filter((t): t is string => typeof t === "string"),
          });
        }
      } catch {
        /* fall back to DEFAULT_TAG_VOCAB already in state */
      }
    }
    const rawTemplates = prefs[TAG_TEMPLATES_PREF_KEY];
    if (rawTemplates) {
      try {
        const parsed = JSON.parse(rawTemplates);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const filtered: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "string") filtered[k] = v;
          }
          useMeetingsStore.setState({ tagTemplates: filtered });
        }
      } catch {
        /* malformed JSON — leave the empty default in place */
      }
    }
    const rawMode = prefs[NEW_MEETING_MODE_PREF_KEY];
    if (rawMode === "record" || rawMode === "notes") {
      useMeetingsStore.setState({ newMeetingMode: rawMode });
    }
    const rawDisabled = prefs[TRANSCRIPTION_DISABLED_PREF_KEY];
    if (rawDisabled === "true") {
      useMeetingsStore.setState({
        transcriptionDisabled: true,
        // Mirror the same coercion setTranscriptionDisabled does, so the panel
        // doesn't briefly show "Record audio" as the default before the user
        // touches it.
        newMeetingMode: "notes",
      });
    }
    const rawLineHeight = prefs[NOTES_LINE_HEIGHT_PREF_KEY];
    if (
      rawLineHeight === "compact" ||
      rawLineHeight === "normal" ||
      rawLineHeight === "relaxed"
    ) {
      useMeetingsStore.setState({ notesLineHeight: rawLineHeight });
    }
  } catch {
    /* ignore */
  }

  await attachListeners();

  // Check whether Rust thinks a recording is in progress (shouldn't be across
  // reloads, but a safety net).
  try {
    const id = await activeMeetingId();
    if (id) {
      console.warn("[meetings] backend reports active meeting across reload:", id);
    }
  } catch {
    /* ignore */
  }

  // Eagerly load the meetings list so the TasksPanel can extract unchecked
  // taskItems from notes-mode meetings on first paint, instead of waiting
  // for the user to navigate to the Meetings screen.
  void useMeetingsStore.getState().loadMeetingsList();
}

useMeetingsStore.subscribe((state) => {
  saveCache(MEETINGS_STORE_KEY, serializableState(state));
});

// ── Exported pure helpers (for UI) ───────────────────────────────────────────

export { buildTranscriptText, formatTimestamp };
