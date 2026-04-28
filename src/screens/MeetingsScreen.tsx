import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Mic,
  Play,
  Pause,
  Square,
  Sparkles,
  Loader2,
  Trash2,
  Plus,
  Clock,
  Tag as TagIcon,
  Users,
  X,
  ChevronDown,
  FileText,
  NotebookPen,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RichNotesEditor } from "@/components/RichNotesEditor";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import {
  createGlobalCommands,
  type SlashCommand,
} from "@/lib/slashCommands";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import {
  listMicrophones,
  type MicrophoneInfo,
  type MeetingRecord,
  type MeetingKind,
  type SpeakerCandidate,
} from "@/lib/tauri";
import { fuzzyScore } from "@/lib/fuzzySearch";
import { extractTiptapPlainText } from "@/lib/tiptapText";
import { getPreferences } from "@/lib/preferences";
import {
  useMeetingsStore,
  formatTimestamp,
  type NewMeetingMode,
} from "@/stores/meetingsStore";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ask } from "@tauri-apps/plugin-dialog";


interface MeetingsScreenProps {
  onBack: () => void;
}

export function MeetingsScreen({ onBack }: MeetingsScreenProps) {
  const meetings = useMeetingsStore((s) => s.meetings);
  const listLoaded = useMeetingsStore((s) => s.listLoaded);
  const selectedId = useMeetingsStore((s) => s.selectedId);
  const active = useMeetingsStore((s) => s.active);
  const newMeetingMode = useMeetingsStore((s) => s.newMeetingMode);
  const setNewMeetingMode = useMeetingsStore((s) => s.setNewMeetingMode);
  const transcriptionDisabled = useMeetingsStore((s) => s.transcriptionDisabled);
  const loadMeetingsList = useMeetingsStore((s) => s.loadMeetingsList);
  const selectMeeting = useMeetingsStore((s) => s.selectMeeting);
  const createNotesMeetingAction = useMeetingsStore((s) => s.createNotesMeeting);
  const refreshWhisperModels = useMeetingsStore((s) => s.refreshWhisperModels);

  const [creating, setCreating] = useState(false);
  // null = "All". When a tag is set, the list shows only meetings whose tags
  // include it. The filter pill row hides itself when no meetings carry tags
  // yet, so empty workspaces aren't cluttered.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // Search mode: ⌘F (or Ctrl+F) opens a Slack-style search overlay in the
  // main panel. When `searchOpen` is true, the main area renders results
  // instead of the active/detail/empty view; the right chat panel is hidden.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!listLoaded) loadMeetingsList();
    refreshWhisperModels();
  }, [listLoaded, loadMeetingsList, refreshWhisperModels]);

  const selected = useMemo(
    () => meetings.find((m) => m.id === selectedId) ?? null,
    [meetings, selectedId],
  );

  // Sorted unique set of tags actually in use across saved meetings. We don't
  // pull from `tagVocab` because the user may have vocab entries that no
  // meeting carries — filtering by them would never yield results.
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const m of meetings) {
      for (const t of m.tags) set.add(t);
    }
    return Array.from(set).sort();
  }, [meetings]);

  // If the active filter tag disappears (e.g. last meeting carrying it was
  // deleted), reset to "All" so the user isn't stuck looking at an empty list.
  useEffect(() => {
    if (tagFilter && !availableTags.includes(tagFilter)) {
      setTagFilter(null);
    }
  }, [tagFilter, availableTags]);

  const filteredMeetings = useMemo(() => {
    if (!tagFilter) return meetings;
    return meetings.filter((m) => m.tags.includes(tagFilter));
  }, [meetings, tagFilter]);

  // If a recording becomes active mid-session, flip to the creating view.
  useEffect(() => {
    if (active) setCreating(true);
  }, [active]);

  // ⌘F / Ctrl+F opens search regardless of which control currently has focus.
  // The native Find behaviour in the Tauri webview isn't useful (it would only
  // search visible DOM, missing notes that are scrolled offscreen or in
  // un-rendered detail views), so we intercept and surface our own search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Esc closes search. Only attached while search is open so it doesn't fight
  // with other Escape consumers in the rest of the app.
  useEffect(() => {
    if (!searchOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSearchOpen(false);
        setSearchQuery("");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  function openMeetingFromSearch(id: string) {
    setSearchOpen(false);
    setSearchQuery("");
    setCreating(false);
    void selectMeeting(id);
  }

  async function handleNewMeeting(mode: NewMeetingMode) {
    setNewMeetingMode(mode);
    if (mode === "record") {
      selectMeeting(null);
      setCreating(true);
    } else {
      try {
        setCreating(false);
        await createNotesMeetingAction();
      } catch (e) {
        toast.error("Failed to create notes meeting", { description: String(e) });
      }
    }
  }

  // Always show the chat panel for any opened meeting. If the meeting has no
  // content yet (empty notes / no transcript) the agent will simply tell the
  // user it has nothing to work with — surfacing the panel early lets the user
  // type the moment notes exist, instead of waiting for the layout to shift.
  // Search mode takes over the main area, so the chat panel hides during it.
  const showChatPanel =
    !!selected && !(active || creating) && !searchOpen;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <WorkflowPanelHeader
        panel="meetings"
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className={APP_HEADER_TITLE}>Meetings</h1>
          </>
        }
      />

      <div className="flex flex-1 min-h-0">
        {/* List pane */}
        <aside className="w-80 shrink-0 border-r flex flex-col bg-background/60">
          <div className="p-3 border-b">
            {transcriptionDisabled ? (
              <Button
                className="w-full"
                disabled={!!active && !creating}
                onClick={() => handleNewMeeting("notes")}
              >
                <NotebookPen className="h-4 w-4 mr-1.5" />
                Write notes
              </Button>
            ) : (
              <NewMeetingSplitButton
                mode={newMeetingMode}
                disabled={!!active && !creating}
                onPick={handleNewMeeting}
              />
            )}
          </div>
          {availableTags.length > 0 && (
            <TagFilterBar
              tags={availableTags}
              selected={tagFilter}
              onSelect={setTagFilter}
            />
          )}
          <MeetingsList
            meetings={filteredMeetings}
            totalCount={meetings.length}
            tagFilter={tagFilter}
            listLoaded={listLoaded}
            selectedId={selectedId}
            active={active}
            onSelect={(id) => {
              setCreating(false);
              selectMeeting(id);
            }}
          />
        </aside>

        {/* Detail + chat pane */}
        <div className="flex-1 min-w-0 flex min-h-0">
          <main className="flex-1 min-w-0 overflow-y-auto">
            {searchOpen ? (
              <SearchResultsView
                meetings={meetings}
                query={searchQuery}
                onQueryChange={setSearchQuery}
                onClose={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                }}
                onOpenMeeting={openMeetingFromSearch}
                inputRef={searchInputRef}
              />
            ) : active || creating ? (
              <ActiveRecordingView onStopped={() => setCreating(false)} />
            ) : selected ? (
              <MeetingDetailView record={selected} />
            ) : (
              <EmptyState />
            )}
          </main>
          {showChatPanel && selected && (
            <aside className="w-[420px] shrink-0 border-l bg-background/40 flex flex-col min-h-0">
              <MeetingChatPanel record={selected} />
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

// Split-button: clicking the main label runs the user's last-chosen mode
// (persisted in preferences); the chevron opens a small menu so they can pick
// the other mode and update the default. Self-closing on outside-click.
function NewMeetingSplitButton({
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

// ── Cross-meeting search ─────────────────────────────────────────────────────
//
// Cmd+F opens a Slack-style search overlay in the main panel. We index every
// meeting into a flat list of "snippets" — one per title, per non-empty notes
// line, and per transcript segment — then run the project's existing fuzzy
// scorer against the user's query. Each snippet renders as a card showing
// only the matching section, not the whole note, so the user isn't drowned
// in surrounding context. Clicking a card opens the underlying meeting.

interface MeetingSnippet {
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

function buildMeetingSnippets(meetings: MeetingRecord[]): MeetingSnippet[] {
  const out: MeetingSnippet[] = [];
  for (const m of meetings) {
    const base = {
      meetingId: m.id,
      meetingTitle: m.title || "Untitled meeting",
      meetingStartedAt: m.startedAt,
      meetingKind: (m.kind ?? "transcript") as MeetingKind,
    };
    if (m.title.trim()) {
      out.push({ ...base, source: "title", text: m.title });
    }
    if (m.notes) {
      // Notes are stored as TipTap JSON. Flatten to plain text so search
      // indexes the user's words rather than the editor's markup. Per-line
      // indexing keeps each result card scoped to one "section" of the note.
      const plain = extractTiptapPlainText(m.notes);
      const lines = plain.split("\n");
      for (const ln of lines) {
        if (ln.trim() === "") continue;
        out.push({ ...base, source: "notes", text: ln });
      }
    }
    for (const seg of m.segments) {
      if (!seg.text.trim()) continue;
      out.push({
        ...base,
        source: "transcript",
        text: seg.text,
        startSec: seg.startSec,
      });
    }
  }
  return out;
}

interface ScoredSnippet extends MeetingSnippet {
  score: number;
}

const MAX_RESULTS = 80;
const MAX_PER_MEETING = 4;

function searchMeetingSnippets(
  query: string,
  snippets: MeetingSnippet[],
): ScoredSnippet[] {
  const q = query.trim();
  if (!q) return [];
  const scored: ScoredSnippet[] = [];
  for (const s of snippets) {
    const score = fuzzyScore(q, s.text);
    if (score === null) continue;
    scored.push({ ...s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // Cap results per meeting so a single long transcript can't crowd the list.
  const perMeeting = new Map<string, number>();
  const capped: ScoredSnippet[] = [];
  for (const s of scored) {
    const c = perMeeting.get(s.meetingId) ?? 0;
    if (c >= MAX_PER_MEETING) continue;
    perMeeting.set(s.meetingId, c + 1);
    capped.push(s);
    if (capped.length >= MAX_RESULTS) break;
  }
  return capped;
}

// Render `text` with the literal substring of `query` highlighted (case-
// insensitive). When the only match is fuzzy/subsequence — meaning the
// substring isn't actually present — falls back to the plain text. We trim
// long lines around the match so each card stays compact.
function HighlightedSnippet({
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

function SearchResultsView({
  meetings,
  query,
  onQueryChange,
  onClose,
  onOpenMeeting,
  inputRef,
}: {
  meetings: MeetingRecord[];
  query: string;
  onQueryChange: (q: string) => void;
  onClose: () => void;
  onOpenMeeting: (id: string) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  // Index is purely a function of meetings — memo so typing in the search
  // input doesn't re-tokenise on every keystroke.
  const snippets = useMemo(() => buildMeetingSnippets(meetings), [meetings]);
  const results = useMemo(
    () => searchMeetingSnippets(query, snippets),
    [query, snippets],
  );

  const hitCountByMeeting = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of results) m.set(r.meetingId, (m.get(r.meetingId) ?? 0) + 1);
    return m;
  }, [results]);

  return (
    <div className="flex flex-col min-h-full">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="max-w-3xl mx-auto p-4 flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search meetings, notes, transcripts…"
            className="h-9 border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 px-1 text-sm"
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded border text-muted-foreground bg-muted">
            esc
          </kbd>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 shrink-0">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 max-w-3xl mx-auto w-full p-4 space-y-2">
        {!query.trim() ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-16 text-muted-foreground">
            <Search className="h-8 w-8" />
            <p className="text-sm">
              Type to search across {meetings.length} meeting
              {meetings.length === 1 ? "" : "s"} — titles, notes, and transcripts.
            </p>
            <p className="text-xs">Fuzzy matching · click a result to open the full meeting.</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-16 text-muted-foreground">
            <Search className="h-8 w-8" />
            <p className="text-sm">
              No results for{" "}
              <span className="font-mono text-foreground">{query.trim()}</span>.
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground px-1 pb-1">
              {results.length} match{results.length === 1 ? "" : "es"} across{" "}
              {hitCountByMeeting.size} meeting
              {hitCountByMeeting.size === 1 ? "" : "s"}
            </p>
            {results.map((r, i) => (
              <SearchResultCard
                key={`${r.meetingId}-${r.source}-${i}`}
                snippet={r}
                query={query}
                onOpen={() => onOpenMeeting(r.meetingId)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SearchResultCard({
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

function TagFilterBar({
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

// ── Meeting list ─────────────────────────────────────────────────────────────

function MeetingsList({
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

function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-3">
      <div className="rounded-full bg-muted p-4">
        <Mic className="h-7 w-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Capture meetings</h2>
        <p className="text-sm text-muted-foreground max-w-md">
          Record audio for local whisper transcription, or write freeform notes
          when recording is not allowed. Either way the AI can summarise the
          discussion. Start a new meeting or select a past meeting from the list.
        </p>
      </div>
    </div>
  );
}

// ── Active recording view ────────────────────────────────────────────────────

function ActiveRecordingView({ onStopped }: { onStopped: () => void }) {
  const active = useMeetingsStore((s) => s.active);
  const draftTitle = useMeetingsStore((s) => s.draftTitle);
  const draftTags = useMeetingsStore((s) => s.draftTags);
  const setDraftTitle = useMeetingsStore((s) => s.setDraftTitle);
  const setDraftTags = useMeetingsStore((s) => s.setDraftTags);
  const startRecording = useMeetingsStore((s) => s.startRecording);
  const pauseRecording = useMeetingsStore((s) => s.pauseRecording);
  const resumeRecording = useMeetingsStore((s) => s.resumeRecording);
  const stopRecording = useMeetingsStore((s) => s.stopRecording);
  const whisperModels = useMeetingsStore((s) => s.whisperModels);

  const [mics, setMics] = useState<MicrophoneInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("base.en");
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listMicrophones().then(setMics).catch(() => {});
    getPreferences().then((prefs) => {
      if (prefs["meeting_mic"]) setSelectedMic(prefs["meeting_mic"]);
      if (prefs["meeting_whisper_model"]) setSelectedModel(prefs["meeting_whisper_model"]);
    });
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [active?.segments.length]);

  const modelDownloaded = whisperModels.find((m) => m.id === selectedModel)?.downloaded ?? false;

  async function handleStart() {
    if (!modelDownloaded) {
      toast.error("Whisper model not downloaded", {
        description: `Download ${selectedModel} in Settings → Meetings before starting.`,
      });
      return;
    }
    setStarting(true);
    try {
      await startRecording(selectedModel, selectedMic || null);
    } catch (e) {
      toast.error("Failed to start recording", { description: String(e) });
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      const record = await stopRecording();
      if (record) {
        toast.success(`Saved meeting — ${formatDuration(record.durationSec)}`);
      }
      onStopped();
    } catch (e) {
      toast.error("Failed to stop", { description: String(e) });
    } finally {
      setStopping(false);
    }
  }

  const isLive = !!active;
  const state = active?.state ?? "idle";

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6 h-full flex flex-col">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-3">
          <Input
            value={isLive ? active.title : draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            disabled={isLive}
            placeholder="Meeting title (e.g., Sprint planning)"
            className="text-lg font-semibold h-10"
          />

          <TagEditor
            tags={isLive ? active.tags : draftTags}
            onChange={setDraftTags}
            disabled={isLive}
          />
        </div>
      </div>

      {/* Device + model (editable before starting) */}
      {!isLive && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Microphone</label>
                <select
                  value={selectedMic}
                  onChange={(e) => setSelectedMic(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— System default —</option>
                  {mics.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                      {m.is_default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Whisper model</label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {whisperModels.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.downloaded}>
                      {m.id} {m.downloaded ? "" : "(not downloaded)"}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {!modelDownloaded && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Download the {selectedModel} model from Settings → Meetings before starting.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Control bar */}
      <div className="flex items-center gap-3">
        {!isLive ? (
          <Button onClick={handleStart} disabled={starting || !modelDownloaded} size="lg">
            {starting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Start Transcribing
          </Button>
        ) : (
          <>
            {state === "recording" ? (
              <Button variant="outline" onClick={pauseRecording}>
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </Button>
            ) : (
              <Button variant="outline" onClick={resumeRecording}>
                <Play className="h-4 w-4 mr-2" />
                Resume
              </Button>
            )}
            <Button
              variant="destructive"
              onClick={handleStop}
              disabled={stopping || state === "stopping"}
            >
              {stopping ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Square className="h-4 w-4 mr-2" />
              )}
              Stop & save
            </Button>
            <div className="flex items-center gap-2 ml-auto">
              {state === "recording" && (
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
              )}
              <span className="font-mono text-sm text-muted-foreground">
                {formatTimestamp(active.elapsedSec)}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Transcript */}
      <Card className="flex-1 min-h-0 flex flex-col">
        <CardContent className="p-4 flex-1 flex flex-col min-h-0">
          <div className="text-xs text-muted-foreground mb-2 flex items-center justify-between">
            <span>Live transcript</span>
            {isLive && active.segments.length > 0 && (
              <span>{active.segments.length} segments</span>
            )}
          </div>
          <div
            ref={transcriptRef}
            className="flex-1 overflow-y-auto space-y-2 font-mono text-sm rounded-md bg-muted/40 p-3"
          >
            {!isLive ? (
              <p className="text-xs text-muted-foreground italic">
                Transcript will appear here in ~10-second chunks as you speak.
              </p>
            ) : active.segments.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                Listening... first segment arrives after ~10 seconds.
              </p>
            ) : (
              active.segments.map((seg, i) => (
                <div key={i} className="flex gap-3">
                  <span className="text-muted-foreground shrink-0">
                    {formatTimestamp(seg.startSec)}
                  </span>
                  <span>{seg.text}</span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Past meeting detail view ─────────────────────────────────────────────────

function MeetingDetailView({ record }: { record: MeetingRecord }) {
  const busy = useMeetingsStore((s) => s.busy);
  const summarizeSelected = useMeetingsStore((s) => s.summarizeSelected);
  const renameMeeting = useMeetingsStore((s) => s.renameMeeting);
  const setMeetingTags = useMeetingsStore((s) => s.setMeetingTags);
  const deleteSelectedMeeting = useMeetingsStore((s) => s.deleteSelectedMeeting);
  const renameSpeaker = useMeetingsStore((s) => s.renameSpeaker);
  const saveSelectedNotes = useMeetingsStore((s) => s.saveSelectedNotes);
  const notesLineHeight = useMeetingsStore((s) => s.notesLineHeight);
  const setNotesLineHeight = useMeetingsStore((s) => s.setNotesLineHeight);

  // Build a map from raw speaker id (e.g. "SPEAKER_00") to the user-assigned
  // name, so transcript rows can render the friendly label even when the
  // segment only carries the raw id.
  const speakerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const sp of record.speakers ?? []) {
      if (sp.displayName) map.set(sp.id, sp.displayName);
    }
    return map;
  }, [record.speakers]);

  const isNotesMode = record.kind === "notes";
  const hasDiarization = !isNotesMode && (record.speakers?.length ?? 0) > 0;

  const [title, setTitle] = useState(record.title);
  const isBusy = busy.has(record.id);

  // Local notes buffer with debounced persistence — emitting every TipTap
  // update through the Tauri command would thrash the on-disk JSON. Settles
  // ~600ms after the user stops typing; also flushed on blur. Holds the
  // serialised TipTap document JSON (or legacy plain text for old records).
  const [notes, setNotes] = useState(record.notes ?? "");
  const lastSavedNotesRef = useRef(record.notes ?? "");
  useEffect(() => {
    setNotes(record.notes ?? "");
    lastSavedNotesRef.current = record.notes ?? "";
  }, [record.id, record.notes]);
  useEffect(() => {
    if (!isNotesMode) return;
    if (notes === lastSavedNotesRef.current) return;
    const handle = window.setTimeout(() => {
      lastSavedNotesRef.current = notes;
      void saveSelectedNotes(notes);
    }, 600);
    return () => window.clearTimeout(handle);
  }, [notes, isNotesMode, saveSelectedNotes]);

  function flushNotes() {
    if (!isNotesMode) return;
    if (notes === lastSavedNotesRef.current) return;
    lastSavedNotesRef.current = notes;
    void saveSelectedNotes(notes);
  }

  // Keep local title synced if the record changes (e.g. after summary rename)
  useEffect(() => {
    setTitle(record.title);
  }, [record.id, record.title]);

  async function saveTitleIfChanged() {
    if (title.trim() && title !== record.title) {
      await renameMeeting(record.id, title.trim());
    }
  }

  const hasSummary = !!record.summary || record.actionItems.length > 0 || record.decisions.length > 0;
  // For notes-mode the buffer holds a serialised TipTap document; an "empty"
  // doc is `{"type":"doc","content":[{"type":"paragraph"}]}`, which still has
  // length > 0. Strip down to plain text before judging emptiness.
  const hasContent = isNotesMode
    ? extractTiptapPlainText(notes).length > 0
    : record.segments.length > 0;

  return (
    <div
      className={cn(
        "max-w-4xl mx-auto p-6",
        // Notes-mode fills the viewport so the editor can grow to the bottom
        // (with the container's p-6 padding acting as the breathing room the
        // user asked for). Transcript-mode keeps its natural block layout —
        // long transcript / summary content scrolls the outer <main>.
        isNotesMode ? "h-full flex flex-col gap-4" : "space-y-4",
      )}
    >
      <div className="flex items-start gap-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitleIfChanged}
          placeholder={isBusy ? "Generating title…" : "Untitled meeting"}
          className="text-lg font-semibold h-10"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const confirmed = await ask(
              isNotesMode
                ? "The notes will be permanently removed."
                : "The transcript will be permanently removed.",
              { title: "Delete this meeting?", kind: "warning" },
            );
            if (confirmed) void deleteSelectedMeeting();
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
        <span>{formatDate(record.startedAt)}</span>
        {isNotesMode ? (
          <>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <NotebookPen className="h-3 w-3" />
              Notes
            </span>
          </>
        ) : (
          <>
            <span>·</span>
            <span>{formatDuration(record.durationSec)}</span>
            <span>·</span>
            <span className="font-mono">{record.model}</span>
            <span>·</span>
            <span>{record.micDeviceName}</span>
          </>
        )}
      </div>

      <TagEditor
        tags={record.tags}
        onChange={(next) => setMeetingTags(record.id, next)}
      />

      {record.suggestedTitle &&
        record.title.trim() &&
        record.suggestedTitle !== record.title && (
          <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">AI-suggested title:</span>
            <span className="font-medium">{record.suggestedTitle}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2"
              onClick={() => {
                setTitle(record.suggestedTitle!);
                renameMeeting(record.id, record.suggestedTitle!);
              }}
            >
              Use
            </Button>
          </div>
        )}

      {(() => {
        // Both notes-mode and transcript-mode render the same Summary block;
        // we just place it differently — for notes-mode it sits beneath the
        // editor (so the user types first, then summarises), while transcript
        // mode keeps it above the read-only transcript. Hoisting to a local
        // const avoids duplicating ~80 lines of Summary JSX in each branch.
        const summarySection = (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Summary
              </h3>
              {hasSummary && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={summarizeSelected}
                  disabled={isBusy || !hasContent}
                  className="h-7"
                >
                  {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Regenerate
                </Button>
              )}
            </div>
            {!hasSummary ? (
              <Card>
                <CardContent className="p-6 flex flex-col items-center text-center gap-3">
                  <Sparkles className="h-6 w-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {isBusy
                      ? "Generating summary…"
                      : !hasContent
                        ? isNotesMode
                          ? "Type some notes above, then generate a summary."
                          : "No transcript available to summarise."
                        : isNotesMode
                          ? "Generate a summary of your notes."
                          : "Summary runs automatically after a meeting ends."}
                  </p>
                  {/* Always rendered so the user has a clear primary action;
                      disabled when there's nothing to summarise yet. */}
                  <Button
                    onClick={summarizeSelected}
                    size="sm"
                    disabled={isBusy || !hasContent}
                  >
                    {isBusy ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-2" />
                    )}
                    Generate summary
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {record.summary && (
                  <Card>
                    <CardContent className="p-4 space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Overview</p>
                      <p className="text-sm whitespace-pre-wrap">{record.summary}</p>
                    </CardContent>
                  </Card>
                )}
                {record.decisions.length > 0 && (
                  <Card>
                    <CardContent className="p-4 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Decisions</p>
                      <ul className="list-disc list-inside space-y-1 text-sm">
                        {record.decisions.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}
                {record.actionItems.length > 0 && (
                  <Card>
                    <CardContent className="p-4 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Action items</p>
                      <ul className="list-disc list-inside space-y-1 text-sm">
                        {record.actionItems.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </section>
        );

        const speakersSection = hasDiarization && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" /> Speakers
              </h3>
            </div>
            <Card>
              <CardContent className="p-4 space-y-2">
                {(record.speakers ?? []).map((sp) => (
                  <SpeakerRow
                    key={sp.id}
                    id={sp.id}
                    displayName={sp.displayName ?? null}
                    candidates={sp.candidates ?? []}
                    onRename={(name) => renameSpeaker(sp.id, name)}
                  />
                ))}
              </CardContent>
            </Card>
          </section>
        );

        const notesSection = (
          /* Notes editor — TipTap WYSIWYG. Renders bold, italic, headings,
           * bullet/numbered/task lists inline; the user never sees raw
           * markdown. We persist the editor's native JSON document and convert
           * to plain markdown only when feeding the AI summary / chat / retro
           * agents (extractTiptapPlainText). Keyed on record.id so switching
           * to a different meeting re-hydrates with the new doc rather than
           * silently editing the wrong record.
           *
           * The flex chain (section → Card → CardContent → editor) is what
           * makes the editor stretch to the bottom of the viewport.
           */
          <section className="flex-1 min-h-0 flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Notes
            </h3>
            <Card className="flex-1 min-h-0 flex flex-col">
              <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
                <RichNotesEditor
                  key={record.id}
                  value={record.notes ?? null}
                  onChange={setNotes}
                  onBlur={flushNotes}
                  lineHeight={notesLineHeight}
                  onLineHeightChange={setNotesLineHeight}
                  placeholder="Start typing. Use the toolbar above for headings, lists, checkboxes, bold, and italic."
                />
              </CardContent>
            </Card>
          </section>
        );

        const transcriptSection = (
          /* Transcript view — read-only segments captured by Whisper. */
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Transcript
            </h3>
            <Card>
              <CardContent className="p-4">
                {record.segments.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">
                    No transcript was captured for this meeting.
                  </p>
                ) : (
                  <div className="space-y-2 font-mono text-sm">
                    {record.segments.map((seg, i) => {
                      const label = seg.speakerId
                        ? speakerNameById.get(seg.speakerId) ?? seg.speakerId
                        : null;
                      return (
                        <div key={i} className="flex gap-3">
                          <span className="text-muted-foreground shrink-0 w-12">
                            {formatTimestamp(seg.startSec)}
                          </span>
                          {label && (
                            <span className="shrink-0 w-32 font-semibold text-primary/90 truncate">
                              {label}
                            </span>
                          )}
                          <span className="min-w-0">{seg.text}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        );

        // Notes-mode skips the persistent Summary section entirely — for
        // hand-written notes the chat panel is the right surface for
        // on-demand summaries (the user can ask "summarise this" any time).
        // Transcript-mode keeps the historical order so the post-recording
        // flow is unchanged.
        return isNotesMode ? (
          notesSection
        ) : (
          <>
            {summarySection}
            {speakersSection}
            {transcriptSection}
          </>
        );
      })()}
    </div>
  );
}

function SpeakerRow({
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

function MeetingChatPanel({ record }: { record: MeetingRecord }) {
  const busy = useMeetingsStore((s) => s.busy);
  const sendChatMessage = useMeetingsStore((s) => s.sendChatMessage);
  const summarizeSelected = useMeetingsStore((s) => s.summarizeSelected);
  const clearSelectedChat = useMeetingsStore((s) => s.clearSelectedChat);
  const dropLastAssistantTurn = useMeetingsStore((s) => s.dropLastAssistantTurn);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const isBusy = busy.has(record.id);
  const history = record.chatHistory ?? [];

  // Auto-scroll to the latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, isBusy]);

  // Resolve speaker id → name for the /speakers output.
  const speakerLines = useMemo(() => {
    const lines: string[] = [];
    for (const sp of record.speakers ?? []) {
      lines.push(
        sp.displayName ? `${sp.id} — ${sp.displayName}` : `${sp.id} (unnamed)`,
      );
    }
    return lines;
  }, [record.speakers]);

  // Notes-mode meetings have no transcript, no speakers, no audio timestamps,
  // and no persistent Summary section — so the slash commands tied to those
  // surfaces aren't useful. Hide them so the picker only shows commands that
  // actually do something.
  const isNotesMode = record.kind === "notes";

  const commands: SlashCommand[] = useMemo(() => {
    const transcriptOnly: SlashCommand[] = [
      {
        name: "summarize",
        description: "Regenerate this meeting's summary",
        execute: async () => {
          await summarizeSelected();
          toast.success("Regenerating summary…");
        },
      },
      {
        name: "speakers",
        description: "List speakers and any names assigned",
        execute: ({ toast: t }) => {
          if (speakerLines.length === 0) {
            t.info("No speakers have been detected for this meeting");
            return;
          }
          t("Speakers", { description: speakerLines.join("\n") });
        },
      },
      {
        name: "transcript",
        description: "Ask for the full diarized transcript",
        execute: async () => {
          await sendChatMessage(
            "Please provide the full diarized transcript in a readable form, with speaker names where known.",
          );
        },
      },
      {
        name: "at",
        description: "Focus the next question on a timestamp",
        args: "HH:MM",
        execute: ({ args, setInput }) => {
          const ts = args.trim();
          if (!ts) {
            setInput("/at ");
            return;
          }
          setInput(`At ${ts} — `);
        },
      },
    ];

    const shared: SlashCommand[] = [
      {
        name: "actions",
        description: "Ask for just the action items",
        execute: async () => {
          await sendChatMessage(
            "List just the action items from this meeting as a bulleted list, with the owner if mentioned.",
          );
        },
      },
      {
        name: "decisions",
        description: "Ask for just the decisions made",
        execute: async () => {
          await sendChatMessage(
            "List just the decisions that were made during this meeting as a bulleted list.",
          );
        },
      },
    ];

    return [
      ...createGlobalCommands({
        history,
        clearHistory: clearSelectedChat,
        sendMessage: sendChatMessage,
        removeLastAssistantMessage: dropLastAssistantTurn,
      }),
      ...(isNotesMode ? [] : transcriptOnly),
      ...shared,
    ];
  }, [
    history,
    clearSelectedChat,
    sendChatMessage,
    dropLastAssistantTurn,
    summarizeSelected,
    speakerLines,
    isNotesMode,
  ]);

  return (
    <>
      <div className="shrink-0 px-4 py-2.5 border-b flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Ask about this meeting
        </p>
        {isBusy && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground italic text-center pt-6">
            Ask anything about this meeting — what was discussed, decisions made,
            action items, or details you want to recall. Type <span className="font-mono">/</span> to see commands.
          </p>
        ) : (
          history.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "flex",
                msg.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}
        {isBusy && (
          <div className="flex justify-start pt-1">
            <div className="bg-muted rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2 border-t">
        <SlashCommandInput
          value={input}
          onChange={setInput}
          onSend={async (text) => {
            try {
              await sendChatMessage(text);
            } catch (e) {
              toast.error("Chat failed", { description: String(e) });
            }
          }}
          commands={commands}
          busy={isBusy}
          placeholder="Ask about this meeting. Enter to send. / for commands."
        />
      </div>
    </>
  );
}

// ── Tag editor ───────────────────────────────────────────────────────────────
//
// Renders the union of DEFAULT_TAGS and whatever extra tags the meeting already
// carries, so custom tags stay visible as selectable pills. Custom tags get a
// small red × badge overlapping their top-right corner for deletion (the
// built-in defaults are non-destructive — click the pill to deselect).

function TagEditor({
  tags,
  onChange,
  disabled,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const tagVocab = useMeetingsStore((s) => s.tagVocab);
  const addTagToVocab = useMeetingsStore((s) => s.addTagToVocab);
  const removeTagFromVocab = useMeetingsStore((s) => s.removeTagFromVocab);

  // Pill list = persisted vocab ∪ any tags already on this meeting that
  // aren't in the vocab (e.g. a historical meeting whose tag was later
  // removed from the vocabulary). Preserves vocab order; meeting-only tags
  // are appended.
  const allTags = useMemo(() => {
    const vocabSet = new Set(tagVocab);
    const extras = tags.filter((t) => !vocabSet.has(t));
    return [...tagVocab, ...extras];
  }, [tagVocab, tags]);

  function toggle(tag: string) {
    if (disabled) return;
    const next = tags.includes(tag)
      ? tags.filter((t) => t !== tag)
      : [...tags, tag];
    onChange(next);
  }

  function removePill(tag: string) {
    if (disabled) return;
    // Remove from both the vocab (persisted) and this meeting's selection.
    // Other meetings that still have this tag keep it — they just won't see
    // it as a clickable pill unless they re-add it.
    removeTagFromVocab(tag);
    onChange(tags.filter((t) => t !== tag));
  }

  function addTag(raw: string) {
    const t = raw.trim().toLowerCase();
    if (!t) return;
    addTagToVocab(t);
    if (!tags.includes(t)) onChange([...tags, t]);
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
      {allTags.map((t) => {
        const selected = tags.includes(t);
        return (
          <div key={t} className="relative group">
            <button
              disabled={disabled}
              onClick={() => toggle(t)}
              className={cn(
                "text-xs px-2 py-1 rounded-full border transition-colors",
                selected
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground hover:bg-muted border-input",
                disabled && "opacity-60 cursor-not-allowed",
              )}
            >
              {t}
            </button>
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removePill(t);
                }}
                className="absolute top-0 right-0 translate-x-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-red-500 text-white flex items-center justify-center shadow-sm focus:outline-none focus:ring-1 focus:ring-red-400 opacity-0 group-hover:opacity-40 hover:!opacity-100 transition-opacity duration-150"
              >
                <X className="h-2.5 w-2.5" strokeWidth={3} />
              </button>
            )}
          </div>
        );
      })}
      {!disabled && <AddTagPill onSubmit={addTag} />}
    </div>
  );
}

// "+" pill that animates open into an editable text field. Matches the size
// and rounded-full silhouette of the tag pills so it visually sits with them;
// the inner content swaps between a Plus icon and an input, while the pill
// itself transitions width between a compact ~28px and a roomier ~112px.
function AddTagPill({ onSubmit }: { onSubmit: (value: string) => void }) {
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

function formatDate(iso: string): string {
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

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
