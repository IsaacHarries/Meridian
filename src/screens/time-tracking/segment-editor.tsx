import { useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fromTimeInput, toTimeInput } from "./_shared";

export function SegmentEditor({
  start,
  end,
  onSave,
  onCancel,
}: {
  start: number;
  end: number | null;
  onSave: (start: number, end: number | null) => void;
  onCancel: () => void;
}) {
  const [startStr, setStartStr] = useState(() => toTimeInput(start));
  const [endStr, setEndStr] = useState(() => (end == null ? "" : toTimeInput(end)));
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const startMs = fromTimeInput(start, startStr);
    if (startMs == null) {
      setError("Invalid start time");
      return;
    }
    let endMs: number | null;
    if (endStr.trim() === "") {
      endMs = end;
    } else {
      const parsed = fromTimeInput(end ?? start, endStr);
      if (parsed == null) {
        setError("Invalid end time");
        return;
      }
      if (parsed < startMs) {
        setError("End must be after start");
        return;
      }
      endMs = parsed;
    }
    onSave(startMs, endMs);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="time"
        value={startStr}
        onChange={(e) => setStartStr(e.target.value)}
        className="w-28 h-8"
      />
      <span className="text-muted-foreground text-xs">→</span>
      <Input
        type="time"
        value={endStr}
        onChange={(e) => setEndStr(e.target.value)}
        placeholder="end"
        className="w-28 h-8"
      />
      {error && (
        <span className="text-xs text-destructive flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {error}
        </span>
      )}
      <span className="flex-1" />
      <Button size="sm" variant="ghost" className="h-8" onClick={commit}>
        <Check className="h-3.5 w-3.5 mr-1" />
        Save
      </Button>
      <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
        <X className="h-3.5 w-3.5 mr-1" />
        Cancel
      </Button>
    </div>
  );
}
