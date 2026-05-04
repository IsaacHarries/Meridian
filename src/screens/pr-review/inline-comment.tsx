import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type BitbucketComment, type BitbucketTask } from "@/lib/tauri/bitbucket";
import {
    Check,
    Image as ImageIcon,
    Loader2,
    Pencil,
    Send,
} from "lucide-react";
import { useRef, useState } from "react";
import { CommentRow, QuickTaskBox } from "./_shared";

// ── Inline comment compose box ────────────────────────────────────────────────

export function InlineCommentBox({
  onSubmit,
  onCancel,
  onAttachImage,
}: {
  onSubmit: (c: string) => Promise<void>;
  onCancel: () => void;
  /** Resolve a picked / pasted image into the URL to embed in markdown.
   *  Parent decides whether to return a data URI (offline-ish embed) or
   *  upload to Bitbucket and return an attachment URL (visible to
   *  teammates on the Bitbucket web UI). */
  onAttachImage: (file: File) => Promise<string>;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // Track an in-flight image attach so the user gets a visual cue while a
  // Bitbucket upload is happening (data-URI mode is fast enough that the
  // spinner barely flashes; that's fine).
  const [attaching, setAttaching] = useState(false);

  // Insert markdown image syntax at the current selection in the textarea,
  // preserving the user's caret position so they can keep typing.
  function insertImageMarkdown(alt: string, url: string) {
    const md = `![${alt}](${url})`;
    const ta = textareaRef.current;
    if (!ta) {
      setText((t) => `${t}${t && !t.endsWith("\n") ? "\n" : ""}${md}\n`);
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const next = before + md + after;
    setText(next);
    // Restore caret to immediately after the inserted markdown.
    requestAnimationFrame(() => {
      const pos = before.length + md.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  async function attachAndInsert(file: File) {
    setAttaching(true);
    setErr("");
    try {
      const url = await onAttachImage(file);
      insertImageMarkdown(file.name || "image", url);
    } catch (e) {
      setErr(`Could not attach image: ${String(e)}`);
    } finally {
      setAttaching(false);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((it) => it.type.startsWith("image/"));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    void attachAndInsert(file);
  }

  async function pickImage() {
    // Native file input — Tauri's plugin-dialog could also work, but the
    // browser-style picker keeps the read flow simple and works identically
    // on all platforms.
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      await attachAndInsert(file);
    };
    input.click();
  }

  return (
    <div className="border-l-2 border-primary/40 ml-[88px] mr-4 my-1 bg-muted/30 rounded-r-md p-2 space-y-2">
      <Textarea
        ref={textareaRef}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={handlePaste}
        placeholder="Leave a comment on this line… (paste a screenshot to attach)"
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
      <div className="flex gap-2 items-center">
        <Button size="sm" onClick={handleSubmit} disabled={!text.trim() || submitting} className="h-7 text-xs gap-1">
          {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          Comment
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={submitting} className="h-7 text-xs">
          Cancel
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void pickImage()}
          disabled={submitting || attaching}
          className="h-7 text-xs gap-1"
          title="Insert an image (also: paste a screenshot directly into the box)"
        >
          {attaching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ImageIcon className="h-3 w-3" />
          )}
          {attaching ? "Uploading…" : "Image"}
        </Button>
        <span className="text-[10px] text-muted-foreground self-center">⌘↵</span>
      </div>
    </div>
  );
}

// ── Inline comment thread (anchored under a diff line) ─────────────────────────

export function InlineCommentThread({
  comment, replies, tasks, myAccountId, myPostedCommentIds, onReply, onCreateTask, onResolveTask, onEditTask, onDeleteComment, onEditComment, onAttachImage,
}: {
  comment: BitbucketComment;
  replies: BitbucketComment[];
  tasks: BitbucketTask[];
  myAccountId: string;
  myPostedCommentIds: number[];
  onReply: (content: string) => Promise<void>;
  onCreateTask: (content: string) => Promise<BitbucketTask>;
  onResolveTask: (taskId: number, resolved: boolean) => Promise<void>;
  onEditTask: (taskId: number, content: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onEditComment: (commentId: number, newContent: string) => Promise<void>;
  onAttachImage: (file: File) => Promise<string>;
}) {
  const [showReply, setShowReply] = useState(false);
  const [showTask, setShowTask] = useState<number | "root" | null>(null);
  const [togglingTask, setTogglingTask] = useState<number | null>(null);
  const [, setDeletingId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [taskEditDraft, setTaskEditDraft] = useState("");
  const [savingTaskEdit, setSavingTaskEdit] = useState(false);

  function startTaskEdit(taskId: number, currentContent: string) {
    setEditingTaskId(taskId);
    setTaskEditDraft(currentContent);
  }

  async function saveTaskEdit() {
    if (editingTaskId == null || !taskEditDraft.trim()) return;
    setSavingTaskEdit(true);
    try {
      await onEditTask(editingTaskId, taskEditDraft.trim());
      setEditingTaskId(null);
    } finally {
      setSavingTaskEdit(false);
    }
  }
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
            <div key={task.id} className="flex items-start gap-2 group/task">
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
              {editingTaskId === task.id ? (
                <div className="flex-1 space-y-1">
                  <Input
                    value={taskEditDraft}
                    onChange={(e) => setTaskEditDraft(e.target.value)}
                    className="text-xs h-7"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && taskEditDraft.trim()) {
                        e.preventDefault();
                        saveTaskEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingTaskId(null);
                      }
                    }}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" className="h-6 text-xs px-2" onClick={saveTaskEdit} disabled={savingTaskEdit || !taskEditDraft.trim()}>
                      {savingTaskEdit ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => setEditingTaskId(null)} disabled={savingTaskEdit}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <span className={`leading-snug flex-1 ${task.resolved ? "line-through text-muted-foreground" : "text-foreground"}`}>
                    {task.content}
                  </span>
                  <button
                    onClick={() => startTaskEdit(task.id, task.content)}
                    className="opacity-0 group-hover/task:opacity-100 transition-opacity shrink-0 h-4 w-4 flex items-center justify-center rounded hover:bg-muted/80 text-muted-foreground"
                    title="Edit task"
                  >
                    <Pencil className="h-2.5 w-2.5" />
                  </button>
                </>
              )}
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
            onAttachImage={onAttachImage}
          />
        </div>
      )}
    </div>
  );
}

