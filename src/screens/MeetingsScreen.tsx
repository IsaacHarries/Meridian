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
  Plus,
  Clock,
  Tag as TagIcon,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import {
  createGlobalCommands,
  type SlashCommand,
} from "@/lib/slashCommands";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import {
  listMicrophones,
  type MicrophoneInfo,
  type MeetingRecord,
  type SpeakerCandidate,
} from "@/lib/tauri";
import { getPreferences } from "@/lib/preferences";
import {
  useMeetingsStore,
  formatTimestamp,
} from "@/stores/meetingsStore";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ask } from "@tauri-apps/plugin-dialog";


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
    <div className="h-screen flex flex-col overflow-hidden">
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

          <TagEditor
            tags={isLive ? active.tags : draftTags}
            onChange={setDraftTags}
            disabled={isLive}
          />
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
  const renameSpeaker = useMeetingsStore((s) => s.renameSpeaker);

  // Build a map from raw speaker id (e.g. "SPEAKER_00") to the user-assigned
  // name, so transcript rows can render the friendly label even when the
  // segment only carries the raw id.
  const speakerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const sp of record.speakers ?? []) {
      if (sp.displayName) map.set(sp.id, sp.displayName);
    }
    return map;
  }, [record.speakers]);

  const hasDiarization = (record.speakers?.length ?? 0) > 0;

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
          onClick={async () => {
            const confirmed = await ask(
              "The transcript will be permanently removed.",
              { title: "Delete this meeting?", kind: "warning" },
            );
            if (confirmed) void deleteSelectedMeeting();
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

      <TagEditor
        tags={record.tags}
        onChange={(next) => setMeetingTags(record.id, next)}
      />

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

      {/* Speakers */}
      {hasDiarization && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" /> Speakers
            </h3>
          </div>
          <Card>
            <CardContent className="p-4 space-y-2">
              {(record.speakers ?? []).map((sp) => (
                <SpeakerRow
                  key={sp.id}
                  id={sp.id}
                  displayName={sp.displayName ?? null}
                  candidates={sp.candidates ?? []}
                  onRename={(name) => renameSpeaker(sp.id, name)}
                />
              ))}
            </CardContent>
          </Card>
        </section>
      )}

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
                {record.segments.map((seg, i) => {
                  const label = seg.speakerId
                    ? speakerNameById.get(seg.speakerId) ?? seg.speakerId
                    : null;
                  return (
                    <div key={i} className="flex gap-3">
                      <span className="text-muted-foreground shrink-0 w-12">
                        {formatTimestamp(seg.startSec)}
                      </span>
                      {label && (
                        <span className="shrink-0 w-32 font-semibold text-primary/90 truncate">
                          {label}
                        </span>
                      )}
                      <span className="min-w-0">{seg.text}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function SpeakerRow({
  id,
  displayName,
  candidates,
  onRename,
}: {
  id: string;
  displayName: string | null;
  candidates: SpeakerCandidate[];
  onRename: (name: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(displayName ?? "");
  useEffect(() => setValue(displayName ?? ""), [displayName]);

  // Show the candidate picker when recognition surfaced multiple plausible
  // names and no display name is set yet. Picking one commits via onRename;
  // the backend clears `candidates` on rename so this row collapses back to
  // the plain input afterwards.
  const showPicker = !displayName && candidates.length > 0;

  return (
    <div className="flex items-start gap-3">
      <span className="font-mono text-xs text-muted-foreground w-28 shrink-0 pt-1.5">
        {id}
      </span>
      <div className="flex-1 min-w-0 space-y-1.5">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            const trimmed = value.trim();
            const next = trimmed === "" ? null : trimmed;
            if (next !== displayName) {
              void onRename(next);
            }
          }}
          placeholder={
            showPicker
              ? "Not one of these? Type a name"
              : "Name this speaker (e.g., Isaac)"
          }
          className="h-8 text-sm"
        />
        {showPicker && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">
              Could be:
            </span>
            {candidates.map((c) => (
              <button
                key={c.name}
                onClick={() => void onRename(c.name)}
                className="text-xs px-2 py-0.5 rounded-full border border-input bg-background hover:bg-muted transition-colors"
                title={`similarity ${c.similarity.toFixed(2)}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MeetingChatPanel({ record }: { record: MeetingRecord }) {
  const busy = useMeetingsStore((s) => s.busy);
  const sendChatMessage = useMeetingsStore((s) => s.sendChatMessage);
  const summarizeSelected = useMeetingsStore((s) => s.summarizeSelected);
  const clearSelectedChat = useMeetingsStore((s) => s.clearSelectedChat);
  const dropLastAssistantTurn = useMeetingsStore((s) => s.dropLastAssistantTurn);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const isBusy = busy.has(record.id);
  const history = record.chatHistory ?? [];

  // Auto-scroll to the latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, isBusy]);

  // Resolve speaker id → name for the /speakers output.
  const speakerLines = useMemo(() => {
    const lines: string[] = [];
    for (const sp of record.speakers ?? []) {
      lines.push(
        sp.displayName ? `${sp.id} — ${sp.displayName}` : `${sp.id} (unnamed)`,
      );
    }
    return lines;
  }, [record.speakers]);

  const commands: SlashCommand[] = useMemo(
    () => [
      ...createGlobalCommands({
        history,
        clearHistory: clearSelectedChat,
        sendMessage: sendChatMessage,
        removeLastAssistantMessage: dropLastAssistantTurn,
      }),
      {
        name: "summarize",
        description: "Regenerate this meeting's summary",
        execute: async () => {
          await summarizeSelected();
          toast.success("Regenerating summary…");
        },
      },
      {
        name: "speakers",
        description: "List speakers and any names assigned",
        execute: ({ toast: t }) => {
          if (speakerLines.length === 0) {
            t.info("No speakers have been detected for this meeting");
            return;
          }
          t("Speakers", { description: speakerLines.join("\n") });
        },
      },
      {
        name: "transcript",
        description: "Ask for the full diarized transcript",
        execute: async () => {
          await sendChatMessage(
            "Please provide the full diarized transcript in a readable form, with speaker names where known.",
          );
        },
      },
      {
        name: "actions",
        description: "Ask for just the action items",
        execute: async () => {
          await sendChatMessage(
            "List just the action items from this meeting as a bulleted list, with the owner if mentioned.",
          );
        },
      },
      {
        name: "decisions",
        description: "Ask for just the decisions made",
        execute: async () => {
          await sendChatMessage(
            "List just the decisions that were made during this meeting as a bulleted list.",
          );
        },
      },
      {
        name: "at",
        description: "Focus the next question on a timestamp",
        args: "HH:MM",
        execute: ({ args, setInput }) => {
          const ts = args.trim();
          if (!ts) {
            setInput("/at ");
            return;
          }
          setInput(`At ${ts} — `);
        },
      },
    ],
    [
      history,
      clearSelectedChat,
      sendChatMessage,
      dropLastAssistantTurn,
      summarizeSelected,
      speakerLines,
    ],
  );

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
            action items, or details you want to recall. Type <span className="font-mono">/</span> to see commands.
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
        <SlashCommandInput
          value={input}
          onChange={setInput}
          onSend={async (text) => {
            try {
              await sendChatMessage(text);
            } catch (e) {
              toast.error("Chat failed", { description: String(e) });
            }
          }}
          commands={commands}
          busy={isBusy}
          placeholder="Ask about this meeting. Enter to send. / for commands."
        />
      </div>
    </>
  );
}

// ── Tag editor ───────────────────────────────────────────────────────────────
//
// Renders the union of DEFAULT_TAGS and whatever extra tags the meeting already
// carries, so custom tags stay visible as selectable pills. Custom tags get a
// small red × badge overlapping their top-right corner for deletion (the
// built-in defaults are non-destructive — click the pill to deselect).

function TagEditor({
  tags,
  onChange,
  disabled,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const tagVocab = useMeetingsStore((s) => s.tagVocab);
  const addTagToVocab = useMeetingsStore((s) => s.addTagToVocab);
  const removeTagFromVocab = useMeetingsStore((s) => s.removeTagFromVocab);

  // Pill list = persisted vocab ∪ any tags already on this meeting that
  // aren't in the vocab (e.g. a historical meeting whose tag was later
  // removed from the vocabulary). Preserves vocab order; meeting-only tags
  // are appended.
  const allTags = useMemo(() => {
    const vocabSet = new Set(tagVocab);
    const extras = tags.filter((t) => !vocabSet.has(t));
    return [...tagVocab, ...extras];
  }, [tagVocab, tags]);

  function toggle(tag: string) {
    if (disabled) return;
    const next = tags.includes(tag)
      ? tags.filter((t) => t !== tag)
      : [...tags, tag];
    onChange(next);
  }

  function removePill(tag: string) {
    if (disabled) return;
    // Remove from both the vocab (persisted) and this meeting's selection.
    // Other meetings that still have this tag keep it — they just won't see
    // it as a clickable pill unless they re-add it.
    removeTagFromVocab(tag);
    onChange(tags.filter((t) => t !== tag));
  }

  function addTag(raw: string) {
    const t = raw.trim().toLowerCase();
    if (!t) return;
    addTagToVocab(t);
    if (!tags.includes(t)) onChange([...tags, t]);
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
      {allTags.map((t) => {
        const selected = tags.includes(t);
        return (
          <div key={t} className="relative group">
            <button
              disabled={disabled}
              onClick={() => toggle(t)}
              className={cn(
                "text-xs px-2 py-1 rounded-full border transition-colors",
                selected
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground hover:bg-muted border-input",
                disabled && "opacity-60 cursor-not-allowed",
              )}
            >
              {t}
            </button>
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removePill(t);
                }}
                className="absolute top-0 right-0 translate-x-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-red-500 text-white flex items-center justify-center shadow-sm focus:outline-none focus:ring-1 focus:ring-red-400 opacity-0 group-hover:opacity-40 hover:!opacity-100 transition-opacity duration-150"
              >
                <X className="h-2.5 w-2.5" strokeWidth={3} />
              </button>
            )}
          </div>
        );
      })}
      {!disabled && <AddTagPill onSubmit={addTag} />}
    </div>
  );
}

// "+" pill that animates open into an editable text field. Matches the size
// and rounded-full silhouette of the tag pills so it visually sits with them;
// the inner content swaps between a Plus icon and an input, while the pill
// itself transitions width between a compact ~28px and a roomier ~112px.
function AddTagPill({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    if (value.trim()) onSubmit(value);
    setValue("");
    setEditing(false);
  }

  return (
    <div
      className={cn(
        "h-7 rounded-full border border-input bg-background text-xs transition-all duration-200 ease-out overflow-hidden flex items-center",
        editing ? "w-28" : "w-7 hover:bg-muted cursor-pointer",
      )}
      onClick={() => {
        if (!editing) {
          setEditing(true);
          // Wait for the width transition to begin, then focus the input so
          // the caret lands once the pill has opened.
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setValue("");
              setEditing(false);
            }
          }}
          onBlur={commit}
          placeholder="tag name"
          className="w-full h-full px-3 bg-transparent outline-none placeholder:text-muted-foreground/60"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
          <Plus className="h-3 w-3" strokeWidth={2.5} />
        </div>
      )}
    </div>
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
