import { APP_HEADER_TITLE, WorkflowPanelHeader } from "@/components/appHeaderLayout";
import { CrossMeetingsChatPanel } from "@/components/CrossMeetingsChatPanel";
import { Button } from "@/components/ui/button";
import { useMeetingsStore } from "@/stores/meetings/store";
import { type NewMeetingMode } from "@/stores/meetings/types";
import {
    ArrowLeft,
    Mic,
    NotebookPen,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { TagFilterBar } from "./meetings/_shared";
import { ActiveRecordingView } from "./meetings/active-recording-view";
import { MeetingChatPanel } from "./meetings/meeting-chat-panel";
import { MeetingDetailView } from "./meetings/meeting-detail-view";
import { MeetingsList } from "./meetings/meetings-list";
import { NewMeetingSplitButton } from "./meetings/new-meeting-split-button";
import { SearchResultsView } from "./meetings/search-results-view";

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

  // Chat panel is always available unless a fullscreen mode is active.
  // When a meeting is selected it shows the per-meeting Q&A (with a
  // /search slash command for cross-meetings RAG); when no meeting
  // is open it falls back to the dedicated cross-meetings panel so
  // the user can ask "find that conversation about X" the moment they
  // land on the panel, without first picking a meeting. The search
  // overlay only takes over the main area — the chat aside stays
  // visible alongside it so the user can pivot between scanning
  // results and asking the agent without losing the conversation.
  const showChatPanel = !(active || creating);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <WorkflowPanelHeader
        panel="meetings"
        leading={
          <>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className={APP_HEADER_TITLE}>Meetings</h1>
          </>
        }
      />

      <div className="flex flex-1 min-h-0">
        {/* List pane */}
        <aside className="w-80 shrink-0 border-r flex flex-col h-full min-h-0 bg-background/60">
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
              <EmptyState transcriptionDisabled={transcriptionDisabled} />
            )}
          </main>
          {showChatPanel && (
            <aside className="w-[420px] shrink-0 border-l bg-background/40 flex flex-col h-full min-h-0">
              {selected ? (
                <MeetingChatPanel record={selected} />
              ) : (
                <CrossMeetingsChatPanel
                  compact
                  onOpenMeeting={(id) => {
                    setCreating(false);
                    void selectMeeting(id);
                  }}
                />
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ transcriptionDisabled }: { transcriptionDisabled: boolean }) {
  // Pencil-on-paper when transcription is off (notes is the only path);
  // mic when transcription is on (recording is the primary action).
  const Icon = transcriptionDisabled ? NotebookPen : Mic;
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-3">
      <div className="rounded-full bg-muted p-4">
        <Icon className="h-7 w-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        {transcriptionDisabled ? (
          <>
            <h2 className="text-lg font-semibold">Write meeting notes</h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Capture freeform notes during your meetings. Start a new one or
              select a past meeting from the list.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">Capture meetings</h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Record audio for local whisper transcription, or write freeform
              notes when recording is not allowed. Either way the AI can
              summarise the discussion. Start a new meeting or select a past
              meeting from the list.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
