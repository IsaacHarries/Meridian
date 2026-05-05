/**
 * WYSIWYG editor for meeting notes. Wraps TipTap so the user sees formatted
 * text (bold, headings, lists, checkboxes) directly — never raw markdown.
 *
 * Storage: TipTap's native JSON document, persisted as a string in the
 * existing `notes` field on MeetingRecord. Legacy plain-text notes are
 * detected and hydrated as a sequence of paragraphs on first open.
 *
 * The editor is uncontrolled with respect to `initialValue` — once mounted,
 * its internal state is the source of truth. The parent should remount it
 * (via a `key` based on meeting id) when switching to a different meeting.
 */

import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import {
    EditorContent,
    useEditor,
    useEditorState,
    type Editor,
    type JSONContent,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
// StarterKit 3 already bundles Bold, Italic, Underline, Strike, Code,
// CodeBlock, Blockquote, Link, lists, etc., so we configure them through
// StarterKit's options object rather than re-importing. Highlight is the
// only mark we still bring in standalone.
import type { MentionSuggestionItem } from "@/components/MentionSuggestionList";
import { mentionSuggestionRenderer } from "@/components/mentionSuggestionRenderer";
import { Button } from "@/components/ui/button";
import { gatherNamePool } from "@/lib/meetingPeople";
import { getJiraBaseUrlCache, openUrl } from "@/lib/tauri/core";
import type { AccentColor } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useTheme } from "@/providers/ThemeProvider";
import { useMeetingsStore } from "@/stores/meetings/store";
import Highlight from "@tiptap/extension-highlight";
import Mention from "@tiptap/extension-mention";
import {
    Bold,
    Check,
    ChevronDown,
    Code,
    Highlighter,
    Italic,
    Link2,
    List,
    ListChecks,
    ListOrdered,
    Quote,
    SquareCode,
    Strikethrough,
    Underline as UnderlineIcon,
    X,
} from "lucide-react";

export type LineHeightMode = "compact" | "normal" | "relaxed";

const LINE_HEIGHTS: Record<LineHeightMode, string> = {
  compact: "1.3",
  normal: "1.5",
  relaxed: "1.75",
};

function resolveLineHeight(mode: LineHeightMode): string {
  return LINE_HEIGHTS[mode];
}

// JIRA tickets are PROJECT-NUMBER (uppercase letters, digits). Conservative
// boundaries: must not be preceded/followed by another letter/digit/dash so
// that things like "ISO-8601-2" or "GIT-2-something" don't match. Anchored
// to a small text slice (the click target's text node — usually <500 chars)
// and only invoked on Cmd/Ctrl-click, so per-keystroke cost is zero.
const JIRA_KEY_GLOBAL = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9-])/g;

/**
 * Find the JIRA ticket key whose match span covers `offset` in `text`, if any.
 * Returns the matched key (e.g. "ABC-123") or null.
 *
 * Exported for unit testing — keep the regex/decision in one place so the
 * editor's click handler and the test see exactly the same logic.
 */
export function findJiraKeyAtOffset(text: string, offset: number): string | null {
  // Reset lastIndex defensively — global regex state leaks across calls.
  JIRA_KEY_GLOBAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JIRA_KEY_GLOBAL.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (offset >= start && offset <= end) return m[0];
  }
  return null;
}

interface RichNotesEditorProps {
  /**
   * The current notes value — TipTap JSON, legacy plain text, or null for an
   * empty editor. Used as the initial content on mount; later changes are
   * detected and synced into the editor (so external writes — e.g. the Tasks
   * panel toggling a checkbox — stay in sync) UNLESS the change matches the
   * JSON the editor most recently emitted (its own save echo).
   */
  value: string | null;
  /** Fires on every edit with the serialised TipTap JSON. */
  onChange: (json: string) => void;
  /** Called when the editor loses focus — used by the parent to flush a debounced save. */
  onBlur?: () => void;
  placeholder?: string;
  /**
   * Current line-spacing preset. Drives both the editor's leading (via a CSS
   * custom property) and the toolbar dropdown's selected value. Optional —
   * the editor falls back to "normal" if omitted.
   */
  lineHeight?: LineHeightMode;
  /** Persists a new line-spacing choice when the user picks one in the toolbar. */
  onLineHeightChange?: (mode: LineHeightMode) => void;
}

