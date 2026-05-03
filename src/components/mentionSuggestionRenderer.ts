/**
 * TipTap Mention `suggestion.render` factory. Wires our React-based
 * `MentionSuggestionList` to the imperative lifecycle TipTap expects
 * (onStart / onUpdate / onKeyDown / onExit) and positions the popover
 * via a simple fixed-coordinate div anchored at the editor's caret —
 * no tippy.js dependency.
 *
 * Positioning notes:
 *   - `props.clientRect()` returns the rect of the `@` token in viewport
 *     coordinates. We anchor the popover under that rect's bottom-left.
 *   - When the popover would clip the viewport bottom, flip it above the
 *     anchor so the user can still see the candidates near where they're
 *     typing. The popover is always above the editor in z-order.
 */

import { ReactRenderer, type Editor } from "@tiptap/react";
import {
  MentionSuggestionList,
  type MentionSuggestionItem,
  type MentionSuggestionListHandle,
} from "@/components/MentionSuggestionList";

interface SuggestionProps {
  editor: Editor;
  query: string;
  text: string;
  range: { from: number; to: number };
  command: (attrs: { id: string; label: string }) => void;
  items: MentionSuggestionItem[];
  decorationNode: Element | null;
  clientRect?: (() => DOMRect | null) | null;
}

export function mentionSuggestionRenderer() {
  let component: ReactRenderer<MentionSuggestionListHandle, any> | null = null;
  let popup: HTMLDivElement | null = null;

  const position = (props: SuggestionProps) => {
    if (!popup) return;
    const rect = props.clientRect?.();
    if (!rect) {
      popup.style.display = "none";
      return;
    }
    popup.style.display = "block";
    // Default: place under the anchor.
    const popupRect = popup.getBoundingClientRect();
    const wantTop = rect.bottom + 4;
    const flipsAboveBecauseClipsBelow =
      wantTop + popupRect.height > window.innerHeight - 8;
    const top = flipsAboveBecauseClipsBelow
      ? Math.max(8, rect.top - popupRect.height - 4)
      : wantTop;
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - popupRect.width - 8,
    );
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  };

  return {
    onStart: (props: SuggestionProps) => {
      popup = document.createElement("div");
      popup.style.position = "fixed";
      popup.style.zIndex = "1000";
      // Hide until first measurement so the empty box doesn't flash at 0,0.
      popup.style.top = "-9999px";
      popup.style.left = "-9999px";
      document.body.appendChild(popup);

      component = new ReactRenderer(MentionSuggestionList, {
        editor: props.editor,
        props: {
          items: props.items,
          onPick: (item: MentionSuggestionItem) => {
            props.command({ id: item.label, label: item.label });
          },
        },
      });
      popup.appendChild(component.element as Node);
      // Defer to the next frame so React has actually rendered into the
      // element and the popup has a non-zero size to position against.
      requestAnimationFrame(() => position(props));
    },

    onUpdate: (props: SuggestionProps) => {
      component?.updateProps({
        items: props.items,
        onPick: (item: MentionSuggestionItem) => {
          props.command({ id: item.label, label: item.label });
        },
      });
      requestAnimationFrame(() => position(props));
    },

    onKeyDown: (props: { event: KeyboardEvent }) => {
      if (props.event.key === "Escape") {
        // Closing the popover on Escape mirrors the slash-command palette.
        if (popup) popup.style.display = "none";
        return true;
      }
      return component?.ref?.onKeyDown(props.event) ?? false;
    },

    onExit: () => {
      if (popup) {
        popup.remove();
        popup = null;
      }
      component?.destroy();
      component = null;
    },
  };
}
