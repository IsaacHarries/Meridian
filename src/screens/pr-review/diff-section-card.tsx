import { getPrismLanguageForPath } from "@/lib/syntaxHighlight";
import { type BitbucketComment, type BitbucketTask } from "@/lib/tauri/bitbucket";
import { ChevronDown, ChevronRight, FileCode } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { GapExpandRow } from "./_shared";
import { DiffLineRow, type AnnotatedLine, type MatchRange } from "./diff-line";
import { InlineCommentBox, InlineCommentThread } from "./inline-comment";

// ── Diff section type ────────────────────────────────────────────────────────

export interface DiffSection {
  path: string;
  lines: string[];
}

export function sanitizeId(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

// ── Hunk extraction & context-expansion render items ─────────────────────────

interface Hunk {
  /** Index of the @@ header line within the annotated array */
  headerIdx: number;
  /** Exclusive index where this hunk's content ends (next @@ or end of section) */
  contentEndIdx: number;
  /** First new-side line number in this hunk (from the @@ header) */
  newStart: number | null;
  /** Last new-side line number covered by this hunk */
  newEnd: number | null;
}

function extractHunks(annotated: AnnotatedLine[]): Hunk[] {
  const hunks: Hunk[] = [];
  for (let i = 0; i < annotated.length; i++) {
    if (!annotated[i].raw.startsWith("@@")) continue;
    let end = i + 1;
    while (end < annotated.length && !annotated[end].raw.startsWith("@@")) end++;
    const m = annotated[i].raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    const newStart = m ? parseInt(m[3], 10) : null;
    const newCount = m ? (m[4] ? parseInt(m[4], 10) : 1) : null;
    const newEnd = newStart != null && newCount != null ? newStart + Math.max(0, newCount - 1) : null;
    hunks.push({ headerIdx: i, contentEndIdx: end, newStart, newEnd });
    i = end - 1;
  }
  return hunks;
}

type RenderItem =
  | { kind: "diff"; annotatedIdx: number; line: AnnotatedLine }
  | { kind: "context"; line: AnnotatedLine }
  | { kind: "gap"; gapId: string; lineCount: number | null };

function buildRenderItems(
  annotated: AnnotatedLine[],
  hunks: Hunk[],
  fileLines: string[] | null,
  expandedGaps: Set<string>,
): RenderItem[] {
  const items: RenderItem[] = [];
  const preHunkEnd = hunks[0]?.headerIdx ?? annotated.length;

  // Pre-hunk file header lines (diff --git, index, ---, +++)
  for (let i = 0; i < preHunkEnd; i++) {
    items.push({ kind: "diff", annotatedIdx: i, line: annotated[i] });
  }

  // Gap above the first hunk (if any)
  if (hunks.length > 0 && hunks[0].newStart != null && hunks[0].newStart > 1) {
    const gapStart = 1;
    const gapEnd = hunks[0].newStart - 1;
    const gapId = "before";
    if (expandedGaps.has(gapId) && fileLines) {
      for (let n = gapStart; n <= gapEnd && n - 1 < fileLines.length; n++) {
        items.push({ kind: "context", line: { raw: " " + fileLines[n - 1], oldNum: null, newNum: n } });
      }
    } else {
      items.push({ kind: "gap", gapId, lineCount: gapEnd - gapStart + 1 });
    }
  }

  // Each hunk + the gap after it
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    for (let i = hunk.headerIdx; i < hunk.contentEndIdx; i++) {
      items.push({ kind: "diff", annotatedIdx: i, line: annotated[i] });
    }

    if (h < hunks.length - 1) {
      const next = hunks[h + 1];
      const gapStart = (hunk.newEnd ?? 0) + 1;
      const gapEnd = (next.newStart ?? 0) - 1;
      const gapSize = gapEnd - gapStart + 1;
      if (gapSize > 0) {
        const gapId = `between-${h}`;
        if (expandedGaps.has(gapId) && fileLines) {
          for (let n = gapStart; n <= gapEnd && n - 1 < fileLines.length; n++) {
            items.push({ kind: "context", line: { raw: " " + fileLines[n - 1], oldNum: null, newNum: n } });
          }
        } else {
          items.push({ kind: "gap", gapId, lineCount: gapSize });
        }
      }
    } else {
      // Trailing gap after the last hunk
      const gapStart = (hunk.newEnd ?? 0) + 1;
      const gapId = "after";
      if (expandedGaps.has(gapId) && fileLines) {
        for (let n = gapStart; n <= fileLines.length; n++) {
          items.push({ kind: "context", line: { raw: " " + fileLines[n - 1], oldNum: null, newNum: n } });
        }
      } else if (!fileLines || gapStart <= fileLines.length) {
        items.push({
          kind: "gap",
          gapId,
          lineCount: fileLines ? Math.max(0, fileLines.length - gapStart + 1) : null,
        });
      }
    }
  }

  return items;
}

// ── Diff section card (with inline comment support) ───────────────────────────