// ── Quick reply box ───────────────────────────────────────────────────────────

export function QuickReplyBox({
  onSubmit,
  onCancel,
  onAttachImage,
}: {
  onSubmit: (c: string) => Promise<void>;
  onCancel: () => void;
  /** Same contract as InlineCommentBox.onAttachImage — see that prop's docstring. */
  onAttachImage: (file: File) => Promise<string>;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [err, setErr] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function go() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try { await onSubmit(text.trim()); } finally { setSubmitting(false); }
  }

  function insertAt(md: string) {
    const ta = taRef.current;
    if (!ta) {
      setText((t) => `${t}${t && !t.endsWith("\n") ? "\n" : ""}${md}\n`);
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const next = before + md + after;
    setText(next);
    requestAnimationFrame(() => {
      const pos = before.length + md.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  async function attachAndInsert(file: File) {
    setAttaching(true);
    setErr("");
    try {
      const url = await onAttachImage(file);
      insertAt(`![${file.name || "image"}](${url})`);
    } catch (e) {
      setErr(`Could not attach image: ${String(e)}`);
    } finally {
      setAttaching(false);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((it) => it.type.startsWith("image/"));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    void attachAndInsert(file);
  }

  function pickImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await attachAndInsert(file);
    };
    input.click();
  }

  return (
    <div className="space-y-1.5">
      <Textarea
        ref={taRef}
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        onPaste={handlePaste}
        placeholder="Reply… (paste a screenshot to attach)"
        className="min-h-[48px] resize-none text-xs"
        disabled={submitting}
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) { e.preventDefault(); go(); } }}
      />
      {err && <p className="text-[11px] text-destructive">{err}</p>}
      <div className="flex gap-1.5 items-center">
        <Button size="sm" onClick={go} disabled={!text.trim() || submitting} className="h-6 text-[11px] px-2 gap-1">
          {submitting ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Send className="h-2.5 w-2.5" />} Reply
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-6 text-[11px] px-2">Cancel</Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={pickImage}
          disabled={submitting || attaching}
          className="h-6 text-[11px] px-2 gap-1"
          title="Insert an image (or paste a screenshot)"
        >
          {attaching ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <ImageIcon className="h-2.5 w-2.5" />}
          {attaching ? "Uploading…" : "Image"}
        </Button>
      </div>
    </div>
  );
}
