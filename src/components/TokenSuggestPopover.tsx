/**
 * Inline `#tag` / `@name` autocomplete that hangs above any text input
 * the user is typing into. Detects when the caret has just moved past
 * a `#` or `@` (preceded by start-of-input or whitespace), pops up a
 * filtered list of candidates from the supplied pools, and inserts
 * the picked value back into the input — replacing the partial token
 * the user typed.
 *
 * The component is render-prop-shaped: the parent owns the input
 * element and the controlled `value`. We just observe the input's
 * caret position via the ref and render a positioned popover. That
 * keeps the integration minimal — works equally well for the ⌘F
 * `<Input>` and the chat `<Textarea>` without a custom wrapper for
 * each shape.
 *
 * Keyboard semantics:
 *   - ↑/↓ — navigate while popover is open
 *   - Enter or Tab — accept the highlighted candidate
 *   - Escape — dismiss without inserting
 * Mouse: click to accept; mousedown is used so the input doesn't blur
 * before the click lands.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface TokenSuggestPopoverProps {
  /** Current value of the input — read-only here, parent controls it. */
  value: string;
  /**
   * Setter the parent uses to keep the input controlled. We call it
   * with the new full value when the user accepts a suggestion.
   */
  onChange: (next: string) => void;
  /** The input or textarea element the popover anchors to. */
  inputRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /**
   * Available `#tag` candidates — already deduped and sorted in the
   * order the popover should show them. The component does its own
   * substring filter against the partial token the user has typed.
   */
  tagPool: string[];
  /** Available `@name` candidates — same shape as `tagPool`. */
  namePool: string[];
  /**
   * Optional max number of candidate rows to show after filtering.
   * Defaults to 8.
   */
  limit?: number;
}

/**
 * Result of inspecting the input's text + caret position. When the
 * caret is "inside a token" (i.e. immediately after `#…` or `@…` with
 * no whitespace between), `kind` is the trigger character and `query`
 * is the partial body the user has typed so far.
 */
interface TokenContext {
  kind: "#" | "@";
  /** Index of the trigger character in the value string. */
  triggerIndex: number;
  /** Partial body the user has typed after the trigger (no leading `#`/`@`). */
  query: string;
}

function detectTokenContext(
  value: string,
  caret: number,
): TokenContext | null {
  // Walk backwards from the caret looking for a trigger character.
  // Stop the moment we hit whitespace or another trigger — those mean
  // the caret is no longer inside a token.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    if (ch === "#" || ch === "@") {
      // The trigger must be at the start of the input or preceded by
      // whitespace — otherwise it's a literal `@` (e.g. inside an
      // email address) and we don't want to pop the suggester.
      const before = i === 0 ? " " : value[i - 1];
      if (before !== " " && before !== "\n" && before !== "\t" && i !== 0) {
        return null;
      }
      return {
        kind: ch,
        triggerIndex: i,
        query: value.slice(i + 1, caret),
      };
    }
  }
  return null;
}