function parseInitialContent(value: string | null): JSONContent | undefined {
  if (!value || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && parsed.type === "doc") {
      return parsed as JSONContent;
    }
  } catch {
    // fall through to plain-text hydration
  }
  // Legacy plain text — wrap each line as a paragraph so old notes survive
  // the migration without data loss.
  return {
    type: "doc",
    content: value.split("\n").map((line) =>
      line === ""
        ? { type: "paragraph" }
        : { type: "paragraph", content: [{ type: "text", text: line }] },
    ),
  };
}

export function RichNotesEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  lineHeight = "normal",
  onLineHeightChange,
}: RichNotesEditorProps) {
  // useEditor binds its callbacks at creation time. We don't want to recreate
  // the editor on every parent render (it would lose cursor/selection state),
  // so we route callbacks through refs that are kept in sync each render.
  // This ensures the latest closure values (e.g. a flushNotes that reads the
  // current `notes` state) are used when the editor fires update/blur events.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;

  // The most recent JSON the editor emitted via onUpdate. Used to tell apart
  // "our own save echo" (incoming `value` matches what we just produced —
  // ignore) from a genuine external change (incoming `value` differs — sync
  // into the editor). Without this, every keystroke's save round-trip would
  // re-set the editor content and clobber the cursor.
  const lastEmittedRef = useRef<string | null>(value);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Clicking a link in editing mode should position the caret, not
        // navigate. Auto-link typed/pasted URLs so the user rarely needs the
        // toolbar for the common case.
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight.configure({ multicolor: true }),
      Placeholder.configure({
        placeholder: placeholder ?? "Type your meeting notes here…",
      }),
      Mention.configure({
        // Mark mention nodes so we can style them in CSS without a
        // dedicated React component (the styling lives in index.css).
        HTMLAttributes: { class: "mention" },
        // The default `renderText` already returns `@${label}`, which
        // matches the form `extractTiptapPlainText` produces for the
        // AI agent and the indexer.
        suggestion: {
          // Filter the live name pool by the user's typed query, then
          // append a synthetic "create new" row so a brand-new name
          // can be inserted from the popover without leaving the keyboard.
          // Reading the store inside the callback keeps the pool live —
          // newly tagged speakers and notes mentions show up without
          // remounting the editor.
          items: ({ query }: { query: string }): MentionSuggestionItem[] => {
            const pool = gatherNamePool(useMeetingsStore.getState().meetings);
            const q = query.trim().toLowerCase();
            const matches = q
              ? pool.filter((p) => p.toLowerCase().includes(q))
              : pool;
            const out: MentionSuggestionItem[] = matches
              .slice(0, 8)
              .map((label) => ({ label }));
            // Offer "create new" only when the typed text is non-empty
            // and isn't already in the pool (case-insensitive). Trimmed
            // to avoid creating a `@` mention with trailing spaces.
            const trimmed = query.trim();
            if (
              trimmed &&
              !pool.some((p) => p.toLowerCase() === trimmed.toLowerCase())
            ) {
              out.push({ label: trimmed, isCreate: true });
            }
            return out;
          },
          render: mentionSuggestionRenderer,
        },
      }),
    ],
    content: parseInitialContent(value),
    onUpdate: ({ editor }) => {
      const json = JSON.stringify(editor.getJSON());
      lastEmittedRef.current = json;
      onChangeRef.current(json);
    },
    onBlur: () => onBlurRef.current?.(),
    editorProps: {
      attributes: {
        // Apple-Notes-y feel: clean prose, no border or ring on focus (the
        // wrapping Card supplies the chrome). `min-h-full` makes the prose
        // area fill its EditorContent parent so the entire region remains
        // clickable even when the document is short — without it the editor
        // would only react to clicks on actual text.
        class:
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-full px-4 py-3",
        title: "Cmd/Ctrl-click a JIRA ticket key (e.g. ABC-123) to open it",
      },
      // Cmd/Ctrl-click on a JIRA ticket key opens the ticket in the browser.
      // Cost is zero on a normal click (the modifier-key guard short-circuits)
      // and the regex only ever runs on a single text node — usually a
      // paragraph's worth of chars — when the modifier IS held.
      handleClick(view, pos, event) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const baseUrl = getJiraBaseUrlCache();
        if (!baseUrl) return false;
        const $pos = view.state.doc.resolve(pos);
        const nodeText = $pos.parent.textContent;
        const key = findJiraKeyAtOffset(nodeText, $pos.parentOffset);
        if (!key) return false;
        const url = `${baseUrl.replace(/\/+$/, "")}/browse/${key}`;
        void openUrl(url);
        event.preventDefault();
        return true;
      },
    },
  });

  // Sync external writes into the editor (e.g. the Tasks panel ticking a
  // checkbox in this meeting's notes). We compare the incoming `value` to
  // what the editor most recently emitted — if they match, this is just our
  // own save round-trip and we leave the editor alone. If they differ, the
  // change came from somewhere else and we replace the document.
  //
  // Caveat: if the user is mid-typing AND the panel writes a checkbox change
  // for the same meeting in the same instant, the in-flight typing since the
  // last save will be lost when we resync. Acceptable for v1 — both inputs
  // for the same meeting at the same time is a rare race.
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmittedRef.current) return;
    if (value == null) return;
    const parsed = parseInitialContent(value);
    if (!parsed) return;
    // `false` = don't fire onUpdate; we already know what the new content is
    // and don't want to round-trip it back through the save path.
    editor.commands.setContent(parsed, { emitUpdate: false });
    lastEmittedRef.current = value;
  }, [editor, value]);

  // Inline link prompt state lives at the editor level so the Link toolbar
  // button can ask for a URL without losing the current selection (we stash
  // a snapshot via `editor.chain()` chained from the click handler).
  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [linkInitial, setLinkInitial] = useState("");

  if (!editor) return null;

  function startLinkPrompt() {
    if (!editor) return;
    if (editor.isActive("link")) {
      // Toggle: clicking the link button while inside an existing link
      // removes it. Matches the behaviour of every other mark button.
      editor.chain().focus().unsetLink().run();
      return;
    }
    if (editor.state.selection.empty) return; // disabled in Toolbar already
    setLinkInitial((editor.getAttributes("link").href as string) ?? "");
    setLinkPromptOpen(true);
  }

  function applyLink(url: string) {
    if (!editor) return;
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      const normalized = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: normalized })
        .run();
    }
    setLinkPromptOpen(false);
  }

  return (
    <div
      // `h-full flex flex-col` lets the EditorContent grow to the bottom of
      // whatever flex container the parent puts us in. The toolbar and link
      // prompt take their natural height; the editor itself fills the rest
      // and scrolls if its content overflows.
      className="h-full flex flex-col"
      style={
        {
          ["--notes-line-height" as string]: resolveLineHeight(lineHeight),
        } as React.CSSProperties
      }
    >
      <Toolbar
        editor={editor}
        onLinkClick={startLinkPrompt}
        lineHeight={lineHeight}
        onLineHeightChange={onLineHeightChange}
      />
      {linkPromptOpen && (
        <LinkInputRow
          initialUrl={linkInitial}
          onApply={applyLink}
          onCancel={() => setLinkPromptOpen(false)}
        />
      )}
      {/*
        Why a positioned wrapper around EditorContent rather than just letting
        flex-1 + overflow-y-auto on EditorContent itself do the job?
        EditorContent renders a Fragment (the editor div + a Portals sibling
        for React node-views) and the resulting flex sizing didn't reliably
        cap its height when typing past the visible area — long content kept
        rendering past the bottom of the card. Wrapping in a `relative` flex
        item and absolutely positioning EditorContent gives the editor a
        rock-solid definite height (= the wrapper's content box), so its
        own `overflow-y-auto` always clips and shows the scrollbar exactly
        when content exceeds the visible region.
      */}
      <div className="flex-1 min-h-0 relative">
        <EditorContent
          editor={editor}
          className="absolute inset-0 overflow-y-auto"
        />
      </div>
    </div>
  );
}

