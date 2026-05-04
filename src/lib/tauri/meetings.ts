import { invoke } from "@tauri-apps/api/core";
import {
  invokeWithLlmCheck,
  reportPanelUsage,
  reportPanelChatContext,
} from "./core";
import type { SidecarUsage } from "./workflows";

// ── Meetings types ────────────────────────────────────────────────────────────

export interface MicrophoneInfo {
  name: string;
  is_default: boolean;
  sampleRate: number;
  channels: number;
}

export interface WhisperModelStatus {
  id: string;
  downloaded: boolean;
  sizeBytes: number;
}

export interface MeetingSegment {
  startSec: number;
  endSec: number;
  text: string;
  // Populated by the diarization pass. Absent on legacy segments and on
  // meetings that have not been diarized yet.
  speakerId?: string | null;
}

export interface MeetingChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SpeakerCandidate {
  name: string;
  similarity: number;
}

export interface MeetingSpeaker {
  id: string;
  embedding: number[];
  displayName?: string | null;
  candidates?: SpeakerCandidate[];
}

export type MeetingKind = "transcript" | "notes";

export interface PersonSummary {
  name: string;
  summary: string;
  actionItems: string[];
}

export interface MeetingRecord {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  micDeviceName: string;
  model: string;
  tags: string[];
  segments: MeetingSegment[];
  summary: string | null;
  actionItems: string[];
  decisions: string[];
  perPerson: PersonSummary[];
  suggestedTitle: string | null;
  suggestedTags: string[];
  chatHistory: MeetingChatMessage[];
  speakers?: MeetingSpeaker[];
  // `transcript` for live-recorded meetings, `notes` for freeform note-taking.
  // Older on-disk records default to `transcript`.
  kind?: MeetingKind;
  // Freeform notes body for notes-mode meetings. Null/undefined for transcript
  // meetings.
  notes?: string | null;
}

export interface StartMeetingRequest {
  title: string;
  tags: string[];
  micName: string | null;
  modelId: string;
}

export interface StartMeetingResult {
  id: string;
  startedAt: string;
  micDeviceName: string;
  sampleRate: number;
  channels: number;
}

export interface MeetingSummaryJson {
  summary: string;
  actionItems: string[];
  decisions: string[];
  perPerson: PersonSummary[];
  suggestedTitle: string | null;
  suggestedTags: string[];
}

// ── Meetings commands ─────────────────────────────────────────────────────────

export async function listMicrophones(): Promise<MicrophoneInfo[]> {
  return invoke<MicrophoneInfo[]>("list_microphones");
}

export async function listWhisperModels(): Promise<WhisperModelStatus[]> {
  return invoke<WhisperModelStatus[]>("list_whisper_models");
}

export async function downloadWhisperModel(modelId: string): Promise<string> {
  return invoke<string>("download_whisper_model", { modelId });
}

export async function startMeetingRecording(
  req: StartMeetingRequest,
): Promise<StartMeetingResult> {
  return invoke<StartMeetingResult>("start_meeting_recording", { req });
}

export async function pauseMeetingRecording(): Promise<void> {
  return invoke<void>("pause_meeting_recording");
}

export async function resumeMeetingRecording(): Promise<void> {
  return invoke<void>("resume_meeting_recording");
}

export async function stopMeetingRecording(): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("stop_meeting_recording");
}

export async function diarizeMeeting(meetingId: string): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("diarize_meeting", { meetingId });
}

export async function renameMeetingSpeaker(
  meetingId: string,
  speakerId: string,
  displayName: string | null,
): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("rename_meeting_speaker", {
    meetingId,
    speakerId,
    displayName,
  });
}

export async function activeMeetingId(): Promise<string | null> {
  return invoke<string | null>("active_meeting_id");
}

export async function saveMeeting(record: MeetingRecord): Promise<void> {
  return invoke<void>("save_meeting", { record });
}

export async function createNotesMeeting(
  title: string,
  tags: string[],
): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("create_notes_meeting", { title, tags });
}

export async function updateMeetingNotes(
  meetingId: string,
  notes: string,
): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("update_meeting_notes", { meetingId, notes });
}

export async function loadMeeting(id: string): Promise<MeetingRecord> {
  return invoke<MeetingRecord>("load_meeting", { id });
}

export async function listMeetings(): Promise<MeetingRecord[]> {
  return invoke<MeetingRecord[]>("list_meetings");
}

export async function deleteMeeting(id: string): Promise<void> {
  return invoke<void>("delete_meeting", { id });
}

export async function getMeetingsDir(): Promise<string> {
  return invoke<string>("get_meetings_dir");
}

export async function summarizeMeeting(
  transcriptText: string,
  currentTitle: string,
  currentTags: string[],
): Promise<string> {
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_meeting_summary_workflow", {
    transcriptText,
    currentTitle,
    currentTagsJson: JSON.stringify(currentTags),
  });
  reportPanelUsage("meetings", result?.usage);
  return result?.output?.markdown ?? "";
}

export async function generateMeetingTitle(
  contentText: string,
  currentTags: string[],
): Promise<string> {
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_meeting_title_workflow", {
    contentText,
    currentTagsJson: JSON.stringify(currentTags),
  });
  reportPanelUsage("meetings", result?.usage);
  return (result?.output?.markdown ?? "").trim();
}

