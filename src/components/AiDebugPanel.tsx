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
import {
    clearAiDebugLogFile,
    getAiDebugLogPath,
    readAiDebugLog,
} from "@/lib/tauri/misc";
import { cn } from "@/lib/utils";
import {
    totalCapturedTokens,
    useAiDebugStore,
    type AiTrafficEvent,
} from "@/stores/aiDebugStore";
import { formatTokens } from "@/stores/tokenUsageStore";
import { ChevronDown, ChevronRight, Filter, FolderOpen, Trash2, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

// On-mount hydrate cap: matches the in-memory store's MAX_EVENTS so we
// never request more rows than the buffer can hold. The Rust read
// command parses lines as JSON; capping here keeps the IPC payload
// bounded for users with multi-MB log files.
const MAX_HYDRATE_EVENTS = 200;
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

// ── Date-range filter helpers (exported for unit testing) ──────────────────

/**
 * Convert a date string (yyyy-MM-dd from <input type=date>) and an optional
 * time string (HH:MM from <input type=time>) into an epoch-ms value in the
 * user's local timezone. Returns null when the date is empty/invalid so
 * callers can treat that side of the range as unbounded.
 *
 * `fallbackTime` is used when `time` is empty — pass "00:00" for the lower
 * bound and "23:59:59.999" for the upper bound so a date-only range covers
 * the whole calendar day.
 */
export function combineDateTime(
  date: string,
  time: string,
  fallbackTime: string,
): number | null {
  if (!date) return null;
  // Parse yyyy-MM-dd as a LOCAL date (not UTC) so the user's "today" lines
  // up with their wall clock. Constructing `new Date("yyyy-MM-dd")` would
  // be parsed as UTC midnight, shifting the boundary in non-UTC timezones.
  const [yStr, mStr, dStr] = date.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const t = time || fallbackTime;
  const [hStr = "0", mnStr = "0", sStr = "0"] = t.split(":");
  const hour = Number(hStr);
  const minute = Number(mnStr);
  const second = Number(sStr.split(".")[0] ?? "0");
  const ms = Number(sStr.includes(".") ? sStr.split(".")[1] : "0");
  const local = new Date(year, month - 1, day, hour, minute, second, ms);
  const epoch = local.getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

export interface TimeRangeFilter {
  fromDate: string;
  fromTime: string;
  toDate: string;
  toTime: string;
}

/**
 * Filter traffic events by a date+optional-time range. Either side may be
 * empty (unbounded). When only the date is set on a side, that side
 * defaults to the start of the day (lower bound) or the end of the day
 * (upper bound). Returns the input unchanged when no filter is active.
 */
export function filterEventsByTimeRange(
  events: AiTrafficEvent[],
  filter: TimeRangeFilter,
): AiTrafficEvent[] {
  const fromMs = combineDateTime(filter.fromDate, filter.fromTime, "00:00");
  const toMs = combineDateTime(filter.toDate, filter.toTime, "23:59:59.999");
  if (fromMs === null && toMs === null) return events;
  return events.filter((e) => {
    if (fromMs !== null && e.startedAt < fromMs) return false;
    if (toMs !== null && e.startedAt > toMs) return false;
    return true;
  });
}

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
  const hydrateFromDisk = useAiDebugStore((s) => s.hydrateFromDisk);

  // Hydrate the buffer from the on-disk JSONL log on mount so the panel
  // reflects history regardless of whether the live `ai-traffic-event`
  // broadcast reached this webview. Critical for the popped-out window:
  // if it opens after a workflow has already been emitting traffic, the
  // listener only catches subsequent events, but the JSONL log has the
  // full record — read once on mount, dedup against any live events
  // already in the store, and the user sees a complete picture.
  useEffect(() => {
    let cancelled = false;
    void readAiDebugLog(MAX_HYDRATE_EVENTS)
      .then((rows) => {
        if (cancelled) return;
        const parsed = rows.filter(
          (r): r is AiTrafficEvent =>
            r != null &&
            typeof r === "object" &&
            typeof (r as AiTrafficEvent).runId === "string" &&
            typeof (r as AiTrafficEvent).startedAt === "number",
        );
        if (parsed.length > 0) hydrateFromDisk(parsed);
      })
      .catch((e) => {
        console.warn("[ai-debug] failed to hydrate from disk:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrateFromDisk]);

  // Date+optional-time range filter — local component state because this is
  // a developer tool that doesn't need cross-session persistence. Empty
  // strings mean "unbounded on this side". `filterOpen` gates whether the
  // input row is rendered AND whether the filter is applied; the panel
  // opens with the filter off so the full traffic stream is visible by
  // default and users opt in via the header toggle.
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<TimeRangeFilter>({
    fromDate: "",
    fromTime: "",
    toDate: "",
    toTime: "",
  });

  const filteredEvents = useMemo(
    () => (filterOpen ? filterEventsByTimeRange(events, filter) : events),
    [events, filter, filterOpen],
  );
  const filterActive =
    filterOpen &&
    Boolean(
      filter.fromDate || filter.fromTime || filter.toDate || filter.toTime,
    );
  const totals = useMemo(
    () => totalCapturedTokens(filteredEvents),
    [filteredEvents],
  );

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

  async function revealLogInFinder() {
    if (!logPath) return;
    try {
      // `revealItemInDir` opens the parent directory in Finder/Explorer
      // and selects the file itself. Works for files that don't yet
      // exist on disk too — the OS will just open the parent without a
      // selection — which matches the case where the user opens the
      // panel before any traffic has been captured.
      await revealItemInDir(logPath);
    } catch (e) {
      toast.error("Couldn't open log folder", { description: String(e) });
    }
  }

  return (
    <div className="flex flex-col h-full bg-background/95 border-border">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold">AI Traffic</span>
          <span className="text-muted-foreground">
            {filterActive
              ? `${filteredEvents.length} of ${events.length} ${events.length === 1 ? "call" : "calls"}`
              : `${events.length} ${events.length === 1 ? "call" : "calls"}`}
            {filteredEvents.length > 0 && (
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
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7",
              filterOpen && "bg-muted text-foreground",
            )}
            onClick={() => setFilterOpen((v) => !v)}
            title={filterOpen ? "Hide time-range filter" : "Show time-range filter"}
            aria-pressed={filterOpen}
          >
            <Filter className="h-3.5 w-3.5" />
          </Button>
          {logPath && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void revealLogInFinder()}
              title={`Reveal log in Finder: ${logPath}`}
            >
              <FolderOpen className="h-3.5 w-3.5" />
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

      {filterOpen && (
        <FilterRow
          filter={filter}
          onChange={setFilter}
          active={filterActive}
          onClear={() =>
            setFilter({ fromDate: "", fromTime: "", toDate: "", toTime: "" })
          }
        />
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {events.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground p-6">
            {enabled
              ? "Waiting for traffic — kick off a workflow and prompts will land here."
              : "Capture is off. Turn it on in Settings or via the button above."}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground p-6">
            No calls in the selected time range. Adjust the filter or clear it.
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {filteredEvents.map((e, i) => (
              <TrafficRow key={`${e.runId}-${e.startedAt}-${i}`} event={e} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterRow({
  filter,
  onChange,
  active,
  onClear,
}: {
  filter: TimeRangeFilter;
  onChange: (next: TimeRangeFilter) => void;
  active: boolean;
  onClear: () => void;
}) {
  const inputBase =
    "h-7 px-1.5 rounded border border-input bg-background text-[11px] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed";
  // Tauri's WKWebView renders the native popup picker on `<input type="date">`
  // when clicked, but does NOT do the same for `<input type="time">` — the
  // user clicks and gets no visible response. Explicitly calling
  // `showPicker()` on click forces the same picker UX for both inputs across
  // every supported WebView build. Wrapped in try/catch because showPicker()
  // throws if invoked outside a user gesture or on a disabled element.
  function openPickerOnClick(e: React.MouseEvent<HTMLInputElement>) {
    const el = e.currentTarget;
    if (el.disabled) return;
    try {
      el.showPicker?.();
    } catch {
      /* fall back to native focus; user can type the value */
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b bg-muted/20 text-[11px]">
      <span className="text-muted-foreground">Filter:</span>
      <span className="text-muted-foreground">From</span>
      <input
        type="date"
        value={filter.fromDate}
        onChange={(e) => onChange({ ...filter, fromDate: e.target.value })}
        onClick={openPickerOnClick}
        className={inputBase}
        title="From date (lower bound)"
      />
      <input
        type="time"
        value={filter.fromTime}
        onChange={(e) => onChange({ ...filter, fromTime: e.target.value })}
        onClick={openPickerOnClick}
        className={inputBase}
        disabled={!filter.fromDate}
        title={
          filter.fromDate
            ? "Optional time on the From date — defaults to 00:00 when blank"
            : "Pick a From date first to set a time"
        }
      />
      <span className="text-muted-foreground">To</span>
      <input
        type="date"
        value={filter.toDate}
        onChange={(e) => onChange({ ...filter, toDate: e.target.value })}
        onClick={openPickerOnClick}
        className={inputBase}
        title="To date (upper bound)"
      />
      <input
        type="time"
        value={filter.toTime}
        onChange={(e) => onChange({ ...filter, toTime: e.target.value })}
        onClick={openPickerOnClick}
        className={inputBase}
        disabled={!filter.toDate}
        title={
          filter.toDate
            ? "Optional time on the To date — defaults to 23:59:59 when blank"
            : "Pick a To date first to set a time"
        }
      />
      {active && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={onClear}
        >
          Clear
        </Button>
      )}
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
