import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type NewMeetingMode } from "@/stores/meetings/types";
import { ChevronDown, Mic, NotebookPen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Split-button: clicking the main label runs the user's last-chosen mode
// (persisted in preferences); the chevron opens a small menu so they can pick
// the other mode and update the default. Self-closing on outside-click.
export function NewMeetingSplitButton({
  mode,
  disabled,
  onPick,
}: {
  mode: NewMeetingMode;
  disabled: boolean;
  onPick: (m: NewMeetingMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const primaryLabel =
    mode === "record" ? "Transcribe" : "Write notes";
  const PrimaryIcon = mode === "record" ? Mic : NotebookPen;

  return (
    <div ref={ref} className="relative w-full">
      <div className="flex w-full">
        <Button
          className="flex-1 rounded-r-none"
          disabled={disabled}
          onClick={() => onPick(mode)}
        >
          <PrimaryIcon className="h-4 w-4 mr-1.5" />
          {primaryLabel}
        </Button>
        <Button
          className="rounded-l-none border-l border-primary-foreground/20 px-2"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-label="Choose meeting type"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 rounded-md border bg-popover shadow-md py-1">
          <button
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left",
              mode === "record" && "font-semibold",
            )}
            onClick={() => {
              setOpen(false);
              onPick("record");
            }}
          >
            <Mic className="h-4 w-4" />
            Transcribe
          </button>
          <button
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left",
              mode === "notes" && "font-semibold",
            )}
            onClick={() => {
              setOpen(false);
              onPick("notes");
            }}
          >
            <NotebookPen className="h-4 w-4" />
            Write notes
          </button>
        </div>
      )}
    </div>
  );
}