export async function chatMeeting(
  contextText: string,
  historyJson: string,
): Promise<string> {
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_meeting_chat_workflow", {
    contextText,
    historyJson,
  });
  reportPanelUsage("meetings", result?.usage);
  reportPanelChatContext("meetings", result?.usage);
  return result?.output?.markdown ?? "";
}

// ── Cross-meetings RAG search + chat ─────────────────────────────────────────

/** One hit returned by `searchMeetings`. Mirrors the Rust SegmentHit. */
export interface MeetingSearchHit {
  segmentId: number;
  meetingId: string;
  meetingTitle: string;
  meetingStartedAt: string;
  segmentIdx: number;
  speaker: string | null;
  startMs: number;
  endMs: number;
  text: string;
  matchedKeyword: boolean;
  matchedSemantic: boolean;
  score: number;
}

export interface MeetingSearchResponse {
  hits: MeetingSearchHit[];
  semanticUnavailable: boolean;
  semanticMessage: string | null;
  embeddingModel: string;
}

/** Hybrid keyword + semantic search across every indexed meeting. */
export async function searchMeetings(
  query: string,
  opts?: {
    limit?: number;
    semantic?: boolean;
    /** Minimum fused score (0–1) a hit must clear to be returned.
     *  Filters out the long tail of weakly-similar chunks that
     *  embedding search would otherwise surface as "citations".
     *  Defaults to a sensible value on the Rust side. */
    minScore?: number;
    /** Restrict the search to segments belonging to these meeting ids.
     *  Used by the `#tag` query syntax: the caller resolves tags →
     *  meeting ids client-side, then passes them through so the FTS5 +
     *  cosine queries only consider the right slice of the index. An
     *  empty array yields no results (used to express "this tag has
     *  no meetings"); omit the option entirely to search everything. */
    meetingIds?: string[];
  },
): Promise<MeetingSearchResponse> {
  const raw = await invoke<{
    hits: Array<{
      segment_id: number;
      meeting_id: string;
      meeting_title: string;
      meeting_started_at: string;
      segment_idx: number;
      speaker: string | null;
      start_ms: number;
      end_ms: number;
      text: string;
      matched_keyword: boolean;
      matched_semantic: boolean;
      score: number;
    }>;
    semantic_unavailable: boolean;
    semantic_message: string | null;
    embedding_model: string;
  }>("search_meetings", {
    query,
    limit: opts?.limit,
    semantic: opts?.semantic,
    minScore: opts?.minScore,
    meetingIds: opts?.meetingIds,
  });
  return {
    hits: raw.hits.map((h) => ({
      segmentId: h.segment_id,
      meetingId: h.meeting_id,
      meetingTitle: h.meeting_title,
      meetingStartedAt: h.meeting_started_at,
      segmentIdx: h.segment_idx,
      speaker: h.speaker,
      startMs: h.start_ms,
      endMs: h.end_ms,
      text: h.text,
      matchedKeyword: h.matched_keyword,
      matchedSemantic: h.matched_semantic,
      score: h.score,
    })),
    semanticUnavailable: raw.semantic_unavailable,
    semanticMessage: raw.semantic_message,
    embeddingModel: raw.embedding_model,
  };
}

/** Cross-meetings RAG chat. Pre-pass retrieval lives in Rust; this
 *  wrapper just relays the hits + history to the sidecar workflow. */
export async function chatCrossMeetings(
  hits: MeetingSearchHit[],
  historyJson: string,
  semanticAvailable: boolean,
): Promise<string> {
  // Convert to the snake_case shape the Rust command expects (and
  // which forwards verbatim to the sidecar's Zod schema).
  const contextHits = hits.map((h) => ({
    segmentId: h.segmentId,
    meetingId: h.meetingId,
    meetingTitle: h.meetingTitle,
    meetingStartedAt: h.meetingStartedAt,
    speaker: h.speaker,
    startMs: h.startMs,
    endMs: h.endMs,
    text: h.text,
  }));
  const result = await invokeWithLlmCheck<{
    output?: { markdown?: string } | null;
    usage?: SidecarUsage;
  }>("run_cross_meetings_chat_workflow", {
    contextHits,
    historyJson,
    semanticAvailable,
  });
  reportPanelUsage("meetings", result?.usage);
  reportPanelChatContext("meetings", result?.usage);
  return result?.output?.markdown ?? "";
}

export interface MeetingsIndexStatus {
  totalSegments: number;
  embeddedSegments: number;
  meetingsIndexed: number;
}

export async function getMeetingsIndexStatus(): Promise<MeetingsIndexStatus> {
  const raw = await invoke<{
    total_segments: number;
    embedded_segments: number;
    meetings_indexed: number;
  }>("meetings_index_status");
  return {
    totalSegments: raw.total_segments,
    embeddedSegments: raw.embedded_segments,
    meetingsIndexed: raw.meetings_indexed,
  };
}

export async function reindexAllMeetings(): Promise<number> {
  return invoke<number>("reindex_all_meetings");
}

export async function clearMeetingsEmbeddings(): Promise<void> {
  return invoke<void>("clear_meetings_embeddings");
}
