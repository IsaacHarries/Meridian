/**
 * Chat input with slash-command autocomplete.
 *
 * Drop-in replacement for a plain <Textarea> + send button. The panel passes
 * its own `commands` array (typically `[...createGlobalCommands(...), ...panelCommands]`);
 * this component injects a `/help` command at the top of the list that opens
 * a popover listing every available command. That means `/help` behavior is
 * owned by the component and panels don't need to rewire it each time.
 *
 * Behavior:
 *   - typing `/` (as first character, before any whitespace) opens an
 *     autocomplete popover filtered by the partial name
 *   - ↑/↓ navigates; Tab/Enter accepts; Esc closes
 *   - accepting a zero-arg command runs it and clears the input
 *   - accepting an args command replaces the input with "/name " and leaves
 *     the palette closed so the user can type the argument body
 *   - pressing the submit key (configurable: "enter" or "cmd-enter") with
 *     a complete slash command runs it; with no slash, sends as normal chat
 *   - if the typed prefix matches more than one command and the user hits
 *     Enter without an explicit selection, the palette stays open and
 *     nothing is sent — forces an intentional pick
 */

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Loader2, Command as CommandIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  type SlashCommand,
  type SlashCommandContext,
  filterCommands,
  parseSlashInput,
  resolveCommand,
} from "@/lib/slashCommands";
import { TokenSuggestPopover } from "@/components/TokenSuggestPopover";

export interface SlashCommandInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Send a plain (non-slash) chat message. */
  onSend: (text: string) => void | Promise<void>;
  commands: SlashCommand[];
  busy?: boolean;
  placeholder?: string;
  /**
   * Which key submits:
   *   - "enter"     (default): Enter sends, Shift+Enter inserts a newline.
   *   - "cmd-enter":           ⌘↵ (or Ctrl↵) sends, Enter inserts a newline.
   * Kept as a prop for future per-panel overrides; every current chat uses the
   * default so this rarely needs to be set explicitly.
   */
  sendKey?: "enter" | "cmd-enter";
  /**
   * Rows for the underlying textarea. Defaults to 2 which matches the
   * existing chat panels.
   */
  rows?: number;
  /**
   * Classname passed through to the textarea (not the outer wrapper).
   */
  textareaClassName?: string;
  /**
   * When provided, enables a `#tag` autocomplete popover that fires
   * while typing a `#` token. Pass the pool of available tag names.
   */
  tagPool?: string[];
  /**
   * When provided, enables an `@name` autocomplete popover that fires
   * while typing an `@` token. Pass the pool of available participant
   * names (typically union of speakers + notes mentions).
   */
  namePool?: string[];
}

