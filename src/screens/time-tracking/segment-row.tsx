import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  type WorkSegment,
  formatDurationHm,
  formatTimeOfDay,
} from "@/lib/timeTracking";
import { EndReasonBadge } from "./_shared";
import { SegmentEditor } from "./segment-editor";

export function SegmentRow({
  day,
  idx,
  seg,
  now,
  onEdit,
  onDelete,
}: {
  day: string;
  idx: number;
  seg: WorkSegment;
  now: number;
  onEdit: (
    day: string,
    idx: number,
    patch: { startMs?: number; endMs?: number | null },
  ) => void;
  onDelete: (day: string, idx: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const open = seg.endMs === null;
  const endValue = seg.endMs ?? now;
  const durationMs = Math.max(0, endValue - seg.startMs);

  if (editing) {
    return (
      <li className="px-3 py-2">
        <SegmentEditor
          start={seg.startMs}
          end={seg.endMs}
          onCancel={() => setEditing(false)}
          onSave={(nextStart, nextEnd) => {
            onEdit(day, idx, { startMs: nextStart, endMs: nextEnd });
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="px-3 py-2 flex items-center gap-3 text-sm">
      <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0 w-32">
        {formatTimeOfDay(seg.startMs)} →{" "}
        {open ? "now" : formatTimeOfDay(seg.endMs!)}
      </span>
      <span className="font-medium tabular-nums shrink-0 w-16">
        {formatDurationHm(durationMs)}
      </span>
      {open ? (
        <Badge variant="default" className="text-[10px]">
          Live
        </Badge>
      ) : (
        seg.endReason && <EndReasonBadge reason={seg.endReason} />
      )}
      <span className="flex-1" />
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => setEditing(true)}
        aria-label="Edit segment"
        title="Edit"
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => onDelete(day, idx)}
        aria-label="Delete segment"
        title="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}
