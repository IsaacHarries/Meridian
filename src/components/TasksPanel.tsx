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

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, ListTodo, Tag, ChevronDown, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTasksStore } from "@/stores/tasksStore";
import { useMeetingsStore } from "@/stores/meetingsStore";
import { usePrTasksStore } from "@/stores/prTasksStore";
import { useOpenMeetings } from "@/context/OpenMeetingsContext";
import {
  extractNotesTaskItems,
  setTaskCheckedAtPath,
  type NotesTaskItem,
} from "@/lib/tiptapTasks";
import { type TaskRecord, openUrl } from "@/lib/tauri";
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
  const setTaskCategory = useTasksStore((s) => s.setTaskCategory);
  const setPanelOpen = useTasksStore((s) => s.setPanelOpen);

  const meetings = useMeetingsStore((s) => s.meetings);
  const selectMeeting = useMeetingsStore((s) => s.selectMeeting);
  const saveNotesForMeeting = useMeetingsStore((s) => s.saveNotesForMeeting);

  const prTaskGroups = usePrTasksStore((s) => s.entries);
  const resolvePrTaskAction = usePrTasksStore((s) => s.resolveTask);
  const refreshPrTasks = usePrTasksStore((s) => s.refresh);

  // Refresh PR tasks every time the user opens the panel — the
  // background poll only runs hourly, so opening the panel after a
  // while otherwise risks showing stale data. The store guards against
  // overlapping refreshes itself.
  useEffect(() => {
    if (panelOpen) void refreshPrTasks();
  }, [panelOpen, refreshPrTasks]);

  const openMeetings = useOpenMeetings();

  const [draft, setDraft] = useState("");
  // Sticky category for the input — once picked, subsequent tasks default to
  // the same category until the user changes it. `null` = uncategorised.
  const [draftCategory, setDraftCategory] = useState<string | null>(null);

  const outstandingManual = useMemo(
    () => tasks.filter((t) => !t.completed),
    [tasks],
  );

  // Categories vocabulary, derived from EVERY task (not just outstanding) so
  // completing the last task in a category doesn't make the category vanish
  // from the dropdown — the user can still file a new task under it.
  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      const c = t.category?.trim();
      if (c) set.add(c);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  // Group outstanding manual tasks into per-category sections. Named
  // categories appear alphabetically; the "Uncategorised" bucket renders
  // last so user-curated groups stay top-of-list.
  const manualSections = useMemo<{ title: string | null; tasks: TaskRecord[] }[]>(
    () => {
      if (outstandingManual.length === 0) return [];
      const buckets = new Map<string, TaskRecord[]>();
      for (const t of outstandingManual) {
        const key = t.category?.trim() ?? "";
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(t);
      }
      const named = [...buckets.entries()]
        .filter(([k]) => k !== "")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([title, list]) => ({ title, tasks: list }));
      const uncat = buckets.get("") ?? [];
      return uncat.length > 0
        ? [...named, { title: null, tasks: uncat }]
        : named;
    },
    [outstandingManual],
  );

  // If the sticky draft category gets removed from the vocabulary (e.g. the
  // user just deleted the only task carrying it), drop it back to null so
  // the picker doesn't show a stale choice.
  useEffect(() => {
    if (draftCategory && !allCategories.includes(draftCategory)) {
      setDraftCategory(null);
    }
  }, [draftCategory, allCategories]);

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

  const prTasksCount = useMemo(
    () => prTaskGroups.reduce((sum, g) => sum + g.tasks.length, 0),
    [prTaskGroups],
  );

  const totalCount = outstandingManual.length +
    meetingGroups.reduce((sum, g) => sum + g.items.length, 0) +
    prTasksCount;

  if (!panelOpen) return null;

  async function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await addTask(text, draftCategory);
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

  async function checkPrTask(prId: number, taskId: number) {
    try {
      await resolvePrTaskAction(prId, taskId);
    } catch (e) {
      toast.error("Failed to resolve PR task", { description: String(e) });
    }
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

      <div className="px-3 py-2 border-b space-y-1.5">
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
        <div className="flex items-center pl-1">
          <CategoryPicker
            categories={allCategories}
            value={draftCategory}
            onChange={setDraftCategory}
            triggerLabel={draftCategory ?? "No category"}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!loaded ? (
          <div className="px-4 py-6 text-xs text-muted-foreground">Loading…</div>
        ) : totalCount === 0 ? (
          <EmptyState />
        ) : (
          <div className="py-2">
            {manualSections.map((sec) => (
              <Section
                key={sec.title ?? "__uncat__"}
                title={sec.title ?? "Uncategorised"}
              >
                {sec.tasks.map((t) => (
                  <ManualTaskRow
                    key={t.id}
                    task={t}
                    categories={allCategories}
                    onCheck={() => void setTaskCompleted(t.id, true)}
                    onChangeCategory={(cat) =>
                      void setTaskCategory(t.id, cat)
                    }
                  />
                ))}
              </Section>
            ))}

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

            {prTaskGroups.length > 0 && (
              <Section title="From PRs">
                {prTaskGroups.map((g) => (
                  <div key={g.pr.id} className="space-y-0.5">
                    <button
                      onClick={() => g.pr.url && openUrl(g.pr.url)}
                      className="w-full flex items-center gap-1.5 text-left px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground truncate"
                      title={`#${g.pr.id} — ${g.pr.title}`}
                    >
                      <GitPullRequest className="h-3 w-3 shrink-0" />
                      <span className="truncate">{g.pr.title}</span>
                    </button>
                    {g.tasks.map((t) => (
                      <PrTaskRow
                        key={t.id}
                        text={t.content}
                        onCheck={() => void checkPrTask(g.pr.id, t.id)}
                        onOpen={() => g.pr.url && openUrl(g.pr.url)}
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

function PrTaskRow({
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
        // Click the text to open the PR on Bitbucket; click the
        // checkbox to mark the task resolved (handled separately above
        // so clicks don't fall through).
        className="flex-1 text-left text-sm leading-tight hover:underline whitespace-pre-wrap break-words"
      >
        {text}
      </button>
    </div>
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
  task,
  categories,
  onCheck,
  onChangeCategory,
}: {
  task: TaskRecord;
  categories: string[];
  onCheck: () => void;
  onChangeCategory: (cat: string | null) => void;
}) {
  return (
    <div className="group flex items-start gap-2 px-3 py-1.5 hover:bg-muted/40">
      <Checkbox onCheck={onCheck} />
      <span className="flex-1 min-w-0 text-sm leading-tight break-words">
        {task.text}
      </span>
      {/* Tag button — visible always when a category is set, on hover otherwise.
          Section headers already show the category name, so the icon alone is
          enough; the click target opens the recategorise menu. */}
      <div
        className={cn(
          "shrink-0 self-center transition-opacity",
          task.category ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <CategoryPicker
          categories={categories}
          value={task.category ?? null}
          onChange={onChangeCategory}
          triggerLabel={task.category ?? "Set category"}
          compact
          iconOnly
        />
      </div>
    </div>
  );
}

// ── Category picker ─────────────────────────────────────────────────────────
//
// Used in two places: above the "Add a task…" input (sticky default for new
// tasks) and inline on each task row (recategorise existing). Same component
// handles both — `compact` shrinks the trigger for the per-row variant.
//
// "Create new category" path: the picker stays open while the inline input
// is active, commits on Enter, and threads the new name straight back via
// `onChange` — it doesn't try to "register" the category anywhere because
// the vocabulary is derived from existing tasks, so the moment any task
// carries the new name the dropdown picks it up.

function CategoryPicker({
  categories,
  value,
  onChange,
  triggerLabel,
  compact,
  iconOnly,
}: {
  categories: string[];
  value: string | null;
  onChange: (cat: string | null) => void;
  triggerLabel: string;
  compact?: boolean;
  /** Render a square tag-icon trigger only — used in the per-row picker where
   *  the section header already names the category, so showing it again would
   *  be redundant. */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewName("");
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function commitNew() {
    const trimmed = newName.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    onChange(trimmed);
    setNewName("");
    setCreating(false);
    setOpen(false);
  }

  function pick(cat: string | null) {
    onChange(cat);
    setOpen(false);
    setCreating(false);
    setNewName("");
  }

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center rounded-md border bg-background hover:bg-muted text-muted-foreground transition-colors",
          iconOnly
            ? "h-5 w-5 justify-center"
            : compact
            ? "h-5 text-[10px] px-1.5 gap-1"
            : "h-6 text-[11px] px-2 gap-1",
          value && !compact && !iconOnly && "text-foreground border-primary/30 bg-primary/5",
          value && iconOnly && "text-foreground border-primary/30 bg-primary/5",
        )}
        title={value ? `Category: ${triggerLabel}` : "Set category"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={value ? `Category: ${triggerLabel}` : "Set category"}
      >
        <Tag className={iconOnly || compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
        {!iconOnly && (
          <>
            <span className="max-w-[120px] truncate">{triggerLabel}</span>
            <ChevronDown className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute z-30 mt-1 left-0 min-w-[160px] rounded-md border bg-popover shadow-md py-1"
        >
          <button
            type="button"
            role="menuitem"
            className={cn(
              "w-full text-left text-xs px-3 py-1.5 hover:bg-accent",
              value === null && "font-medium text-foreground",
            )}
            onClick={() => pick(null)}
          >
            No category
          </button>
          {categories.length > 0 && (
            <div className="my-0.5 border-t" />
          )}
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              role="menuitem"
              className={cn(
                "w-full text-left text-xs px-3 py-1.5 hover:bg-accent truncate",
                value === c && "font-medium text-foreground",
              )}
              onClick={() => pick(c)}
            >
              {c}
            </button>
          ))}
          <div className="my-0.5 border-t" />
          {creating ? (
            <div className="px-2 py-1.5">
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitNew();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCreating(false);
                    setNewName("");
                  }
                }}
                onBlur={commitNew}
                placeholder="New category"
                className="h-7 text-xs"
              />
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="w-full text-left text-xs px-3 py-1.5 hover:bg-accent text-primary"
              onClick={() => setCreating(true)}
            >
              + New category…
            </button>
          )}
        </div>
      )}
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
