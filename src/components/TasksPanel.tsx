/**
 * Right-side panel listing every outstanding task across the app.
 *
 * Two sources of truth:
 *   • Manual tasks — own store, persisted in tasks.json on disk.
 *   • Meeting tasks — unchecked TipTap taskItem nodes inside each notes-mode
 *     meeting. Pulled lazily and written back to the source meeting's notes
 *     JSON when toggled.
 *
 * Completed tasks fall out of the list as soon as they're checked. To recover
 * one, the user opens the source (manual: nowhere yet — could add a "Show
 * completed" toggle later; meeting: open the meeting and uncheck inline).
 */

import { useMemo, useState } from "react";
import { Plus, X, ListTodo, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTasksStore } from "@/stores/tasksStore";
import { useMeetingsStore } from "@/stores/meetingsStore";
import { useOpenMeetings } from "@/context/OpenMeetingsContext";
import {
  extractNotesTaskItems,
  setTaskCheckedAtPath,
  type NotesTaskItem,
} from "@/lib/tiptapTasks";
import { toast } from "sonner";

interface MeetingGroup {
  meetingId: string;
  meetingTitle: string;
  meetingStartedAt: string;
  items: NotesTaskItem[];
}

export function TasksPanel() {
  const panelOpen = useTasksStore((s) => s.panelOpen);
  const panelWidth = useTasksStore((s) => s.panelWidth);
  const resizePanel = useTasksStore((s) => s.resizePanel);
  const persistPanelWidth = useTasksStore((s) => s.persistPanelWidth);
  const tasks = useTasksStore((s) => s.tasks);
  const loaded = useTasksStore((s) => s.loaded);
  const addTask = useTasksStore((s) => s.addTask);
  const setTaskCompleted = useTasksStore((s) => s.setTaskCompleted);
  const removeTask = useTasksStore((s) => s.removeTask);
  const setPanelOpen = useTasksStore((s) => s.setPanelOpen);

  const meetings = useMeetingsStore((s) => s.meetings);
  const selectMeeting = useMeetingsStore((s) => s.selectMeeting);
  const saveNotesForMeeting = useMeetingsStore((s) => s.saveNotesForMeeting);

  const openMeetings = useOpenMeetings();

  const [draft, setDraft] = useState("");

  const outstandingManual = useMemo(
    () => tasks.filter((t) => !t.completed),
    [tasks],
  );

  // Build per-meeting groups of unchecked taskItems. Sorted by the meeting's
  // start time descending so the most recent meeting's tasks appear first
  // — that's where active follow-ups usually live.
  const meetingGroups = useMemo<MeetingGroup[]>(() => {
    const groups: MeetingGroup[] = [];
    for (const m of meetings) {
      if (m.kind !== "notes" || !m.notes) continue;
      const items = extractNotesTaskItems(m.notes).filter(
        (it) => !it.checked && it.text.length > 0,
      );
      if (items.length === 0) continue;
      groups.push({
        meetingId: m.id,
        meetingTitle: m.title.trim() || "Untitled meeting",
        meetingStartedAt: m.startedAt,
        items,
      });
    }
    groups.sort((a, b) => b.meetingStartedAt.localeCompare(a.meetingStartedAt));
    return groups;
  }, [meetings]);

  const totalCount = outstandingManual.length +
    meetingGroups.reduce((sum, g) => sum + g.items.length, 0);

  if (!panelOpen) return null;

  async function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await addTask(text);
    } catch (e) {
      toast.error("Failed to add task", { description: String(e) });
    }
  }

  async function checkMeetingTask(group: MeetingGroup, item: NotesTaskItem) {
    const meeting = meetings.find((m) => m.id === group.meetingId);
    if (!meeting?.notes) return;
    const next = setTaskCheckedAtPath(meeting.notes, item.path, true);
    if (!next) {
      // The notes have changed since we built the index (path no longer
      // resolves to a taskItem). Tell the user instead of silently failing.
      toast.error("Couldn't update that task", {
        description: "The notes have changed — open the meeting to check it off.",
      });
      return;
    }
    try {
      await saveNotesForMeeting(group.meetingId, next);
    } catch (e) {
      toast.error("Failed to save", { description: String(e) });
    }
  }

  function openMeeting(meetingId: string) {
    void selectMeeting(meetingId);
    openMeetings();
  }

  return (
    <aside
      // Fixed overlay so the panel sits to the right of every screen without
      // each screen needing to know about it. The App wrapper provides the
      // matching `padding-right` when this is open so screen content isn't
      // hidden behind the panel.
      className="fixed inset-y-0 right-0 z-30 border-l bg-background flex flex-col min-h-0"
      style={{ width: panelWidth }}
      aria-label="Tasks panel"
    >
      <ResizeHandle resize={resizePanel} commit={persistPanelWidth} />
      <header className="px-4 py-3 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListTodo className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Tasks</h2>
          {loaded && totalCount > 0 && (
            <span className="text-xs text-muted-foreground">{totalCount}</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setPanelOpen(false)}
          aria-label="Hide tasks"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="px-3 py-2 border-b">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitDraft();
          }}
          className="flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-1" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a task…"
            className="h-8 text-sm border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 px-1"
          />
        </form>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!loaded ? (
          <div className="px-4 py-6 text-xs text-muted-foreground">Loading…</div>
        ) : totalCount === 0 ? (
          <EmptyState />
        ) : (
          <div className="py-2">
            {outstandingManual.length > 0 && (
              <Section title="Manual">
                {outstandingManual.map((t) => (
                  <ManualTaskRow
                    key={t.id}
                    text={t.text}
                    onCheck={() => void setTaskCompleted(t.id, true)}
                    onDelete={() => void removeTask(t.id)}
                  />
                ))}
              </Section>
            )}

            {meetingGroups.length > 0 && (
              <Section title="From meetings">
                {meetingGroups.map((g) => (
                  <div key={g.meetingId} className="space-y-0.5">
                    <button
                      onClick={() => openMeeting(g.meetingId)}
                      className="w-full text-left px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground truncate"
                      title={g.meetingTitle}
                    >
                      {g.meetingTitle}
                    </button>
                    {g.items.map((item, i) => (
                      <MeetingTaskRow
                        key={`${g.meetingId}-${i}`}
                        text={item.text}
                        onCheck={() => void checkMeetingTask(g, item)}
                        onOpen={() => openMeeting(g.meetingId)}
                      />
                    ))}
                  </div>
                ))}
              </Section>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

// Thin draggable strip pinned to the panel's left edge. While the user holds
// the mouse, it streams width updates to the store; on release it asks the
// store to persist the final value to preferences. We listen on `document`
// rather than the handle itself so a fast drag that overshoots the strip
// doesn't drop tracking.
function ResizeHandle({
  resize,
  commit,
}: {
  resize: (w: number) => void;
  commit: () => void;
}) {
  const [dragging, setDragging] = useState(false);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);

    function onMove(ev: MouseEvent) {
      // Panel is anchored to the right edge of the viewport, so its width is
      // simply how far the cursor sits from the right edge. The store clamps
      // to min/max so we don't have to.
      resize(window.innerWidth - ev.clientX);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // Restore default cursor and text selection on the document body.
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
      commit();
    }

    // Force the col-resize cursor everywhere during drag so it doesn't flicker
    // when the cursor briefly leaves the handle. Disable text selection so
    // dragging doesn't accidentally select chunks of the screen content.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize tasks panel"
      onMouseDown={onMouseDown}
      className={cn(
        // 4 px wide hit area; visually shows a 1 px line on hover/drag so the
        // resize affordance is obvious without being intrusive at rest.
        "absolute inset-y-0 left-0 w-1 cursor-col-resize z-10",
        "before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border",
        "hover:before:bg-primary/60",
        dragging && "before:bg-primary",
      )}
    />
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-3">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
        {title}
      </div>
      {children}
    </section>
  );
}

function ManualTaskRow({
  text,
  onCheck,
  onDelete,
}: {
  text: string;
  onCheck: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-start gap-2 px-3 py-1.5 hover:bg-muted/40">
      <Checkbox onCheck={onCheck} />
      <span className="flex-1 text-sm leading-tight">{text}</span>
      <button
        onClick={onDelete}
        title="Delete task"
        aria-label="Delete task"
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0 mt-0.5"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function MeetingTaskRow({
  text,
  onCheck,
  onOpen,
}: {
  text: string;
  onCheck: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 hover:bg-muted/40">
      <Checkbox onCheck={onCheck} />
      <button
        onClick={onOpen}
        // Click the text to jump to the meeting; click the checkbox to mark
        // done (handled separately above so clicks don't fall through).
        className="flex-1 text-left text-sm leading-tight hover:underline"
      >
        {text}
      </button>
    </div>
  );
}

function Checkbox({ onCheck }: { onCheck: () => void }) {
  return (
    <button
      onClick={onCheck}
      aria-label="Mark complete"
      title="Mark complete"
      className={cn(
        "mt-0.5 h-4 w-4 shrink-0 rounded border border-input hover:border-primary",
        "transition-colors flex items-center justify-center",
      )}
    >
      {/* Empty until checked — the row vanishes from the panel on check, so
          there's no transient checked-state to render here. */}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-10 px-6 text-muted-foreground">
      <ListTodo className="h-7 w-7" />
      <p className="text-sm">No outstanding tasks.</p>
      <p className="text-xs">
        Add one above, or use the checklist tool in a meeting's notes.
      </p>
    </div>
  );
}
