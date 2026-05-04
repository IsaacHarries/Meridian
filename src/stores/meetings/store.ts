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

import { participantsForMeeting } from "@/lib/meetingPeople";
import { setPreference } from "@/lib/preferences";
import {
    meetingMatchesNames,
    meetingMatchesTags,
    parseTaggedQuery,
} from "@/lib/taggedQuery";
import { extractTiptapPlainText } from "@/lib/tiptapText";
import { subscribeWorkflowStream } from "@/lib/workflowStream";
import { useTokenUsageStore } from "@/stores/tokenUsageStore";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { currentModelKeyFor } from "@/lib/tauri/core";
import { type MeetingChatMessage, type MeetingRecord, type MeetingSummaryJson, chatCrossMeetings, chatMeeting, createNotesMeeting as createNotesMeetingCmd, deleteMeeting, diarizeMeeting, downloadWhisperModel, generateMeetingTitle, listMeetings, listWhisperModels, loadMeeting, pauseMeetingRecording, renameMeetingSpeaker, resumeMeetingRecording, saveMeeting, searchMeetings, startMeetingRecording, stopMeetingRecording, summarizeMeeting, updateMeetingNotes } from "@/lib/tauri/meetings";
import { parseAgentJson } from "@/lib/tauri/workflows";
import {
    DEFAULT_NEW_MEETING_MODE,
    DEFAULT_NOTES_LINE_HEIGHT,
    DEFAULT_TAG_VOCAB,
    NEW_MEETING_MODE_PREF_KEY,
    NOTES_LINE_HEIGHT_PREF_KEY,
    TAG_TEMPLATES_PREF_KEY,
    TAG_VOCAB_PREF_KEY,
    TRANSCRIPTION_DISABLED_PREF_KEY,
} from "./constants";
import {
    buildAgentInputText,
    normalizeTag,
    replaceOrInsert,
} from "./helpers";
import type { MeetingsState } from "./types";

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
    // Tags must be single tokens (no whitespace) so `#tag` query syntax
    // can rely on a simple word-boundary parser.
    const normalized = normalizeTag(tag);
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
    // Switching meetings swaps the visible chat to the new record's
    // own history, so the previous meeting's recorded chat-context
    // size no longer represents what's on screen. Reset it.
    useTokenUsageStore.getState().clearPanelChatLastInput("meetings");
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
      data?: {
        partial?: Partial<MeetingSummaryJson>;
        usagePartial?: { inputTokens?: number; outputTokens?: number };
      };
    }>("meeting-summary-workflow-event", (event) => {
      if (event.payload.kind !== "progress") return;
      const usagePartial = event.payload.data?.usagePartial;
      if (usagePartial && typeof usagePartial === "object") {
        useTokenUsageStore
          .getState()
          .setCurrentCallUsage(
            "meetings",
            {
              inputTokens: usagePartial.inputTokens ?? 0,
              outputTokens: usagePartial.outputTokens ?? 0,
            },
            currentModelKeyFor("meetings"),
          );
        return;
      }
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
      {
        onUsage: (usage) =>
          useTokenUsageStore
            .getState()
            .setCurrentCallUsage(
              "meetings",
              usage,
              currentModelKeyFor("meetings"),
            ),
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

  sendCrossMeetingsSearch: async (query) => {
    const { selectedId, meetings } = get();
    if (!selectedId) return;
    const record = meetings.find((m) => m.id === selectedId);
    if (!record) return;
    const trimmed = query.trim();
    if (!trimmed) return;

    // Pull `#tag` and `@name` filters out of the query. The residual
    // is what the hybrid retrieval actually searches for; the filters
    // narrow the meeting universe.
    const { tags, names, residual } = parseTaggedQuery(trimmed);
    const hasFilter = tags.length > 0 || names.length > 0;
    const meetingIds = hasFilter
      ? meetings
          .filter(
            (m) =>
              meetingMatchesTags(m.tags, tags) &&
              meetingMatchesNames(participantsForMeeting(m), names),
          )
          .map((m) => m.id)
      : undefined;

    const userMsg: MeetingChatMessage = {
      role: "user",
      content: `/search ${trimmed}`,
    };
    const nextHistory: MeetingChatMessage[] = [
      ...(record.chatHistory ?? []),
      userMsg,
    ];
    const optimistic = { ...record, chatHistory: nextHistory };
    set((s) => ({
      meetings: replaceOrInsert(s.meetings, optimistic),
      busy: new Set(s.busy).add(selectedId),
    }));

    try {
      let assistantContent: string;
      const filterTokens = [
        ...tags.map((t) => `#${t}`),
        ...names.map((n) => `@${n}`),
      ];
      if (!residual) {
        assistantContent = hasFilter
          ? `Add a query alongside ${filterTokens.map((t) => `\`${t}\``).join(" ")}, e.g. \`/search ${filterTokens[0]} what was decided\`.`
          : "Add a query after `/search`.";
      } else if (meetingIds && meetingIds.length === 0) {
        assistantContent = `No meetings match ${filterTokens.map((t) => `\`${t}\``).join(" ")}.`;
      } else {
        const search = await searchMeetings(residual, { limit: 16, meetingIds });
        if (search.hits.length === 0) {
          assistantContent = hasFilter
            ? `No matches in ${meetingIds!.length} filtered meeting${meetingIds!.length === 1 ? "" : "s"}. Try rephrasing or removing a filter.`
            : "No matches across your indexed meetings. Try rephrasing, or lower the relevance threshold in Settings → Meetings.";
        } else {
          const reply = await chatCrossMeetings(
            search.hits,
            JSON.stringify(nextHistory),
            !search.semanticUnavailable,
          );
          assistantContent = reply.trim();
          if (search.semanticUnavailable) {
            const note =
              search.semanticMessage ??
              "Semantic search unavailable — keyword matches only.";
            assistantContent = `${assistantContent}\n\n_${note}_`;
          }
        }
      }
      const assistantMsg: MeetingChatMessage = {
        role: "assistant",
        content: assistantContent,
      };
      const finalHistory = [...nextHistory, assistantMsg];
      const updated: MeetingRecord = { ...record, chatHistory: finalHistory };
      await saveMeeting(updated);
      set((s) => ({ meetings: replaceOrInsert(s.meetings, updated) }));
    } finally {
      set((s) => {
        const nextBusy = new Set(s.busy);
        nextBusy.delete(selectedId);
        return { busy: nextBusy };
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
    useTokenUsageStore.getState().clearPanelChatLastInput("meetings");
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
