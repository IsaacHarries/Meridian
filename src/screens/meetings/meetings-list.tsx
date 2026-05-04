import { Badge } from "@/components/ui/badge";
import { type MeetingRecord } from "@/lib/tauri/meetings";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/stores/meetings/helpers";
import { useMeetingsStore } from "@/stores/meetings/store";
import {
    Clock,
    Loader2,
    Mic,
    Tag as TagIcon,
} from "lucide-react";
import { formatDate, formatDuration } from "./_shared";

export function MeetingsList({
  meetings,
  totalCount,
  tagFilter,
  listLoaded,
  selectedId,
  active,
  onSelect,
}: {
  meetings: MeetingRecord[];
  totalCount: number;
  tagFilter: string | null;
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
    if (tagFilter) {
      // The tag filter excluded everything — make the cause obvious so the
      // user doesn't think they've lost meetings.
      return (
        <div className="flex flex-col items-center justify-center gap-2 py-10 px-4 text-center text-sm text-muted-foreground">
          <TagIcon className="h-8 w-8 text-muted-foreground/60" />
          <p>
            No meetings tagged{" "}
            <span className="font-mono text-foreground">{tagFilter}</span>.
          </p>
          <p className="text-xs">
            {totalCount} meeting{totalCount === 1 ? "" : "s"} hidden by this filter.
          </p>
        </div>
      );
    }
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
