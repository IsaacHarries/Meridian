import { Search, ChevronUp, ChevronDown, X } from "lucide-react";

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  matchCount: number;
  currentIdx: number;
  inputRef: React.Ref<HTMLInputElement>;
  containerRef?: React.Ref<HTMLDivElement>;
}

export function DiffSearchBar({ value, onChange, onNext, onPrev, onClose, matchCount, currentIdx, inputRef, containerRef }: SearchBarProps) {
  return (
    <div
      ref={containerRef ?? null}
      className="sticky top-0 z-30 flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-background/95 backdrop-blur-sm shadow-sm rounded-md"
    >
      <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-1" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Search in diff…"
        className="flex-1 min-w-0 bg-transparent text-xs outline-none font-mono"
      />
      <span className="text-[10px] text-muted-foreground font-mono tabular-nums shrink-0 px-1">
        {value ? (matchCount === 0 ? "0/0" : `${currentIdx + 1}/${matchCount}`) : ""}
      </span>
      <button
        onClick={onPrev}
        disabled={matchCount === 0}
        title="Previous match (Shift+Enter)"
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent shrink-0"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onNext}
        disabled={matchCount === 0}
        title="Next match (Enter)"
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent shrink-0"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onClose}
        title="Close (Esc)"
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