export function TokenSuggestPopover({
  value,
  onChange,
  inputRef,
  tagPool,
  namePool,
  limit = 8,
}: TokenSuggestPopoverProps) {
  const [caret, setCaret] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Re-read the caret on input/select events so detection stays in
  // sync without the parent having to thread the position through.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const refresh = () => setCaret(el.selectionStart ?? null);
    el.addEventListener("input", refresh);
    el.addEventListener("select", refresh);
    el.addEventListener("keyup", refresh);
    el.addEventListener("click", refresh);
    el.addEventListener("focus", refresh);
    el.addEventListener("blur", () => setCaret(null));
    refresh();
    return () => {
      el.removeEventListener("input", refresh);
      el.removeEventListener("select", refresh);
      el.removeEventListener("keyup", refresh);
      el.removeEventListener("click", refresh);
      el.removeEventListener("focus", refresh);
    };
  }, [inputRef]);

  const ctx = useMemo<TokenContext | null>(() => {
    if (caret == null) return null;
    return detectTokenContext(value, caret);
  }, [value, caret]);

  const items = useMemo(() => {
    if (!ctx) return [];
    const pool = ctx.kind === "#" ? tagPool : namePool;
    const q = ctx.query.toLowerCase();
    const matches = q
      ? pool.filter((p) => p.toLowerCase().includes(q))
      : pool;
    return matches.slice(0, limit);
  }, [ctx, tagPool, namePool, limit]);

  // Reset highlight when the candidate set changes so we don't index
  // off the end of a freshly-shrunk list.
  useEffect(() => {
    setHighlight(0);
  }, [items]);

  // Position the popover at the trigger character's actual screen
  // coordinates. We measure via a hidden mirror element that copies
  // the input's typography + box so wrapping (in textareas) lines up
  // with the source. Anchoring at the trigger — not the input's left
  // edge — keeps the popover next to where the user is actually typing
  // even when the field is long, scrolled, or contains wrapped lines.
  //
  // Flip-above behaviour: when the trigger is near the viewport bottom
  // (chat input docks at the bottom of the meetings panel), placing
  // the popover below would clip it. We estimate the popover's height
  // from row count + the max-h-60 cap, and if it doesn't fit below we
  // place it above the trigger line instead. Estimation rather than
  // measurement avoids a "below → above" flash on each open.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !ctx || items.length === 0) {
      setPosition(null);
      return;
    }
    const triggerCoords = measureCaretCoords(el, ctx.triggerIndex);
    const fallback = (): { top: number; left: number } => {
      const rect = el.getBoundingClientRect();
      return { top: rect.bottom + 4, left: rect.left };
    };
    if (!triggerCoords) {
      setPosition(fallback());
      return;
    }
    // Each row is roughly 32px (px-3 py-1.5 text-sm) + 8px wrapper
    // padding (py-1). Capped at the popover's max-h-60 (240px). The
    // estimate is intentionally a slight over-count so we err on the
    // side of flipping above rather than letting the bottom clip.
    const ROW_PX = 32;
    const PAD_PX = 8;
    const MAX_PX = 240;
    const popoverHeight = Math.min(items.length * ROW_PX + PAD_PX, MAX_PX);
    const wantBelowTop = triggerCoords.top + triggerCoords.lineHeight + 4;
    const wouldClipBelow =
      wantBelowTop + popoverHeight > window.innerHeight - 8;
    const top = wouldClipBelow
      ? Math.max(8, triggerCoords.top - popoverHeight - 4)
      : wantBelowTop;
    setPosition({ top, left: triggerCoords.left });
  }, [inputRef, ctx, items.length]);

  const insert = useCallback(
    (label: string) => {
      if (!ctx) return;
      // Tags are stored lowercase so the search comparator hits them
      // directly. Names keep their canonical casing — the matcher does
      // its own case-insensitive compare.
      const inserted = ctx.kind === "#" ? label.toLowerCase() : label;
      const before = value.slice(0, ctx.triggerIndex);
      const after = value.slice((caret ?? value.length));
      const next = `${before}${ctx.kind}${inserted}${after.startsWith(" ") ? "" : " "}${after}`;
      onChange(next);
      // Move the caret to just past the inserted token + trailing space.
      const newCaret = before.length + 1 + inserted.length + 1;
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(newCaret, newCaret);
      });
    },
    [ctx, value, caret, onChange, inputRef],
  );

  // Keyboard handling lives at the input level so the parent's keydown
  // handlers (e.g. ⌘F's Escape-to-close) keep working. We listen on the
  // capture phase so we can intercept arrow keys before the input acts
  // on them, but only when the popover is actually showing.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onKey: EventListener = (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (!ctx || items.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((i) => (i + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const target = items[highlight];
        if (target) {
          event.preventDefault();
          event.stopPropagation();
          insert(target);
        }
        return;
      }
      if (event.key === "Escape") {
        // Dismiss the popover without consuming Escape — the parent
        // (e.g. ⌘F) may still want to close on Escape.
        setPosition(null);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [inputRef, ctx, items, highlight, insert]);

  if (!ctx || items.length === 0 || !position) return null;

  // Portal to document.body so the popover escapes any ancestor that
  // has a transform / filter / backdrop-filter — those create a new
  // containing block for `position: fixed` descendants, which would
  // anchor the popover to that ancestor's box instead of the viewport.
  // (Both the ⌘F header and the chat aside use backdrop-blur, which
  // is precisely such a property.) Body-level portal keeps the popover
  // pinned to the actual viewport coordinates we computed.
  return createPortal(
    <div
      ref={popoverRef}
      style={{ position: "fixed", top: position.top, left: position.left, zIndex: 50 }}
      className="rounded-md border border-input bg-popover text-popover-foreground shadow-md max-h-60 overflow-y-auto py-1 min-w-[200px]"
      role="listbox"
    >
      {items.map((item, i) => (
        <button
          key={`${ctx.kind}:${item}`}
          type="button"
          role="option"
          aria-selected={i === highlight}
          onMouseEnter={() => setHighlight(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            insert(item);
          }}
          className={cn(
            "w-full text-left px-3 py-1.5 text-sm flex items-baseline gap-2 transition-colors",
            i === highlight ? "bg-muted" : "hover:bg-muted/60",
          )}
        >
          <span className="font-mono text-xs text-muted-foreground">
            {ctx.kind}
          </span>
          <span className="font-medium">{item}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Measure the viewport coordinates of a character at index `i` inside
 * an input or textarea. Uses the canonical "mirror element" trick:
 * spin up a hidden div that copies every box-affecting style of the
 * source field, fill it with the same text up to the target index
 * (followed by a marker span), and read the marker's position. The
 * returned `top`/`left` are in viewport coordinates; `lineHeight` is
 * the computed line-height in px so callers can offset the popover
 * to land just below the caret line.
 *
 * Why a mirror is necessary: there's no DOM API to ask `<input>` or
 * `<textarea>` "where is character N?" — the platform exposes only
 * `selectionStart` (an offset, not a coordinate) and `getBoundingClientRect`
 * (the field as a whole). Copying the typography into a measurable
 * div is the only way to recover the per-character geometry.
 */
function measureCaretCoords(
  el: HTMLInputElement | HTMLTextAreaElement,
  index: number,
): { left: number; top: number; lineHeight: number } | null {
  const isTextarea = el.tagName === "TEXTAREA";
  const style = window.getComputedStyle(el);
  const div = document.createElement("div");
  // Box-affecting properties — must match exactly so wrap points and
  // line breaks reproduce the source field's layout.
  const props = [
    "boxSizing",
    "width",
    "height",
    "fontSize",
    "fontFamily",
    "fontWeight",
    "fontStyle",
    "fontVariant",
    "fontStretch",
    "letterSpacing",
    "wordSpacing",
    "textTransform",
    "textAlign",
    "textIndent",
    "lineHeight",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderTopStyle",
    "borderRightStyle",
    "borderBottomStyle",
    "borderLeftStyle",
    "tabSize",
  ] as const;
  for (const p of props) {
    div.style.setProperty(
      // CSS property names: convert camelCase to kebab-case for setProperty.
      p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
      style.getPropertyValue(
        p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
      ),
    );
  }
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = isTextarea ? "pre-wrap" : "pre";
  div.style.wordWrap = isTextarea ? "break-word" : "normal";
  div.style.overflow = "hidden";
  div.style.top = "0";
  div.style.left = "0";

  const value = el.value;
  div.appendChild(document.createTextNode(value.substring(0, index)));
  const marker = document.createElement("span");
  // Marker is JUST the trigger character so its bounding box stays
  // single-character. Putting the whole rest-of-value inside the marker
  // would let it span multiple wrapped lines in a textarea, and
  // getBoundingClientRect would return the union — top-left of the
  // first wrapped row, not of the trigger glyph itself.
  marker.textContent = value.charAt(index) || ".";
  div.appendChild(marker);
  div.appendChild(document.createTextNode(value.substring(index + 1)));
  document.body.appendChild(div);

  let result: { left: number; top: number; lineHeight: number } | null = null;
  try {
    const elRect = el.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const divRect = div.getBoundingClientRect();
    const lineHeight = parseFloat(style.lineHeight);
    result = {
      left: elRect.left + (markerRect.left - divRect.left) - el.scrollLeft,
      top: elRect.top + (markerRect.top - divRect.top) - el.scrollTop,
      lineHeight: Number.isFinite(lineHeight)
        ? lineHeight
        : parseFloat(style.fontSize) * 1.2,
    };
  } finally {
    document.body.removeChild(div);
  }
  return result;
}