export function SlashCommandInput({
  value,
  onChange,
  onSend,
  commands,
  busy = false,
  placeholder,
  sendKey = "enter",
  rows = 2,
  textareaClassName,
  tagPool,
  namePool,
}: SlashCommandInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);

  // Merge in the built-in /help command so panels don't each reinvent it.
  const effectiveCommands = useMemo<SlashCommand[]>(() => {
    const help: SlashCommand = {
      name: "help",
      description: "Show all available commands",
      execute: () => {
        setHelpOpen(true);
      },
    };
    // De-dupe in case a panel accidentally provides its own /help — ours wins.
    return [help, ...commands.filter((c) => c.name.toLowerCase() !== "help")];
  }, [commands]);

  // What we use to decide whether the palette should be open and what to show.
  const parsed = useMemo(() => parseSlashInput(value), [value]);
  const inCommandName = useMemo(() => {
    // "In command-name mode" = starts with /, hasn't typed a space yet.
    if (!value.startsWith("/")) return false;
    return !value.slice(1).includes(" ");
  }, [value]);

  const filtered = useMemo(() => {
    if (!inCommandName) return [];
    return filterCommands(effectiveCommands, parsed?.name ?? "");
  }, [effectiveCommands, inCommandName, parsed?.name]);

  // Open/close the palette in response to input state. Keep highlight in range.
  useEffect(() => {
    const shouldOpen = inCommandName && filtered.length > 0;
    setPaletteOpen(shouldOpen);
    setHighlightIndex((prev) => {
      if (!shouldOpen) return 0;
      if (prev >= filtered.length) return Math.max(0, filtered.length - 1);
      return prev;
    });
  }, [inCommandName, filtered.length]);

  const effectivePlaceholder =
    placeholder ??
    (sendKey === "cmd-enter"
      ? "Type a message. ⌘↵ to send. / for commands."
      : "Type a message. Enter to send. Shift+Enter for newline. / for commands.");

  async function runCommand(
    cmd: SlashCommand,
    args: string,
  ): Promise<void> {
    const ctx: SlashCommandContext = {
      args,
      toast,
      setInput: (text: string) => {
        onChange(text);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        });
      },
    };
    try {
      await cmd.execute(ctx);
    } catch (e) {
      toast.error(`/${cmd.name} failed`, { description: String(e) });
    }
  }

  async function acceptCommand(cmd: SlashCommand): Promise<void> {
    setPaletteOpen(false);
    if (cmd.args) {
      // Expand input to "/name " so the user can keep typing the argument.
      onChange(`/${cmd.name} `);
      // Refocus and place caret at end.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } else {
      onChange("");
      await runCommand(cmd, "");
    }
  }

  async function handleSubmit(): Promise<void> {
    if (busy) return;
    const raw = value;
    if (!raw.trim()) return;

    const parsed = parseSlashInput(raw);
    if (parsed) {
      // Slash path: resolve by exact name (or alias). If no exact match but
      // still in command-name mode with multiple candidates, block submission
      // and force an intentional pick.
      const resolved = resolveCommand(effectiveCommands, parsed.name);
      if (resolved) {
        onChange("");
        await runCommand(resolved, parsed.args);
        return;
      }
      if (inCommandName) {
        // Ambiguous / unknown name still being typed — keep palette open.
        toast.info("Pick a command or press Esc to cancel", {
          description: "Use ↑/↓ then Tab/Enter.",
        });
        setPaletteOpen(filtered.length > 0);
        return;
      }
      // Literal slash in the body (e.g. URL) — pass through as chat.
    }

    // Normal chat path.
    onChange("");
    await onSend(raw);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Palette navigation takes precedence when open.
    if (paletteOpen && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex(
          (i) => (i - 1 + filtered.length) % filtered.length,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPaletteOpen(false);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        // Tab always accepts; Enter accepts only if exactly one command is
        // highlighted AND there's no newline intent (shift). This matches
        // "ambiguity forces pick" — highlight is always one item.
        const target = filtered[highlightIndex];
        if (target) {
          e.preventDefault();
          void acceptCommand(target);
          return;
        }
      }
    }

    // Submit key.
    const isSubmit =
      sendKey === "enter"
        ? e.key === "Enter" && !e.shiftKey
        : e.key === "Enter" && (e.metaKey || e.ctrlKey);
    if (isSubmit) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  return (
    <div className="relative">
      {/* Autocomplete palette */}
      {paletteOpen && filtered.length > 0 && (
        <div
          className="absolute bottom-full left-0 right-0 mb-1.5 rounded-md border border-input bg-popover text-popover-foreground shadow-md z-50 max-h-60 overflow-y-auto"
          role="listbox"
        >
          {filtered.map((cmd, i) => (
            <button
              key={cmd.name}
              type="button"
              role="option"
              aria-selected={i === highlightIndex}
              onMouseEnter={() => setHighlightIndex(i)}
              onClick={() => {
                void acceptCommand(cmd);
              }}
              className={cn(
                "w-full flex items-baseline gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                i === highlightIndex
                  ? "bg-muted"
                  : "hover:bg-muted/60",
              )}
            >
              <span className="font-mono text-xs text-primary shrink-0">
                /{cmd.name}
              </span>
              {cmd.args && (
                <span className="font-mono text-xs text-muted-foreground shrink-0">
                  {cmd.args}
                </span>
              )}
              <span className="text-xs text-muted-foreground truncate">
                {cmd.description}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Help popover */}
      {helpOpen && (
        <div
          className="absolute bottom-full left-0 right-0 mb-1.5 rounded-md border border-input bg-popover text-popover-foreground shadow-md z-50 max-h-80 overflow-y-auto"
          role="dialog"
        >
          <div className="sticky top-0 bg-popover border-b px-3 py-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <CommandIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Commands
              </span>
            </div>
            <button
              onClick={() => setHelpOpen(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          <ul className="py-1">
            {effectiveCommands.map((cmd) => (
              <li
                key={cmd.name}
                className="flex items-baseline gap-2 px-3 py-1.5 text-sm"
              >
                <span className="font-mono text-xs text-primary shrink-0">
                  /{cmd.name}
                </span>
                {cmd.args && (
                  <span className="font-mono text-xs text-muted-foreground shrink-0">
                    {cmd.args}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {cmd.description}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2 items-end">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={rows}
          placeholder={effectivePlaceholder}
          className={cn("resize-none text-sm", textareaClassName)}
          disabled={busy}
        />
        <Button
          onClick={() => void handleSubmit()}
          disabled={busy || !value.trim()}
          size="sm"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>

      {(tagPool || namePool) && (
        <TokenSuggestPopover
          value={value}
          onChange={onChange}
          inputRef={textareaRef}
          tagPool={tagPool ?? []}
          namePool={namePool ?? []}
        />
      )}
    </div>
  );
}
