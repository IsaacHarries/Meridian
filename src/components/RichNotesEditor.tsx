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

import { useEffect, useRef, useState } from "react";
import {
  useEditor,
  EditorContent,
  type Editor,
  type JSONContent,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
// StarterKit 3 already bundles Bold, Italic, Underline, Strike, Code,
// CodeBlock, Blockquote, Link, lists, etc., so we configure them through
// StarterKit's options object rather than re-importing. Highlight is the
// only mark we still bring in standalone.
import Highlight from "@tiptap/extension-highlight";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Code,
  Highlighter,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  SquareCode,
  Link2,
  X,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type LineHeightMode = "compact" | "normal" | "relaxed";

function resolveLineHeight(mode: LineHeightMode): string {
  switch (mode) {
    case "compact":
      return "1.3";
    case "relaxed":
      return "1.75";
    default:
      return "1.5";
  }
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
      Highlight,
      Placeholder.configure({
        placeholder: placeholder ?? "Type your meeting notes here…",
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
  const headingValue = editor.isActive("heading", { level: 1 })
    ? "h1"
    : editor.isActive("heading", { level: 2 })
      ? "h2"
      : editor.isActive("heading", { level: 3 })
        ? "h3"
        : "paragraph";

  function onHeadingChange(value: string) {
    if (value === "paragraph") {
      editor.chain().focus().setParagraph().run();
      return;
    }
    const level = Number(value.slice(1)) as 1 | 2 | 3;
    editor.chain().focus().setHeading({ level }).run();
  }

  // Link button is enabled when there's a selection (to wrap as a link) OR
  // when the cursor is already inside a link (to remove it). Without that
  // guard, clicking with an empty selection would do nothing visible and
  // feel broken.
  const linkActionable =
    editor.isActive("link") || !editor.state.selection.empty;

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-1 py-1 border-b">
      <select
        value={headingValue}
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
      </select>
      <Divider />
      <ToolButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label="Bold (⌘B)"
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label="Italic (⌘I)"
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        label="Underline (⌘U)"
      >
        <UnderlineIcon className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        label="Strikethrough"
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolButton>
      <Divider />
      <ToolButton
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
        label="Inline code"
      >
        <Code className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("highlight")}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        label="Highlight"
      >
        <Highlighter className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("link")}
        disabled={!linkActionable}
        onClick={onLinkClick}
        label={editor.isActive("link") ? "Remove link" : "Add link"}
      >
        <Link2 className="h-3.5 w-3.5" />
      </ToolButton>
      <Divider />
      <ToolButton
        active={editor.isActive("bulletList")}
        // toggleBulletList wraps the current line — empty or not — so clicking
        // on a blank line still produces a fresh "- " bullet, matching the
        // user's expectation that list buttons always insert a marker.
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        label="Bullet list"
      >
        <List className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        label="Numbered list"
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        label="Checklist"
      >
        <ListChecks className="h-3.5 w-3.5" />
      </ToolButton>
      <Divider />
      <ToolButton
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        label="Block quote"
      >
        <Quote className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("codeBlock")}
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
