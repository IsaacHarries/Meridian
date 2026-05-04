/**
 * Developer panel for inspecting captured AI traffic.
 *
 * Shows a most-recent-first list of LLM round-trips with provider,
 * model, workflow, latency, and token usage. Each row is expandable
 * to reveal the full prompt messages + response so the user can see
 * exactly what was sent and received.
 *
 * Layout-agnostic — the surrounding `AiDebugDock` decides where the
 * panel sits (bottom split, right/left sidebar, or popped-out window).
 */

import { Button } from "@/components/ui/button";
import { clearAiDebugLogFile, getAiDebugLogPath } from "@/lib/tauri/misc";
import { cn } from "@/lib/utils";
import {
    totalCapturedTokens,
    useAiDebugStore,
    type AiTrafficEvent,
} from "@/stores/aiDebugStore";
import { formatTokens } from "@/stores/tokenUsageStore";
import { ChevronDown, ChevronRight, FileText, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface AiDebugPanelProps {
  /** Show a close (x) button that hides the panel — only the docked
   *  variants pass this; the popped-out window has its own close. */
  onClose?: () => void;
  /** Header right-side controls — the dock-mode picker lives here so
   *  users can switch dock orientation without going to Settings. */
  controls?: React.ReactNode;
}

export function AiDebugPanel({ onClose, controls }: AiDebugPanelProps) {
  const events = useAiDebugStore((s) => s.events);
  const enabled = useAiDebugStore((s) => s.enabled);
  const setEnabled = useAiDebugStore((s) => s.setEnabled);
  const clear = useAiDebugStore((s) => s.clear);

  const totals = useMemo(() => totalCapturedTokens(events), [events]);

  // Resolve the on-disk JSONL log path lazily — the main reason to
  // surface it is so the user (or Claude Code) can grep / tail the
  // file directly. Quick to fetch, but no need to do it on first
  // render of every workflow screen.
  const [logPath, setLogPath] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void getAiDebugLogPath().then((p) => {
      if (!cancelled) setLogPath(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleClear() {
    clear(); // wipe in-memory ring buffer
    try {
      await clearAiDebugLogFile(); // truncate the JSONL mirror to match
    } catch (e) {
      toast.error("Couldn't clear debug log file", { description: String(e) });
    }
  }

  async function copyPathToClipboard() {
    if (!logPath) return;
    try {
      await navigator.clipboard.writeText(logPath);
      toast.success("Log path copied");
    } catch {
      toast.error("Clipboard write failed");
    }
  }

  return (
    <div className="flex flex-col h-full bg-background/95 border-border">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold">AI Traffic</span>
          <span className="text-muted-foreground">
            {events.length} {events.length === 1 ? "call" : "calls"}
            {events.length > 0 && (
              <>
                {" • "}
                <span title="Total input tokens captured">
                  {formatTokens(totals.input)} in
                </span>
                {" → "}
                <span title="Total output tokens captured">
                  {formatTokens(totals.output)} out
                </span>
              </>
            )}
          </span>
          {!enabled && (
            <span className="text-amber-500" title="Capture is currently off">
              capture off
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!enabled && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => void setEnabled(true)}
            >
              Enable capture
            </Button>
          )}
          {logPath && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void copyPathToClipboard()}
              title={`Copy log path: ${logPath}`}
            >
              <FileText className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void handleClear()}
            title="Clear captured events (in-memory and on-disk)"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          {controls}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
              title="Hide debug panel"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {events.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground p-6">
            {enabled
              ? "Waiting for traffic — kick off a workflow and prompts will land here."
              : "Capture is off. Turn it on in Settings or via the button above."}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {events.map((e, i) => (
              <TrafficRow key={`${e.runId}-${e.startedAt}-${i}`} event={e} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TrafficRow({ event }: { event: AiTrafficEvent }) {
  const [open, setOpen] = useState(false);
  const time = new Date(event.startedAt).toLocaleTimeString();

  return (
    <li className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2 hover:bg-muted/50 text-left"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{event.workflow}</span>
            {event.node && (
              <span className="text-muted-foreground">/ {event.node}</span>
            )}
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{event.provider}</span>
            <span className="text-muted-foreground truncate">{event.model}</span>
            {event.error && (
              <span className="text-destructive">· error</span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>{time}</span>
            <span>{event.latencyMs} ms</span>
            <span>
              {formatTokens(event.usage.inputTokens)} →{" "}
              {formatTokens(event.usage.outputTokens)}
            </span>
          </div>
        </div>
      </button>
      {open && <TrafficDetail event={event} />}
    </li>
  );
}

function TrafficDetail({ event }: { event: AiTrafficEvent }) {
  return (
    <div className="px-3 pb-3 space-y-2 text-[11px]">
      {event.error && (
        <div className="rounded bg-destructive/10 text-destructive border border-destructive/30 p-2">
          {event.error}
        </div>
      )}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          Request
        </div>
        <div className="space-y-1">
          {event.messages.map((m, i) => (
            <MessageBlock key={i} role={m.role} content={m.content} />
          ))}
        </div>
      </div>
      {event.response && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            Response
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono bg-muted/40 p-2 rounded">
            {event.response}
          </pre>
        </div>
      )}
    </div>
  );
}

const ROLE_CLASSES: Record<string, string> = {
  system: "bg-amber-500/10 border-amber-500/30",
  user: "bg-blue-500/10 border-blue-500/30",
  assistant: "bg-emerald-500/10 border-emerald-500/30",
  tool: "bg-purple-500/10 border-purple-500/30",
};

function MessageBlock({ role, content }: { role: string; content: string }) {
  const roleClass = ROLE_CLASSES[role] ?? "bg-muted/40 border-border";
  return (
    <div className={cn("border rounded p-2", roleClass)}>
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">
        {role}
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono">{content}</pre>
    </div>
  );
}
