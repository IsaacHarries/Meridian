import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getPreferences } from "@/lib/preferences";
import { listMicrophones, type MicrophoneInfo } from "@/lib/tauri/meetings";
import { formatTimestamp } from "@/stores/meetings/helpers";
import { useMeetingsStore } from "@/stores/meetings/store";
import {
    Loader2,
    Pause,
    Play,
    Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatDuration } from "./_shared";
import { TagEditor } from "./tag-editor";

export function ActiveRecordingView({ onStopped }: { onStopped: () => void }) {
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
    <div className="max-w-4xl mx-auto p-6 space-y-6 h-full flex flex-col">
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
            Start Transcribing
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
      <Card className="flex-1 min-h-0 flex flex-col">
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
