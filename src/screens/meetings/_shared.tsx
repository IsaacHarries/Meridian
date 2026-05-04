import { Input } from "@/components/ui/input";
import { type MeetingKind, type SpeakerCandidate } from "@/lib/tauri/meetings";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/stores/meetings/helpers";
import { Plus, Tag as TagIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// ── Search snippet types ─────────────────────────────────────────────────────
//
// Shared between SearchResultsView (the producer) and SearchResultCard
// (the consumer). Kept here so the small atom file owns the contract both
// ends rely on.

export interface MeetingSnippet {
  meetingId: string;
  meetingTitle: string;
  meetingStartedAt: string;
  meetingKind: MeetingKind;
  source: "title" | "notes" | "transcript";
  text: string;
  // For transcript snippets, the audio offset where this segment starts —
  // surfaced in the result card so the user can locate it in the meeting.
  startSec?: number;
}

export interface ScoredSnippet extends MeetingSnippet {
  score: number;
}

// Render `text` with the literal substring of `query` highlighted (case-
// insensitive). When the only match is fuzzy/subsequence — meaning the
// substring isn't actually present — falls back to the plain text. We trim
// long lines around the match so each card stays compact.
export function HighlightedSnippet({
  text,
  query,
  maxLen = 220,
}: {
  text: string;
  query: string;
  maxLen?: number;
}) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());

  if (idx === -1) {
    // Fuzzy-only match — no literal substring to highlight. Truncate from the
    // start since we have no anchor.
    const t = text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
    return <>{t}</>;
  }

  // Window the text around the match so very long lines don't overwhelm the
  // card. Keeps about half of `maxLen` on each side of the match.
  let head = text.slice(0, idx);
  let match = text.slice(idx, idx + q.length);
  let tail = text.slice(idx + q.length);
  let prefixEllipsis = false;
  let suffixEllipsis = false;
  if (text.length > maxLen) {
    const halfWindow = Math.max(20, Math.floor((maxLen - q.length) / 2));
    if (head.length > halfWindow) {
      head = head.slice(-halfWindow);
      prefixEllipsis = true;
    }
    if (tail.length > halfWindow) {
      tail = tail.slice(0, halfWindow);
      suffixEllipsis = true;
    }
  }

  return (
    <>
      {prefixEllipsis && "…"}
      {head}
      <mark className="bg-yellow-300/30 dark:bg-yellow-400/25 text-foreground rounded-sm px-0.5">
        {match}
      </mark>
      {tail}
      {suffixEllipsis && "…"}
    </>
  );
}

export function SearchResultCard({
  snippet,
  query,
  onOpen,
}: {
  snippet: ScoredSnippet;
  query: string;
  onOpen: () => void;
}) {
  const sourceLabel =
    snippet.source === "title"
      ? "Title"
      : snippet.source === "notes"
        ? "Notes"
        : `Transcript${
            snippet.startSec !== undefined ? ` · ${formatTimestamp(snippet.startSec)}` : ""
          }`;
  return (
    <button
      onClick={onOpen}
      className="w-full text-left rounded-md border bg-card hover:bg-accent/50 transition-colors p-3 space-y-1.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold truncate">
          <HighlightedSnippet text={snippet.meetingTitle} query={query} />
        </p>
        <span className="text-xs text-muted-foreground shrink-0">
          {formatDate(snippet.meetingStartedAt)}
        </span>
      </div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {sourceLabel}
      </p>
      {snippet.source !== "title" && (
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          <HighlightedSnippet text={snippet.text} query={query} />
        </p>
      )}
    </button>
  );
}

// ── Tag filter ───────────────────────────────────────────────────────────────

export function TagFilterBar({
  tags,
  selected,
  onSelect,
}: {
  tags: string[];
  selected: string | null;
  onSelect: (tag: string | null) => void;
}) {
  return (
    <div className="px-3 py-2 border-b flex items-center gap-1.5 flex-wrap">
      <TagIcon className="h-3 w-3 text-muted-foreground shrink-0" />
      <button
        onClick={() => onSelect(null)}
        className={cn(
          "text-[11px] px-2 py-0.5 rounded-full border transition-colors",
          selected === null
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-background hover:bg-muted border-input",
        )}
      >
        All
      </button>
      {tags.map((t) => (
        <button
          key={t}
          onClick={() => onSelect(t)}
          className={cn(
            "text-[11px] px-2 py-0.5 rounded-full border transition-colors",
            selected === t
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background hover:bg-muted border-input",
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

export function SpeakerRow({
  id,
  displayName,
  candidates,
  onRename,
}: {
  id: string;
  displayName: string | null;
  candidates: SpeakerCandidate[];
  onRename: (name: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(displayName ?? "");
  useEffect(() => setValue(displayName ?? ""), [displayName]);

  // Show the candidate picker when recognition surfaced multiple plausible
  // names and no display name is set yet. Picking one commits via onRename;
  // the backend clears `candidates` on rename so this row collapses back to
  // the plain input afterwards.
  const showPicker = !displayName && candidates.length > 0;

  return (
    <div className="flex items-start gap-3">
      <span className="font-mono text-xs text-muted-foreground w-28 shrink-0 pt-1.5">
        {id}
      </span>
      <div className="flex-1 min-w-0 space-y-1.5">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            const trimmed = value.trim();
            const next = trimmed === "" ? null : trimmed;
            if (next !== displayName) {
              void onRename(next);
            }
          }}
          placeholder={
            showPicker
              ? "Not one of these? Type a name"
              : "Name this speaker (e.g., Isaac)"
          }
          className="h-8 text-sm"
        />
        {showPicker && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">
              Could be:
            </span>
            {candidates.map((c) => (
              <button
                key={c.name}
                onClick={() => void onRename(c.name)}
                className="text-xs px-2 py-0.5 rounded-full border border-input bg-background hover:bg-muted transition-colors"
                title={`similarity ${c.similarity.toFixed(2)}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// "+" pill that animates open into an editable text field. Matches the size
// and rounded-full silhouette of the tag pills so it visually sits with them;
// the inner content swaps between a Plus icon and an input, while the pill
// itself transitions width between a compact ~28px and a roomier ~112px.
export function AddTagPill({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    if (value.trim()) onSubmit(value);
    setValue("");
    setEditing(false);
  }

  return (
    <div
      className={cn(
        "h-7 rounded-full border border-input bg-background text-xs transition-all duration-200 ease-out overflow-hidden flex items-center",
        editing ? "w-28" : "w-7 hover:bg-muted cursor-pointer",
      )}
      onClick={() => {
        if (!editing) {
          setEditing(true);
          // Wait for the width transition to begin, then focus the input so
          // the caret lands once the pill has opened.
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setValue("");
              setEditing(false);
            }
          }}
          onBlur={commit}
          placeholder="tag name"
          className="w-full h-full px-3 bg-transparent outline-none placeholder:text-muted-foreground/60"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
          <Plus className="h-3 w-3" strokeWidth={2.5} />
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

