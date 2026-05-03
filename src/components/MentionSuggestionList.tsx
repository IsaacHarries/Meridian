/**
 * Suggestion popover for the TipTap Mention extension. Shows a vertical
 * list of name candidates filtered by what the user has typed after `@`,
 * with arrow-key navigation and Enter/Tab to accept.
 *
 * The popover is mounted by `mentionSuggestionRenderer.tsx` — this file
 * just owns the list rendering + the imperative ref that the renderer
 * uses to forward key events from the editor's keymap.
 *
 * "Create new" affordance: when the user types something that doesn't
 * match any pooled name, a final row offers to insert it as-is. Mentions
 * created this way still show up as Mention nodes (so they're searchable
 * via `@name`) and seed the autocomplete pool for future meetings.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { cn } from "@/lib/utils";

export interface MentionSuggestionItem {
  /** Canonical display label — what gets stored on the Mention node. */
  label: string;
  /** True for the synthetic "create" row at the end of the list. */
  isCreate?: boolean;
}

export interface MentionSuggestionListProps {
  items: MentionSuggestionItem[];
  /**
   * Called when the user accepts an item (click, Enter, or Tab). The
   * renderer forwards this through to the TipTap suggestion command.
   */
  onPick: (item: MentionSuggestionItem) => void;
}

export interface MentionSuggestionListHandle {
  /**
   * Forward a key event from the editor's prosemirror keymap. Returns
   * `true` when the list consumed the key (so the editor should stop
   * its default handling).
   */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const MentionSuggestionList = forwardRef<
  MentionSuggestionListHandle,
  MentionSuggestionListProps
>(({ items, onPick }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset highlight to the top whenever the candidate set changes —
  // otherwise typing more characters could leave the cursor on a row
  // that no longer exists.
  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        setSelectedIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelectedIndex((i) =>
          items.length === 0 ? 0 : (i - 1 + items.length) % items.length,
        );
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[selectedIndex];
        if (item) {
          onPick(item);
          return true;
        }
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-input bg-popover text-popover-foreground shadow-md text-xs px-3 py-2 min-w-[180px]">
        Keep typing to add a new name…
      </div>
    );
  }

  return (
    <ul
      role="listbox"
      className="rounded-md border border-input bg-popover text-popover-foreground shadow-md max-h-60 overflow-y-auto py-1 min-w-[200px]"
    >
      {items.map((item, i) => (
        <li key={`${item.isCreate ? "__create" : "name"}:${item.label}:${i}`}>
          <button
            type="button"
            role="option"
            aria-selected={i === selectedIndex}
            onMouseEnter={() => setSelectedIndex(i)}
            // `mousedown` fires before the editor's blur, which would
            // otherwise tear down the popover before the click lands.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(item);
            }}
            className={cn(
              "w-full text-left px-3 py-1.5 text-sm flex items-baseline gap-2 transition-colors",
              i === selectedIndex ? "bg-muted" : "hover:bg-muted/60",
            )}
          >
            {item.isCreate ? (
              <>
                <span className="text-xs text-muted-foreground">New:</span>
                <span className="font-medium">@{item.label}</span>
              </>
            ) : (
              <span className="font-medium">@{item.label}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
});

MentionSuggestionList.displayName = "MentionSuggestionList";
