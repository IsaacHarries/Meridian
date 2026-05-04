import { RichNotesEditor } from "@/components/RichNotesEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { type MeetingRecord } from "@/lib/tauri/meetings";
import { extractTiptapPlainText } from "@/lib/tiptapText";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/stores/meetings/helpers";
import { useMeetingsStore } from "@/stores/meetings/store";
import { ask } from "@tauri-apps/plugin-dialog";
import {
    FileText,
    Loader2,
    NotebookPen,
    Sparkles,
    Trash2,
    Users,
    X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SpeakerRow, formatDate, formatDuration } from "./_shared";
import { TagEditor } from "./tag-editor";

// ── Past meeting detail view ─────────────────────────────────────────────────

export function MeetingDetailView({ record }: { record: MeetingRecord }) {
  const busy = useMeetingsStore((s) => s.busy);
  const summaryPartial = useMeetingsStore(
    (s) => s.summaryStreamPartial[record.id],
  );
  const selectMeeting = useMeetingsStore((s) => s.selectMeeting);
  const summarizeSelected = useMeetingsStore((s) => s.summarizeSelected);
  const generateTitleForSelected = useMeetingsStore((s) => s.generateTitleForSelected);
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

  // While a summary is streaming we render fields directly off the partial
  // JSON (so they fill in live), otherwise off the saved record.
  const hasPartial =
    isBusy &&
    summaryPartial != null &&
    (!!summaryPartial.summary ||
      (summaryPartial.actionItems?.length ?? 0) > 0 ||
      (summaryPartial.decisions?.length ?? 0) > 0 ||
      (summaryPartial.perPerson?.length ?? 0) > 0);
  const summaryView: {
    summary: string | null;
    actionItems: string[];
    decisions: string[];
    perPerson: { name: string; summary: string; actionItems: string[] }[];
  } = hasPartial
    ? {
        summary: summaryPartial?.summary ?? null,
        actionItems: (summaryPartial?.actionItems ?? []).filter(
          (s): s is string => typeof s === "string",
        ),
        decisions: (summaryPartial?.decisions ?? []).filter(
          (s): s is string => typeof s === "string",
        ),
        perPerson: (summaryPartial?.perPerson ?? [])
          .filter((p) => p && typeof p === "object")
          .map((p) => ({
            name: typeof p.name === "string" ? p.name : "",
            summary: typeof p.summary === "string" ? p.summary : "",
            actionItems: Array.isArray(p.actionItems)
              ? p.actionItems.filter((a): a is string => typeof a === "string")
              : [],
          })),
      }
    : {
        summary: record.summary,
        actionItems: record.actionItems,
        decisions: record.decisions,
        perPerson: record.perPerson ?? [],
      };
  const hasSummary =
    !!summaryView.summary ||
    summaryView.actionItems.length > 0 ||
    summaryView.decisions.length > 0 ||
    summaryView.perPerson.length > 0;
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
        <div className="relative flex-1">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitleIfChanged}
            placeholder={isBusy ? "Generating title…" : "Untitled meeting"}
            // Right-pad so the inline generate button never overlaps text.
            className="text-lg font-semibold h-10 pr-10"
          />
          {/* Inline regenerate button — only renders when the title field is
              empty, so a meeting with a real title doesn't show a stray
              control inside the field. Disabled (and hidden) once present
              text is typed; clicking generates a title from the meeting
              content, or falls back to date+time when content is empty. */}
          {title.trim().length === 0 && (
            <button
              type="button"
              onClick={() => void generateTitleForSelected()}
              disabled={isBusy}
              aria-label="Generate title with AI"
              title="Generate title"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
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
          title="Delete meeting"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void selectMeeting(null)}
          title="Close meeting"
        >
          <X className="h-4 w-4" />
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
                {hasPartial && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Generating summary…</span>
                  </div>
                )}
                {summaryView.summary && (
                  <Card>
                    <CardContent className="p-4 space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Overview</p>
                      <p className="text-sm whitespace-pre-wrap">{summaryView.summary}</p>
                    </CardContent>
                  </Card>
                )}
                {summaryView.decisions.length > 0 && (
                  <Card>
                    <CardContent className="p-4 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Decisions</p>
                      <ul className="list-disc list-inside space-y-1 text-sm">
                        {summaryView.decisions.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}
                {summaryView.actionItems.length > 0 && (
                  <Card>
                    <CardContent className="p-4 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Action items</p>
                      <ul className="list-disc list-inside space-y-1 text-sm">
                        {summaryView.actionItems.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}
                {summaryView.perPerson.length > 0 && (
                  <Card>
                    <CardContent className="p-4 space-y-3">
                      <p className="text-xs font-medium text-muted-foreground">Per person</p>
                      <div className="space-y-3">
                        {summaryView.perPerson.map((p, i) => (
                          <div key={i} className="space-y-1">
                            <p className="text-sm font-medium">{p.name}</p>
                            {p.summary && (
                              <p className="text-sm whitespace-pre-wrap">{p.summary}</p>
                            )}
                            {p.actionItems.length > 0 && (
                              <ul className="list-disc list-inside space-y-0.5 text-sm">
                                {p.actionItems.map((a, j) => (
                                  <li key={j}>{a}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
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
