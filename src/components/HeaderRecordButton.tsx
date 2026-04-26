import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, Square, ExternalLink, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useMeetingsStore,
  formatTimestamp,
} from "@/stores/meetingsStore";
import { useOpenMeetings } from "@/context/OpenMeetingsContext";
import { useRecordingContextTags } from "@/context/RecordingContextTagsContext";
import { getPreferences } from "@/lib/preferences";

function LiveTranscribeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M32.7554,34.8415H8.1671A2.7945,2.7945,0,0,1,5.3727,32.047V8.2944A2.7944,2.7944,0,0,1,8.1671,5.5H22.531Z" />
      <path d="M25.2,13.1585H39.8329a2.7945,2.7945,0,0,1,2.7944,2.7945V39.7056A2.7944,2.7944,0,0,1,39.8329,42.5H25.469L22.8,34.8414" />
      <line x1="32.7554" y1="34.8415" x2="25.469" y2="42.5" />
      <path d="M16.0441,11.0706h0a3.96,3.96,0,0,1,3.96,3.96v4.8958a3.96,3.96,0,0,1-3.96,3.96h0a3.96,3.96,0,0,1-3.96-3.96h0V15.0307a3.96,3.96,0,0,1,3.96-3.96Z" />
      <path d="M9.4018,21.1048a6.7645,6.7645,0,0,0,13.2847,0" />
      <line x1="16.0441" y1="26.5891" x2="16.0441" y2="29.9251" />
      <line x1="27.9687" y1="21.1048" x2="39.2192" y2="21.1048" />
      <line x1="31.3835" y1="30.9044" x2="39.2192" y2="30.9044" />
      <line x1="29.7307" y1="26.0046" x2="39.2192" y2="26.0046" />
    </svg>
  );
}

