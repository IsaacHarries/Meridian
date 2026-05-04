/**
 * Module-level subscribers and one-shot bootstrapping for the Meetings
 * store: live segment / status / model-download event listeners, the
 * 1Hz elapsed-time ticker, the cache subscription that mirrors the
 * persisted draft slice to disk, and `hydrateMeetingsStore()` which
 * reads cache + preferences back into the store at startup.
 *
 * Importing this module has side effects (it calls `ensureTicker()` and
 * registers the cache subscription). The barrel re-export at
 * `@/stores/meetingsStore` pulls it in for that purpose.
 */

import { getPreferences } from "@/lib/preferences";
import { loadCache, saveCache } from "@/lib/storeCache";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { activeMeetingId } from "@/lib/tauri/meetings";
import {
    MEETINGS_STORE_KEY,
    NEW_MEETING_MODE_PREF_KEY,
    NOTES_LINE_HEIGHT_PREF_KEY,
    TAG_TEMPLATES_PREF_KEY,
    TAG_VOCAB_PREF_KEY,
    TRANSCRIPTION_DISABLED_PREF_KEY,
} from "./constants";
import { useMeetingsStore } from "./store";
import type { MeetingsState, RecordingState } from "./types";

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
