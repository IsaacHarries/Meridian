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
  chatMeeting,
  parseAgentJson,
} from "@/lib/tauri";
import { getPreferences } from "@/lib/preferences";
import { loadCache, saveCache } from "@/lib/storeCache";

export const MEETINGS_STORE_KEY = "meridian-meetings-store";

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

  // ── Active session (only one at a time) ────────────────────────────────────
  active: ActiveSession | null;

  // ── Whisper model status + download progress ──────────────────────────────
  whisperModels: WhisperModelStatus[];
  modelProgress: Record<string, ModelProgress>;

  // ── Actions ───────────────────────────────────────────────────────────────
  _set: (patch: Partial<MeetingsState>) => void;
  setDraftTitle: (title: string) => void;
  setDraftTags: (tags: string[]) => void;
  setMicOverride: (mic: string | null) => void;

  loadMeetingsList: () => Promise<void>;
  selectMeeting: (id: string | null) => Promise<void>;
  deleteSelectedMeeting: () => Promise<void>;
  renameMeeting: (id: string, title: string) => Promise<void>;
  setMeetingTags: (id: string, tags: string[]) => Promise<void>;

  startRecording: (
    modelId: string,
    micName: string | null,
  ) => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  stopRecording: () => Promise<MeetingRecord | null>;

  summarizeSelected: () => Promise<void>;
  sendChatMessage: (input: string) => Promise<void>;

  refreshWhisperModels: () => Promise<void>;
  startModelDownload: (modelId: string) => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTranscriptText(record: MeetingRecord): string {
  if (record.segments.length === 0) return "(no transcript available)";
  return record.segments
    .map((s) => {
      const t = formatTimestamp(s.startSec);
      return `[${t}] ${s.text}`;
    })
    .join("\n");
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

  active: null,

  whisperModels: [],
  modelProgress: {},

  _set: (patch) => set(patch as Partial<MeetingsState>),

  setDraftTitle: (title) => set({ draftTitle: title }),
  setDraftTags: (tags) => set({ draftTags: tags }),
  setMicOverride: (mic) => set({ micOverride: mic }),

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
    const record = get().meetings.find((m) => m.id === id);
    if (!record) return;
    const updated = { ...record, tags };
    await saveMeeting(updated);
    set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
  },

  startRecording: async (modelId, micName) => {
    if (get().active) throw new Error("A meeting is already recording.");
    const { draftTitle, draftTags } = get();
    const req = {
      // Leave the title empty when the user didn't type one — the AI will
      // suggest one during summary and we'll auto-apply it.
      title: draftTitle.trim(),
      tags: draftTags,
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
      // Auto-generate summary + AI title in the background so the meeting
      // doesn't sit in the list as "Untitled meeting". The UI still shows a
      // manual "Regenerate" button for the user to run again later.
      if (record.segments.length > 0) {
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

  summarizeSelected: async () => {
    const { selectedId, meetings } = get();
    if (!selectedId) return;
    const record = meetings.find((m) => m.id === selectedId);
    if (!record) return;
    set((s) => ({ busy: new Set(s.busy).add(selectedId) }));
    try {
      const raw = await summarizeMeeting(
        buildTranscriptText(record),
        record.title,
        record.tags,
      );
      const parsed = parseAgentJson<MeetingSummaryJson>(raw);
      if (!parsed) throw new Error("Could not parse summary JSON");
      // If the user didn't set a title, auto-apply the AI's suggestion so the
      // meeting list stops saying "Untitled meeting". If the user typed
      // something, keep it — the suggestion still appears as a "Use" prompt.
      const autoTitle =
        !record.title.trim() && parsed.suggestedTitle
          ? parsed.suggestedTitle
          : record.title;
      const updated: MeetingRecord = {
        ...record,
        title: autoTitle,
        summary: parsed.summary ?? null,
        actionItems: parsed.actionItems ?? [],
        decisions: parsed.decisions ?? [],
        suggestedTitle: parsed.suggestedTitle ?? null,
        suggestedTags: parsed.suggestedTags ?? [],
      };
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

    try {
      const reply = await chatMeeting(
        buildTranscriptText(record),
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
      set((s) => {
        const nextBusy = new Set(s.busy);
        nextBusy.delete(selectedId);
        const nextStream = { ...s.chatStreamText };
        delete nextStream[selectedId];
        return { busy: nextBusy, chatStreamText: nextStream };
      });
    }
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

  // Pull the default mic from Settings if the user hasn't set an override.
  try {
    const prefs = await getPreferences();
    const prefMic = prefs["meeting_mic"] ?? "";
    if (prefMic && !useMeetingsStore.getState().micOverride) {
      // Don't set as override — micOverride means per-meeting override. The
      // fallback ordering (override → pref → system default) is handled at
      // recording start time.
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
}

useMeetingsStore.subscribe((state) => {
  saveCache(MEETINGS_STORE_KEY, serializableState(state));
});

// ── Exported pure helpers (for UI) ───────────────────────────────────────────

export { buildTranscriptText, formatTimestamp };
