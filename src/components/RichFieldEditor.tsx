/**
 * Rich-text editor for JIRA ticket fields shown in the Groom Tickets panel.
 *
 * Why TipTap + tiptap-markdown? Our pipeline carries field values as
 * markdown (the Rust ADF→markdown projection emits headings, lists, bold/
 * italic, image embeds, etc.). The editor needs to:
 *   - Hydrate from markdown so the user sees formatted text, not raw `**…**`.
 *   - Emit markdown on edit so we can round-trip it back to JIRA via the
 *     existing `update_jira_fields` command.
 *   - Render image markdown via the same proxy used elsewhere
 *     (RemoteImage), so JIRA-attachment images appear inline while editing.
 *
 * The component is "always editable" — there's no view/edit toggle. The
 * caller decides when the value is dirty (compare emitted markdown to its
 * own baseline) and shows a Save button accordingly.
 *
 * The toolbar is intentionally a JIRA-compatible subset of the meeting-
 * notes toolbar: only marks/blocks that round-trip cleanly through
 * markdown into ADF. Specifically excluded:
 *   - Underline (no markdown representation; would degrade to plain text)
 *   - Highlight (ADF-only mark; markdown loses it)
 *   - Task list (`- [ ]` lands as plain bullets in ADF)
 *   - Spacing (per-document personal preference, not a content concern)
 */

import { useEffect, useRef, useState } from "react";
import {
  useEditor,
  useEditorState,
  EditorContent,
  type Editor,
  type JSONContent,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link2,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  X,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface RichFieldEditorProps {
  /**
   * Markdown source. The editor hydrates from this on mount and re-syncs
   * any time `value` differs from the markdown the editor most recently
   * emitted (so external writes — AI suggestions accepting, fresh refetch
   * after save, etc. — propagate cleanly without clobbering in-progress
   * edits caused by the same change).
   */
  value: string;
  /** Fires on every edit with the latest markdown projection. */
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** Disable input while a save is in flight. */
  disabled?: boolean;
}

export function RichFieldEditor({
  value,
  onChange,
  placeholder,
  disabled,
}: RichFieldEditorProps) {
  // Latest markdown the editor itself emitted. We use this to differentiate
  // "this is our own onChange echo" from "the value prop genuinely changed".
  const lastEmittedRef = useRef<string>(value);
  // Stable callback ref so updating onChange between renders doesn't
  // recreate the editor (which would lose cursor / selection state).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Same options as RichNotesEditor — links open externally only when
        // explicitly clicked, not when the caret is dropped on them.
        link: { openOnClick: false, autolink: true, linkOnPaste: true },
      }),
      Markdown.configure({
        // Round-trip behaviour we want from the markdown extension:
        //   - HTML in source: kept verbatim so anything we don't model
        //     (panels, mentions) doesn't get silently stripped.
        //   - Tight lists: matches what our Rust ADF→markdown emits.
        //   - Linkify on paste: friendly UX for users dropping in URLs.
        html: true,
        tightLists: true,
        bulletListMarker: "-",
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "Type here…",
      }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      // tiptap-markdown registers a `markdown` storage slot at runtime,
      // but it isn't in the @tiptap/core Storage type definitions —
      // hence the cast.
      const storage = editor.storage as unknown as {
        markdown: { getMarkdown: () => string };
      };
      const markdown = storage.markdown.getMarkdown();
      lastEmittedRef.current = markdown;
      onChangeRef.current(markdown);
    },
    editorProps: {
      attributes: {
        // `prose` mirrors the read-only MarkdownBlock styling so editing
        // looks like editing what the user already saw, not a different
        // chrome. min-h-full keeps the click area filling the wrapping
        // card even when the document is short.
        class:
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-full px-3 py-2",
      },
    },
  });

  // External value changes (AI suggestion accepted, refetch after save,
  // ticket switched) — push them into the editor without triggering an
  // onChange round-trip. If the new value matches what the editor last
  // emitted, this is just an echo; bail out so we don't fight the user's
  // in-flight typing.
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmittedRef.current) return;
    // setContent accepts either a string (parsed by the configured input
    // pipeline — Markdown extension takes care of md→TipTap) or a doc.
    editor.commands.setContent(value as unknown as JSONContent | string, {
      emitUpdate: false,
    });
    lastEmittedRef.current = value;
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  // Inline link prompt — same lightweight pattern as the meeting-notes
  // editor, in lieu of a Dialog. State lives at the editor level so the
  // toolbar's Link button can stash the current selection's link href and
  // pop it back into the input on toggle.
  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [linkInitial, setLinkInitial] = useState("");

  if (!editor) return null;

  function startLinkPrompt() {
    if (!editor) return;
    if (editor.isActive("link")) {
      // Mirror behaviour of every other mark button — clicking while the
      // caret is in a link removes it.
      editor.chain().focus().unsetLink().run();
      return;
    }
    if (editor.state.selection.empty) return; // Toolbar disables in this case anyway.
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
    <div className="flex flex-col">
      <Toolbar editor={editor} onLinkClick={startLinkPrompt} />
      {linkPromptOpen && (
        <LinkInputRow
          initialUrl={linkInitial}
          onApply={applyLink}
          onCancel={() => setLinkPromptOpen(false)}
        />
      )}
      <EditorWrapper editor={editor} />
    </div>
  );
}

// Thin wrapper so the EditorContent doesn't need to know about styling.
// Kept separate from RichFieldEditor so the conditional `if (!editor) return null`
// doesn't violate the rules-of-hooks shape — all hooks live above.
function EditorWrapper({ editor }: { editor: Editor }) {
  return <EditorContent editor={editor} />;
}

// ── Toolbar ─────────────────────────────────────────────────────────────────

function Toolbar({
  editor,
  onLinkClick,
}: {
  editor: Editor;
  onLinkClick: () => void;
}) {
  // TipTap 3's useEditor doesn't re-render on selection-only transactions
  // by default, so toolbar active-state needs an explicit subscription —
  // same gotcha and same fix as the meeting-notes editor.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      headingValue: editor.isActive("heading", { level: 1 })
        ? "h1"
        : editor.isActive("heading", { level: 2 })
          ? "h2"
          : editor.isActive("heading", { level: 3 })
            ? "h3"
            : "paragraph",
      isBold: editor.isActive("bold"),
      isItalic: editor.isActive("italic"),
      isStrike: editor.isActive("strike"),
      isCode: editor.isActive("code"),
      isLink: editor.isActive("link"),
      isBulletList: editor.isActive("bulletList"),
      isOrderedList: editor.isActive("orderedList"),
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
    const level = Number(value.slice(1)) as 1 | 2 | 3;
    editor.chain().focus().setHeading({ level }).run();
  }

  // Link is enabled when there's a selection (to wrap into a link) OR when
  // the caret already sits inside one (to remove it). Without that guard,
  // clicking with an empty selection would do nothing visible.
  const linkActionable = state.isLink || !state.selectionEmpty;

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-1 py-1 border-b">
      <select
        value={state.headingValue}
        onChange={(e) => onHeadingChange(e.target.value)}
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
        // clicked — otherwise toggleBold etc. would run after the
        // selection collapsed to nothing.
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

// ── Link prompt row ─────────────────────────────────────────────────────────

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