export function HeaderRecordButton({ className }: { className?: string }) {
  const active = useMeetingsStore((s) => s.active);
  const whisperModels = useMeetingsStore((s) => s.whisperModels);
  const refreshWhisperModels = useMeetingsStore((s) => s.refreshWhisperModels);
  const startRecording = useMeetingsStore((s) => s.startRecording);
  const pauseRecording = useMeetingsStore((s) => s.pauseRecording);
  const resumeRecording = useMeetingsStore((s) => s.resumeRecording);
  const stopRecording = useMeetingsStore((s) => s.stopRecording);
  const transcriptionDisabled = useMeetingsStore((s) => s.transcriptionDisabled);
  const openMeetings = useOpenMeetings();
  const contextTags = useRecordingContextTags();

  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Button rect drives the popover's fixed position. Recomputed on open and
  // when the viewport changes so the popover stays anchored if the window
  // resizes or the page scrolls.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (whisperModels.length === 0) refreshWhisperModels();
  }, [whisperModels.length, refreshWhisperModels]);

  // Position the popover relative to the button. The parent header uses
  // overflow-hidden, so rendering in-place would get clipped — we portal to
  // document.body and pin with fixed coordinates instead.
  useLayoutEffect(() => {
    if (!popoverOpen) return;
    function reposition() {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      setAnchor({ top: r.bottom + 8, right: window.innerWidth - r.right });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [popoverOpen]);

  // Close on outside click / Escape. With the portal, the popover is no
  // longer a descendant of the button's container, so we check both refs.
  useEffect(() => {
    if (!popoverOpen) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setPopoverOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPopoverOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [popoverOpen]);

  async function handleStartClick() {
    if (starting) return;
    setStarting(true);
    try {
      const prefs = await getPreferences();
      const micPref = prefs["meeting_mic"] ?? "";
      const modelPref = prefs["meeting_whisper_model"] ?? "base.en";

      const models = whisperModels.length > 0
        ? whisperModels
        : await (async () => {
            await refreshWhisperModels();
            return useMeetingsStore.getState().whisperModels;
          })();
      const preferred = models.find((m) => m.id === modelPref && m.downloaded);
      const fallback = models.find((m) => m.downloaded);
      const chosen = preferred ?? fallback;
      if (!chosen) {
        toast.error("No Whisper model downloaded", {
          description: "Download a model in Settings → Meetings before recording.",
          action: { label: "Open Meetings", onClick: openMeetings },
        });
        return;
      }

      await startRecording(chosen.id, micPref || null, contextTags);
      setPopoverOpen(true);
    } catch (e) {
      toast.error("Failed to start recording", { description: String(e) });
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (stopping) return;
    setStopping(true);
    try {
      const record = await stopRecording();
      setPopoverOpen(false);
      if (record) {
        toast.success("Meeting saved", {
          description: "Summary and diarization are running in the background.",
          action: { label: "View", onClick: openMeetings },
        });
      }
    } catch (e) {
      toast.error("Failed to stop", { description: String(e) });
    } finally {
      setStopping(false);
    }
  }

  const isLive = !!active;
  const state = active?.state ?? "idle";
  const previewSegments = useMemo(
    () => (active?.segments ?? []).slice(-4),
    [active?.segments],
  );

  // When the user has disabled transcription in Settings, this button is the
  // primary entry to live recording — hide it entirely. Existing in-flight
  // recordings (rare) still render so the user can stop them gracefully.
  if (transcriptionDisabled && !isLive) return null;

  const dot = (
    <span className="relative flex h-2.5 w-2.5">
      {state === "recording" && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
      )}
      <span
        className={cn(
          "relative inline-flex rounded-full h-2.5 w-2.5",
          state === "paused" ? "bg-amber-500" : "bg-red-500",
        )}
      />
    </span>
  );

  return (
    <div className={cn("relative", className)}>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        onClick={() => {
          if (isLive) setPopoverOpen((v) => !v);
          else void handleStartClick();
        }}
        aria-label={isLive ? "Open recording controls" : "Start transcribing a meeting"}
        title={isLive ? "Recording — click for controls" : "Transcribe a meeting"}
        // Icon-only when idle; wider pill with inline timer when live.
        className={cn(
          "shrink-0 h-9",
          isLive ? "px-2.5 gap-1.5" : "w-9 px-0",
        )}
        disabled={starting}
      >
        {starting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isLive ? (
          <>
            {dot}
            <span className="font-mono text-xs tabular-nums">
              {formatTimestamp(active.elapsedSec)}
            </span>
          </>
        ) : (
          <LiveTranscribeIcon className="h-5 w-5" />
        )}
      </Button>

      {popoverOpen && isLive && anchor &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            style={{
              position: "fixed",
              top: anchor.top,
              right: anchor.right,
              zIndex: 100,
            }}
            className="w-80 rounded-lg border bg-popover text-popover-foreground shadow-lg"
          >
            <div className="px-3 py-2.5 border-b flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                {state === "recording" && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                )}
                <span
                  className={cn(
                    "relative inline-flex rounded-full h-2 w-2",
                    state === "paused" ? "bg-amber-500" : "bg-red-500",
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  {active.title || "Untitled meeting"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {state === "paused" ? "Paused" : "Recording"} ·{" "}
                  <span className="font-mono tabular-nums">
                    {formatTimestamp(active.elapsedSec)}
                  </span>
                </p>
              </div>
            </div>

            <div className="px-3 py-2 max-h-40 overflow-y-auto text-xs font-mono space-y-1 bg-muted/30">
              {active.segments.length === 0 ? (
                <p className="text-[11px] italic text-muted-foreground">
                  Listening… first segment arrives after ~10s.
                </p>
              ) : (
                previewSegments.map((seg, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-muted-foreground shrink-0">
                      {formatTimestamp(seg.startSec)}
                    </span>
                    <span className="min-w-0 break-words">{seg.text}</span>
                  </div>
                ))
              )}
            </div>

            {active.error && (
              <div className="px-3 py-2 border-t flex items-start gap-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{active.error}</span>
              </div>
            )}

            <div className="px-2 py-2 border-t flex items-center gap-1">
              {state === "recording" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 h-8"
                  onClick={() => pauseRecording().catch((e) => toast.error(String(e)))}
                >
                  <Pause className="h-3.5 w-3.5 mr-1.5" />
                  Pause
                </Button>
              ) : state === "paused" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 h-8"
                  onClick={() => resumeRecording().catch((e) => toast.error(String(e)))}
                >
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  Resume
                </Button>
              ) : null}
              <Button
                variant="destructive"
                size="sm"
                className="flex-1 h-8"
                onClick={handleStop}
                disabled={stopping || state === "stopping"}
              >
                {stopping || state === "stopping" ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Square className="h-3.5 w-3.5 mr-1.5" />
                )}
                Stop
              </Button>
            </div>

            <button
              type="button"
              onClick={() => {
                setPopoverOpen(false);
                openMeetings();
              }}
              className="w-full px-3 py-2 border-t text-xs text-muted-foreground hover:bg-muted/60 flex items-center justify-center gap-1.5 rounded-b-lg"
            >
              <ExternalLink className="h-3 w-3" />
              Open in Meetings
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
