import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Mic,
  Play,
  Pause,
  Square,
  Sparkles,
  Loader2,
  Trash2,
  Send,
  Plus,
  Clock,
  Tag as TagIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import {
  listMicrophones,
  type MicrophoneInfo,
  type MeetingRecord,
} from "@/lib/tauri";
import { getPreferences } from "@/lib/preferences";
import {
  useMeetingsStore,
  formatTimestamp,
} from "@/stores/meetingsStore";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const DEFAULT_TAGS = ["standup", "planning", "retro", "1:1", "other"];

interface MeetingsScreenProps {
  onBack: () => void;
}

export function MeetingsScreen({ onBack }: MeetingsScreenProps) {
  const meetings = useMeetingsStore((s) => s.meetings);
  const listLoaded = useMeetingsStore((s) => s.listLoaded);
  const selectedId = useMeetingsStore((s) => s.selectedId);
  const active = useMeetingsStore((s) => s.active);
  const loadMeetingsList = useMeetingsStore((s) => s.loadMeetingsList);
  const selectMeeting = useMeetingsStore((s) => s.selectMeeting);
  const refreshWhisperModels = useMeetingsStore((s) => s.refreshWhisperModels);

  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!listLoaded) loadMeetingsList();
    refreshWhisperModels();
  }, [listLoaded, loadMeetingsList, refreshWhisperModels]);

  const selected = useMemo(
    () => meetings.find((m) => m.id === selectedId) ?? null,
    [meetings, selectedId],
  );

  // If a recording becomes active mid-session, flip to the creating view.
  useEffect(() => {
    if (active) setCreating(true);
  }, [active]);

  return (
    <div className="min-h-screen flex flex-col">
      <WorkflowPanelHeader
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className={APP_HEADER_TITLE}>Transcribe Meeting</h1>
          </>
        }
      />

      <div className="flex flex-1 min-h-0">
        {/* List pane */}
        <aside className="w-80 shrink-0 border-r flex flex-col bg-background/60">
          <div className="p-3 border-b">
            <Button
              className="w-full"
              onClick={() => {
                selectMeeting(null);
                setCreating(true);
              }}
              disabled={!!active && !creating}
            >
              <Plus className="h-4 w-4 mr-1.5" />
              New meeting
            </Button>
          </div>
          <MeetingsList
            meetings={meetings}
            listLoaded={listLoaded}
            selectedId={selectedId}
            active={active}
            onSelect={(id) => {
              setCreating(false);
              selectMeeting(id);
            }}
          />
        </aside>

        {/* Detail + chat pane */}
        <div className="flex-1 min-w-0 flex min-h-0">
          <main className="flex-1 min-w-0 overflow-y-auto">
            {active || creating ? (
              <ActiveRecordingView onStopped={() => setCreating(false)} />
            ) : selected ? (
              <MeetingDetailView record={selected} />
            ) : (
              <EmptyState />
            )}
          </main>
          {selected && !(active || creating) && selected.segments.length > 0 && (
            <aside className="w-[420px] shrink-0 border-l bg-background/40 flex flex-col min-h-0">
              <MeetingChatPanel record={selected} />
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Meeting list ─────────────────────────────────────────────────────────────

function MeetingsList({
  meetings,
  listLoaded,
  selectedId,
  active,
  onSelect,
}: {
  meetings: MeetingRecord[];
  listLoaded: boolean;
  selectedId: string | null;
  active: ReturnType<typeof useMeetingsStore.getState>["active"];
  onSelect: (id: string) => void;
}) {
  if (!listLoaded) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (meetings.length === 0 && !active) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 px-4 text-center text-sm text-muted-foreground">
        <Mic className="h-8 w-8 text-muted-foreground/60" />
        <p>No meetings yet.</p>
        <p className="text-xs">Click "New meeting" to start recording.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {active && (
        <button
          className={cn(
            "w-full text-left px-3 py-2.5 border-b flex items-center gap-2 bg-red-500/10 hover:bg-red-500/15",
          )}
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">
              {active.title || "Untitled meeting"}
            </p>
            <p className="text-xs text-muted-foreground">
              {active.state === "recording" ? "Recording" : "Paused"} —{" "}
              {formatTimestamp(active.elapsedSec)}
            </p>
          </div>
        </button>
      )}
      {meetings.map((m) => (
        <button
          key={m.id}
          onClick={() => onSelect(m.id)}
          className={cn(
            "w-full text-left px-3 py-2.5 border-b hover:bg-muted/50 transition-colors",
            selectedId === m.id && "bg-muted",
          )}
        >
          <p className="text-sm font-medium truncate">
            {m.title || "Untitled meeting"}
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
            <Clock className="h-3 w-3" />
            <span>{formatDate(m.startedAt)}</span>
            <span>·</span>
            <span>{formatDuration(m.durationSec)}</span>
          </div>
          {m.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {m.tags.map((t) => (
                <Badge
                  key={t}
                  variant="secondary"
                  className="text-[10px] py-0 px-1.5"
                >
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-3">
      <div className="rounded-full bg-muted p-4">
        <Mic className="h-7 w-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Record and transcribe meetings</h2>
        <p className="text-sm text-muted-foreground max-w-md">
          Audio is transcribed locally using whisper. Nothing is uploaded — the
          audio is never written to disk, only the transcription. Start a new
          meeting or select a past meeting from the list.
        </p>
      </div>
    </div>
  );
}

// ── Active recording view ────────────────────────────────────────────────────

function ActiveRecordingView({ onStopped }: { onStopped: () => void }) {
  const active = useMeetingsStore((s) => s.active);
  const draftTitle = useMeetingsStore((s) => s.draftTitle);
  const draftTags = useMeetingsStore((s) => s.draftTags);
  const setDraftTitle = useMeetingsStore((s) => s.setDraftTitle);
  const setDraftTags = useMeetingsStore((s) => s.setDraftTags);
  const startRecording = useMeetingsStore((s) => s.startRecording);
  const pauseRecording = useMeetingsStore((s) => s.pauseRecording);
  const resumeRecording = useMeetingsStore((s) => s.resumeRecording);
  const stopRecording = useMeetingsStore((s) => s.stopRecording);
  const whisperModels = useMeetingsStore((s) => s.whisperModels);

  const [mics, setMics] = useState<MicrophoneInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("base.en");
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listMicrophones().then(setMics).catch(() => {});
    getPreferences().then((prefs) => {
      if (prefs["meeting_mic"]) setSelectedMic(prefs["meeting_mic"]);
      if (prefs["meeting_whisper_model"]) setSelectedModel(prefs["meeting_whisper_model"]);
    });
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [active?.segments.length]);

  const modelDownloaded = whisperModels.find((m) => m.id === selectedModel)?.downloaded ?? false;

  async function handleStart() {
    if (!modelDownloaded) {
      toast.error("Whisper model not downloaded", {
        description: `Download ${selectedModel} in Settings → Meetings before starting.`,
      });
      return;
    }
    setStarting(true);
    try {
      await startRecording(selectedModel, selectedMic || null);
    } catch (e) {
      toast.error("Failed to start recording", { description: String(e) });
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      const record = await stopRecording();
      if (record) {
        toast.success(`Saved meeting — ${formatDuration(record.durationSec)}`);
      }
      onStopped();
    } catch (e) {
      toast.error("Failed to stop", { description: String(e) });
    } finally {
      setStopping(false);
    }
  }

  const isLive = !!active;
  const state = active?.state ?? "idle";

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-3">
          <Input
            value={isLive ? active.title : draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            disabled={isLive}
            placeholder="Meeting title (e.g., Sprint planning)"
            className="text-lg font-semibold h-10"
          />

          <div className="flex items-center gap-2 flex-wrap">
            <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
            {DEFAULT_TAGS.map((t) => {
              const activeTags = isLive ? active.tags : draftTags;
              const selected = activeTags.includes(t);
              return (
                <button
                  key={t}
                  disabled={isLive}
                  onClick={() => {
                    if (isLive) return;
                    setDraftTags(
                      selected
                        ? draftTags.filter((x) => x !== t)
                        : [...draftTags, t],
                    );
                  }}
                  className={cn(
                    "text-xs px-2 py-1 rounded-full border transition-colors",
                    selected
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground hover:bg-muted border-input",
                    isLive && "opacity-60 cursor-not-allowed",
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Device + model (editable before starting) */}
      {!isLive && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Microphone</label>
                <select
                  value={selectedMic}
                  onChange={(e) => setSelectedMic(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— System default —</option>
                  {mics.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                      {m.is_default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Whisper model</label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {whisperModels.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.downloaded}>
                      {m.id} {m.downloaded ? "" : "(not downloaded)"}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {!modelDownloaded && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Download the {selectedModel} model from Settings → Meetings before starting.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Control bar */}
      <div className="flex items-center gap-3">
        {!isLive ? (
          <Button onClick={handleStart} disabled={starting || !modelDownloaded} size="lg">
            {starting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Start recording
          </Button>
        ) : (
          <>
            {state === "recording" ? (
              <Button variant="outline" onClick={pauseRecording}>
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </Button>
            ) : (
              <Button variant="outline" onClick={resumeRecording}>
                <Play className="h-4 w-4 mr-2" />
                Resume
              </Button>
            )}
            <Button
              variant="destructive"
              onClick={handleStop}
              disabled={stopping || state === "stopping"}
            >
              {stopping ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Square className="h-4 w-4 mr-2" />
              )}
              Stop & save
            </Button>
            <div className="flex items-center gap-2 ml-auto">
              {state === "recording" && (
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
              )}
              <span className="font-mono text-sm text-muted-foreground">
                {formatTimestamp(active.elapsedSec)}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Transcript */}
      <Card className="h-[500px] flex flex-col">
        <CardContent className="p-4 flex-1 flex flex-col min-h-0">
          <div className="text-xs text-muted-foreground mb-2 flex items-center justify-between">
            <span>Live transcript</span>
            {isLive && active.segments.length > 0 && (
              <span>{active.segments.length} segments</span>
            )}
          </div>
          <div
            ref={transcriptRef}
            className="flex-1 overflow-y-auto space-y-2 font-mono text-sm rounded-md bg-muted/40 p-3"
          >
            {!isLive ? (
              <p className="text-xs text-muted-foreground italic">
                Transcript will appear here in ~10-second chunks as you speak.
              </p>
            ) : active.segments.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                Listening... first segment arrives after ~10 seconds.
              </p>
            ) : (
              active.segments.map((seg, i) => (
                <div key={i} className="flex gap-3">
                  <span className="text-muted-foreground shrink-0">
                    {formatTimestamp(seg.startSec)}
                  </span>
                  <span>{seg.text}</span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Past meeting detail view ─────────────────────────────────────────────────

function MeetingDetailView({ record }: { record: MeetingRecord }) {
  const busy = useMeetingsStore((s) => s.busy);
  const summarizeSelected = useMeetingsStore((s) => s.summarizeSelected);
  const renameMeeting = useMeetingsStore((s) => s.renameMeeting);
  const setMeetingTags = useMeetingsStore((s) => s.setMeetingTags);
  const deleteSelectedMeeting = useMeetingsStore((s) => s.deleteSelectedMeeting);

  const [title, setTitle] = useState(record.title);
  const isBusy = busy.has(record.id);

  // Keep local title synced if the record changes (e.g. after summary rename)
  useEffect(() => {
    setTitle(record.title);
  }, [record.id, record.title]);

  async function saveTitleIfChanged() {
    if (title.trim() && title !== record.title) {
      await renameMeeting(record.id, title.trim());
    }
  }

  function toggleTag(tag: string) {
    const next = record.tags.includes(tag)
      ? record.tags.filter((t) => t !== tag)
      : [...record.tags, tag];
    setMeetingTags(record.id, next);
  }

  const hasSummary = !!record.summary || record.actionItems.length > 0 || record.decisions.length > 0;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div className="flex items-start gap-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitleIfChanged}
          placeholder={isBusy ? "Generating title…" : "Untitled meeting"}
          className="text-lg font-semibold h-10"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (confirm("Delete this meeting? The transcript will be permanently removed.")) {
              deleteSelectedMeeting();
            }
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
        <span>{formatDate(record.startedAt)}</span>
        <span>·</span>
        <span>{formatDuration(record.durationSec)}</span>
        <span>·</span>
        <span className="font-mono">{record.model}</span>
        <span>·</span>
        <span>{record.micDeviceName}</span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
        {DEFAULT_TAGS.map((t) => {
          const selected = record.tags.includes(t);
          return (
            <button
              key={t}
              onClick={() => toggleTag(t)}
              className={cn(
                "text-xs px-2 py-1 rounded-full border transition-colors",
                selected
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground hover:bg-muted border-input",
              )}
            >
              {t}
            </button>
          );
        })}
      </div>

      {record.suggestedTitle &&
        record.title.trim() &&
        record.suggestedTitle !== record.title && (
          <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">AI-suggested title:</span>
            <span className="font-medium">{record.suggestedTitle}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2"
              onClick={() => {
                setTitle(record.suggestedTitle!);
                renameMeeting(record.id, record.suggestedTitle!);
              }}
            >
              Use
            </Button>
          </div>
        )}

      {/* Summary */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Summary
          </h3>
          {hasSummary && (
            <Button
              variant="ghost"
              size="sm"
              onClick={summarizeSelected}
              disabled={isBusy}
              className="h-7"
            >
              {isBusy ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              )}
              Regenerate
            </Button>
          )}
        </div>
        {!hasSummary ? (
          <Card>
            <CardContent className="p-6 flex flex-col items-center text-center gap-3">
              <Sparkles className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {isBusy
                  ? "Generating summary…"
                  : record.segments.length === 0
                    ? "No transcript available to summarise."
                    : "Summary runs automatically after a meeting ends."}
              </p>
              {!isBusy && record.segments.length > 0 && (
                <Button onClick={summarizeSelected} size="sm">
                  <Sparkles className="h-4 w-4 mr-2" />
                  Generate summary
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {record.summary && (
              <Card>
                <CardContent className="p-4 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Overview</p>
                  <p className="text-sm whitespace-pre-wrap">{record.summary}</p>
                </CardContent>
              </Card>
            )}
            {record.decisions.length > 0 && (
              <Card>
                <CardContent className="p-4 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Decisions</p>
                  <ul className="list-disc list-inside space-y-1 text-sm">
                    {record.decisions.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
            {record.actionItems.length > 0 && (
              <Card>
                <CardContent className="p-4 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Action items</p>
                  <ul className="list-disc list-inside space-y-1 text-sm">
                    {record.actionItems.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </section>

      {/* Transcript */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Transcript
        </h3>
        <Card>
          <CardContent className="p-4">
            {record.segments.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No transcript was captured for this meeting.
              </p>
            ) : (
              <div className="space-y-2 font-mono text-sm">
                {record.segments.map((seg, i) => (
                  <div key={i} className="flex gap-3">
                    <span className="text-muted-foreground shrink-0">
                      {formatTimestamp(seg.startSec)}
                    </span>
                    <span>{seg.text}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function MeetingChatPanel({ record }: { record: MeetingRecord }) {
  const busy = useMeetingsStore((s) => s.busy);
  const sendChatMessage = useMeetingsStore((s) => s.sendChatMessage);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const isBusy = busy.has(record.id);
  const history = record.chatHistory ?? [];

  // Auto-scroll to the latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, isBusy]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isBusy) return;
    setInput("");
    try {
      await sendChatMessage(text);
    } catch (e) {
      toast.error("Chat failed", { description: String(e) });
    }
  }

  return (
    <>
      <div className="shrink-0 px-4 py-2.5 border-b flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Ask about this meeting
        </p>
        {isBusy && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground italic text-center pt-6">
            Ask anything about this meeting — what was discussed, decisions made,
            action items, or details you want to recall.
          </p>
        ) : (
          history.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "flex",
                msg.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}
        {isBusy && (
          <div className="flex justify-start pt-1">
            <div className="bg-muted rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2 border-t">
        <div className="flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={2}
            placeholder="Ask about this meeting. ⌘↵ to send."
            className="resize-none text-sm"
            disabled={isBusy}
          />
          <Button onClick={handleSend} disabled={isBusy || !input.trim()} size="sm">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
