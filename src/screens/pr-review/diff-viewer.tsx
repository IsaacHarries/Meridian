import { type BitbucketComment, type BitbucketTask } from "@/lib/tauri/bitbucket";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AnnotatedLine, type MatchRange } from "./diff-line";
import { DiffSearchBar } from "./diff-search-bar";
import { DiffSectionCard, type DiffSection } from "./diff-section-card";

// ── Diff parsing ─────────────────────────────────────────────────────────────

function parseDiffSections(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;

  for (const line of diff.split("\n")) {
    const gitMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (gitMatch) {
      if (current) sections.push(current);
      current = { path: gitMatch[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  // If no git diff headers (e.g. raw patch), treat as one section
  if (sections.length === 0 && diff.trim()) {
    sections.push({ path: "(diff)", lines: diff.split("\n") });
  }

  return sections;
}

/** Walk the raw diff lines for one file section and attach old/new line numbers. */
function annotateDiffLines(lines: string[]): AnnotatedLine[] {
  const result: AnnotatedLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of lines) {
    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      result.push({ raw, oldNum: null, newNum: null });
      continue;
    }

    // File header lines — no numbers
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ")
    ) {
      result.push({ raw, oldNum: null, newNum: null });
      continue;
    }

    if (raw.startsWith("+")) {
      result.push({ raw, oldNum: null, newNum: newLine });
      newLine++;
    } else if (raw.startsWith("-")) {
      result.push({ raw, oldNum: oldLine, newNum: null });
      oldLine++;
    } else {
      // Context line — present in both
      result.push({ raw, oldNum: oldLine, newNum: newLine });
      oldLine++;
      newLine++;
    }
  }

  return result;
}

// ── Diff viewer ───────────────────────────────────────────────────────────────

interface DiffViewerProps {
  diff: string;
  highlightTarget: { path: string; line: number | null } | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  comments: BitbucketComment[];
  tasks: BitbucketTask[];
  myAccountId: string;
  myPostedCommentIds: number[];
  /** Fetch full file content at the PR's source commit (for context expansion). */
  onFetchFileContent?: (path: string) => Promise<string>;
  onPostInlineComment: (path: string, toLine: number, content: string) => Promise<void>;
  onReply: (parentId: number, content: string) => Promise<void>;
  onCreateTask: (commentId: number, content: string) => Promise<BitbucketTask>;
  onResolveTask: (taskId: number, resolved: boolean) => Promise<void>;
  onEditTask: (taskId: number, content: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onEditComment: (commentId: number, newContent: string) => Promise<void>;
  /** Resolve an inline-comment image attachment to the URL to embed. */
  onAttachImage: (file: File) => Promise<string>;
}

interface SearchMatch {
  sectionPath: string;
  annotatedLineIdx: number;
  start: number;
  end: number;
}

export function DiffViewer({ diff, highlightTarget, scrollContainerRef, comments, tasks, myAccountId, myPostedCommentIds, onFetchFileContent, onPostInlineComment, onReply, onCreateTask, onResolveTask, onEditTask, onDeleteComment, onEditComment, onAttachImage }: DiffViewerProps) {
  const sections = useMemo(() => parseDiffSections(diff), [diff]);
  const annotatedBySection = useMemo(() => {
    const m = new Map<string, AnnotatedLine[]>();
    for (const s of sections) m.set(s.path, annotateDiffLines(s.lines));
    return m;
  }, [sections]);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // ── Per-section expansion state (hoisted so search can auto-expand on match) ─
  const [expandedByPath, setExpandedByPath] = useState<Map<string, boolean>>(new Map());
  const isExpanded = useCallback(
    (path: string) => expandedByPath.get(path) ?? true,
    [expandedByPath],
  );
  const setExpanded = useCallback((path: string, value: boolean) => {
    setExpandedByPath((prev) => {
      if ((prev.get(path) ?? true) === value) return prev;
      const next = new Map(prev);
      next.set(path, value);
      return next;
    });
  }, []);
  const toggleExpand = useCallback(
    (path: string) => setExpanded(path, !isExpanded(path)),
    [isExpanded, setExpanded],
  );

  // Reset expansion when we get a new diff (new PR selected)
  useEffect(() => { setExpandedByPath(new Map()); }, [diff]);

  // Respect highlightTarget: auto-expand the targeted section
  useEffect(() => {
    if (highlightTarget?.path) setExpanded(highlightTarget.path, true);
  }, [highlightTarget, setExpanded]);

  // ── Search state ────────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchBarRef = useRef<HTMLDivElement>(null);
  const [searchBarHeight, setSearchBarHeight] = useState(0);

  // Measure the search bar so we can push sticky section headers below it
  useEffect(() => {
    if (!searchOpen) { setSearchBarHeight(0); return; }
    const el = searchBarRef.current;
    if (!el) return;
    setSearchBarHeight(el.offsetHeight);
  }, [searchOpen]);

  // Reset search on new diff
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setCurrentMatchIdx(0);
  }, [diff]);

  const allMatches = useMemo<SearchMatch[]>(() => {
    const q = searchQuery;
    if (!q) return [];
    const lowerQ = q.toLowerCase();
    const results: SearchMatch[] = [];
    for (const section of sections) {
      const annotated = annotatedBySection.get(section.path) ?? [];
      for (let idx = 0; idx < annotated.length; idx++) {
        const raw = annotated[idx].raw;
        const lower = raw.toLowerCase();
        let pos = 0;
        while (pos <= lower.length) {
          const found = lower.indexOf(lowerQ, pos);
          if (found === -1) break;
          results.push({ sectionPath: section.path, annotatedLineIdx: idx, start: found, end: found + q.length });
          pos = found + Math.max(1, q.length);
        }
      }
    }
    return results;
  }, [sections, annotatedBySection, searchQuery]);

  // Clamp currentMatchIdx when matches change
  useEffect(() => {
    if (allMatches.length === 0) {
      if (currentMatchIdx !== 0) setCurrentMatchIdx(0);
    } else if (currentMatchIdx >= allMatches.length) {
      setCurrentMatchIdx(0);
    }
  }, [allMatches.length, currentMatchIdx]);

  const currentMatch = allMatches[currentMatchIdx] ?? null;

  // matchesByLineIdx for each section, with current-match flag
  const matchesBySection = useMemo(() => {
    const map = new Map<string, Map<number, MatchRange[]>>();
    for (let i = 0; i < allMatches.length; i++) {
      const m = allMatches[i];
      if (!map.has(m.sectionPath)) map.set(m.sectionPath, new Map());
      const sec = map.get(m.sectionPath)!;
      if (!sec.has(m.annotatedLineIdx)) sec.set(m.annotatedLineIdx, []);
      sec.get(m.annotatedLineIdx)!.push({
        start: m.start,
        end: m.end,
        isCurrent: i === currentMatchIdx,
      });
    }
    return map;
  }, [allMatches, currentMatchIdx]);

  // Auto-expand the section holding the current match
  useEffect(() => {
    if (currentMatch) setExpanded(currentMatch.sectionPath, true);
  }, [currentMatch, setExpanded]);

  // Scroll current match into view after render
  useEffect(() => {
    if (!currentMatch) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    // Wait a tick so the section has a chance to re-render expanded
    const handle = requestAnimationFrame(() => {
      const matchEl = container.querySelector<HTMLElement>('[data-match-current="true"]');
      if (!matchEl) return;
      const containerRect = container.getBoundingClientRect();
      const matchRect = matchEl.getBoundingClientRect();
      // Center-ish: keep the match comfortably in view, account for sticky search bar (~40px) + section header (~32px)
      const STICKY_OFFSET = 80;
      const scrollTarget = container.scrollTop + (matchRect.top - containerRect.top) - STICKY_OFFSET;
      container.scrollTo({ top: scrollTarget, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(handle);
  }, [currentMatch, scrollContainerRef]);

  // Keyboard shortcut: Cmd/Ctrl+F opens search, focuses input, selects text
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isFind = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.altKey;
      if (isFind) {
        e.preventDefault();
        setSearchOpen(true);
        // Defer focus until the input is mounted
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const goToNext = useCallback(() => {
    if (allMatches.length === 0) return;
    setCurrentMatchIdx((i) => (i + 1) % allMatches.length);
  }, [allMatches.length]);
  const goToPrev = useCallback(() => {
    if (allMatches.length === 0) return;
    setCurrentMatchIdx((i) => (i - 1 + allMatches.length) % allMatches.length);
  }, [allMatches.length]);

  // Scroll-into-view for highlightTarget (preserved from previous behavior)
  useEffect(() => {
    if (!highlightTarget) return;
    const { path, line } = highlightTarget;
    const el = sectionRefs.current.get(path);
    const container = scrollContainerRef.current;
    if (!el || !container) return;
    const PADDING = 16;

    if (line != null) {
      const lineEl = el.querySelector<HTMLElement>(`[data-new-line="${line}"]`);
      if (lineEl) {
        const containerRect = container.getBoundingClientRect();
        const lineRect = lineEl.getBoundingClientRect();
        const scrollTarget = container.scrollTop + (lineRect.top - containerRect.top) - PADDING;
        container.scrollTo({ top: scrollTarget, behavior: "smooth" });
        return;
      }
    }

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const scrollTarget = container.scrollTop + (elRect.top - containerRect.top) - PADDING;
    container.scrollTo({ top: scrollTarget, behavior: "smooth" });
  }, [highlightTarget, scrollContainerRef]);

  if (!diff) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground border rounded-md border-dashed">
        Diff not loaded
      </div>
    );
  }

  // Group inline comments by file path (top-level only; replies are handled inside the card)
  const commentsByFile = new Map<string, BitbucketComment[]>();
  for (const c of comments) {
    if (c.inline?.path) {
      const p = c.inline.path;
      if (!commentsByFile.has(p)) commentsByFile.set(p, []);
      commentsByFile.get(p)!.push(c);
    }
  }

  return (
    <div className="space-y-2">
      {searchOpen && (
        <DiffSearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          onNext={goToNext}
          onPrev={goToPrev}
          onClose={() => setSearchOpen(false)}
          matchCount={allMatches.length}
          currentIdx={currentMatchIdx}
          inputRef={searchInputRef}
          containerRef={searchBarRef}
        />
      )}
      {sections.map((section) => (
        <DiffSectionCard
          key={section.path}
          section={section}
          annotated={annotatedBySection.get(section.path) ?? []}
          expanded={isExpanded(section.path)}
          onToggleExpand={() => toggleExpand(section.path)}
          sectionRef={(el) => {
            if (el) sectionRefs.current.set(section.path, el);
            else sectionRefs.current.delete(section.path);
          }}
          inlineComments={commentsByFile.get(section.path) ?? []}
          tasks={tasks}
          myAccountId={myAccountId}
          myPostedCommentIds={myPostedCommentIds}
          matchesByLineIdx={matchesBySection.get(section.path) ?? new Map()}
          stickyTopOffset={searchBarHeight}
          onFetchFileContent={onFetchFileContent}
          onPostInlineComment={onPostInlineComment}
          onReply={onReply}
          onCreateTask={onCreateTask}
          onResolveTask={onResolveTask}
          onEditTask={onEditTask}
          onDeleteComment={onDeleteComment}
          onEditComment={onEditComment}
          onAttachImage={onAttachImage}
        />
      ))}
    </div>
  );
}
