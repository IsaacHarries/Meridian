/**
 * Prism-based syntax highlighting for diff lines in the PR Review screen.
 *
 * Why a tiny custom helper instead of `react-syntax-highlighter`?
 *   - We highlight ONE LINE at a time (the rest of a unified diff carries
 *     +/- prefix + comment overlays + line numbers + search highlights),
 *     so a per-line component would multiply React tree depth needlessly.
 *   - Returning an HTML string lets DiffLineRow keep its existing flex
 *     layout intact and just inject coloured tokens via dangerouslySetInnerHTML.
 *   - Bundle size: only the languages we explicitly import below ship.
 *
 * The Implement-a-ticket workflow already uses Monaco DiffEditor, which
 * carries its own syntax highlighting; this helper only powers the unified
 * diff in PR Review.
 */

import Prism from "prismjs";
// Languages bundled at build time. Order matters when a language extends
// another (tsx → typescript → javascript) — Prism resolves the dependency
// chain via these imports. Add more languages here as the team's repos
// expand; missing ones gracefully fall back to no-highlight.
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import "prismjs/components/prism-java";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-css";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";

/** File extension → Prism language id. Returns null for unknown extensions
 *  so callers can fall back to plain rendering. */
export function getPrismLanguageForPath(path: string): string | null {
  const ext = path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "go":
      return "go";
    case "java":
      return "java";
    case "rb":
      return "ruby";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "css":
    case "scss":
    case "sass":
      return "css";
    case "md":
    case "markdown":
      return "markdown";
    case "sql":
      return "sql";
    default:
      return null;
  }
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

/**
 * Highlight a single diff line. The leading +/-/space prefix is preserved
 * verbatim (it's structural, not code) and the rest of the line is fed to
 * Prism. Returns an HTML string suitable for dangerouslySetInnerHTML, or
 * `null` when no highlighting should apply (unknown language, hunk header,
 * file metadata line, or no language passed).
 */
export function highlightDiffLine(
  raw: string,
  language: string | null,
): string | null {
  if (!language) return null;
  // Skip non-code lines — these carry no source code to colour.
  if (
    raw.startsWith("@@") ||
    raw.startsWith("diff ") ||
    raw.startsWith("index ") ||
    raw.startsWith("--- ") ||
    raw.startsWith("+++ ")
  ) {
    return null;
  }
  const grammar = Prism.languages[language];
  if (!grammar) return null;

  // Only +, -, or space (context) reach this branch, given the guards above.
  const first = raw.charAt(0);
  const hasPrefix = first === "+" || first === "-" || first === " ";
  const prefix = hasPrefix ? first : "";
  const code = hasPrefix ? raw.slice(1) : raw;

  if (code.length === 0) {
    return escapeHtml(raw);
  }

  try {
    const highlighted = Prism.highlight(code, grammar, language);
    return escapeHtml(prefix) + highlighted;
  } catch {
    // Defensive — Prism shouldn't throw on valid grammars, but if it does
    // (malformed grammar in dev, etc.), fall through to no-highlight.
    return null;
  }
}
