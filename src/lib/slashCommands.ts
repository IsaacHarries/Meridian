/**
 * Slash-command framework for chat panels.
 *
 * A drop-in <SlashCommandInput> component reads a panel's `commands` array
 * and provides an autocomplete popover triggered by a leading `/`. Commands
 * fall into two groups:
 *
 *   1. Globals — provided by `createGlobalCommands(...)`, bound to per-panel
 *      callbacks (clearHistory, the current history, sendMessage). These are
 *      `/clear`, `/copy`, `/export`, `/retry`.
 *
 *   2. Panel-specific — each panel composes its own array on top of the
 *      globals.
 *
 * `/help` is always present; the component injects it automatically so it
 * can own the popover state.
 *
 * When a command is accepted:
 *   - zero-arg commands execute immediately and clear the input
 *   - args commands replace the input with "/name " so the user types the
 *     rest, then submits normally
 *
 * Ambiguity rule: if the typed prefix matches more than one command and the
 * user hits Enter without explicitly picking one, the component keeps the
 * palette open and does NOT send. Forcing an intentional selection is
 * preferable to silent surprises.
 */

import { toast } from "sonner";

async function copyToClipboard(text: string): Promise<void> {
  // Tauri 2's WKWebView supports the async Clipboard API as long as the
  // webview has focus. No plugin needed for this simple text-copy path.
  await navigator.clipboard.writeText(text);
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SlashCommandContext {
  /** Text after "/name " — already trimmed. Empty string when no args given. */
  args: string;
  /** Show a toast (success / error / info). */
  toast: typeof toast;
  /**
   * Replace the textarea contents. Commands that need to prefill an input
   * template (e.g. /at "HH:MM — ") use this instead of executing immediately.
   * The component will also focus the textarea after calling this.
   */
  setInput: (text: string) => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** Optional argument hint shown in the autocomplete list, e.g. "[file]" or "<reason>". */
  args?: string;
  /**
   * Other names that match this command in the palette. Useful for aliasing
   * /next to /approve, for example.
   */
  aliases?: string[];
  execute: (ctx: SlashCommandContext) => Promise<void> | void;
}

/** Hooks every panel can provide to get the four universal commands. */
export interface GlobalCommandHooks {
  /** Wipe the panel's chat history. For meetings this also persists the empty list. */
  clearHistory: () => void | Promise<void>;
  /** Snapshot of the current chat. Used by /copy, /export, /retry. */
  history: ChatTurn[];
  /** Re-send an arbitrary user message (bypasses the slash parser). Used by /retry. */
  sendMessage: (text: string) => void | Promise<void>;
  /**
   * Optional: drop the last assistant message before /retry re-sends, so
   * it can be regenerated cleanly. If omitted, /retry just re-sends
   * without removing anything.
   */
  removeLastAssistantMessage?: () => void | Promise<void>;
}

export function createGlobalCommands(hooks: GlobalCommandHooks): SlashCommand[] {
  return [
    {
      name: "clear",
      description: "Clear this chat's history",
      execute: async () => {
        await hooks.clearHistory();
        toast.success("Chat cleared");
      },
    },
    {
      name: "copy",
      description: "Copy the last AI reply to the clipboard",
      execute: async () => {
        const lastAssistant = [...hooks.history]
          .reverse()
          .find((t) => t.role === "assistant");
        if (!lastAssistant) {
          toast.info("No assistant reply yet");
          return;
        }
        try {
          await copyToClipboard(lastAssistant.content);
          toast.success("Copied last reply");
        } catch (e) {
          toast.error("Copy failed", { description: String(e) });
        }
      },
    },
    {
      name: "export",
      description: "Copy the full chat thread as markdown",
      execute: async () => {
        if (hooks.history.length === 0) {
          toast.info("No chat to export");
          return;
        }
        const md = hooks.history
          .map((t) => {
            const role = t.role === "user" ? "**You**" : "**AI**";
            return `${role}: ${t.content}`;
          })
          .join("\n\n---\n\n");
        try {
          await copyToClipboard(md);
          toast.success("Copied chat as markdown");
        } catch (e) {
          toast.error("Copy failed", { description: String(e) });
        }
      },
    },
    {
      name: "retry",
      description: "Re-run the last message for a fresh reply",
      execute: async () => {
        const lastUser = [...hooks.history]
          .reverse()
          .find((t) => t.role === "user");
        if (!lastUser) {
          toast.info("No user message to retry");
          return;
        }
        if (hooks.removeLastAssistantMessage) {
          await hooks.removeLastAssistantMessage();
        }
        await hooks.sendMessage(lastUser.content);
      },
    },
  ];
}

/**
 * Parse a raw input string into (commandName, args) when it starts with `/`.
 * Returns null when the input is a normal chat message (no leading slash).
 */
export function parseSlashInput(raw: string): { name: string; args: string } | null {
  if (!raw.startsWith("/")) return null;
  const trimmed = raw.slice(1);
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.trim().toLowerCase(), args: "" };
  }
  return {
    name: trimmed.slice(0, spaceIdx).trim().toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

/** Filter commands by substring match on name or aliases. */
export function filterCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => {
    if (c.name.toLowerCase().includes(q)) return true;
    return (c.aliases ?? []).some((a) => a.toLowerCase().includes(q));
  });
}

/** Exact (name or alias) lookup. Case-insensitive. */
export function resolveCommand(
  commands: SlashCommand[],
  name: string,
): SlashCommand | null {
  const n = name.toLowerCase();
  return (
    commands.find((c) => c.name.toLowerCase() === n) ??
    commands.find((c) =>
      (c.aliases ?? []).some((a) => a.toLowerCase() === n),
    ) ??
    null
  );
}