// ── Link prompt ─────────────────────────────────────────────────────────────
//
// Slim inline URL row that drops down between the toolbar and the editor when
// the user clicks the Link button. Lighter than a Dialog for what's a quick
// "type a URL and hit enter" interaction. Cancels on Esc, applies on Enter.

function LinkInputRow({
  initialUrl,
  onApply,
  onCancel,
}: {
  initialUrl: string;
  onApply: (url: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialUrl);
  return (
    <div className="border-b px-2 py-1.5 flex items-center gap-1.5 bg-muted/30">
      <Link2 className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-1" />
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onApply(value.trim());
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="https://…"
        className="flex-1 h-7 text-sm bg-transparent outline-none px-1"
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={() => onApply(value.trim())}
        title="Apply link (Enter)"
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={onCancel}
        title="Cancel (Esc)"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ── Toolbar ─────────────────────────────────────────────────────────────────

function Toolbar({
  editor,
  onLinkClick,
  lineHeight,
  onLineHeightChange,
}: {
  editor: Editor;
  onLinkClick: () => void;
  lineHeight: LineHeightMode;
  onLineHeightChange?: (mode: LineHeightMode) => void;
}) {
  // TipTap 3's useEditor defaults shouldRerenderOnTransaction to false, so
  // selection-only changes (clicking through text of varying styles) don't
  // re-render this component. Subscribe via useEditorState so the toolbar's
  // active states update when the caret moves between an H2 line and a body
  // line, etc.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      headingValue: editor.isActive("heading", { level: 1 })
        ? "h1"
        : editor.isActive("heading", { level: 2 })
          ? "h2"
          : editor.isActive("heading", { level: 3 })
            ? "h3"
            : editor.isActive("heading", { level: 4 })
              ? "h4"
              : editor.isActive("heading", { level: 5 })
                ? "h5"
                : editor.isActive("heading", { level: 6 })
                  ? "h6"
                  : "paragraph",
      isBold: editor.isActive("bold"),
      isItalic: editor.isActive("italic"),
      isUnderline: editor.isActive("underline"),
      isStrike: editor.isActive("strike"),
      isCode: editor.isActive("code"),
      isLink: editor.isActive("link"),
      isBulletList: editor.isActive("bulletList"),
      isOrderedList: editor.isActive("orderedList"),
      isTaskList: editor.isActive("taskList"),
      isBlockquote: editor.isActive("blockquote"),
      isCodeBlock: editor.isActive("codeBlock"),
      selectionEmpty: editor.state.selection.empty,
    }),
  });

  function onHeadingChange(value: string) {
    if (value === "paragraph") {
      editor.chain().focus().setParagraph().run();
      return;
    }
    const level = Number(value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
    editor.chain().focus().setHeading({ level }).run();
  }

  // Link button is enabled when there's a selection (to wrap as a link) OR
  // when the cursor is already inside a link (to remove it). Without that
  // guard, clicking with an empty selection would do nothing visible and
  // feel broken.
  const linkActionable = state.isLink || !state.selectionEmpty;

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-1 py-1 border-b">
      <select
        value={state.headingValue}
        onChange={(e) => onHeadingChange(e.target.value)}
        // Native select keeps things consistent with the rest of the app
        // (mic / model selectors use plain selects too) and gives us reliable
        // keyboard nav for free.
        className="h-7 rounded text-xs px-2 bg-transparent border border-input hover:bg-muted focus:outline-none focus:ring-0"
        aria-label="Text style"
      >
        <option value="paragraph">Body</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="h4">Heading 4</option>
        <option value="h5">Heading 5</option>
        <option value="h6">Heading 6</option>
      </select>
      <Divider />
      <ToolButton
        active={state.isBold}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label="Bold (⌘B)"
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={state.isItalic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label="Italic (⌘I)"
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={state.isUnderline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        label="Underline (⌘U)"
      >
        <UnderlineIcon className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={state.isStrike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        label="Strikethrough"
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolButton>
      <Divider />
      <ToolButton
        active={state.isCode}
        onClick={() => editor.chain().focus().toggleCode().run()}
        label="Inline code"
      >
        <Code className="h-3.5 w-3.5" />
      </ToolButton>
      <HighlightButton editor={editor} />
      <ToolButton
        active={state.isLink}
        disabled={!linkActionable}
        onClick={onLinkClick}
        label={state.isLink ? "Remove link" : "Add link"}
      >
        <Link2 className="h-3.5 w-3.5" />
      </ToolButton>
      <Divider />
      <ToolButton
        active={state.isBulletList}
        // toggleBulletList wraps the current line — empty or not — so clicking
        // on a blank line still produces a fresh "- " bullet, matching the
        // user's expectation that list buttons always insert a marker.
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        label="Bullet list"
      >
        <List className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={state.isOrderedList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        label="Numbered list"
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={state.isTaskList}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        label="Checklist"
      >
        <ListChecks className="h-3.5 w-3.5" />
      </ToolButton>
      <Divider />
      <ToolButton
        active={state.isBlockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        label="Block quote"
      >
        <Quote className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={state.isCodeBlock}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        label="Code block"
      >
        <SquareCode className="h-3.5 w-3.5" />
      </ToolButton>
      {onLineHeightChange && (
        <>
          <Divider />
          <label
            htmlFor="notes-line-height"
            className="text-xs text-muted-foreground pl-1"
          >
            Spacing
          </label>
          <select
            id="notes-line-height"
            value={lineHeight}
            onChange={(e) => onLineHeightChange(e.target.value as LineHeightMode)}
            className="h-7 rounded text-xs px-2 bg-transparent border border-input hover:bg-muted focus:outline-none focus:ring-0"
            title="Line spacing"
          >
            <option value="compact">Compact</option>
            <option value="normal">Normal</option>
            <option value="relaxed">Relaxed</option>
          </select>
        </>
      )}
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-border" />;
}

// Common highlighter colours, mirroring what desktop word processors and
// note-taking apps offer. Stored with ~45% alpha so the underlying text stays
// legible in both light and dark themes (the inline style set by TipTap
// overrides the default `<mark>` rule in `index.css`).
type HighlightColor = { name: string; value: string };

const HIGHLIGHT_COLORS: HighlightColor[] = [
  { name: "Yellow", value: "rgba(253, 224, 71, 0.45)" },
  { name: "Green", value: "rgba(134, 239, 172, 0.5)" },
  { name: "Blue", value: "rgba(147, 197, 253, 0.5)" },
  { name: "Pink", value: "rgba(249, 168, 212, 0.5)" },
  { name: "Orange", value: "rgba(253, 186, 116, 0.55)" },
  { name: "Purple", value: "rgba(216, 180, 254, 0.55)" },
  { name: "Red", value: "rgba(252, 165, 165, 0.55)" },
];

// Map each theme accent to the palette swatch with the closest hue. `slate`
// is intentionally chromatic-neutral so it falls back to Yellow (the
// canonical highlighter colour). When the user picks a different color from
// the palette we still respect that — this only drives the *default* applied
// by a plain click on the highlighter icon.
const ACCENT_TO_HIGHLIGHT: Record<AccentColor, string> = {
  slate: "Yellow",
  blue: "Blue",
  violet: "Purple",
  green: "Green",
  orange: "Orange",
  rose: "Pink",
};

function getDefaultHighlight(accent: AccentColor): HighlightColor {
  const name = ACCENT_TO_HIGHLIGHT[accent];
  return HIGHLIGHT_COLORS.find((c) => c.name === name) ?? HIGHLIGHT_COLORS[0];
}

function HighlightButton({ editor }: { editor: Editor }) {
  const { config } = useTheme();
  const defaultColor = getDefaultHighlight(config.accent);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Subscribe so the active state and current colour swatch update when the
  // caret moves into / out of highlighted text (TipTap 3 doesn't re-render
  // on selection-only transactions by default).
  const { active, currentColor } = useEditorState({
    editor,
    selector: ({ editor }) => ({
      active: editor.isActive("highlight"),
      currentColor:
        (editor.getAttributes("highlight").color as string | undefined) ??
        null,
    }),
  });

  // Close on outside click / Esc so the palette behaves like a popover.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggleDefault() {
    if (active) {
      editor.chain().focus().unsetHighlight().run();
    } else {
      editor.chain().focus().setHighlight({ color: defaultColor.value }).run();
    }
  }

  function applyColor(color: string) {
    editor.chain().focus().setHighlight({ color }).run();
    setOpen(false);
  }

  function removeHighlight() {
    editor.chain().focus().unsetHighlight().run();
    setOpen(false);
  }

  return (
    <div ref={wrapperRef} className="relative inline-flex items-center">
      {/* Main icon: toggles highlight using the theme-matched default colour. */}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleDefault}
        title={`Highlight (${defaultColor.name})`}
        aria-label={`Highlight with ${defaultColor.name}`}
        aria-pressed={active}
        className={cn(
          "h-7 pl-1.5 pr-1 inline-flex items-center justify-center rounded-l transition-colors",
          active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Highlighter className="h-3.5 w-3.5" />
        {/* Thin underline of the active default colour, à la Word/Notion, so
            the user can see at a glance what a plain click will apply. */}
        <span
          className="ml-1 h-3.5 w-1 rounded-sm"
          style={{ backgroundColor: defaultColor.value }}
        />
      </button>
      {/* Caret: opens the palette for picking a different colour. */}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        title="Highlight colour"
        aria-label="Choose highlight colour"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "h-7 w-4 inline-flex items-center justify-center rounded-r transition-colors text-muted-foreground hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          // Floats below the toolbar button. `z-50` keeps it above the editor
          // content; the toolbar itself is not a stacking context root, so a
          // plain absolute position is enough.
          className="absolute top-full left-0 mt-1 z-50 flex items-center gap-1 rounded-md border bg-popover p-1.5 shadow-md"
          role="menu"
        >
          {HIGHLIGHT_COLORS.map((c) => {
            const isSelected = currentColor === c.value;
            const isDefault = c.name === defaultColor.name;
            return (
              <button
                key={c.value}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyColor(c.value)}
                title={isDefault ? `${c.name} (theme default)` : c.name}
                aria-label={c.name}
                className={cn(
                  "h-5 w-5 rounded-sm border transition-transform hover:scale-110",
                  isDefault ? "border-foreground/60" : "border-border/60",
                  isSelected && "ring-2 ring-ring ring-offset-1 ring-offset-popover",
                )}
                style={{ backgroundColor: c.value }}
              />
            );
          })}
          <span className="mx-0.5 h-5 w-px bg-border" />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={removeHighlight}
            disabled={!active}
            title="Remove highlight"
            aria-label="Remove highlight"
            className={cn(
              "h-5 w-5 inline-flex items-center justify-center rounded-sm border border-border/60",
              active
                ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                : "text-muted-foreground/40 cursor-not-allowed",
            )}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function ToolButton({
  active,
  disabled,
  onClick,
  label,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(e) => {
        // Prevent the editor from losing focus when a toolbar button is
        // clicked — otherwise toggleBold etc. would run after the selection
        // collapsed to nothing.
        e.preventDefault();
      }}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
        disabled
          ? "text-muted-foreground/40 cursor-not-allowed"
          : active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
