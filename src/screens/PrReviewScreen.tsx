import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  Sparkles,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  MinusCircle,
  GitPullRequest,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  FileCode,
  Shield,
  Cpu,
  Star,
  ClipboardList,
  GitBranch,
  ThumbsUp,
  ThumbsDown,
  Send,
  MessageSquare,
  MessageCirclePlus,
  CornerDownRight,
  ListTodo,
  Trash2,
  Pencil,
  FlaskConical,
  Play,
  Square,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  type BitbucketPr,
  type BitbucketComment,
  type BitbucketTask,
  type CredentialStatus,
  type ReviewReport,
  type ReviewFinding,
  type ReviewLens,
  type BugTestSteps,
  aiProviderComplete,
  bitbucketComplete,
  jiraComplete,
  openUrl,
  runInTerminal,
  checkoutPrReviewBranch,
} from "@/lib/tauri";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import { usePrReviewStore } from "@/stores/prReviewStore";
import { enrichMessageWithUrls } from "@/lib/urlFetch";
import { ToolRequestCard, type ToolRequest } from "@/components/ToolRequestCard";

interface PrReviewScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Review progress banner (mirrors GroomingProgressBanner) ──────────────────

function ReviewProgressBanner({ message, streamText }: { message: string; streamText: string }) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-expand as soon as tokens start flowing
  useEffect(() => {
    if (streamText && !expanded) setExpanded(true);
  }, [streamText]);

  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamText, expanded]);

  if (!message) return null;
  return (
    <div className="border rounded-md overflow-hidden bg-muted/20">
      <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin shrink-0 text-primary" />
        <span className="flex-1 leading-snug">{message}</span>
        {streamText && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
            {expanded ? "Hide" : "Show"} output
          </button>
        )}
      </div>
      {expanded && streamText && (
        <div
          ref={scrollRef}
          className="border-t px-4 py-3 max-h-64 overflow-y-auto font-mono text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed bg-muted/10"
        >
          {streamText}
          <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-primary animate-pulse align-middle" />
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prAge(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function sanitizeId(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

// ── Diff viewer (with inline comment anchoring + click-to-comment) ─────────────

interface DiffSection {
  path: string;
  lines: string[];
}

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

// ── Annotated diff line (with line numbers) ───────────────────────────────────

interface AnnotatedLine {
  raw: string;
  oldNum: number | null;
  newNum: number | null;
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

function DiffLineRow({
  line, clickable, onClick, hasComments, isPendingComment,
}: {
  line: AnnotatedLine;
  clickable?: boolean;
  onClick?: () => void;
  hasComments?: boolean;
  isPendingComment?: boolean;
}) {
  const [rowHovered, setRowHovered] = useState(false);
  const { raw, oldNum, newNum } = line;

  let rowCls = "";
  let textCls = "text-muted-foreground";

  if (raw.startsWith("+") && !raw.startsWith("+++")) {
    rowCls = "bg-green-50 dark:bg-green-950/30";
    textCls = "text-green-700 dark:text-green-400";
  } else if (raw.startsWith("-") && !raw.startsWith("---")) {
    rowCls = "bg-red-50 dark:bg-red-950/30";
    textCls = "text-red-700 dark:text-red-400";
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
      <span className={`select-text cursor-text font-mono text-xs leading-5 pl-2 pr-4 whitespace-pre min-w-0 flex-1 ${textCls}`}>
        {raw || " "}
      </span>
    </div>
  );
}

// ── Inline comment compose box ────────────────────────────────────────────────

function InlineCommentBox({ onSubmit, onCancel }: { onSubmit: (c: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  async function handleSubmit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setErr("");
    try {
      await onSubmit(text.trim());
      setText("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="border-l-2 border-primary/40 ml-[88px] mr-4 my-1 bg-muted/30 rounded-r-md p-2 space-y-2">
      <Textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Leave a comment on this line…"
        className="min-h-[64px] resize-none text-xs"
        disabled={submitting}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={!text.trim() || submitting} className="h-7 text-xs gap-1">
          {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          Comment
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={submitting} className="h-7 text-xs">
          Cancel
        </Button>
        <span className="text-[10px] text-muted-foreground self-center">⌘↵</span>
      </div>
    </div>
  );
}

// ── Inline comment thread (anchored under a diff line) ─────────────────────────

function InlineCommentThread({
  comment, replies, tasks, myAccountId, myPostedCommentIds, onReply, onCreateTask, onResolveTask, onDeleteComment, onEditComment,
}: {
  comment: BitbucketComment;
  replies: BitbucketComment[];
  tasks: BitbucketTask[];
  myAccountId: string;
  myPostedCommentIds: number[];
  onReply: (content: string) => Promise<void>;
  onCreateTask: (content: string) => Promise<BitbucketTask>;
  onResolveTask: (taskId: number, resolved: boolean) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onEditComment: (commentId: number, newContent: string) => Promise<void>;
}) {
  const [showReply, setShowReply] = useState(false);
  const [showTask, setShowTask] = useState<number | "root" | null>(null);
  const [togglingTask, setTogglingTask] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const isMine = myPostedCommentIds.includes(comment.id) ||
    (!!myAccountId && comment.author.accountId === myAccountId);

  async function handleDelete(commentId: number) {
    if (!confirm("Delete this comment? This cannot be undone.")) return;
    setDeletingId(commentId);
    try { await onDeleteComment(commentId); } finally { setDeletingId(null); }
  }

  function startEdit(commentId: number, currentContent: string) {
    setEditingId(commentId);
    setEditDraft(currentContent);
    setShowReply(false);
    setShowTask(null);
  }

  async function saveEdit() {
    if (!editingId || !editDraft.trim()) return;
    setSavingEdit(true);
    try {
      await onEditComment(editingId, editDraft.trim());
      setEditingId(null);
    } finally {
      setSavingEdit(false);
    }
  }

  async function toggleTask(taskId: number, resolved: boolean) {
    setTogglingTask(taskId);
    try { await onResolveTask(taskId, resolved); } finally { setTogglingTask(null); }
  }

  return (
    <div className="my-0.5 bg-blue-50/50 dark:bg-blue-950/20 text-xs border-t border-blue-200/40 dark:border-blue-800/30">
      {/* Root comment — flush left */}
      {editingId === comment.id ? (
        <div className="px-3 py-2 space-y-2">
          <Textarea
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            className="text-xs min-h-[60px] resize-none"
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" className="h-6 text-xs px-2" onClick={saveEdit} disabled={savingEdit || !editDraft.trim()}>
              {savingEdit ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => setEditingId(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <CommentRow
          comment={comment}
          isMine={isMine}
          onReply={() => { setShowReply(r => !r); setShowTask(null); }}
          onTask={() => setShowTask(t => t === "root" ? null : "root")}
          onDelete={isMine ? () => handleDelete(comment.id) : undefined}
          onEdit={isMine ? () => startEdit(comment.id, comment.content) : undefined}
        />
      )}
      {/* Tasks anchored to this comment */}
      {tasks.length > 0 && (
        <div className="px-3 pb-2 pt-1 space-y-1 border-t border-blue-200/40 dark:border-blue-800/30">
          {tasks.map((task) => (
            <div key={task.id} className="flex items-start gap-2">
              <button
                onClick={() => toggleTask(task.id, !task.resolved)}
                disabled={togglingTask === task.id}
                className="mt-0.5 shrink-0 flex items-center justify-center w-3.5 h-3.5 rounded border border-muted-foreground/40 bg-background hover:border-primary transition-colors disabled:opacity-50"
                title={task.resolved ? "Mark as incomplete" : "Mark as complete"}
              >
                {task.resolved && (
                  <Check className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
                )}
              </button>
              <span className={`leading-snug ${task.resolved ? "line-through text-muted-foreground" : "text-foreground"}`}>
                {task.content}
              </span>
            </div>
          ))}
        </div>
      )}
      {showTask === "root" && (
        <div className="px-3 pb-2 border-t border-blue-200/40 dark:border-blue-800/30 pt-2">
          <QuickTaskBox
            onSubmit={async (c) => { await onCreateTask(c); setShowTask(null); }}
            onCancel={() => setShowTask(null)}
          />
        </div>
      )}
      {/* Replies — each indented 10px with a left accent border to show cascade */}
      {replies.map(r => {
        const isReplyMine = myPostedCommentIds.includes(r.id) || (!!myAccountId && r.author.accountId === myAccountId);
        return (
          <div key={r.id} className="pl-[10px] border-t border-blue-200/40 dark:border-blue-800/30 border-l-2 border-l-blue-300/60 dark:border-l-blue-700/50 ml-3">
            {editingId === r.id ? (
              <div className="px-3 py-2 space-y-2">
                <Textarea
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  className="text-xs min-h-[60px] resize-none"
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button size="sm" className="h-6 text-xs px-2" onClick={saveEdit} disabled={savingEdit || !editDraft.trim()}>
                    {savingEdit ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <CommentRow
                comment={r}
                isMine={isReplyMine}
                onReply={() => { setShowReply(v => !v); setShowTask(null); }}
                onTask={() => setShowTask(t => t === r.id ? null : r.id)}
                onDelete={isReplyMine ? () => handleDelete(r.id) : undefined}
                onEdit={isReplyMine ? () => startEdit(r.id, r.content) : undefined}
              />
            )}
            {showTask === r.id && (
              <div className="px-3 pb-2 pt-1">
                <QuickTaskBox
                  onSubmit={async (c) => { await onCreateTask(c); setShowTask(null); }}
                  onCancel={() => setShowTask(null)}
                />
              </div>
            )}
          </div>
        );
      })}
      {showReply && (
        <div className="pl-[10px] ml-3 p-2 border-t border-blue-200/40 dark:border-blue-800/30 border-l-2 border-l-blue-300/60 dark:border-l-blue-700/50">
          <QuickReplyBox
            onSubmit={async (c) => { await onReply(c); setShowReply(false); }}
            onCancel={() => setShowReply(false)}
          />
        </div>
      )}
    </div>
  );
}

// ── Inline markdown renderer (backtick code spans + fenced code blocks) ───────

function renderCommentContent(text: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];

  // Split on fenced code blocks first (``` ... ```)
  const fencedRe = /```([^\n]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let fm: RegExpExecArray | null;

  while ((fm = fencedRe.exec(text)) !== null) {
    if (fm.index > last) {
      nodes.push(...renderInlineSegment(text.slice(last, fm.index), nodes.length));
    }
    nodes.push(
      <pre
        key={`fence-${fm.index}`}
        className="my-1.5 rounded bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed overflow-x-auto whitespace-pre text-foreground"
      >
        {fm[2]}
      </pre>
    );
    last = fm.index + fm[0].length;
  }

  if (last < text.length) {
    nodes.push(...renderInlineSegment(text.slice(last), nodes.length * 100));
  }

  return <div className="whitespace-pre-wrap leading-snug text-foreground space-y-0.5">{nodes}</div>;
}

/** Split a text segment on inline backtick spans and return mixed text/code nodes. */
function renderInlineSegment(segment: string, keyBase: number): React.ReactNode[] {
  // Tokenise the segment into: image embeds, markdown links, bare URLs, code spans, plain text.
  // Order matters — image syntax must come before regular link syntax.
  // Groups: [1]=img-alt, [2]=img-url, [3]=link-text, [4]=link-url, [5]=code, [6]=bare-url
  const tokenRe =
    /!\[([^\]]*)\]\(([^)]+)\)(?:\{[^}]*\})?|\[([^\]]+)\]\(([^)]+)\)|(`[^`]+`)|(https?:\/\/[^\s)\]"'<>]+)/g;

  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = tokenRe.exec(segment)) !== null) {
    // Push any plain text before this token
    if (m.index > last) {
      nodes.push(<span key={`${keyBase}-t${idx++}`}>{segment.slice(last, m.index)}</span>);
    }

    if (m[1] !== undefined) {
      // Markdown image: ![alt](url){...} → show as a clickable URL
      const url = m[2];
      nodes.push(
        <button
          key={`${keyBase}-img${idx++}`}
          onClick={() => openUrl(url)}
          className="inline-flex items-center gap-1 text-primary hover:underline break-all text-left font-mono text-[11px]"
          title={url}
        >
          <span className="opacity-60">[image]</span> {url}
        </button>
      );
    } else if (m[3] !== undefined) {
      // Markdown link: [text](url)
      const url = m[4];
      nodes.push(
        <button
          key={`${keyBase}-lnk${idx++}`}
          onClick={() => openUrl(url)}
          className="text-primary hover:underline break-all text-left"
          title={url}
        >
          {m[3]}
        </button>
      );
    } else if (m[5] !== undefined) {
      // Inline code `...`
      nodes.push(
        <code
          key={`${keyBase}-c${idx++}`}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground"
        >
          {m[5].slice(1, -1)}
        </code>
      );
    } else if (m[6] !== undefined) {
      // Bare URL
      const url = m[6];
      nodes.push(
        <button
          key={`${keyBase}-url${idx++}`}
          onClick={() => openUrl(url)}
          className="text-primary hover:underline break-all text-left"
          title={url}
        >
          {url}
        </button>
      );
    }

    last = m.index + m[0].length;
  }

  // Remaining plain text
  if (last < segment.length) {
    nodes.push(<span key={`${keyBase}-t${idx++}`}>{segment.slice(last)}</span>);
  }

  return nodes.filter(Boolean);
}

// ── Shared comment row ─────────────────────────────────────────────────────────

function CommentRow({
  comment, isMine, onReply, onTask, onDelete, onEdit,
}: {
  comment: BitbucketComment;
  isMine?: boolean;
  onReply?: () => void;
  onTask?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
}) {
  const date = comment.createdOn
    ? new Date(comment.createdOn).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";
  const name = comment.author.displayName || comment.author.nickname || "?";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || name[0]?.toUpperCase() || "?";
  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-500 text-white font-bold text-[10px] shrink-0 select-none leading-none">
          {initials}
        </span>
        <span className="font-semibold text-foreground text-xs">{comment.author.displayName}</span>
        {date && <span>· {date}</span>}
        {isMine && <span className="text-primary">(you)</span>}
        <div className="ml-auto flex gap-1.5">
          {onReply && (
            <button onClick={onReply} className="hover:text-foreground flex items-center gap-0.5 transition-colors" title="Reply">
              <CornerDownRight className="h-2.5 w-2.5" /> Reply
            </button>
          )}
          {onTask && (
            <button onClick={onTask} className="hover:text-foreground flex items-center gap-0.5 transition-colors" title="Create task">
              <ListTodo className="h-2.5 w-2.5" /> Task
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete} className="hover:text-destructive flex items-center gap-0.5 transition-colors ml-1" title="Delete your comment">
              <Trash2 className="h-2.5 w-2.5" />
            </button>
          )}
          {onEdit && (
            <button onClick={onEdit} className="hover:text-foreground flex items-center gap-0.5 transition-colors" title="Edit your comment">
              <Pencil className="h-2.5 w-2.5" />
            </button>
          )}
        </div>
      </div>
      <div className="leading-snug">{renderCommentContent(comment.content)}</div>
    </div>
  );
}

// ── Quick reply / task boxes ───────────────────────────────────────────────────

function QuickReplyBox({ onSubmit, onCancel }: { onSubmit: (c: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function go() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try { await onSubmit(text.trim()); } finally { setSubmitting(false); }
  }
  return (
    <div className="space-y-1.5">
      <Textarea autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="Reply…" className="min-h-[48px] resize-none text-xs" disabled={submitting}
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) { e.preventDefault(); go(); } }} />
      <div className="flex gap-1.5">
        <Button size="sm" onClick={go} disabled={!text.trim() || submitting} className="h-6 text-[11px] px-2 gap-1">
          {submitting ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Send className="h-2.5 w-2.5" />} Reply
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-6 text-[11px] px-2">Cancel</Button>
      </div>
    </div>
  );
}

function QuickTaskBox({ onSubmit, onCancel }: { onSubmit: (c: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function go() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try { await onSubmit(text.trim()); } finally { setSubmitting(false); }
  }
  return (
    <div className="space-y-1.5">
      <Textarea autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="Task description…" className="min-h-[48px] resize-none text-xs" disabled={submitting} />
      <div className="flex gap-1.5">
        <Button size="sm" onClick={go} disabled={!text.trim() || submitting} className="h-6 text-[11px] px-2 gap-1">
          {submitting ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <ListTodo className="h-2.5 w-2.5" />} Create task
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-6 text-[11px] px-2">Cancel</Button>
      </div>
    </div>
  );
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
  onPostInlineComment: (path: string, toLine: number, content: string) => Promise<void>;
  onReply: (parentId: number, content: string) => Promise<void>;
  onCreateTask: (commentId: number, content: string) => Promise<BitbucketTask>;
  onResolveTask: (taskId: number, resolved: boolean) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onEditComment: (commentId: number, newContent: string) => Promise<void>;
}

function DiffViewer({ diff, highlightTarget, scrollContainerRef, comments, tasks, myAccountId, myPostedCommentIds, onPostInlineComment, onReply, onCreateTask, onResolveTask, onDeleteComment, onEditComment }: DiffViewerProps) {
  const sections = parseDiffSections(diff);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!highlightTarget) return;
    const { path, line } = highlightTarget;
    const el = sectionRefs.current.get(path);
    const container = scrollContainerRef.current;
    if (!el || !container) return;
    const PADDING = 16; // match the p-4 on the left pane

    if (line != null) {
      // Try to find the specific line row inside this section
      const lineEl = el.querySelector<HTMLElement>(`[data-new-line="${line}"]`);
      if (lineEl) {
        // Use getBoundingClientRect to find the line's position relative to the scroll container
        const containerRect = container.getBoundingClientRect();
        const lineRect = lineEl.getBoundingClientRect();
        const scrollTarget = container.scrollTop + (lineRect.top - containerRect.top) - PADDING;
        container.scrollTo({ top: scrollTarget, behavior: "smooth" });
        return;
      }
    }

    // Fall back to scrolling to the file section header
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const scrollTarget = container.scrollTop + (elRect.top - containerRect.top) - PADDING;
    container.scrollTo({ top: scrollTarget, behavior: "smooth" });
  }, [highlightTarget]);

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
      {sections.map((section) => (
        <DiffSectionCard
          key={section.path}
          section={section}
          highlighted={highlightTarget?.path === section.path}
          sectionRef={(el) => {
            if (el) sectionRefs.current.set(section.path, el);
            else sectionRefs.current.delete(section.path);
          }}
          inlineComments={commentsByFile.get(section.path) ?? []}
          tasks={tasks}
          myAccountId={myAccountId}
          myPostedCommentIds={myPostedCommentIds}
          onPostInlineComment={onPostInlineComment}
          onReply={onReply}
          onCreateTask={onCreateTask}
          onResolveTask={onResolveTask}
          onDeleteComment={onDeleteComment}
          onEditComment={onEditComment}
        />
      ))}
    </div>
  );
}

// ── Diff section card (with inline comment support) ───────────────────────────

interface DiffSectionCardProps {
  section: DiffSection;
  highlighted: boolean;
  sectionRef: (el: HTMLDivElement | null) => void;
  inlineComments: BitbucketComment[];
  tasks: BitbucketTask[];
  myAccountId: string;
  myPostedCommentIds: number[];
  onPostInlineComment: (path: string, toLine: number, content: string) => Promise<void>;
  onReply: (parentId: number, content: string) => Promise<void>;
  onCreateTask: (commentId: number, content: string) => Promise<BitbucketTask>;
  onResolveTask: (taskId: number, resolved: boolean) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onEditComment: (commentId: number, newContent: string) => Promise<void>;
}

function DiffSectionCard({
  section, highlighted, sectionRef,
  inlineComments, tasks, myAccountId, myPostedCommentIds,
  onPostInlineComment, onReply, onCreateTask, onResolveTask, onDeleteComment, onEditComment,
}: DiffSectionCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [pendingLine, setPendingLine] = useState<number | null>(null);

  useEffect(() => { if (highlighted) setExpanded(true); }, [highlighted]);

  const addedLines = section.lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removedLines = section.lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const annotated = annotateDiffLines(section.lines);

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
      {/* Sticky file header — stays in view while scrolling through the file */}
      <div className="sticky top-0 z-10 border-b border-border rounded-t-md overflow-hidden backdrop-blur-sm">
        <button
          className="w-full flex items-center gap-2 px-3 py-2 bg-muted/80 hover:bg-muted/90 transition-colors text-left focus:outline-none"
          onClick={() => setExpanded(!expanded)}
        >
          <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span
            className="flex-1 text-xs font-mono truncate select-text cursor-text"
            onClick={(e) => e.stopPropagation()}
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
        </button>
      </div>
      {expanded && (
        <div className="overflow-x-auto [--tw-ring-shadow:0_0_#0000] [--tw-ring-offset-shadow:0_0_#0000]">
          {annotated.map((line, i) => {
            const lineNum = line.newNum;
            const lineComments = lineNum != null ? (commentsByLine.get(lineNum) ?? []) : [];
            const isClickable = lineNum != null &&
              !line.raw.startsWith("@@") && !line.raw.startsWith("diff ") &&
              !line.raw.startsWith("index ") && !line.raw.startsWith("---") && !line.raw.startsWith("+++");
            return (
              <div key={i}>
                <DiffLineRow
                  line={line}
                  clickable={isClickable}
                  onClick={isClickable && lineNum != null ? () => setPendingLine(pendingLine === lineNum ? null : lineNum) : undefined}
                  hasComments={lineComments.length > 0}
                  isPendingComment={lineNum != null && pendingLine === lineNum}
                />
                {pendingLine === lineNum && lineNum != null && (
                  <InlineCommentBox
                    onSubmit={async (content) => { await onPostInlineComment(section.path, lineNum, content); setPendingLine(null); }}
                    onCancel={() => setPendingLine(null)}
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
                    onDeleteComment={onDeleteComment}
                    onEditComment={onEditComment}
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

// ── Review findings ───────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: ReviewFinding["severity"] }) {
  if (severity === "blocking") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">
        <XCircle className="h-3 w-3" /> Blocking
      </span>
    );
  }
  if (severity === "non_blocking") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
        <AlertCircle className="h-3 w-3" /> Non-blocking
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
      <MinusCircle className="h-3 w-3" /> Nitpick
    </span>
  );
}

interface FindingCardProps {
  finding: ReviewFinding;
  onJumpToFile: (path: string, line?: number) => void;
  /** Posts the comment. Returns the created BitbucketComment so a task can be attached. */
  onPostComment: (content: string, file: string | null, lineRange: string | null) => Promise<BitbucketComment>;
}

/**
 * Convert an AI line_range value (e.g. "L42", "L42-L56", "42-56") into an
 * IDE-compatible path suffix using the standard compiler/tool convention:
 *   single line  → ":42"
 *   range        → ":42-56"
 * The "L" prefix is stripped from both numbers. Returns "" if nothing parseable.
 */
function lineRangeToIdeSuffix(lineRange: string | null | undefined): string {
  if (!lineRange) return "";
  // Extract all digit sequences (strips any leading "L" characters)
  const nums = [...lineRange.matchAll(/\d+/g)].map(m => m[0]);
  if (nums.length === 0) return "";
  if (nums.length === 1) return `:${nums[0]}`;
  return `:${nums[0]}-${nums[1]}`;
}

/**
 * Build a draft comment from a finding.
 * Produces a compact, professional comment suitable for Bitbucket.
 */
function buildDraftComment(finding: ReviewFinding): string {
  const severityLabel =
    finding.severity === "blocking" ? "🚫 Blocking"
    : finding.severity === "non_blocking" ? "⚠️ Non-blocking"
    : "💬 Nitpick";

  const lines = [`**${severityLabel}: ${finding.title}**`, "", finding.description];

  if (finding.file) {
    lines.push("");
    lines.push(`_File: \`${finding.file}${lineRangeToIdeSuffix(finding.line_range)}\`_`);
  }

  return lines.join("\n");
}

/**
 * Build a draft task description from a finding.
 * Produces an actionable one-liner suitable for a Bitbucket task.
 */
function buildDraftTask(finding: ReviewFinding): string {
  return `Address: ${finding.title}`;
}

function FindingCard({ finding, onJumpToFile, onPostComment }: FindingCardProps) {
  const [expanded, setExpanded] = useState(finding.severity === "blocking");
  const [showDraft, setShowDraft] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [includeTask, setIncludeTask] = useState(true);
  const [draftTaskText, setDraftTaskText] = useState("");
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState("");
  const [posted, setPosted] = useState(false);

  function openDraft() {
    setDraftText(buildDraftComment(finding));
    setDraftTaskText(buildDraftTask(finding));
    setIncludeTask(true);
    setShowDraft(true);
    setPostErr("");
    setPosted(false);
  }

  async function handlePost() {
    if (!draftText.trim() || posting) return;
    setPosting(true);
    setPostErr("");
    try {
      const comment = await onPostComment(draftText.trim(), finding.file, finding.line_range);
      // If the user wants a task attached, create it on the newly posted comment
      if (includeTask && draftTaskText.trim()) {
        try {
          await usePrReviewStore.getState().createTask(comment.id, draftTaskText.trim());
        } catch {
          // Task creation failure is non-fatal — comment was already posted
        }
      }
      setPosted(true);
      setShowDraft(false);
    } catch (e) {
      setPostErr(String(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="mt-0.5 shrink-0">
          <SeverityBadge severity={finding.severity} />
        </div>
        <span className="flex-1 text-sm font-medium leading-snug">{finding.title}</span>
        {posted && (
          <span className="flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5 mr-1">
            <Check className="h-3 w-3" /> Posted
          </span>
        )}
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t bg-muted/20 space-y-2">
          <p className="text-sm text-muted-foreground leading-relaxed">{finding.description}</p>
          <div className="flex items-center gap-3 flex-wrap">
            {finding.file && (
              <button
                onClick={() => {
                  const lineNum = finding.line_range
                    ? (() => { const m = finding.line_range!.match(/\d+/); return m ? parseInt(m[0], 10) : undefined; })()
                    : undefined;
                  onJumpToFile(finding.file!, lineNum);
                }}
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-mono"
              >
                <FileCode className="h-3 w-3" />
                {finding.file}{lineRangeToIdeSuffix(finding.line_range)}
              </button>
            )}
            {!showDraft && (
              <button
                onClick={openDraft}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
                title="Draft a PR comment for this finding"
              >
                <MessageCirclePlus className="h-3.5 w-3.5" />
                {posted ? "Post again" : "Comment on PR"}
              </button>
            )}
          </div>

          {/* Draft comment editor */}
          {showDraft && (
            <div className="mt-2 space-y-2 rounded-md border border-primary/20 bg-background p-3">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Draft comment
                {finding.file
                  ? ` — will post inline on ${finding.file}${lineRangeToIdeSuffix(finding.line_range)}`
                  : " — will post as a general PR comment"}
              </p>
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                className="min-h-[110px] resize-y text-xs font-mono leading-relaxed"
                disabled={posting}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draftText.trim()) {
                    e.preventDefault();
                    handlePost();
                  }
                }}
              />

              {/* Task draft */}
              <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={includeTask}
                    onChange={(e) => setIncludeTask(e.target.checked)}
                    disabled={posting}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <span className="text-xs font-medium flex items-center gap-1">
                    <ListTodo className="h-3.5 w-3.5 text-muted-foreground" />
                    Include a task on this comment
                  </span>
                </label>
                {includeTask && (
                  <Textarea
                    value={draftTaskText}
                    onChange={(e) => setDraftTaskText(e.target.value)}
                    placeholder="Task description…"
                    className="min-h-[44px] resize-y text-xs leading-relaxed"
                    disabled={posting}
                  />
                )}
              </div>

              {postErr && (
                <p className="text-xs text-destructive">{postErr}</p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handlePost}
                  disabled={!draftText.trim() || posting}
                  className="h-7 text-xs gap-1"
                >
                  {posting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="h-3 w-3" />
                  )}
                  {includeTask && draftTaskText.trim() ? "Post comment + task" : "Post comment"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowDraft(false)}
                  disabled={posting}
                  className="h-7 text-xs"
                >
                  Cancel
                </Button>
                <span className="text-[10px] text-muted-foreground">⌘↵ to post</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface LensPanelProps {
  lens: ReviewLens;
  onJumpToFile: (path: string, line?: number) => void;
  onPostComment: (content: string, file: string | null, lineRange: string | null) => Promise<BitbucketComment>;
}

function LensPanel({ lens, onJumpToFile, onPostComment }: LensPanelProps) {
  const blockingCount = lens.findings.filter((f) => f.severity === "blocking").length;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{lens.assessment}</p>
      {lens.findings.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4" /> No findings
        </div>
      ) : (
        <>
          {blockingCount > 0 && (
            <p className="text-xs font-medium text-red-600 dark:text-red-400">
              {blockingCount} blocking {blockingCount === 1 ? "issue" : "issues"}
            </p>
          )}
          <div className="space-y-2">
            {lens.findings.map((f, i) => (
              <FindingCard key={i} finding={f} onJumpToFile={onJumpToFile} onPostComment={onPostComment} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Bug test steps card ───────────────────────────────────────────────────────

function BugTestStepsCard({ steps }: { steps: BugTestSteps }) {
  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <ClipboardList className="h-4 w-4 text-blue-500 shrink-0" />
        <p className="text-sm font-semibold text-blue-700 dark:text-blue-300">Bug Verification Steps</p>
      </div>
      {steps.description && (
        <p className="text-xs text-muted-foreground italic">{steps.description}</p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> Happy Path
          </p>
          <ol className="space-y-1">
            {steps.happy_path.map((step, i) => (
              <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                <span className="shrink-0 font-mono text-foreground/50">{i + 1}.</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" /> Sad Path / Edge Cases
          </p>
          <ol className="space-y-1">
            {steps.sad_path.map((step, i) => (
              <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                <span className="shrink-0 font-mono text-foreground/50">{i + 1}.</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

// ── Overall verdict ───────────────────────────────────────────────────────────

function VerdictBadge({ overall }: { overall: ReviewReport["overall"] }) {
  if (overall === "approve") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 font-semibold text-sm">
        <CheckCircle2 className="h-4 w-4" /> Approve
      </span>
    );
  }
  if (overall === "request_changes") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 font-semibold text-sm">
        <XCircle className="h-4 w-4" /> Request changes
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 font-semibold text-sm">
      <AlertCircle className="h-4 w-4" /> Needs discussion
    </span>
  );
}

// ── PR selector ───────────────────────────────────────────────────────────────

interface PrSelectorProps {
  prsForReview: BitbucketPr[];
  allOpenPrs: BitbucketPr[];
  loading: boolean;
  onSelect: (pr: BitbucketPr) => void;
  jiraBaseUrl: string;
  myAccountId: string;
  /** Set of PR ids that have a cached review result — shows a badge on those rows */
  cachedPrIds: Set<number>;
  /** Set of PR ids where new commits have arrived since the last review */
  stalePrIds: Set<number>;
}

function PrSelector({ prsForReview, allOpenPrs, loading, onSelect, jiraBaseUrl, myAccountId, cachedPrIds, stalePrIds }: PrSelectorProps) {
  const [showAll, setShowAll] = useState(false);
  const [hideApproved, setHideApproved] = useState(true);

  const baseList = showAll ? allOpenPrs : prsForReview;

  // Determine which PRs the current user has already approved
  const isApproved = (pr: BitbucketPr) =>
    !!myAccountId && pr.reviewers.some((r) => r.user.accountId === myAccountId && r.approved);

  const approvedCount = baseList.filter(isApproved).length;
  const list = hideApproved ? baseList.filter((pr) => !isApproved(pr)) : baseList;

  function PrRow({ pr }: { pr: BitbucketPr }) {
    const iApproved = isApproved(pr);
    const hasCache = cachedPrIds.has(pr.id);
    const isStale = stalePrIds.has(pr.id);

    return (
      <button
        onClick={() => onSelect(pr)}
        className="w-full text-left px-4 py-3 rounded-md border bg-card/60 hover:bg-muted/60 transition-colors space-y-1"
      >
        <div className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs font-mono text-muted-foreground">#{pr.id}</span>
          {iApproved && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> Approved
            </span>
          )}
          {hasCache && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
              <Sparkles className="h-3 w-3" /> Reviewed
            </span>
          )}
          {hasCache && isStale && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border border-amber-300/40 dark:border-amber-700/40">
              <RefreshCw className="h-3 w-3" /> New commits
            </span>
          )}
          <span className="ml-auto text-xs text-muted-foreground shrink-0">{prAge(pr.createdOn)}</span>
        </div>
        <p className="text-sm font-medium leading-snug">{pr.title}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{pr.author.displayName}</span>
          <span>·</span>
          <span className="font-mono">{pr.sourceBranch.slice(0, 30)}</span>
          {pr.jiraIssueKey && (
            <>
              <span>·</span>
              <JiraTicketLink
                ticketKey={pr.jiraIssueKey}
                url={jiraBaseUrl ? `${jiraBaseUrl.replace(/\/$/, "")}/browse/${pr.jiraIssueKey}` : null}
              />
            </>
          )}
          {pr.commentCount > 0 && (
            <>
              <span>·</span>
              <span>{pr.commentCount} comments</span>
            </>
          )}
        </div>
      </button>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading PRs…
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold">
          {showAll ? "All open PRs" : "PRs assigned to you for review"}
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Hide approved toggle — only meaningful when the user has an accountId */}
          {myAccountId && approvedCount > 0 && (
            <button
              onClick={() => setHideApproved(!hideApproved)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
                hideApproved
                  ? "bg-muted text-muted-foreground border-border hover:text-foreground"
                  : "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-700"
              }`}
              title={hideApproved ? `Show ${approvedCount} approved PR${approvedCount !== 1 ? "s" : ""}` : "Hide approved PRs"}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {hideApproved ? `${approvedCount} approved hidden` : "Showing approved"}
            </button>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show mine only" : "Show all open"}
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-2">
          <GitPullRequest className="h-8 w-8 opacity-40" />
          <p className="text-sm">
            {showAll
              ? hideApproved && approvedCount > 0
                ? `All open PRs are already approved by you.`
                : "No open PRs found."
              : hideApproved && approvedCount > 0
                ? `All PRs assigned to you are already approved.`
                : "No PRs assigned to you for review."}
          </p>
          {hideApproved && approvedCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setHideApproved(false)}>
              Show approved PRs
            </Button>
          ) : !showAll ? (
            <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
              Show all open PRs
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((pr) => <PrRow key={pr.id} pr={pr} />)}
        </div>
      )}
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function PrReviewScreen({ credStatus, onBack }: PrReviewScreenProps) {
  const claudeAvailable = aiProviderComplete(credStatus);
  const bbAvailable = bitbucketComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  // ── Store bindings (persistent state — survives navigation) ──────────────────
  const {
    selectedPr,
    sessions,
    prsForReview,
    allOpenPrs,
    loadingPrs,
    jiraBaseUrl,
    myAccountId,
    prListLoaded,
  } = usePrReviewStore();

  // Derive the current session fields from the Map (empty defaults while loading)
  const session = (selectedPr ? sessions.get(selectedPr.id) : undefined) ?? {
    diff: "", diffUpdatedOn: null, diffStale: false,
    comments: [] as import("@/lib/tauri").BitbucketComment[],
    commentCountAtFetch: 0, commentsLastFetchedAt: null as string | null, hasNewComments: false,
    linkedIssue: null, loadingDetails: false, checkingForUpdates: false,
    report: null, rawError: null, reviewing: false,
    reviewProgress: "", reviewStreamText: "",
    worktreeBranch: null, checkoutStatus: "idle" as const, checkoutError: "",
    submitAction: null, submitStatus: "idle" as const, submitError: "",
    reviewChat: [],
    myPostedCommentIds: [] as number[], postingComment: false, postCommentError: "",
    tasks: [] as import("@/lib/tauri").BitbucketTask[],
  };
  // Guard against old cache entries that are missing fields added in newer versions
  const comments = session.comments ?? [];
  const myPostedCommentIds = session.myPostedCommentIds ?? [];
  const tasks = session.tasks ?? [];
  const {
    diff, linkedIssue, loadingDetails, report, rawError, reviewing,
    reviewProgress, reviewStreamText, worktreeBranch, checkoutStatus, checkoutError,
    submitAction, submitStatus, submitError, reviewChat, reviewChatStreamText,
    diffStale, checkingForUpdates,
  } = session;

  const store = usePrReviewStore.getState;

  // ── Ephemeral UI state (local — reset on each visit is fine) ─────────────────
  const [splitPct, setSplitPct] = useState(58);
  const [highlightTarget, setHighlightTarget] = useState<{ path: string; line: number | null } | null>(null);
  const [reviewChatInput, setReviewChatInput] = useState("");
  const [reviewChatSending, setReviewChatSending] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [toolRequests, setToolRequests] = useState<ToolRequest[]>([]);
  const PR_RUN_CMD_KEY = "meridian-pr-review-run-command";
  const DEFAULT_RUN_CMD = "pnpm nx run flowjo:start";
  const [runCommand, setRunCommand] = useState(
    () => localStorage.getItem(PR_RUN_CMD_KEY) ?? DEFAULT_RUN_CMD
  );
  const [runningCommand, setRunningCommand] = useState(false);
  const [runCommandError, setRunCommandError] = useState("");
  const [pullingBranch, setPullingBranch] = useState(false);
  const [pullBranchError, setPullBranchError] = useState("");
  const [pullBranchSuccess, setPullBranchSuccess] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const diffPaneRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // ── Resizable split pane ─────────────────────────────────────────────────────
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    function onMouseMove(ev: MouseEvent) {
      if (!isDragging.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(Math.max(pct, 20), 80));
    }
    function onMouseUp() {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  // ── Backend event listeners — patch the active PR's session ──────────────────
  useEffect(() => {
    const unlisten = listen<{ phase: string; message: string }>("pr-review-progress", (event) => {
      const prId = usePrReviewStore.getState().selectedPr?.id;
      if (!prId) return;
      if (event.payload.phase === "done") {
        setTimeout(() => usePrReviewStore.getState()._patchSession(prId, { reviewProgress: "" }), 1200);
      } else {
        usePrReviewStore.getState()._patchSession(prId, { reviewProgress: event.payload.message });
      }
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    // Accumulate deltas in a plain object (not a React ref) so we never read
    // from Zustand state on every token. We throttle writes to Zustand (and
    // therefore React re-renders) to at most once every 80 ms — enough to feel
    // responsive without flooding the JS event loop when a fast local model is
    // firing tokens rapidly.
    const acc = { text: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleFlush(prId: number) {
      if (flushTimer !== null) return; // already scheduled
      flushTimer = setTimeout(() => {
        flushTimer = null;
        usePrReviewStore.getState()._patchSession(prId, { reviewStreamText: acc.text });
      }, 80);
    }

    const unlistenStream = listen<{ delta: string }>("pr-review-stream", (event) => {
      const prId = usePrReviewStore.getState().selectedPr?.id;
      if (!prId) return;
      acc.text += event.payload.delta;
      scheduleFlush(prId);
    });

    // Reset both the local accumulator and the Zustand state when a new chunk starts.
    const unlistenReset = listen("pr-review-stream-reset", () => {
      acc.text = "";
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      const prId = usePrReviewStore.getState().selectedPr?.id;
      if (prId) usePrReviewStore.getState()._patchSession(prId, { reviewStreamText: "" });
    });

    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      unlistenStream.then(f => f());
      unlistenReset.then(f => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      name: string; description: string; why_needed: string; example_call: string;
    }>("agent-tool-request", (event) => {
      const { name, description, why_needed, example_call } = event.payload;
      setToolRequests(prev => [...prev, {
        id: `${Date.now()}-${name}`,
        name,
        description,
        whyNeeded: why_needed,
        exampleCall: example_call,
        dismissed: false,
        saved: false,
      }]);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  function dismissToolRequest(id: string) {
    setToolRequests(prev => prev.map(r => r.id === id ? { ...r, dismissed: true } : r));
  }
  function markToolRequestSaved(id: string) {
    setToolRequests(prev => prev.map(r => r.id === id ? { ...r, saved: true } : r));
  }

  // ── Refresh PR lists every time this panel mounts ────────────────────────────
  // prListLoaded is still used to avoid a flash of empty state on first hydration,
  // but we always kick off a fresh fetch on mount so new PRs assigned to the user
  // are picked up without needing to restart the app.
  useEffect(() => {
    store().loadPrLists(jiraAvailable, bbAvailable);
  }, [bbAvailable, jiraAvailable]);

  // ── Auto-scroll chat — fires on new messages AND on each streaming token ────
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [reviewChat, reviewChatStreamText]);

  // ── Send chat message ────────────────────────────────────────────────────────
  async function sendReviewChatMessage() {
    const msg = reviewChatInput.trim();
    if (!msg || !report || !selectedPr) return;
    setReviewChatInput("");
    setReviewChatSending(true);
    try {
      const enriched = await enrichMessageWithUrls(msg);
      await store().sendReviewChatMessage(enriched);
    } finally {
      setReviewChatSending(false);
    }
  }


  async function copySummary() {
    if (!report) return;
    const lines = [
      `## PR #${selectedPr?.id} Review`,
      `**Verdict**: ${report.overall.replace("_", " ")}`,
      `**Summary**: ${report.summary}`,
      "",
      "### Findings",
    ];
    for (const [key, label] of [
      ["acceptance_criteria", "Acceptance Criteria"],
      ["security", "Security"],
      ["logic", "Logic"],
      ["quality", "Quality"],
      ["testing", "Testing"],
    ] as const) {
      const lens = report.lenses[key];
      if (lens.findings.length > 0) {
        lines.push(`\n**${label}** — ${lens.assessment}`);
        for (const f of lens.findings) {
          lines.push(`- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${lineRangeToIdeSuffix(f.line_range)})` : ""}`);
          lines.push(`  ${f.description}`);
        }
      }
    }
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopiedSummary(true);
    setTimeout(() => setCopiedSummary(false), 2000);
  }

  // Count total blocking issues
  const blockingTotal = report
    ? Object.values(report.lenses).flatMap((l) => l.findings).filter((f) => f.severity === "blocking").length
    : 0;

  /**
   * Post a comment from a finding. If the finding has a file reference and a
   * parseable line number, post it as an inline comment on that line.
   * Otherwise post it as a general PR comment.
   */
  async function postFindingComment(
    content: string,
    file: string | null,
    lineRange: string | null,
  ): Promise<BitbucketComment> {
    // Try to parse a line number from line_range, e.g. "L42", "42-56", "42"
    let toLine: number | undefined;
    if (file && lineRange) {
      const m = lineRange.match(/\d+/);
      if (m) toLine = parseInt(m[0], 10);
    }
    return store().postComment(content, file ?? undefined, toLine, undefined);
  }

  // Reset highlightTarget to null first so the effect always re-fires even
  // when the same file link is clicked twice in a row.
  function jumpToFile(path: string, line?: number) {
    setHighlightTarget(null);
    requestAnimationFrame(() => setHighlightTarget({ path, line: line ?? null }));
  }

  async function handleRunInTerminal() {
    if (!runCommand.trim() || runningCommand) return;
    setRunningCommand(true);
    setRunCommandError("");
    // Persist as the new default before running so the next PR starts with it
    localStorage.setItem(PR_RUN_CMD_KEY, runCommand.trim());
    try {
      await runInTerminal(runCommand.trim());
    } catch (e) {
      setRunCommandError(String(e));
    } finally {
      setRunningCommand(false);
    }
  }

  async function handlePullBranch() {
    if (!selectedPr?.sourceBranch || pullingBranch) return;
    setPullingBranch(true);
    setPullBranchError("");
    setPullBranchSuccess(false);
    // Mark as checking-out so the worktree status indicator updates immediately
    usePrReviewStore.getState()._patchSession(selectedPr.id, { checkoutStatus: "checking-out", checkoutError: "" });
    try {
      const info = await checkoutPrReviewBranch(selectedPr.sourceBranch);
      // Update the store session so checkoutStatus becomes "ready" and unlocks the run command
      usePrReviewStore.getState()._patchSession(selectedPr.id, {
        checkoutStatus: "ready",
        worktreeBranch: info.branch,
        checkoutError: "",
      });
      setPullBranchSuccess(true);
      setTimeout(() => setPullBranchSuccess(false), 3000);
    } catch (e) {
      usePrReviewStore.getState()._patchSession(selectedPr.id, { checkoutStatus: "error", checkoutError: String(e) });
      setPullBranchError(String(e));
    } finally {
      setPullingBranch(false);
    }
  }

  const lensTabLabel = (key: keyof ReviewReport["lenses"], icon: React.ReactNode, label: string) => {
    if (!report) return <>{icon}<span className="hidden sm:inline ml-1">{label}</span></>;
    const count = report.lenses[key].findings.filter((f) => f.severity === "blocking").length;
    return (
      <span className="flex items-center gap-1">
        {icon}
        <span className="hidden sm:inline">{label}</span>
        {count > 0 && (
          <span className="rounded-full bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 text-xs px-1.5 leading-none py-0.5">
            {count}
          </span>
        )}
      </span>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <WorkflowPanelHeader
        barClassName="z-20"
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={selectedPr ? () => store().clearSelection() : onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className={`${APP_HEADER_TITLE} leading-none`}>PR Review Assistant</h1>
              {selectedPr && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  #{selectedPr.id} — {selectedPr.title}
                </p>
              )}
            </div>
          </>
        }
        trailing={
          selectedPr ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => selectedPr?.url && openUrl(selectedPr.url)}
              >
                <ExternalLink className="mr-1 h-3.5 w-3.5" /> Bitbucket
              </Button>
              {linkedIssue && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => linkedIssue.url && openUrl(linkedIssue.url)}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" /> {linkedIssue.key}
                </Button>
              )}
              {report && (
                <Button variant="ghost" size="sm" onClick={copySummary} className="gap-1">
                  {copiedSummary ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedSummary ? "Copied" : "Copy report"}
                </Button>
              )}
            </div>
          ) : null
        }
      />

      {/* Credential warnings */}
      {(!bbAvailable || !claudeAvailable) && (
        <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-200">
          {!bbAvailable && "Bitbucket credentials not configured. "}
          {!claudeAvailable && "No AI provider configured — AI review unavailable."}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 w-full bg-background/60 flex flex-col min-h-0">
        {!selectedPr ? (
          /* PR selector */
          <div className="px-6 py-6">
            <PrSelector
              prsForReview={prsForReview}
              allOpenPrs={allOpenPrs}
              loading={loadingPrs}
              onSelect={(pr) => store().selectPr(pr, jiraAvailable)}
              jiraBaseUrl={jiraBaseUrl}
              myAccountId={myAccountId}
              cachedPrIds={new Set(
                [...sessions.entries()]
                  .filter(([, s]) => s.report !== null || s.rawError !== null)
                  .map(([id]) => id)
              )}
              stalePrIds={new Set(
                [...sessions.entries()]
                  .filter(([, s]) => s.report !== null && s.diffStale)
                  .map(([id]) => id)
              )}
            />
          </div>
        ) : (
          /* Review layout */
          <div ref={splitContainerRef} className="flex flex-1 min-h-0">
            {/* Left: diff viewer */}
            <div ref={diffPaneRef} style={{ width: `${splitPct}%` }} className="flex-none h-full overflow-y-auto border-r px-4 pb-4 space-y-3">
              <div className="flex items-center justify-between pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Diff</p>
                {loadingDetails && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                  </span>
                )}
              </div>
              {diff ? (
                <DiffViewer
                  diff={diff}
                  highlightTarget={highlightTarget}
                  scrollContainerRef={diffPaneRef}
                  comments={comments}
                  tasks={tasks}
                  myAccountId={myAccountId}
                  myPostedCommentIds={myPostedCommentIds}
                  onPostInlineComment={async (path, toLine, content) => {
                    await store().postComment(content, path, toLine);
                  }}
                  onReply={async (parentId, content) => {
                    await store().postComment(content, undefined, undefined, parentId);
                  }}
                  onCreateTask={async (commentId, content) => store().createTask(commentId, content)}
                  onResolveTask={async (taskId, resolved) => store().resolveTask(taskId, resolved)}
                  onDeleteComment={async (commentId) => store().deleteComment(commentId)}
                  onEditComment={async (commentId, newContent) => store().editComment(commentId, newContent)}
                />
              ) : loadingDetails ? null : (
                <div className="flex items-center justify-center h-48 text-sm text-muted-foreground border rounded-md border-dashed">
                  No diff available
                </div>
              )}
            </div>

            {/* Drag handle */}
            <div
              onMouseDown={onDividerMouseDown}
              className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors"
            />

            {/* Right: review panel — never scrolls as a whole; only the body below the run button scrolls */}
            <div style={{ width: `${100 - splitPct}%` }} className="flex-none h-full flex flex-col overflow-hidden">

              {/* ── Pinned top strip: run button + worktree status ── */}
              <div className="p-4 border-b shrink-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    onClick={() => reviewing ? store().cancelReview() : store().runReview()}
                    disabled={!reviewing && (!claudeAvailable || loadingDetails)}
                    variant={reviewing ? "destructive" : "default"}
                    className={`gap-2 flex-1 ${!reviewing && diffStale ? "ring-2 ring-amber-500/60" : ""}`}
                  >
                    {reviewing ? (
                      <><Square className="h-4 w-4" /> Stop review</>
                    ) : report ? (
                      <><RefreshCw className="h-4 w-4" /> Re-run review</>
                    ) : (
                      <><Sparkles className="h-4 w-4" /> Run AI Review</>
                    )}
                  </Button>
                  {checkoutStatus === "checking-out" && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Checking out branch…
                    </span>
                  )}
                  {checkoutStatus === "ready" && worktreeBranch && (
                    <span className="flex items-center gap-1.5 text-xs text-green-600">
                      <GitBranch className="h-3 w-3" /> {worktreeBranch}
                    </span>
                  )}
                  {checkoutStatus === "error" && (
                    <span className="flex items-center gap-1.5 text-xs text-amber-600" title={`Branch checkout failed: ${checkoutError}`}>
                      <GitBranch className="h-3 w-3" /> Branch checkout failed
                    </span>
                  )}
                  {/* Pull branch button — re-fetches and checks out the PR branch in the worktree */}
                  {selectedPr?.sourceBranch && (
                    <button
                      onClick={handlePullBranch}
                      disabled={pullingBranch || reviewing}
                      title={`Pull ${selectedPr.sourceBranch} into the worktree`}
                      className="shrink-0 flex items-center gap-1.5 px-2 h-7 rounded-md border border-input bg-background text-xs text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {pullingBranch
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : pullBranchSuccess
                        ? <Check className="h-3 w-3 text-green-600" />
                        : <Download className="h-3 w-3" />}
                      {pullingBranch ? "Pulling…" : pullBranchSuccess ? "Pulled" : "Pull branch"}
                    </button>
                  )}
                </div>
                {pullBranchError && (
                  <p className="mt-1 text-[11px] text-destructive leading-snug">{pullBranchError}</p>
                )}

                {/* Stale diff banner */}
                {diffStale && !reviewing && (
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <RefreshCw className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      <span className="font-medium">New commits detected.</span>{" "}
                      The diff has been refreshed with the latest changes.
                      Re-run the AI review to assess the updated code.
                    </span>
                  </div>
                )}

                {/* Checking for updates indicator */}
                {checkingForUpdates && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Checking for new commits…
                  </div>
                )}

                {/* ── Run branch command ── */}
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    value={runCommand}
                    onChange={(e) => { setRunCommand(e.target.value); setRunCommandError(""); }}
                    className="flex-1 min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
                    placeholder="command to run…"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && runCommand.trim() && !runningCommand && checkoutStatus === "ready") {
                        e.preventDefault();
                        handleRunInTerminal();
                      }
                    }}
                    disabled={runningCommand || checkoutStatus !== "ready"}
                  />
                  <button
                    onClick={handleRunInTerminal}
                    disabled={!runCommand.trim() || runningCommand || checkoutStatus !== "ready"}
                    title={checkoutStatus !== "ready" ? "Pull the branch first to enable running commands" : "Open a Terminal window and run this command in the worktree directory"}
                    className="shrink-0 flex items-center justify-center h-7 w-7 rounded-md bg-green-600 text-white hover:bg-green-700 active:bg-green-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {runningCommand
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Play className="h-3.5 w-3.5 ml-0.5" />}
                  </button>
                </div>
                {runCommandError && (
                  <p className="mt-1 text-[11px] text-destructive leading-snug">{runCommandError}</p>
                )}
              </div>

              {/* ── Scrollable body: review findings ── */}
              <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">

                  {/* Verdict + summary + Bitbucket submit + error */}
                  {(report || rawError) && !reviewing && (
                  <div className="p-4 border-b space-y-3">
                    {report && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <VerdictBadge overall={report.overall} />
                          {blockingTotal > 0 && (
                            <span className="text-xs text-red-600 dark:text-red-400 font-medium">
                              {blockingTotal} blocking {blockingTotal === 1 ? "issue" : "issues"}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground leading-relaxed">{report.summary}</p>

                        {/* Bug test steps */}
                        {report.bug_test_steps && (
                          <BugTestStepsCard steps={report.bug_test_steps} />
                        )}

                        {/* Submit to Bitbucket */}
                        <div className="pt-1 space-y-2">
                          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Submit to Bitbucket</p>
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              onClick={() => store().submitReview("approve")}
                              disabled={submitStatus === "submitting"}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors disabled:opacity-50 ${
                                submitAction === "approve" && submitStatus === "done"
                                  ? "bg-green-600 text-white border-green-600 hover:bg-green-700"
                                  : "border-green-600 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/30"
                              }`}
                              title={submitAction === "approve" && submitStatus === "done" ? "Click to remove your approval" : "Approve this PR in Bitbucket"}
                            >
                              {submitStatus === "submitting" && submitAction !== "needs_work" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ThumbsUp className="h-3.5 w-3.5" />
                              )}
                              {submitAction === "approve" && submitStatus === "done" ? "Approved ✓" : "Approve"}
                            </button>

                            <button
                              onClick={() => store().submitReview("needs_work")}
                              disabled={submitStatus === "submitting"}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors disabled:opacity-50 ${
                                submitAction === "needs_work" && submitStatus === "done"
                                  ? "bg-amber-600 text-white border-amber-600 hover:bg-amber-700"
                                  : "border-amber-600 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                              }`}
                              title={submitAction === "needs_work" && submitStatus === "done" ? "Click to remove 'Needs work'" : "Mark as Needs work in Bitbucket"}
                            >
                              {submitStatus === "submitting" && submitAction !== "approve" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ThumbsDown className="h-3.5 w-3.5" />
                              )}
                              {submitAction === "needs_work" && submitStatus === "done" ? "Needs work ✓" : "Needs work"}
                            </button>

                            {submitStatus === "error" && (
                              <span className="text-xs text-destructive leading-tight max-w-[200px]" title={submitError}>
                                {submitError.includes("Write")
                                  ? "App Password needs 'Pull requests: Write' scope — update it in Settings"
                                  : "Failed — see title for details"}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {rawError && (
                      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                        <p className="text-xs font-medium text-destructive mb-1">Review error</p>
                        <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                          {rawError}
                        </pre>
                      </div>
                    )}
                  </div>
                )}

                {/* Findings tabs */}
                {report && !reviewing && (
                  <div className="p-4">
                    <Tabs defaultValue="acceptance_criteria">
                      <TabsList className="grid grid-cols-5 w-full">
                        <TabsTrigger value="acceptance_criteria" className="px-1">
                          {lensTabLabel("acceptance_criteria", <ClipboardList className="h-3.5 w-3.5" />, "AC")}
                        </TabsTrigger>
                        <TabsTrigger value="security" className="px-1">
                          {lensTabLabel("security", <Shield className="h-3.5 w-3.5" />, "Security")}
                        </TabsTrigger>
                        <TabsTrigger value="logic" className="px-1">
                          {lensTabLabel("logic", <Cpu className="h-3.5 w-3.5" />, "Logic")}
                        </TabsTrigger>
                        <TabsTrigger value="quality" className="px-1">
                          {lensTabLabel("quality", <Star className="h-3.5 w-3.5" />, "Quality")}
                        </TabsTrigger>
                        <TabsTrigger value="testing" className="px-1">
                          {lensTabLabel("testing", <FlaskConical className="h-3.5 w-3.5" />, "Testing")}
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="acceptance_criteria" className="mt-4">
                        <LensPanel lens={report.lenses.acceptance_criteria} onJumpToFile={jumpToFile} onPostComment={postFindingComment} />
                      </TabsContent>
                      <TabsContent value="security" className="mt-4">
                        <LensPanel lens={report.lenses.security} onJumpToFile={jumpToFile} onPostComment={postFindingComment} />
                      </TabsContent>
                      <TabsContent value="logic" className="mt-4">
                        <LensPanel lens={report.lenses.logic} onJumpToFile={jumpToFile} onPostComment={postFindingComment} />
                      </TabsContent>
                      <TabsContent value="quality" className="mt-4">
                        <LensPanel lens={report.lenses.quality} onJumpToFile={jumpToFile} onPostComment={postFindingComment} />
                      </TabsContent>
                      <TabsContent value="testing" className="mt-4">
                        <LensPanel lens={report.lenses.testing ?? { assessment: "No testing analysis available.", findings: [] }} onJumpToFile={jumpToFile} onPostComment={postFindingComment} />
                      </TabsContent>
                    </Tabs>
                  </div>
                )}

                {/* ── Post-review chat ── */}
                {report && !reviewing && (
                  <div className="border-t">
                    {/* Chat header */}
                    <div className="px-4 py-3 flex items-center gap-2">
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Ask the reviewer
                      </p>
                    </div>

                    {/* Messages */}
                    <div className="px-4 space-y-3 pb-3">
                      {reviewChat.length === 0 && (
                        <p className="text-xs text-muted-foreground italic text-center py-2">
                          Ask a question about any finding — why it was raised, whether it applies given your context, or to reassess something.
                        </p>
                      )}
                      {reviewChat.map((msg, i) => (
                        <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                          <div className={`max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                            msg.role === "user"
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-foreground"
                          }`}>
                            <p className="whitespace-pre-wrap">{msg.content}</p>
                          </div>
                        </div>
                      ))}
                      {/* Tool request cards — shown inline after messages */}
                      {toolRequests.filter(r => !r.dismissed).map(r => (
                        <ToolRequestCard
                          key={r.id}
                          request={r}
                          onDismiss={dismissToolRequest}
                          onSaved={markToolRequestSaved}
                        />
                      ))}
                      {reviewChatSending && (
                        <div className="flex justify-start">
                          <div className="bg-muted rounded-lg px-3 py-2 text-sm text-foreground max-w-[90%]">
                            {reviewChatStreamText ? (
                              <p className="whitespace-pre-wrap leading-relaxed">{reviewChatStreamText}</p>
                            ) : (
                              <span className="flex items-center gap-2 text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                      <div ref={chatBottomRef} />
                    </div>

                    {/* Input */}
                    <div className="px-4 pb-4 space-y-2 border-t pt-3">
                      <div className="flex gap-2">
                        <Textarea
                          value={reviewChatInput}
                          onChange={(e) => setReviewChatInput(e.target.value)}
                          placeholder="Ask about a finding…"
                          className="min-h-[52px] resize-none text-sm"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reviewChatInput.trim()) {
                              e.preventDefault();
                              sendReviewChatMessage();
                            }
                          }}
                          disabled={reviewChatSending}
                        />
                        <Button
                          size="icon"
                          onClick={sendReviewChatMessage}
                          disabled={!reviewChatInput.trim() || reviewChatSending}
                          title="Send (⌘↵)"
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">⌘↵ to send</p>
                    </div>
                  </div>
                )}

                {/* Empty state */}
                {!report && !reviewing && !rawError && (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-6 text-center">
                    Run the AI review to see findings across four lenses
                  </div>
                )}

                {/* Reviewing progress */}
                {reviewing && (
                  <div className="p-4 space-y-3">
                    <ReviewProgressBanner
                      message={reviewProgress || "Analysing diff…"}
                      streamText={reviewStreamText}
                    />
                  </div>
                )}

              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
