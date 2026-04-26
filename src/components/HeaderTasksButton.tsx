import { ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTasksStore } from "@/stores/tasksStore";
import { useMeetingsStore } from "@/stores/meetingsStore";
import { extractNotesTaskItems } from "@/lib/tiptapTasks";

/**
 * Header button that toggles the right-side Tasks panel. The badge count
 * combines outstanding manual tasks with unchecked task items pulled from
 * every notes-mode meeting, so the user can see at a glance how many open
 * items there are without having to expand the panel.
 */
export function HeaderTasksButton({ className }: { className?: string }) {
  const panelOpen = useTasksStore((s) => s.panelOpen);
  const togglePanel = useTasksStore((s) => s.togglePanel);
  const tasks = useTasksStore((s) => s.tasks);
  const meetings = useMeetingsStore((s) => s.meetings);

  let count = tasks.filter((t) => !t.completed).length;
  for (const m of meetings) {
    if (!m.notes || m.kind !== "notes") continue;
    for (const item of extractNotesTaskItems(m.notes)) {
      if (!item.checked && item.text.length > 0) count++;
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("relative", className)}
      onClick={togglePanel}
      aria-label={panelOpen ? "Hide tasks" : "Show tasks"}
      aria-pressed={panelOpen}
      title={panelOpen ? "Hide tasks" : "Show tasks"}
    >
      <ListTodo className="h-4 w-4" />
      {count > 0 && (
        <span
          // Small numeric badge — maxes at "99+" to keep the icon size sane.
          // Positioned in the top-right; uses the primary token so it tracks
          // theme changes.
          className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-[10px] font-medium text-primary-foreground inline-flex items-center justify-center leading-none"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Button>
  );
}