interface DiffSectionCardProps {
  section: DiffSection;
  annotated: AnnotatedLine[];
  expanded: boolean;
  onToggleExpand: () => void;
  sectionRef: (el: HTMLDivElement | null) => void;
  inlineComments: BitbucketComment[];
  tasks: BitbucketTask[];
  myAccountId: string;
  myPostedCommentIds: number[];
  /** Keyed by annotated-line index within this section */
  matchesByLineIdx: Map<number, MatchRange[]>;
  /** Extra offset in px for the sticky header (e.g. to clear a sticky search bar above). */
  stickyTopOffset: number;
  /** If provided, enables context expansion by lazy-loading the full file contents. */
  onFetchFileContent?: (path: string) => Promise<string>;
  onPostInlineComment: (path: string, toLine: number, content: string) => Promise<void>;
  onReply: (parentId: number, content: string) => Promise<void>;
  onCreateTask: (commentId: number, content: string) => Promise<BitbucketTask>;
  onResolveTask: (taskId: number, resolved: boolean) => Promise<void>;
  onEditTask: (taskId: number, content: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onEditComment: (commentId: number, newContent: string) => Promise<void>;
  onAttachImage: (file: File) => Promise<string>;
}

export function DiffSectionCard({
  section, annotated, expanded, onToggleExpand, sectionRef,
  inlineComments, tasks, myAccountId, myPostedCommentIds, matchesByLineIdx, stickyTopOffset, onFetchFileContent,
  onPostInlineComment, onReply, onCreateTask, onResolveTask, onEditTask, onDeleteComment, onEditComment,
  onAttachImage,
}: DiffSectionCardProps) {
  const [pendingLine, setPendingLine] = useState<number | null>(null);

  const addedLines = section.lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removedLines = section.lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  // ── Context expansion state ─────────────────────────────────────────────────
  const [fileLines, setFileLines] = useState<string[] | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set());

  const hunks = useMemo(() => extractHunks(annotated), [annotated]);
  const renderItems = useMemo(
    () => buildRenderItems(annotated, hunks, fileLines, expandedGaps),
    [annotated, hunks, fileLines, expandedGaps],
  );
  // Resolve the Prism language once per section — DiffLineRow uses this to
  // decide whether to syntax-highlight the line's code portion.
  const language = useMemo(
    () => getPrismLanguageForPath(section.path),
    [section.path],
  );

  const ensureFileLoaded = useCallback(async () => {
    if (fileLines || loadingFile) return;
    if (!onFetchFileContent) {
      setFileError("Context expansion unavailable.");
      return;
    }
    setLoadingFile(true);
    setFileError(null);
    try {
      const content = await onFetchFileContent(section.path);
      setFileLines(content.split("\n"));
    } catch (e) {
      setFileError(String(e));
    } finally {
      setLoadingFile(false);
    }
  }, [fileLines, loadingFile, onFetchFileContent, section.path]);

  const toggleGap = useCallback(async (gapId: string) => {
    const isCurrentlyExpanded = expandedGaps.has(gapId);
    if (!isCurrentlyExpanded) await ensureFileLoaded();
    setExpandedGaps((prev) => {
      const next = new Set(prev);
      if (next.has(gapId)) next.delete(gapId);
      else next.add(gapId);
      return next;
    });
  }, [expandedGaps, ensureFileLoaded]);

  // Group top-level inline comments by new-side line number
  const commentsByLine = new Map<number, BitbucketComment[]>();
  for (const c of inlineComments) {
    if (c.inline?.toLine != null && c.parentId == null) {
      const ln = c.inline.toLine;
      if (!commentsByLine.has(ln)) commentsByLine.set(ln, []);
      commentsByLine.get(ln)!.push(c);
    }
  }
  // Build reply threads keyed by parent id
  const repliesById = new Map<number, BitbucketComment[]>();
  for (const c of inlineComments) {
    if (c.parentId != null) {
      if (!repliesById.has(c.parentId)) repliesById.set(c.parentId, []);
      repliesById.get(c.parentId)!.push(c);
    }
  }

