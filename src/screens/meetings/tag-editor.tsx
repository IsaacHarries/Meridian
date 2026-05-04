import { cn } from "@/lib/utils";
import { normalizeTag } from "@/stores/meetings/helpers";
import { useMeetingsStore } from "@/stores/meetings/store";
import { Tag as TagIcon, X } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { AddTagPill } from "./_shared";

// ── Tag editor ───────────────────────────────────────────────────────────────
//
// Renders the union of DEFAULT_TAGS and whatever extra tags the meeting already
// carries, so custom tags stay visible as selectable pills. Custom tags get a
// small red × badge overlapping their top-right corner for deletion (the
// built-in defaults are non-destructive — click the pill to deselect).

export function TagEditor({
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
    const t = normalizeTag(raw);
    if (!t) return;
    if (/\s/.test(raw.trim())) {
      toast.info("Tags can't contain spaces", {
        description: `Saved as "${t}".`,
      });
    }
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
