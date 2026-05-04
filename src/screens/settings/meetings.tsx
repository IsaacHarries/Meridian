import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getPreferences, setPreference } from "@/lib/preferences";
import { listMicrophones, type MicrophoneInfo } from "@/lib/tauri/meetings";
import { useMeetingsStore } from "@/stores/meetings/store";
import {
    AlertCircle,
    CheckCircle,
    Download,
    Loader2,
    Mic,
    RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type SectionStatus } from "./_shared";

const WHISPER_MODEL_META: Record<
  string,
  { label: string; sizeHuman: string; note: string }
> = {
  "tiny.en": {
    label: "tiny.en",
    sizeHuman: "~75 MB",
    note: "Fastest, lowest accuracy",
  },
  "base.en": {
    label: "base.en",
    sizeHuman: "~140 MB",
    note: "Recommended default",
  },
  "small.en": {
    label: "small.en",
    sizeHuman: "~470 MB",
    note: "Better accuracy",
  },
  "medium.en": {
    label: "medium.en",
    sizeHuman: "~1.5 GB",
    note: "Highest accuracy, slow on CPU",
  },
};

function humanBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function MeetingsSection() {
  const [mics, setMics] = useState<MicrophoneInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("base.en");
  const [micStatus, setMicStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [modelStatus, setModelStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });

  const whisperModels = useMeetingsStore((s) => s.whisperModels);
  const modelProgress = useMeetingsStore((s) => s.modelProgress);
  const refreshWhisperModels = useMeetingsStore((s) => s.refreshWhisperModels);
  const startModelDownload = useMeetingsStore((s) => s.startModelDownload);
  const transcriptionDisabled = useMeetingsStore(
    (s) => s.transcriptionDisabled,
  );
  const setTranscriptionDisabled = useMeetingsStore(
    (s) => s.setTranscriptionDisabled,
  );

  useEffect(() => {
    // Skip mic enumeration entirely while transcription is disabled — even
    // listing devices can prompt for the macOS mic permission on some setups,
    // and the user has explicitly opted out of that flow.
    if (transcriptionDisabled) return;
    getPreferences().then((prefs) => {
      if (prefs["meeting_mic"]) setSelectedMic(prefs["meeting_mic"]);
      if (prefs["meeting_whisper_model"])
        setSelectedModel(prefs["meeting_whisper_model"]);
    });
    listMicrophones()
      .then((list) => setMics(list))
      .catch((e) => setMicStatus({ state: "error", message: String(e) }));
    refreshWhisperModels();
  }, [refreshWhisperModels, transcriptionDisabled]);

  async function saveMic(next: string) {
    setSelectedMic(next);
    setMicStatus({ state: "loading", message: "" });
    try {
      await setPreference("meeting_mic", next);
      setMicStatus({ state: "success", message: "Saved" });
    } catch (e) {
      setMicStatus({ state: "error", message: String(e) });
    }
  }

  async function saveModel(next: string) {
    setSelectedModel(next);
    setModelStatus({ state: "loading", message: "" });
    try {
      await setPreference("meeting_whisper_model", next);
      setModelStatus({ state: "success", message: "Saved" });
    } catch (e) {
      setModelStatus({ state: "error", message: String(e) });
    }
  }

  async function handleDownload(modelId: string) {
    setModelStatus({ state: "loading", message: `Downloading ${modelId}...` });
    try {
      await startModelDownload(modelId);
      setModelStatus({ state: "success", message: `Downloaded ${modelId}` });
    } catch (e) {
      setModelStatus({ state: "error", message: String(e) });
    }
  }

  async function refreshMics() {
    setMicStatus({ state: "loading", message: "" });
    try {
      const list = await listMicrophones();
      setMics(list);
      setMicStatus({ state: "idle", message: "" });
    } catch (e) {
      setMicStatus({ state: "error", message: String(e) });
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Transcription</CardTitle>
          <CardDescription>
            Disable to hide all audio-recording entry points across the app —
            useful when company policy forbids recording meetings. You can still
            create freeform notes meetings from the Meetings panel and run AI
            summaries on them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <Label
              htmlFor="meeting-transcription-disabled"
              className="font-normal"
            >
              Disable meeting transcription
            </Label>
            <Switch
              id="meeting-transcription-disabled"
              checked={transcriptionDisabled}
              onCheckedChange={setTranscriptionDisabled}
            />
          </div>
        </CardContent>
      </Card>

      {transcriptionDisabled ? null : (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Mic className="h-4 w-4" /> Microphone
              </CardTitle>
              <CardDescription>
                Default input device for live meeting transcription. You can
                override this per meeting from the Meetings screen.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="meeting-mic">Input device</Label>
                <div className="flex gap-2">
                  <select
                    id="meeting-mic"
                    value={selectedMic}
                    onChange={(e) => saveMic(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">— System default —</option>
                    {mics.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                        {m.is_default ? " (default)" : ""} — {m.sampleRate}Hz
                        {m.channels > 1 ? ` / ${m.channels}ch` : ""}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={refreshMics}
                    title="Re-enumerate devices"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {mics.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No input devices found. If this is your first use, macOS will
                  prompt for microphone permission when you start a meeting.
                </p>
              )}
              {micStatus.state === "success" && (
                <p className="text-xs text-emerald-600 flex items-center gap-1">
                  <CheckCircle className="h-3 w-3" /> {micStatus.message}
                </p>
              )}
              {micStatus.state === "error" && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> {micStatus.message}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Whisper Model</CardTitle>
              <CardDescription>
                Local speech-to-text model. Downloaded from HuggingFace and
                stored under <span className="font-mono">models/whisper/</span>{" "}
                in your data directory. Audio is never written to disk — only
                the transcription is saved.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="whisper-model">Active model</Label>
                <select
                  id="whisper-model"
                  value={selectedModel}
                  onChange={(e) => saveModel(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {Object.entries(WHISPER_MODEL_META).map(([id, meta]) => (
                    <option key={id} value={id}>
                      {meta.label} — {meta.sizeHuman} — {meta.note}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                {whisperModels.map((m) => {
                  const meta = WHISPER_MODEL_META[m.id];
                  const progress = modelProgress[m.id];
                  const downloading = !!progress && !progress.done;
                  const pct =
                    progress && progress.total > 0
                      ? Math.min(
                          100,
                          Math.floor(
                            (progress.downloaded / progress.total) * 100,
                          ),
                        )
                      : 0;
                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {meta?.label ?? m.id}
                          </span>
                          {m.downloaded && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] py-0 px-1.5"
                            >
                              Downloaded
                            </Badge>
                          )}
                        </div>
                        <p className="text-muted-foreground">
                          {m.downloaded
                            ? humanBytes(m.sizeBytes)
                            : downloading
                              ? `${pct}% — ${humanBytes(progress.downloaded)} / ${humanBytes(progress.total)}`
                              : (meta?.sizeHuman ?? "")}
                        </p>
                      </div>
                      {!m.downloaded && !downloading && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDownload(m.id)}
                        >
                          <Download className="h-3.5 w-3.5 mr-1.5" />
                          Download
                        </Button>
                      )}
                      {downloading && (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      )}
                    </div>
                  );
                })}
              </div>
              {modelStatus.state === "success" && (
                <p className="text-xs text-emerald-600 flex items-center gap-1">
                  <CheckCircle className="h-3 w-3" /> {modelStatus.message}
                </p>
              )}
              {modelStatus.state === "error" && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> {modelStatus.message}
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