  return (
    <div
      ref={sectionRef}
      id={`diff-file-${sanitizeId(section.path)}`}
      className="border rounded-md border-border"
    >
      {/* Sticky file header — stays in view while scrolling through the file.
          Implemented as a div+role="button" rather than a real <button> so
          the file path inside can be selected and copied. Native <button>
          elements suppress text selection in most browsers even with
          `user-select: text` on a child, which broke the path-copy UX. */}
      <div
        className="sticky z-10 border-b border-border rounded-t-md overflow-hidden backdrop-blur-sm"
        style={{ top: stickyTopOffset }}
      >
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          className="w-full flex items-center gap-2 px-3 py-2 bg-muted/80 hover:bg-muted/90 transition-colors text-left focus:outline-none cursor-pointer"
          onClick={(e) => {
            // If the user just finished a click-and-drag text selection
            // (anchored anywhere inside this header row), the browser
            // still fires a click on the row's LCA — skip the toggle so
            // releasing the drag-select doesn't collapse the file.
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) {
              const row = e.currentTarget as HTMLElement;
              if (
                (sel.anchorNode && row.contains(sel.anchorNode)) ||
                (sel.focusNode && row.contains(sel.focusNode))
              ) {
                return;
              }
            }
            onToggleExpand();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleExpand();
            }
          }}
        >
          <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span
            className="flex-1 text-xs font-mono truncate select-text cursor-text"
            // Stop propagation so click-and-drag on the path doesn't get
            // misread by the parent. The parent also guards against
            // toggling when a text selection was just made inside the
            // row, which catches drag-select cases the browser routes
            // straight to the parent's click handler.
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
          >
            {section.path}
          </span>
          <span className="text-xs text-green-600 shrink-0">+{addedLines}</span>
          <span className="text-xs text-red-500 shrink-0 ml-1">-{removedLines}</span>
          {inlineComments.filter(c => c.parentId == null).length > 0 && (
            <span className="ml-1 text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 rounded-full px-1.5 py-0.5 shrink-0">
              {inlineComments.filter(c => c.parentId == null).length} 💬
            </span>
          )}
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-1" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-1" />}
        </div>
      </div>
      {expanded && (
        <div
          className="overflow-x-auto overflow-y-clip [--tw-ring-shadow:0_0_#0000] [--tw-ring-offset-shadow:0_0_#0000]"
          // The horizontal scroll container also captures wheel events
          // for *vertical* scrolling in some browsers, even with
          // `overflow-y: clip` set, which makes vertical scrolling stall
          // when the cursor sits over the diff body. Explicitly forward
          // any wheel event whose dominant axis is vertical to the
          // nearest ancestor scroller.
          onWheel={(e) => {
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            const target = e.currentTarget as HTMLElement;
            // Walk up to find a vertically scrollable ancestor (the
            // diff pane). data-pr-diff-pane marks the canonical one.
            let parent: HTMLElement | null = target.parentElement;
            while (parent) {
              const style = window.getComputedStyle(parent);
              const overflowY = style.overflowY;
              const canScrollY =
                (overflowY === "auto" || overflowY === "scroll") &&
                parent.scrollHeight > parent.clientHeight;
              if (canScrollY) break;
              parent = parent.parentElement;
            }
            if (parent) {
              parent.scrollTop += e.deltaY;
            }
          }}
        >
          {renderItems.map((item, itemIdx) => {
            if (item.kind === "gap") {
              const isExpanded = expandedGaps.has(item.gapId);
              return (
                <GapExpandRow
                  key={`gap-${item.gapId}-${itemIdx}`}
                  lineCount={item.lineCount}
                  loading={loadingFile && !isExpanded}
                  error={fileError}
                  canExpand={!!onFetchFileContent}
                  onClick={() => toggleGap(item.gapId)}
                />
              );
            }

            if (item.kind === "context") {
              return (
                <div key={`ctx-${itemIdx}`} className="bg-blue-50/30 dark:bg-blue-950/10">
                  <DiffLineRow line={item.line} language={language} />
                </div>
              );
            }

            // kind === "diff"
            const { line, annotatedIdx } = item;
            const lineNum = line.newNum;
            const lineComments = lineNum != null ? (commentsByLine.get(lineNum) ?? []) : [];
            const isClickable = lineNum != null &&
              !line.raw.startsWith("@@") && !line.raw.startsWith("diff ") &&
              !line.raw.startsWith("index ") && !line.raw.startsWith("---") && !line.raw.startsWith("+++");
            return (
              <div key={`d-${annotatedIdx}`} data-line-idx={annotatedIdx}>
                <DiffLineRow
                  line={line}
                  clickable={isClickable}
                  onClick={isClickable && lineNum != null ? () => setPendingLine(pendingLine === lineNum ? null : lineNum) : undefined}
                  hasComments={lineComments.length > 0}
                  isPendingComment={lineNum != null && pendingLine === lineNum}
                  matches={matchesByLineIdx.get(annotatedIdx)}
                  language={language}
                />
                {pendingLine === lineNum && lineNum != null && (
                  <InlineCommentBox
                    onSubmit={async (content) => { await onPostInlineComment(section.path, lineNum, content); setPendingLine(null); }}
                    onCancel={() => setPendingLine(null)}
                    onAttachImage={onAttachImage}
                  />
                )}
                {lineComments.map((c) => (
                  <InlineCommentThread
                    key={c.id}
                    comment={c}
                    replies={repliesById.get(c.id) ?? []}
                    tasks={tasks.filter((t) => t.commentId === c.id)}
                    myAccountId={myAccountId}
                    myPostedCommentIds={myPostedCommentIds}
                    onReply={(content) => onReply(c.id, content)}
                    onCreateTask={(content) => onCreateTask(c.id, content)}
                    onResolveTask={onResolveTask}
                    onEditTask={onEditTask}
                    onDeleteComment={onDeleteComment}
                    onEditComment={onEditComment}
                    onAttachImage={onAttachImage}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
