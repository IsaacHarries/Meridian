import { useState } from "react";
import { AlertTriangle, Check, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fromTimeInput } from "./_shared";

export function ManualEntryForm({
  day,
  onAdd,
}: {
  day: string;
  onAdd: (start: number, end: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [startStr, setStartStr] = useState("09:00");
  const [endStr, setEndStr] = useState("10:00");
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const baseDate = new Date(`${day}T12:00:00`);
    const startMs = fromTimeInput(baseDate.getTime(), startStr);
    const endMs = fromTimeInput(baseDate.getTime(), endStr);
    if (startMs == null || endMs == null) {
      setError("Enter both start and end times");
      return;
    }
    if (endMs <= startMs) {
      setError("End must be after start");
      return;
    }
    onAdd(startMs, endMs);
    setOpen(false);
    setError(null);
  }

  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        className="h-8 text-muted-foreground"
      >
        <Plus className="h-3.5 w-3.5 mr-1.5" />
        Add a segment
      </Button>
    );
  }

  return (
    <div className="rounded-md border px-3 py-2 flex flex-wrap items-center gap-2">
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
        Add
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
      >
        <X className="h-3.5 w-3.5 mr-1" />
        Cancel
      </Button>
    </div>
  );
}
