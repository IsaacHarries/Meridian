import { useState } from "react";
import { MessageSquare, MessageCirclePlus } from "lucide-react";
import { highlightDiffLine } from "@/lib/syntaxHighlight";

// ── Annotated diff line types ────────────────────────────────────────────────

export interface AnnotatedLine {
  raw: string;
  oldNum: number | null;
  newNum: number | null;
}

// ── Search match highlighting ─────────────────────────────────────────────────

export interface MatchRange {
  start: number;
  end: number;
  isCurrent: boolean;
}

function renderWithHighlights(raw: string, matches: MatchRange[]): React.ReactNode {
  if (matches.length === 0) return raw || " ";
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((m, i) => {
    if (m.start > cursor) parts.push(raw.slice(cursor, m.start));
    parts.push(
      <span
        key={i}
        data-match-current={m.isCurrent ? "true" : undefined}
        className={
          m.isCurrent
            ? "bg-orange-300 dark:bg-orange-600 text-foreground rounded-sm"
            : "bg-yellow-200 dark:bg-yellow-800/70 text-foreground rounded-sm"
        }
      >
        {raw.slice(m.start, m.end)}
      </span>,
    );
    cursor = m.end;
  });
  if (cursor < raw.length) parts.push(raw.slice(cursor));
  return parts;
}

export function DiffLineRow({
  line, clickable, onClick, hasComments, isPendingComment, matches, language,
}: {
  line: AnnotatedLine;
  clickable?: boolean;
  onClick?: () => void;
  hasComments?: boolean;
  isPendingComment?: boolean;
  matches?: MatchRange[];
  /** Prism language id, derived from the section's file path. When null
   *  (unknown extension / no path), the line renders as plain text. */
  language?: string | null;
}) {
  const [rowHovered, setRowHovered] = useState(false);
  const { raw, oldNum, newNum } = line;

  let rowCls = "";
  let textCls = "text-muted-foreground";

  if (raw.startsWith("+") && !raw.startsWith("+++")) {
    // Row background flags the line as added; the +/- glyph itself stays
    // coloured (see DiffLineCode + diff-prefix-add CSS) but the body text
    // uses normal foreground / syntax-highlight colours.
    rowCls = "bg-green-50 dark:bg-green-950/30";
    textCls = "";
  } else if (raw.startsWith("-") && !raw.startsWith("---")) {
    rowCls = "bg-red-50 dark:bg-red-950/30";
    textCls = "";
  } else if (raw.startsWith("@@")) {
    rowCls = "bg-muted/40";
    textCls = "text-muted-foreground";
  } else if (
    raw.startsWith("diff ") ||
    raw.startsWith("index ") ||
    raw.startsWith("---") ||
    raw.startsWith("+++")
  ) {
    rowCls = "bg-muted/20";
    textCls = "text-muted-foreground font-medium";
  }

  const pendingCls = isPendingComment ? " ring-1 ring-inset ring-primary/50" : "";

  const gutterCls = `select-none text-right font-mono text-[10px] leading-5 w-10 shrink-0 px-1.5 border-0 text-muted-foreground/50 ${rowCls}`;

  return (
    <div
      className={`flex min-w-0 ${rowCls}${pendingCls}`}
      data-new-line={newNum ?? undefined}
      data-old-line={oldNum ?? undefined}
      onMouseEnter={() => setRowHovered(true)}
      onMouseLeave={() => setRowHovered(false)}
    >
      <span className={gutterCls}>{oldNum ?? ""}</span>
      <span className={gutterCls}>{newNum ?? ""}</span>
      {/* Comment button gutter — only this is clickable */}
      <span className={`w-5 shrink-0 flex items-center justify-center ${rowCls}`}>
        {hasComments ? (
          <MessageSquare className="h-2.5 w-2.5 text-blue-500" />
        ) : clickable ? (
          <button
            onClick={onClick}
            title="Add a comment on this line"
            className={`h-4 w-4 flex items-center justify-center rounded hover:bg-muted/60 focus:outline-none transition-opacity ${rowHovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          >
            <MessageCirclePlus className="h-2.5 w-2.5 text-muted-foreground/70" />
          </button>
        ) : null}
      </span>
      <DiffLineCode
        raw={raw}
        textCls={textCls}
        matches={matches}
        language={language}
      />
    </div>
  );
}

// ── Diff line code cell ───────────────────────────────────────────────────────
//
// Owns the right-hand "code" portion of a diff row. Three rendering modes,
// in priority order:
//   1. Active search match → render with <mark>-style highlights so the user
//      can read the match in context. Syntax highlighting is suppressed
//      because mixing the two would obscure which spans are matches.
//   2. Prism syntax highlighting available (known language, code line) →
//      render the prism HTML via dangerouslySetInnerHTML; a `.diff-token`
//      wrapper class scopes the colour rules in index.css.
//   3. Fallback → plain text with the row's added/removed/context colour.

export function DiffLineCode({
  raw,
  textCls,
  matches,
  language,
}: {
  raw: string;
  textCls: string;
  matches?: MatchRange[];
  language?: string | null;
}) {
  const baseCls =
    "select-text cursor-text font-mono text-xs leading-5 pl-2 pr-4 whitespace-pre min-w-0 flex-1";

  // Detect the +/- prefix so we can render it in its own coloured span. The
  // body of the line then uses the row's textCls (normally neutral so syntax
  // highlighting shows through).
  const first = raw.charAt(0);
  const isAdd = first === "+" && !raw.startsWith("+++");
  const isDel = first === "-" && !raw.startsWith("---");
  const prefixCls = isAdd
    ? "diff-prefix-add"
    : isDel
    ? "diff-prefix-del"
    : "";
  const body = isAdd || isDel ? raw.slice(1) : raw;

  if (matches && matches.length > 0) {
    // Shift match offsets by 1 when we've split off a prefix character so
    // search highlights still align with the original raw content.
    const adjusted: MatchRange[] = (isAdd || isDel)
      ? matches
          .map((m) => ({ ...m, start: m.start - 1, end: m.end - 1 }))
          .filter((m) => m.end > 0)
          .map((m) => ({ ...m, start: Math.max(0, m.start) }))
      : matches;
    return (
      <span className={`${baseCls} ${textCls}`}>
        {prefixCls && <span className={prefixCls}>{first}</span>}
        {renderWithHighlights(body || " ", adjusted)}
      </span>
    );
  }

  const html = highlightDiffLine(raw, language ?? null);
  if (html !== null) {
    return (
      <span
        className={`${baseCls} diff-token ${textCls}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <span className={`${baseCls} ${textCls}`}>
      {prefixCls && <span className={prefixCls}>{first}</span>}
      {body || " "}
    </span>
  );
}
