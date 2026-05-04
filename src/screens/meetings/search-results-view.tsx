import { TokenSuggestPopover } from "@/components/TokenSuggestPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fuzzyScore } from "@/lib/fuzzySearch";
import {
    gatherNamePool,
    gatherTagPool,
    participantsForMeeting,
} from "@/lib/meetingPeople";
import {
    meetingMatchesNames,
    meetingMatchesTags,
    parseTaggedQuery,
} from "@/lib/taggedQuery";
import { type MeetingKind, type MeetingRecord } from "@/lib/tauri/meetings";
import { extractTiptapPlainText } from "@/lib/tiptapText";
import { Search, X } from "lucide-react";
import { useMemo } from "react";
import {
    SearchResultCard,
    type MeetingSnippet,
    type ScoredSnippet,
} from "./_shared";

// ── Cross-meeting search ─────────────────────────────────────────────────────
//
// Cmd+F opens a Slack-style search overlay in the main panel. We index every
// meeting into a flat list of "snippets" — one per title, per non-empty notes
// line, and per transcript segment — then run the project's existing fuzzy
// scorer against the user's query. Each snippet renders as a card showing
// only the matching section, not the whole note, so the user isn't drowned
// in surrounding context. Clicking a card opens the underlying meeting.

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

export function SearchResultsView({
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
  // Pull `#tag` and `@name` filters out of the raw query first so the
  // rest of the pipeline sees a clean prose residual. Both halves
  // recompute every keystroke; the parse itself is microsecond-cheap.
  const { tags, names, residual } = useMemo(
    () => parseTaggedQuery(query),
    [query],
  );

  // Apply the tag + name filters to the meeting universe before snippet-
  // building so a single long transcript without matching metadata can't
  // crowd the index. When neither filter is specified this is identity.
  const tagFilteredMeetings = useMemo(() => {
    if (tags.length === 0 && names.length === 0) return meetings;
    return meetings.filter(
      (m) =>
        meetingMatchesTags(m.tags, tags) &&
        meetingMatchesNames(participantsForMeeting(m), names),
    );
  }, [meetings, tags, names]);

  const snippets = useMemo(
    () => buildMeetingSnippets(tagFilteredMeetings),
    [tagFilteredMeetings],
  );

  // Three modes:
  //   - residual + filters : fuzzy search the residual within the filtered meetings
  //   - residual only      : fuzzy search every meeting (existing behaviour)
  //   - filters only       : list the filtered meetings as title-only synthetic
  //                          snippets so the user can pick one even without prose
  const hasFilter = tags.length > 0 || names.length > 0;
  const results = useMemo<ScoredSnippet[]>(() => {
    if (residual) return searchMeetingSnippets(residual, snippets);
    if (!hasFilter) return [];
    return tagFilteredMeetings.map((m) => ({
      meetingId: m.id,
      meetingTitle: m.title || "Untitled meeting",
      meetingStartedAt: m.startedAt,
      meetingKind: (m.kind ?? "transcript") as MeetingKind,
      source: "title" as const,
      text: m.title || "Untitled meeting",
      score: 0,
    }));
  }, [residual, hasFilter, snippets, tagFilteredMeetings]);

  const hitCountByMeeting = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of results) m.set(r.meetingId, (m.get(r.meetingId) ?? 0) + 1);
    return m;
  }, [results]);

  const tagPool = useMemo(() => gatherTagPool(meetings), [meetings]);
  const namePool = useMemo(() => gatherNamePool(meetings), [meetings]);

  return (
    <div className="flex flex-col min-h-full">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="max-w-3xl mx-auto p-4 flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search meetings, notes, transcripts… (filter with #tag and @name)"
            className="h-9 border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 px-1 text-sm"
          />
          <TokenSuggestPopover
            value={query}
            onChange={onQueryChange}
            inputRef={inputRef}
            tagPool={tagPool}
            namePool={namePool}
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
            <p className="text-xs">
              Fuzzy matching · prefix <span className="font-mono">#tag</span> or{" "}
              <span className="font-mono">@name</span> to filter · click a result to open.
            </p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-16 text-muted-foreground">
            <Search className="h-8 w-8" />
            <p className="text-sm">
              No results for{" "}
              <span className="font-mono text-foreground">{query.trim()}</span>.
            </p>
            {hasFilter && tagFilteredMeetings.length === 0 && (
              <p className="text-xs">
                No meetings match{" "}
                {[
                  ...tags.map((t) => `#${t}`),
                  ...names.map((n) => `@${n}`),
                ].map((tok, i, arr) => (
                  <span key={tok}>
                    <span className="font-mono text-foreground">{tok}</span>
                    {i < arr.length - 1 ? " " : ""}
                  </span>
                ))}
                .
              </p>
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground px-1 pb-1">
              {results.length} match{results.length === 1 ? "" : "es"} across{" "}
              {hitCountByMeeting.size} meeting
              {hitCountByMeeting.size === 1 ? "" : "s"}
              {hasFilter && (
                <>
                  {" "}filtered by{" "}
                  {[
                    ...tags.map((t) => `#${t}`),
                    ...names.map((n) => `@${n}`),
                  ].map((tok, i, arr) => (
                    <span key={tok}>
                      <span className="font-mono text-foreground">{tok}</span>
                      {i < arr.length - 1 ? " " : ""}
                    </span>
                  ))}
                </>
              )}
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
