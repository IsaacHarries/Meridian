import { type BitbucketComment, type BitbucketTask } from "@/lib/tauri/bitbucket";
import { ChevronDown, ChevronRight, MessageSquareWarning } from "lucide-react";
import { useMemo, useState } from "react";
import { annotateDiffLines, parseDiffSections } from "./diff-viewer";
import { InlineCommentThread } from "./inline-comment";

// ── Partition comments by whether their anchor still exists in the diff ─────

interface PartitionResult {
  /** Top-level off-diff comments + their replies. Top-level entries are
   *  ordered by id ascending (oldest first) so the panel reads chronologically. */
  topLevel: BitbucketComment[];
  /** Replies grouped by parent id — same shape DiffSectionCard uses. */
  repliesByParent: Map<number, BitbucketComment[]>;
}

function partitionOffDiffComments(
  diff: string,
  comments: BitbucketComment[],
): PartitionResult {
  // Build the per-file new-side line set from the current diff hunks. A
  // top-level inline comment is "in diff" when its (path, toLine) appears
  // as a new-side line in the diff; otherwise the line was removed in a
  // newer commit (or the file was dropped from the PR) and the comment is
  // outdated — surface it above the diff so the reviewer can see it.
  const inDiffPathLines = new Map<string, Set<number>>();
  for (const section of parseDiffSections(diff)) {
    const lineSet = new Set<number>();
    for (const annotated of annotateDiffLines(section.lines)) {
      if (annotated.newNum != null) lineSet.add(annotated.newNum);
    }
    inDiffPathLines.set(section.path, lineSet);
  }

  const topLevelOffDiffIds = new Set<number>();
  for (const c of comments) {
    if (c.parentId != null) continue;
    const inline = c.inline;
    if (!inline?.path || inline.toLine == null) {
      // General PR comment with no file/line anchor.
      topLevelOffDiffIds.add(c.id);
      continue;
    }
    const lineSet = inDiffPathLines.get(inline.path);
    if (!lineSet || !lineSet.has(inline.toLine)) {
      // Inline anchor points at a line that's no longer in the diff
      // (file removed from the PR, or that specific line replaced /
      // removed in a newer push).
      topLevelOffDiffIds.add(c.id);
    }
  }

  const topLevel: BitbucketComment[] = [];
  const repliesByParent = new Map<number, BitbucketComment[]>();
  for (const c of comments) {
    if (c.parentId == null) {
      if (topLevelOffDiffIds.has(c.id)) topLevel.push(c);
    } else if (topLevelOffDiffIds.has(c.parentId)) {
      const list = repliesByParent.get(c.parentId);
      if (list) list.push(c);
      else repliesByParent.set(c.parentId, [c]);
    }
  }
  topLevel.sort((a, b) => a.id - b.id);
  return { topLevel, repliesByParent };
}

// ── Per-comment context label ───────────────────────────────────────────────

function commentContextLabel(c: BitbucketComment): string {
  const inline = c.inline;
  if (!inline?.path) return "General PR comment";
  const line = inline.toLine ?? inline.fromLine;
  if (line == null) return `Outdated · ${inline.path}`;
  return `Outdated · ${inline.path}:${line}`;
}

// ── Panel ───────────────────────────────────────────────────────────────────

interface OffDiffCommentsPanelProps {
  diff: string;
  comments: BitbucketComment[];
  tasks: BitbucketTask[];
  myAccountId: string;
  myPostedCommentIds: number[];
  onReply: (parentId: number, content: string) => Promise<void>;
  onCreateTask: (commentId: number, content: string) => Promise<BitbucketTask>;
  onResolveTask: (taskId: number, resolved: boolean) => Promise<void>;
  onEditTask: (taskId: number, content: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onEditComment: (commentId: number, newContent: string) => Promise<void>;
  onAttachImage: (file: File) => Promise<string>;
}

export function OffDiffCommentsPanel({
  diff,
  comments,
  tasks,
  myAccountId,
  myPostedCommentIds,
  onReply,
  onCreateTask,
  onResolveTask,
  onEditTask,
  onDeleteComment,
  onEditComment,
  onAttachImage,
}: OffDiffCommentsPanelProps) {
  const { topLevel, repliesByParent } = useMemo(
    () => partitionOffDiffComments(diff, comments),
    [diff, comments],
  );
  const [collapsed, setCollapsed] = useState(false);

  if (topLevel.length === 0) return null;

  return (
    <div className="border rounded-md border-amber-300 dark:border-amber-800 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100/70 dark:hover:bg-amber-950/50 transition-colors text-left"
        aria-expanded={!collapsed}
      >
        <MessageSquareWarning className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="text-xs font-medium text-amber-900 dark:text-amber-100 flex-1">
          Comments not in current diff
          <span className="text-[11px] font-normal text-amber-700 dark:text-amber-300/80 ml-1.5">
            (general PR comments and outdated inline threads)
          </span>
        </span>
        <span className="text-[10px] bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200 rounded-full px-1.5 py-0.5 shrink-0">
          {topLevel.length}
        </span>
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 shrink-0" />
        )}
      </button>
      {!collapsed && (
        <div className="divide-y">
          {topLevel.map((c) => (
            <div key={c.id} className="bg-background">
              <div className="px-3 pt-2 text-[11px] font-mono text-muted-foreground">
                {commentContextLabel(c)}
              </div>
              <InlineCommentThread
                comment={c}
                replies={repliesByParent.get(c.id) ?? []}
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
