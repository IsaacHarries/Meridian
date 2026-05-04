import { BitbucketImage } from "@/components/BitbucketImage";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type BitbucketComment } from "@/lib/tauri/bitbucket";
import { openUrl } from "@/lib/tauri/core";
import { type BugTestSteps, type ReviewFinding, type ReviewReport } from "@/lib/tauri/pr-review";
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    ChevronsUpDown,
    ClipboardList,
    CornerDownRight,
    ListTodo,
    Loader2,
    MinusCircle,
    Pencil,
    Trash2,
    XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

// ── Review progress banner (mirrors GroomingProgressBanner) ──────────────────

export function ReviewProgressBanner({ message, streamText }: { message: string; streamText: string }) {
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

/**
 * Convert an AI line_range value (e.g. "L42", "L42-L56", "42-56") into an
 * IDE-compatible path suffix using the standard compiler/tool convention:
 *   single line  → ":42"
 *   range        → ":42-56"
 * The "L" prefix is stripped from both numbers. Returns "" if nothing parseable.
 */
export function lineRangeToIdeSuffix(lineRange: string | null | undefined): string {
  if (!lineRange) return "";
  // Extract all digit sequences (strips any leading "L" characters)
  const nums = [...lineRange.matchAll(/\d+/g)].map(m => m[0]);
  if (nums.length === 0) return "";
  if (nums.length === 1) return `:${nums[0]}`;
  return `:${nums[0]}-${nums[1]}`;
}

/** Read a Blob/File and resolve to a `data:` URI string. */
export function readFileAsDataUri(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("Unexpected reader result type"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

// ── Inline markdown renderer (backtick code spans + fenced code blocks) ───────

export function renderCommentContent(text: string): React.ReactNode {
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
      // Markdown image: ![alt](url){...} → render inline. BitbucketImage
      // handles data URIs, Bitbucket-hosted (auth-required) URLs, and
      // arbitrary public URLs uniformly.
      const url = m[2];
      const alt = m[1];
      nodes.push(
        <BitbucketImage
          key={`${keyBase}-img${idx++}`}
          src={url}
          alt={alt}
        />,
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

export function CommentRow({
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

// ── Quick task box ─────────────────────────────────────────────────────────────

export function QuickTaskBox({ onSubmit, onCancel }: { onSubmit: (c: string) => Promise<void>; onCancel: () => void }) {
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

// ── Severity & verdict badges ─────────────────────────────────────────────────

export function SeverityBadge({ severity }: { severity: ReviewFinding["severity"] }) {
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

export function VerdictBadge({ overall }: { overall: ReviewReport["overall"] }) {
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

// ── Bug test steps card ───────────────────────────────────────────────────────

export function BugTestStepsCard({ steps }: { steps: BugTestSteps }) {
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

// ── Gap expand row (click to reveal the hidden file context) ─────────────────

export function GapExpandRow({
  lineCount, loading, error, canExpand, onClick,
}: {
  lineCount: number | null;
  loading: boolean;
  error: string | null;
  canExpand: boolean;
  onClick: () => void;
}) {
  const countLabel = lineCount == null
    ? "Show code below"
    : lineCount === 1
      ? "Show 1 hidden line"
      : `Show ${lineCount} hidden lines`;

  return (
    <button
      onClick={onClick}
      disabled={!canExpand || loading}
      className="w-full flex items-center justify-center gap-2 px-3 py-1 text-[11px] text-muted-foreground bg-muted/30 hover:bg-muted/60 border-t border-b border-border/40 font-mono disabled:opacity-60"
    >
      {loading ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <ChevronsUpDown className="h-3 w-3" />
      )}
      <span>{error ? `Failed to load: ${error}` : countLabel}</span>
    </button>
  );
}
