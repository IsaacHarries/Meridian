import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { PipelineProgress } from "@/components/PipelineProgress";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { HeaderRecordButton } from "@/components/HeaderRecordButton";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import { createGlobalCommands, type SlashCommand } from "@/lib/slashCommands";
import {
  APP_HEADER_BAR,
  APP_HEADER_ROW_PANEL,
  APP_HEADER_TITLE,
} from "@/components/appHeaderLayout";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import { MarkdownBlock } from "@/components/MarkdownBlock";
import {
  ArrowLeft,
  Loader2,
  CheckCircle2,
  Circle,
  ChevronRight,
  Sparkles,
  Copy,
  Check,
  AlertTriangle,
  ChevronDown,
  FileCode,
  TestTube,
  Shield,
  BookOpen,
  ClipboardList,
  GitPullRequest,
  ExternalLink,
  Bug,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  X,
  Eye,
  EyeOff,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  type JiraIssue,
  type DescriptionSection,
  type CredentialStatus,
  type GroomingOutput,
  type SuggestedEdit,
  type ImpactOutput,
  type ImplementationPlan,
  type ImplementationOutput,
  type TestOutput,
  type TestFileWritten,
  type PlanReviewOutput,
  type PrDescriptionOutput,
  type BitbucketPr,
  type RetrospectiveOutput,
  type TriageMessage,
  type TriageTurnOutput,
  type RetroKbEntry,
  aiProviderComplete,
  jiraComplete,
  isMockMode,
  getMySprintIssues,
  searchJiraIssues,
  openUrl,
  readRepoFile,
  writeRepoFile,
  getFileAtBase,
  type BuildCheckResult,
} from "@/lib/tauri";
import {
  useImplementTicketStore,
  snapshotSession,
  consumePendingResume,
  type Stage,
  type GroomingBlocker,
} from "@/stores/implementTicketStore";
import { enrichMessageWithUrls } from "@/lib/urlFetch";
import { fuzzyFilterIssues, mergeIssuesById } from "@/lib/fuzzySearch";
import {
  ToolRequestCard,
  type ToolRequest,
} from "@/components/ToolRequestCard";

interface ImplementTicketScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Pipeline stage config ─────────────────────────────────────────────────────

// ── Pipeline stage config ─────────────────────────────────────────────────────

// Stage type is re-exported from the store — imported above

const STAGE_LABELS: Record<Exclude<Stage, "select">, string> = {
  grooming: "Grooming",
  impact: "Impact Analysis",
  triage: "Triage",
  plan: "Implementation Plan",
  implementation: "Implementation",
  tests: "Test Suggestions",
  review: "Code Review",
  pr: "PR Description",
  retro: "Retrospective",
  complete: "Complete",
};

const STAGE_ORDER: Exclude<Stage, "select" | "complete">[] = [
  "grooming",
  "impact",
  "triage",
  "plan",
  "implementation",
  "tests",
  "review",
  "pr",
  "retro",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
// compileTicketText, compilePipelineContext, detectGroomingBlockers, GroomingBlocker
// are now imported from the store.

function BlockerBanner({ blockers }: { blockers: GroomingBlocker[] }) {
  if (blockers.length === 0) return null;
  const hasBlocking = blockers.some((b) => b.severity === "blocking");
  return (
    <div
      className={`rounded-md border p-3 space-y-2 ${hasBlocking ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30" : "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"}`}
    >
      <div
        className={`flex items-center gap-2 text-sm font-medium ${hasBlocking ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"}`}
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {hasBlocking
          ? "Blocking issues — resolve before proceeding"
          : "Warnings — review before proceeding"}
      </div>
      {blockers.map((b) => (
        <div key={b.id} className="pl-6 space-y-0.5">
          <div
            className={`flex items-center gap-1.5 text-xs font-medium ${b.severity === "blocking" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"}`}
          >
            <span
              className={`px-1.5 py-0.5 rounded ${b.severity === "blocking" ? "bg-red-100 dark:bg-red-900" : "bg-amber-100 dark:bg-amber-900"}`}
            >
              {b.severity}
            </span>
            {b.message}
          </div>
          <p
            className={`text-xs ${b.severity === "blocking" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}
          >
            {b.detail}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Small display components ──────────────────────────────────────────────────

function RiskBadge({ level }: { level: "low" | "medium" | "high" }) {
  const cls =
    level === "high"
      ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
      : level === "medium"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
        : "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {level} risk
    </span>
  );
}

function ConfidenceBadge({
  level,
}: {
  level: "ready" | "needs_attention" | "requires_rework";
}) {
  if (level === "ready")
    return (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
        Ready
      </span>
    );
  if (level === "needs_attention")
    return (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
        Needs attention
      </span>
    );
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
      Requires rework
    </span>
  );
}

function CollapsibleList({
  title,
  items,
  icon,
}: {
  title: string;
  items: string[];
  icon?: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;
  return (
    <div className="border rounded-md overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className="flex-1 text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{items.length}</span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <ul className="px-3 pb-2 pt-1 space-y-1">
          {items.map((item, i) => (
            <li key={i} className="text-sm text-muted-foreground flex gap-2">
              <span className="text-muted-foreground shrink-0">·</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={copy}
      className="gap-1.5 h-7 text-xs"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : label}
    </Button>
  );
}

// ── JIRA description sections panel ──────────────────────────────────────────

/**
 * Parse a flat description string into sections by detecting common heading
 * patterns used in JIRA tickets:
 *   - "h1." / "h2." / "h3." (Confluence wiki markup)
 *   - "## Heading" (Markdown)
 *   - "**Heading**" on its own line (bold heading)
 *   - "Heading:" on its own line where the heading is 1–5 words (short label)
 */
function parseDescriptionText(text: string): DescriptionSection[] {
  if (!text.trim()) return [];

  const lines = text.split("\n");
  const sections: DescriptionSection[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const headingPattern =
    /^(?:h[1-6]\.\s*(.+)|#{1,3}\s+(.+)|(\*{1,2})(.+)\3\s*$)/;
  // A line that is just a short phrase (1-6 words) ending in ":" and nothing else
  const labelPattern = /^([A-Z][^:\n]{2,40}):\s*$/;

  function flush() {
    const content = currentLines.join("\n").trim();
    if (content || currentHeading !== null) {
      sections.push({ heading: currentHeading, content });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const hMatch = line.match(headingPattern);
    const labelMatch = !hMatch && line.match(labelPattern);
    const heading = hMatch
      ? (hMatch[1] || hMatch[2] || hMatch[4] || "").trim()
      : labelMatch
        ? labelMatch[1].trim()
        : null;

    if (heading) {
      flush();
      currentHeading = heading;
    } else {
      currentLines.push(line);
    }
  }
  flush();

  // Drop empty leading/trailing sections
  return sections.filter(
    (s) => s.heading !== null || s.content.trim().length > 0,
  );
}

function DescriptionSectionsPanel({
  sections,
  fallbackDescription,
}: {
  sections: DescriptionSection[];
  fallbackDescription?: string | null;
}) {
  // Use structured sections from ADF if available; otherwise parse the flat text.
  const resolved: DescriptionSection[] =
    sections.length > 0
      ? sections
      : fallbackDescription
        ? parseDescriptionText(fallbackDescription)
        : [];

  if (resolved.length === 0) return null;

  // If there's only one section with no heading it's just prose — show it simply.
  if (resolved.length === 1 && !resolved[0].heading) {
    return (
      <div className="border rounded-md overflow-hidden">
        <div className="px-3 py-2 bg-muted/30 text-sm font-medium">
          Description
        </div>
        <div className="px-3 py-2">
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
            {resolved[0].content}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="border rounded-md overflow-hidden divide-y">
      <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        Key Details
      </div>
      {resolved.map((section, i) => (
        <CollapsibleSection
          key={i}
          heading={section.heading}
          content={section.content}
        />
      ))}
    </div>
  );
}

function CollapsibleSection({
  heading,
  content,
}: {
  heading: string | null;
  content: string;
}) {
  const [open, setOpen] = useState(true);
  if (!heading) {
    // Preamble prose (before first heading) — always shown inline without toggle
    const trimmed = content.trim();
    if (!trimmed) return null;
    return (
      <div className="px-3 py-2">
        <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
          {trimmed}
        </pre>
      </div>
    );
  }
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
      >
        <span className="flex-1 text-sm font-medium">{heading}</span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
            {content.trim()}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Stage output panels ───────────────────────────────────────────────────────

/**
 * Diff two string arrays and return each item tagged as "added", "removed", or "unchanged".
 * Simple string equality — good enough for AC/ambiguities/dependencies.
 */
function diffStringArrays(
  prev: string[],
  next: string[],
): { text: string; status: "added" | "removed" | "unchanged" }[] {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const result: { text: string; status: "added" | "removed" | "unchanged" }[] =
    [];
  for (const item of next) {
    result.push({
      text: item,
      status: prevSet.has(item) ? "unchanged" : "added",
    });
  }
  for (const item of prev) {
    if (!nextSet.has(item)) result.push({ text: item, status: "removed" });
  }
  return result;
}

interface DiffedListProps {
  title: string;
  items: { text: string; status: "added" | "removed" | "unchanged" }[];
  icon?: React.ReactNode;
  hasChanges: boolean;
}

function DiffedCollapsibleList({
  title,
  items,
  icon,
  hasChanges,
}: DiffedListProps) {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;
  return (
    <div
      className={`border rounded-md overflow-hidden ${hasChanges ? "border-blue-300 dark:border-blue-700" : ""}`}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className="flex-1 text-sm font-medium">{title}</span>
        {hasChanges && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 font-medium">
            updated
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {items.filter((i) => i.status !== "removed").length}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <ul className="px-3 pb-2 pt-1 space-y-1">
          {items.map((item, i) => (
            <li
              key={i}
              className={`text-sm flex gap-2 rounded px-1 py-0.5 ${
                item.status === "added"
                  ? "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-200"
                  : item.status === "removed"
                    ? "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 line-through opacity-60"
                    : "text-muted-foreground"
              }`}
            >
              <span className="shrink-0">
                {item.status === "added"
                  ? "+"
                  : item.status === "removed"
                    ? "−"
                    : "·"}
              </span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Grooming progress banner ──────────────────────────────────────────────────

function GroomingProgressBanner({
  message,
  streamText,
}: {
  message: string;
  streamText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the stream panel as new tokens arrive
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamText, expanded]);

  if (!message) return null;

  return (
    <div className="border rounded-md overflow-hidden bg-muted/20">
      {/* Status row */}
      <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin shrink-0 text-primary" />
        <span className="flex-1 leading-snug">{message}</span>
        {streamText && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
            {expanded ? "Hide" : "Show"} output
          </button>
        )}
      </div>
      {/* Streaming text panel */}
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

// ── Suggested Edit components ─────────────────────────────────────────────────

function SuggestedEditCard({
  edit,
  onApprove,
  onDecline,
  onEdit,
  highlighted,
}: {
  edit: SuggestedEdit;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  onEdit: (id: string, newSuggested: string) => void;
  highlighted?: boolean;
}) {
  const isPending = edit.status === "pending";
  const isApproved = edit.status === "approved";
  const isDeclined = edit.status === "declined";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(edit.suggested);

  function startEditing() {
    setDraft(edit.suggested);
    setEditing(true);
  }

  function saveEditing() {
    const next = draft.trim();
    if (next.length > 0 && next !== edit.suggested) onEdit(edit.id, next);
    setEditing(false);
  }

  function cancelEditing() {
    setDraft(edit.suggested);
    setEditing(false);
  }

  return (
    <div
      className={`border rounded-md overflow-hidden transition-opacity ${isDeclined ? "opacity-40" : ""} ${highlighted ? "animate-update-glow ring-1 ring-primary/40" : ""}`}
    >
      {/* Header */}
      <div
        className={`px-3 py-2 flex items-center justify-between text-sm font-medium ${
          isApproved
            ? "bg-green-50 dark:bg-green-950/30 border-b border-green-200 dark:border-green-800"
            : isDeclined
              ? "bg-muted/30 border-b"
              : "bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800"
        }`}
      >
        <div className="flex items-center gap-2">
          {isApproved && (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
          )}
          {isDeclined && (
            <Circle className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {isPending && (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          )}
          <span
            className={isDeclined ? "line-through text-muted-foreground" : ""}
          >
            {edit.section}
          </span>
          {edit.current === null && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
              missing
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!isDeclined && !editing && (
            <button
              onClick={startEditing}
              title="Edit the suggested text"
              className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border hover:bg-muted transition-colors"
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
          {isPending && !editing && (
            <>
              <button
                onClick={() => onApprove(edit.id)}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-600 text-white hover:bg-green-700 transition-colors"
              >
                <Check className="h-3 w-3" /> Approve
              </button>
              <button
                onClick={() => onDecline(edit.id)}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border hover:bg-muted transition-colors"
              >
                Decline
              </button>
            </>
          )}
          {isApproved && !editing && (
            <button
              onClick={() => onDecline(edit.id)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Undo
            </button>
          )}
          {isDeclined && !editing && (
            <button
              onClick={() => onApprove(edit.id)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Restore
            </button>
          )}
        </div>
      </div>
      {/* Diff / editor */}
      {!isDeclined && (
        <div className="divide-y text-xs font-mono">
          {edit.current !== null && (
            <div className="px-3 py-2 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 whitespace-pre-wrap leading-relaxed">
              <span className="select-none mr-1 opacity-60">−</span>
              {edit.current}
            </div>
          )}
          {editing ? (
            <div className="bg-green-50 dark:bg-green-950/20">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    saveEditing();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEditing();
                  }
                }}
                autoFocus
                rows={Math.max(3, Math.min(20, draft.split("\n").length + 1))}
                className="w-full px-3 py-2 bg-transparent text-green-800 dark:text-green-200 font-mono text-xs leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-green-500/50"
                placeholder="Edit the suggested text…"
              />
              <div className="flex items-center justify-end gap-1 px-2 py-1 border-t border-green-200/50 dark:border-green-800/40 bg-green-50/60 dark:bg-green-950/30">
                <span className="text-[10px] text-muted-foreground mr-auto pl-1">
                  ⌘/Ctrl+Enter to save · Esc to cancel
                </span>
                <button
                  onClick={cancelEditing}
                  className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border hover:bg-muted transition-colors"
                >
                  <X className="h-3 w-3" /> Cancel
                </button>
                <button
                  onClick={saveEditing}
                  disabled={draft.trim().length === 0}
                  className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Check className="h-3 w-3" /> Save
                </button>
              </div>
            </div>
          ) : (
            <div className="px-3 py-2 bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-300 whitespace-pre-wrap leading-relaxed">
              <span className="select-none mr-1 opacity-60">+</span>
              {edit.suggested}
            </div>
          )}
        </div>
      )}
      {/* Reasoning */}
      {!isDeclined && (
        <div className="px-3 py-2 text-xs text-muted-foreground italic border-t">
          {edit.reasoning}
        </div>
      )}
    </div>
  );
}

// ── Resolvable list ──────────────────────────────────────────────────────────
// Renders the union of `initial` and `current`, marking items missing from
// `current` as resolved (strikethrough). Used for both clarifying questions
// and ambiguities so the engineer can see what was answered without losing
// the original list.

function ResolvableList({
  title,
  initial,
  current,
  icon,
  highlight,
}: {
  title: string;
  initial: string[];
  current: string[];
  icon: React.ReactNode;
  highlight?: boolean;
}) {
  const merged: { text: string; resolved: boolean }[] = [];
  const seen = new Set<string>();
  for (const text of initial) {
    if (seen.has(text)) continue;
    seen.add(text);
    merged.push({ text, resolved: !current.includes(text) });
  }
  for (const text of current) {
    if (seen.has(text)) continue;
    seen.add(text);
    merged.push({ text, resolved: false });
  }
  if (merged.length === 0) return null;

  const remaining = merged.filter((m) => !m.resolved).length;
  const resolved = merged.length - remaining;

  return (
    <div
      className={`border rounded-md overflow-hidden ${highlight ? "animate-update-glow ring-1 ring-primary/40" : ""}`}
    >
      <div className="px-3 py-2 bg-muted/30 flex items-center gap-2 text-sm font-medium">
        {icon}
        <span>{title}</span>
        <span className="text-xs font-normal text-muted-foreground ml-auto">
          {resolved > 0
            ? `${resolved} resolved · ${remaining} open`
            : `${remaining} open`}
        </span>
      </div>
      <ul className="divide-y">
        {merged.map((item, i) => (
          <li
            key={i}
            className={`px-3 py-2 text-sm leading-relaxed ${
              item.resolved
                ? "line-through text-muted-foreground"
                : "text-foreground"
            }`}
          >
            {i + 1}. {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilesReadPanel({ files }: { files: string[] }) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  return (
    <div className="border rounded-md overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2 flex items-center justify-between text-sm bg-muted/20 hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <FileCode className="h-4 w-4" />
          <span>
            {files.length} file{files.length !== 1 ? "s" : ""} read from
            codebase
          </span>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <ul className="divide-y">
          {files.map((f, i) => (
            <li
              key={i}
              className="px-3 py-1.5 text-xs font-mono text-muted-foreground"
            >
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface GroomingPanelProps {
  data: GroomingOutput;
  baseline?: GroomingOutput | null;
  descriptionSections?: DescriptionSection[];
  description?: string | null;
  stepsToReproduce?: string | null;
  observedBehavior?: string | null;
  expectedBehavior?: string | null;
  suggestedEdits: SuggestedEdit[];
  clarifyingQuestions: string[];
  clarifyingQuestionsInitial: string[];
  ambiguitiesInitial: string[];
  highlights: { editIds: string[]; questions: boolean; ambiguities: boolean };
  showHighlights: boolean;
  onToggleHighlights: () => void;
  filesRead: string[];
  onApproveEdit: (id: string) => void;
  onDeclineEdit: (id: string) => void;
  onEditSuggested: (id: string, newSuggested: string) => void;
  onUpdateJira: () => void;
  jiraUpdateStatus: "idle" | "saving" | "saved" | "error";
  jiraUpdateError: string;
}

function GroomingPanel({
  data,
  baseline,
  descriptionSections,
  description,
  stepsToReproduce,
  observedBehavior,
  expectedBehavior,
  suggestedEdits,
  clarifyingQuestions,
  clarifyingQuestionsInitial,
  ambiguitiesInitial,
  highlights,
  showHighlights,
  onToggleHighlights,
  filesRead,
  onApproveEdit,
  onDeclineEdit,
  onEditSuggested,
  onUpdateJira,
  jiraUpdateStatus,
  jiraUpdateError,
}: GroomingPanelProps) {
  const hasDiff = baseline != null;

  const relevantItems = hasDiff
    ? diffStringArrays(
        baseline!.relevant_areas.map((a) => `${a.area} — ${a.reason}`),
        data.relevant_areas.map((a) => `${a.area} — ${a.reason}`),
      )
    : data.relevant_areas.map((a) => ({
        text: `${a.area} — ${a.reason}`,
        status: "unchanged" as const,
      }));

  const depItems = hasDiff
    ? diffStringArrays(baseline!.dependencies, data.dependencies)
    : data.dependencies.map((t) => ({ text: t, status: "unchanged" as const }));

  const summaryChanged =
    hasDiff && baseline!.ticket_summary !== data.ticket_summary;

  const pendingCount = suggestedEdits.filter(
    (e) => e.status === "pending",
  ).length;
  const approvedCount = suggestedEdits.filter(
    (e) => e.status === "approved",
  ).length;

  return (
    <div className="space-y-3">
      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="secondary">{data.ticket_type}</Badge>
        <Badge
          variant={
            data.estimated_complexity === "high"
              ? "destructive"
              : data.estimated_complexity === "medium"
                ? "secondary"
                : "outline"
          }
        >
          {data.estimated_complexity} complexity
        </Badge>
        {approvedCount > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 font-medium">
            {approvedCount} approved
          </span>
        )}
        {pendingCount > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 font-medium">
            {pendingCount} pending review
          </span>
        )}
      </div>

      {/* Summary */}
      <div
        className={`rounded px-2 py-1 -mx-2 ${summaryChanged ? "bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800" : ""}`}
      >
        <p className="text-sm leading-relaxed">{data.ticket_summary}</p>
        {summaryChanged && (
          <p className="text-xs text-muted-foreground line-through mt-0.5">
            {baseline!.ticket_summary}
          </p>
        )}
      </div>

      {/* Highlights toggle — shows when there is anything to highlight */}
      {(highlights.editIds.length > 0 ||
        highlights.questions ||
        highlights.ambiguities) && (
        <div className="flex items-center justify-end">
          <button
            onClick={onToggleHighlights}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
            title={
              showHighlights
                ? "Hide the update highlights"
                : "Show the update highlights"
            }
          >
            {showHighlights ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            {showHighlights ? "Hide highlights" : "Show highlights"}
          </button>
        </div>
      )}

      {/* Open items — clarifying questions + ambiguities (with strike-through
          when resolved through chat) */}
      <ResolvableList
        title="Clarifying Questions"
        initial={clarifyingQuestionsInitial}
        current={clarifyingQuestions}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        highlight={showHighlights && highlights.questions}
      />
      <ResolvableList
        title="Ambiguities"
        initial={ambiguitiesInitial}
        current={data.ambiguities}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        highlight={showHighlights && highlights.ambiguities}
      />

      {/* JIRA description sections */}
      {(descriptionSections?.length || description) && (
        <DescriptionSectionsPanel
          sections={descriptionSections ?? []}
          fallbackDescription={description}
        />
      )}

      {/* Bug-specific custom fields */}
      {(stepsToReproduce || observedBehavior || expectedBehavior) && (
        <div className="border rounded-md overflow-hidden divide-y">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <Bug className="h-4 w-4 text-muted-foreground" />
            Bug Details
          </div>
          {stepsToReproduce && (
            <CollapsibleSection
              heading="Steps to Reproduce"
              content={stepsToReproduce}
            />
          )}
          {observedBehavior && (
            <CollapsibleSection
              heading="Observed Behavior"
              content={observedBehavior}
            />
          )}
          {expectedBehavior && (
            <CollapsibleSection
              heading="Expected Behavior"
              content={expectedBehavior}
            />
          )}
        </div>
      )}

      {/* Suggested edits — the heart of the new grooming flow */}
      {suggestedEdits.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Suggested ticket improvements
          </p>
          {suggestedEdits.map((edit) => (
            <SuggestedEditCard
              key={edit.id}
              edit={edit}
              onApprove={onApproveEdit}
              onDecline={onDeclineEdit}
              onEdit={onEditSuggested}
              highlighted={
                showHighlights && highlights.editIds.includes(edit.id)
              }
            />
          ))}
          {/* Update JIRA — lives here, below the edits */}
          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              variant={approvedCount > 0 ? "default" : "outline"}
              className="gap-1.5"
              onClick={onUpdateJira}
              disabled={jiraUpdateStatus === "saving" || approvedCount === 0}
              title={
                approvedCount === 0
                  ? "Approve at least one suggested edit first"
                  : `Push ${approvedCount} approved edit${approvedCount !== 1 ? "s" : ""} to JIRA`
              }
            >
              {jiraUpdateStatus === "saving" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5" />
              )}
              Update JIRA{approvedCount > 0 ? ` (${approvedCount})` : ""}
            </Button>
            {jiraUpdateStatus === "saved" && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle2 className="h-3 w-3" /> Saved to JIRA
              </span>
            )}
            {jiraUpdateStatus === "error" && (
              <span
                className="text-xs text-orange-600 leading-tight"
                title={jiraUpdateError}
              >
                {jiraUpdateError.startsWith("Saved.")
                  ? jiraUpdateError
                  : "Error saving — check console"}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Standard grooming analysis */}
      <DiffedCollapsibleList
        title="Relevant Areas"
        items={relevantItems}
        icon={<FileCode className="h-4 w-4 text-muted-foreground" />}
        hasChanges={relevantItems.some((i) => i.status !== "unchanged")}
      />
      <DiffedCollapsibleList
        title="Dependencies"
        items={depItems}
        hasChanges={depItems.some((i) => i.status !== "unchanged")}
      />
      {data.grooming_notes && (
        <p className="text-sm text-muted-foreground italic">
          {data.grooming_notes}
        </p>
      )}

      {/* Files read from the codebase */}
      <FilesReadPanel files={filesRead} />
    </div>
  );
}

function ImpactPanel({ data }: { data: ImpactOutput }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <RiskBadge level={data.risk_level} />
        <p className="text-sm text-muted-foreground">
          {data.risk_justification}
        </p>
      </div>
      <CollapsibleList title="Affected Areas" items={data.affected_areas} />
      <CollapsibleList
        title="Potential Regressions"
        items={data.potential_regressions}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
      />
      <CollapsibleList
        title="Cross-cutting Concerns"
        items={data.cross_cutting_concerns}
      />
      <CollapsibleList
        title="Files Needing Consistent Updates"
        items={data.files_needing_consistent_updates}
        icon={<FileCode className="h-4 w-4 text-muted-foreground" />}
      />
      {data.recommendations && (
        <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30 px-3 py-2">
          <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-1">
            Recommendations
          </p>
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {data.recommendations}
          </p>
        </div>
      )}
    </div>
  );
}

function PlanPanel({ data }: { data: ImplementationPlan }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium leading-relaxed">{data.summary}</p>
      {data.files.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <FileCode className="h-4 w-4 text-muted-foreground" /> Files (
            {data.files.length})
          </div>
          <div className="divide-y">
            {data.files.map((f, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-0.5">
                  <code className="text-xs font-mono">{f.path}</code>
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      f.action === "create"
                        ? "bg-green-100 text-green-700"
                        : f.action === "delete"
                          ? "bg-red-100 text-red-700"
                          : "bg-blue-100 text-blue-700"
                    }`}
                  >
                    {f.action}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      <CollapsibleList
        title="Order of Operations"
        items={data.order_of_operations}
      />
      <CollapsibleList
        title="Edge Cases to Handle"
        items={data.edge_cases}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
      />
      <CollapsibleList
        title="Do NOT Change"
        items={data.do_not_change}
        icon={<Shield className="h-4 w-4 text-red-500" />}
      />
      <CollapsibleList title="Assumptions" items={data.assumptions} />
      <CollapsibleList
        title="Open Questions"
        items={data.open_questions}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
      />
    </div>
  );
}

function BuildVerificationPanel({ result }: { result: BuildCheckResult }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div className={cn(
      "border rounded-md overflow-hidden",
      result.build_passed
        ? "border-green-300 dark:border-green-800"
        : "border-red-300 dark:border-red-800",
    )}>
      <div className={cn(
        "px-3 py-2 text-sm font-medium flex items-center gap-2",
        result.build_passed
          ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300"
          : "bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300",
      )}>
        {result.build_passed ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <AlertTriangle className="h-4 w-4" />
        )}
        Build {result.build_passed ? "passed" : "failed"} —{" "}
        <code className="text-xs font-mono">{result.build_command}</code>
        <span className="ml-auto text-xs font-normal opacity-70">
          {result.attempts.length} attempt{result.attempts.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="divide-y">
        {result.attempts.map((a, i) => (
          <div key={i} className="px-3 py-2">
            <button
              className="w-full flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(expanded === i ? null : i)}
            >
              <span className={cn(
                "font-mono px-1 rounded text-[10px]",
                a.exit_code === 0
                  ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                  : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
              )}>
                exit {a.exit_code}
              </span>
              <span>Attempt {a.attempt}</span>
              {a.files_written.length > 0 && (
                <span className="text-blue-600 dark:text-blue-400">
                  → fixed {a.files_written.length} file{a.files_written.length !== 1 ? "s" : ""}
                </span>
              )}
              <ChevronDown className={cn("h-3 w-3 ml-auto transition-transform", expanded === i && "rotate-180")} />
            </button>
            {expanded === i && (
              <pre className="mt-2 text-xs font-mono bg-muted/30 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                {a.output}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ImplementationStatusContent({
  data,
  buildVerification,
}: {
  data: ImplementationOutput;
  buildVerification: BuildCheckResult | null;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">{data.summary}</p>
      {buildVerification && <BuildVerificationPanel result={buildVerification} />}
      {data.files_changed.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <FileCode className="h-4 w-4 text-muted-foreground" /> Files changed
            ({data.files_changed.length})
          </div>
          <div className="divide-y">
            {data.files_changed.map((f, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-0.5">
                  <code className="text-xs font-mono">{f.path}</code>
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      f.action === "created"
                        ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                        : f.action === "deleted"
                          ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                          : "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                    }`}
                  >
                    {f.action}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{f.summary}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {data.deviations.length > 0 && (
        <div className="border border-amber-300 rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/30 text-sm font-medium flex items-center gap-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" /> Deviations from plan (
            {data.deviations.length})
          </div>
          <div className="divide-y">
            {data.deviations.map((d, i) => (
              <p key={i} className="px-3 py-2 text-sm text-muted-foreground">
                {d}
              </p>
            ))}
          </div>
        </div>
      )}
      {data.skipped.length > 0 && (
        <CollapsibleList
          title={`Skipped files (${data.skipped.length})`}
          items={data.skipped}
          icon={<AlertTriangle className="h-4 w-4 text-red-500" />}
        />
      )}
    </div>
  );
}

interface FileDiffState {
  original: string;
  modified: string;
  loading: boolean;
  saving: boolean;
  saved: boolean;
}

function ImplementationDiffContent({ data }: { data: ImplementationOutput }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(
    data.files_changed.length > 0 ? data.files_changed[0].path : null,
  );
  const [fileStates, setFileStates] = useState<Record<string, FileDiffState>>({});
  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);

  useEffect(() => {
    if (!selectedFile) return;
    if (fileStates[selectedFile]) return;
    setFileStates((prev) => ({
      ...prev,
      [selectedFile]: { original: "", modified: "", loading: true, saving: false, saved: false },
    }));
    Promise.all([
      getFileAtBase(selectedFile).catch(() => ""),
      readRepoFile(selectedFile).catch(() => ""),
    ]).then(([original, modified]) => {
      setFileStates((prev) => ({
        ...prev,
        [selectedFile]: { original, modified, loading: false, saving: false, saved: false },
      }));
    });
  }, [selectedFile]);

  const handleSave = useCallback(async () => {
    if (!selectedFile) return;
    const editor = editorRef.current;
    if (!editor) return;
    const modifiedModel = editor.getModifiedEditor().getModel();
    if (!modifiedModel) return;
    const content = modifiedModel.getValue();
    setFileStates((prev) => ({
      ...prev,
      [selectedFile]: { ...prev[selectedFile], saving: true, saved: false },
    }));
    try {
      await writeRepoFile(selectedFile, content);
      setFileStates((prev) => ({
        ...prev,
        [selectedFile]: { ...prev[selectedFile], modified: content, saving: false, saved: true },
      }));
      setTimeout(() => {
        setFileStates((prev) => ({
          ...prev,
          [selectedFile]: { ...prev[selectedFile], saved: false },
        }));
      }, 2000);
    } catch {
      setFileStates((prev) => ({
        ...prev,
        [selectedFile]: { ...prev[selectedFile], saving: false },
      }));
    }
  }, [selectedFile]);

  const currentState = selectedFile ? fileStates[selectedFile] : null;

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex flex-wrap gap-1">
        {data.files_changed.map((f) => (
          <button
            key={f.path}
            onClick={() => setSelectedFile(f.path)}
            className={cn(
              "text-xs font-mono px-2 py-1 rounded border truncate max-w-[240px]",
              selectedFile === f.path
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted/40 text-muted-foreground border-transparent hover:border-border",
            )}
            title={f.path}
          >
            {f.path.split("/").pop()}
          </button>
        ))}
      </div>
      {selectedFile && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <code className="truncate">{selectedFile}</code>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs px-2 ml-2 shrink-0"
            onClick={handleSave}
            disabled={!currentState || currentState.loading || currentState.saving}
          >
            {currentState?.saving ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : currentState?.saved ? (
              <Check className="h-3 w-3 mr-1 text-green-500" />
            ) : null}
            {currentState?.saved ? "Saved" : "Save"}
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 rounded border overflow-hidden">
        {!selectedFile ? (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            No files changed
          </div>
        ) : currentState?.loading ? (
          <div className="flex items-center justify-center h-32 gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading diff…
          </div>
        ) : (
          <DiffEditor
            height="100%"
            original={currentState?.original ?? ""}
            modified={currentState?.modified ?? ""}
            language={getLanguageForPath(selectedFile)}
            theme="vs-dark"
            options={{
              readOnly: false,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
            }}
            onMount={(editor) => {
              editorRef.current = editor;
            }}
          />
        )}
      </div>
    </div>
  );
}

function getLanguageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    rs: "rust", py: "python", go: "go",
    json: "json", toml: "toml", yaml: "yaml", yml: "yaml",
    md: "markdown", css: "css", html: "html",
    sh: "shell", bash: "shell",
  };
  return map[ext] ?? "plaintext";
}

function ImplementationPanel({
  data,
  tab,
  buildVerification,
}: {
  data: ImplementationOutput;
  tab: "status" | "diff";
  buildVerification: BuildCheckResult | null;
}) {
  return tab === "status" ? (
    <ImplementationStatusContent data={data} buildVerification={buildVerification} />
  ) : (
    <ImplementationDiffContent data={data} />
  );
}

function TestsPanel({ data }: { data: TestOutput }) {
  const filesWritten = data.files_written ?? [];
  const edgeCases = data.edge_cases_covered ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">{data.summary}</p>
      {filesWritten.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <TestTube className="h-4 w-4 text-muted-foreground" /> Test Files
            Written ({filesWritten.length})
          </div>
          <div className="divide-y">
            {filesWritten.map((f: TestFileWritten, i: number) => (
              <div key={i} className="px-3 py-2">
                <p className="text-xs font-mono text-foreground mb-0.5">
                  {f.path}
                </p>
                <p className="text-sm text-muted-foreground">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      <CollapsibleList
        title="Edge Cases Covered"
        items={edgeCases}
      />
      {data.coverage_notes && (
        <p className="text-sm text-muted-foreground italic">
          {data.coverage_notes}
        </p>
      )}
    </div>
  );
}

function ReviewPanel({ data }: { data: PlanReviewOutput }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ConfidenceBadge level={data.confidence} />
        <p className="text-sm text-muted-foreground">{data.summary}</p>
      </div>
      {data.findings.length > 0 && (
        <div className="space-y-2">
          {data.findings.map((f, i) => (
            <div key={i} className="border rounded-md px-3 py-2">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    f.severity === "blocking"
                      ? "bg-red-100 text-red-700"
                      : f.severity === "non_blocking"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {f.severity}
                </span>
                <span className="text-sm font-medium">{f.area}</span>
              </div>
              <p className="text-sm text-muted-foreground">{f.feedback}</p>
            </div>
          ))}
        </div>
      )}
      <CollapsibleList
        title="Address Before Starting"
        items={data.things_to_address}
        icon={<AlertTriangle className="h-4 w-4 text-red-500" />}
      />
      <CollapsibleList
        title="Keep in Mind While Implementing"
        items={data.things_to_watch}
      />
    </div>
  );
}

interface PrPanelProps {
  data: PrDescriptionOutput;
  createdPr: BitbucketPr | null;
  submitStatus: "idle" | "squashing" | "pushing" | "creating" | "error";
  submitError: string | null;
  onSubmit: () => void;
}

function PrPanel({
  data,
  createdPr,
  submitStatus,
  submitError,
  onSubmit,
}: PrPanelProps) {
  const mock = isMockMode();
  const submitting =
    submitStatus === "squashing" ||
    submitStatus === "pushing" ||
    submitStatus === "creating";
  const submitLabel: Record<PrPanelProps["submitStatus"], string> = mock
    ? {
        idle: "Skip PR creation (mock mode)",
        squashing: "Working…",
        pushing: "Working…",
        creating: "Working…",
        error: "Retry",
      }
    : {
        idle: "Create Draft PR on Bitbucket",
        squashing: "Squashing commits…",
        pushing: "Pushing branch…",
        creating: "Creating PR on Bitbucket…",
        error: "Retry: Create Draft PR",
      };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground font-medium mb-1">
            PR Title
          </p>
          <p className="text-sm font-semibold">{data.title}</p>
        </div>
        <CopyButton
          text={`${data.title}\n\n${data.description}`}
          label="Copy PR"
        />
      </div>
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-1">
          Description
        </p>
        <pre className="text-sm font-sans leading-relaxed whitespace-pre-wrap bg-muted/30 rounded-md p-3 max-h-80 overflow-y-auto">
          {data.description}
        </pre>
      </div>

      {/* Submission area — squash + push + draft PR creation on Bitbucket. */}
      {createdPr ? (
        createdPr.url ? (
          <div className="border rounded-md p-3 bg-emerald-500/5 border-emerald-500/30 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Draft PR created on Bitbucket
            </div>
            <p className="text-xs text-muted-foreground">
              Created with no reviewers so nobody is notified. Add reviewers
              from the Bitbucket UI when you're ready for real review.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => createdPr.url && openUrl(createdPr.url)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open PR #{createdPr.id}
            </Button>
          </div>
        ) : (
          <div className="border rounded-md p-3 bg-muted/30 space-y-1.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              PR creation skipped (mock mode)
            </div>
            <p className="text-xs text-muted-foreground">
              Nothing was pushed to origin and no PR was opened on Bitbucket.
              You can proceed to the retrospective.
            </p>
          </div>
        )
      ) : (
        <div className="border rounded-md p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {mock
              ? "Mock mode is on — clicking below will mark the PR stage complete without pushing anything to origin or opening a PR on Bitbucket."
              : "Submitting will squash your implementation + tests commits into one, push the feature branch to origin, and open a PR on Bitbucket with no reviewers attached — use the Bitbucket UI to add reviewers when you're ready."}
          </p>
          {submitStatus === "error" && submitError && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded p-2">
              {submitError}
            </div>
          )}
          <Button
            onClick={onSubmit}
            disabled={submitting}
            className="gap-2"
            size="sm"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <GitPullRequest className="h-4 w-4" />
            )}
            {submitLabel[submitStatus]}
          </Button>
        </div>
      )}
    </div>
  );
}

interface RetroPanelProps {
  data: RetrospectiveOutput;
  onSaveToKb: (entries: RetroKbEntry[]) => void;
  kbSaved: boolean;
}

function RetroPanel({ data, onSaveToKb, kbSaved }: RetroPanelProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">{data.summary}</p>
      <CollapsibleList
        title="What Went Well"
        items={data.what_went_well}
        icon={<CheckCircle2 className="h-4 w-4 text-green-500" />}
      />
      <CollapsibleList
        title="What Could Improve"
        items={data.what_could_improve}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
      />
      <CollapsibleList
        title="Patterns Identified"
        items={data.patterns_identified}
      />
      {data.agent_skill_suggestions.length > 0 && (
        <CollapsibleList
          title="Agent Skill Suggestions"
          items={data.agent_skill_suggestions.map(
            (s) => `${s.skill}: ${s.suggestion}`,
          )}
          icon={<Sparkles className="h-4 w-4 text-purple-500" />}
        />
      )}
      {data.knowledge_base_entries.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <BookOpen className="h-4 w-4 text-muted-foreground" />
              Knowledge Base Entries ({data.knowledge_base_entries.length})
            </div>
            {!kbSaved ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => onSaveToKb(data.knowledge_base_entries)}
              >
                Save to KB
              </Button>
            ) : (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <Check className="h-3 w-3" /> Saved
              </span>
            )}
          </div>
          <div className="divide-y">
            {data.knowledge_base_entries.map((e, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-0.5">
                  <Badge variant="outline" className="text-xs">
                    {e.type}
                  </Badge>
                  <span className="text-sm font-medium">{e.title}</span>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {e.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Stage approval row (proceed gate — chat moved to right panel) ─────────────

const NEXT_STAGE_LABEL: Partial<Record<Stage, string>> = {
  grooming: "Proceed to Impact Analysis",
  impact: "Proceed to Triage",
  plan: "Proceed to Implementation",
  implementation: "Proceed to Test Suggestions",
  tests: "Proceed to Code Review",
  review: "Proceed to PR Description",
  pr: "Proceed to Retrospective",
  retro: "Mark Pipeline Complete",
};

function StreamingLoader({
  label,
  streamText,
}: {
  label: string;
  streamText: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {label}
      </div>
      {streamText && (
        <pre className="text-xs font-mono bg-muted/50 rounded p-3 whitespace-pre-wrap overflow-auto max-h-96 border">
          {streamText}
        </pre>
      )}
    </div>
  );
}

// ── Triage panel ─────────────────────────────────────────────────────────────
// Living-document layout: the latest agent proposal sits at the top as the
// "current plan", and prior rounds collapse into a Revisions timeline so the
// engineer can see how the plan got here without scrolling a chat transcript.
// Live-streams the agent's in-progress reply at the top while a follow-up is
// being processed.

interface TriageRevision {
  /** The user's clarification that triggered this revision. */
  clarification: string;
  /** The agent's proposal that was current *before* this clarification was sent. */
  previousProposal: string;
}

function buildRevisions(
  history: TriageMessage[],
  turns: TriageTurnOutput[],
): {
  current: string | null;
  revisions: TriageRevision[];
} {
  if (turns.length === 0) return { current: null, revisions: [] };
  const current = turns[turns.length - 1].proposal;

  // Skip the seed "Please analyse this ticket…" message and pair each user
  // clarification with the proposal that was current right before it was sent.
  const userTurns = history
    .slice(history[0]?.role === "user" ? 1 : 0)
    .filter((m) => m.role === "user");

  const revisions: TriageRevision[] = [];
  for (let i = 0; i < userTurns.length; i++) {
    const prior = turns[i];
    if (!prior) continue;
    revisions.push({
      clarification: userTurns[i].content,
      previousProposal: prior.proposal,
    });
  }
  return { current, revisions };
}

function summarizeClarification(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 110 ? oneLine.slice(0, 107) + "…" : oneLine;
}

function RevisionRow({ revision, index }: { revision: TriageRevision; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border rounded-md overflow-hidden bg-card/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
      >
        <span className="text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          v{index + 1}
        </span>
        <span className="text-xs text-foreground/80 flex-1 truncate">
          {summarizeClarification(revision.clarification)}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t divide-y">
          <div className="px-3 py-2 bg-muted/20">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">
              Your clarification
            </p>
            <p className="text-xs leading-relaxed whitespace-pre-wrap">{revision.clarification}</p>
          </div>
          <div className="px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">
              Previous proposal (replaced)
            </p>
            <div className="opacity-70">
              <MarkdownBlock text={revision.previousProposal} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TriagePanel({
  history,
  turns,
  streamText,
}: {
  history: TriageMessage[];
  turns: TriageTurnOutput[];
  streamText: string;
}) {
  const { current, revisions } = buildRevisions(history, turns);
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  return (
    <div className="space-y-4">
      {/* Current proposal — the headline */}
      <div className="rounded-md border bg-card/40">
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/20">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">
              Current proposed approach
            </span>
            {revisions.length > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                v{revisions.length + 1}
              </span>
            )}
          </div>
          {streamText && (
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Updating
            </span>
          )}
        </div>
        <div className="px-4 py-3">
          {streamText ? (
            <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-muted-foreground">
              {streamText}
            </pre>
          ) : current ? (
            <MarkdownBlock text={current} />
          ) : (
            <p className="text-sm text-muted-foreground italic">
              Waiting for the agent's first proposal…
            </p>
          )}
        </div>
      </div>

      {/* Revisions timeline */}
      {revisions.length > 0 && (
        <div>
          <button
            onClick={() => setRevisionsOpen((v) => !v)}
            className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
          >
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform ${revisionsOpen ? "rotate-90" : ""}`}
            />
            Revisions ({revisions.length})
          </button>
          {revisionsOpen && (
            <div className="mt-2 space-y-2">
              {revisions.map((rev, i) => (
                <RevisionRow key={i} revision={rev} index={i} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface StageApprovalRowProps {
  stage: Stage;
  onProceed: () => void;
  proceeding: boolean;
  hasBlockingIssues?: boolean;
  onRetry?: () => void;
  disabledReason?: string;
}

function StageApprovalRow({
  stage,
  onProceed,
  proceeding,
  hasBlockingIssues,
  onRetry,
  disabledReason,
}: StageApprovalRowProps) {
  const nextLabel = NEXT_STAGE_LABEL[stage] ?? "Proceed";
  const disabled = proceeding || !!disabledReason;
  return (
    <div className="mt-5 border-t pt-4 flex items-center justify-between gap-3">
      {hasBlockingIssues && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Blocking issues present — proceeding not recommended
        </p>
      )}
      {disabledReason && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          {disabledReason}
        </p>
      )}
      {onRetry && (
        <Button
          onClick={onRetry}
          disabled={proceeding}
          variant="outline"
          size="sm"
          className="gap-2"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Re-run
        </Button>
      )}
      <Button
        onClick={onProceed}
        disabled={disabled}
        variant={hasBlockingIssues ? "outline" : "default"}
        className="gap-2 ml-auto"
      >
        {proceeding ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        {hasBlockingIssues ? `Proceed anyway: ${nextLabel}` : nextLabel}
      </Button>
    </div>
  );
}

// ── Persistent chat panel (right side of the split layout) ────────────────────

interface PipelineChatPanelProps {
  grooming: GroomingOutput | null;
  groomingChat: TriageMessage[];
  triageHistory: TriageMessage[];
  checkpointChats: Partial<Record<Stage, TriageMessage[]>>;
  currentStage: Stage;
  pendingApproval: Stage | null;
  toolRequests: ToolRequest[];
  onDismissToolRequest: (id: string) => void;
  onSavedToolRequest: (id: string) => void;
  chatInput: string;
  onChatInputChange: (v: string) => void;
  /** Send text through the unified pipeline send function. */
  onSend: (text: string) => void;
  onCancel: () => void;
  onFinalizePlan: () => void;
  sending: boolean;
  finalizing: boolean;
  proceeding: boolean;
  streamingText: string;
  /** Slash-command set. Built by the caller based on which stage is active. */
  commands: SlashCommand[];
}

const CHAT_STAGE_LABEL: Partial<Record<Stage, string>> = {
  grooming: "Grooming",
  triage: "Triage",
  impact: "Impact Analysis",
  plan: "Implementation Plan",
  implementation: "Implementation",
  tests: "Test Suggestions",
  review: "Code Review",
  pr: "PR Description",
  retro: "Retrospective",
};

function PipelineChatPanel({
  grooming,
  groomingChat,
  triageHistory,
  checkpointChats,
  currentStage,
  pendingApproval,
  toolRequests,
  onDismissToolRequest,
  onSavedToolRequest,
  chatInput,
  onChatInputChange,
  onSend,
  onCancel,
  onFinalizePlan,
  sending,
  finalizing,
  proceeding,
  streamingText,
  commands,
}: PipelineChatPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [groomingChat, triageHistory, checkpointChats, sending]);

  useEffect(() => {
    if (!sending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || (e.key === "c" && e.ctrlKey)) {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sending, onCancel]);

  // Build unified message thread with stage dividers
  const sections: Array<{ stage: Stage; messages: TriageMessage[] }> = [];
  if (groomingChat.length > 0)
    sections.push({ stage: "grooming", messages: groomingChat });
  if (triageHistory.length > 0) {
    // Drop only the seeded "Please analyse this ticket…" user prompt — the
    // assistant turns now contain just the chat-friendly message + enumerated
    // questions (the full proposal lives in the middle panel), so they belong
    // in the chat thread.
    const turnsForChat = triageHistory.slice(
      triageHistory[0]?.role === "user" ? 1 : 0,
    );
    if (turnsForChat.length > 0) {
      sections.push({ stage: "triage", messages: turnsForChat });
    }
  }
  for (const stage of [
    "impact",
    "plan",
    "implementation",
    "tests",
    "review",
    "pr",
    "retro",
  ] as Stage[]) {
    const msgs = checkpointChats[stage];
    if (msgs && msgs.length > 0) sections.push({ stage, messages: msgs });
  }

  // Determine if input is active
  const isGroomingActive =
    pendingApproval === "grooming" ||
    (currentStage === "grooming" && grooming !== null);
  const isCheckpointActive =
    pendingApproval !== null && pendingApproval !== "grooming";
  const isTriageActive = currentStage === "triage" && pendingApproval === null;
  const inputActive = isGroomingActive || isCheckpointActive || isTriageActive;
  const agentRunning =
    !inputActive && currentStage !== "select" && currentStage !== "complete";

  const placeholder = isGroomingActive
    ? "Suggest changes to the ticket or ask questions…"
    : isTriageActive
      ? "Respond to the agent's proposal or provide clarification…"
      : isCheckpointActive
        ? "Ask about these findings…"
        : agentRunning
          ? "Agent is running…"
          : "Pipeline complete";

  const showFinalize = isTriageActive && triageHistory.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0 border-l bg-background/40">
      {/* Panel header */}
      <div className="shrink-0 px-4 py-2.5 border-b flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Agent Chat
        </p>
        {agentRunning && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Running…
          </div>
        )}
      </div>

      {/* Chat thread — scrollable */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-1">
        {sections.length === 0 && !sending && (
          <p className="text-xs text-muted-foreground italic text-center pt-6">
            No messages yet. The conversation will appear here once the grooming
            stage completes.
          </p>
        )}

        {sections.map(({ stage, messages }) => (
          <div key={stage}>
            {/* Stage divider */}
            <div className="flex items-center gap-2 py-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground px-1">
                {CHAT_STAGE_LABEL[stage] ?? stage}
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="space-y-2">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">
                      {msg.role === "assistant" && stage === "grooming"
                        ? msg.content
                            .replace(/```json[\s\S]*?```/g, "")
                            .trim() || msg.content
                        : msg.content}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Tool requests */}
        {toolRequests
          .filter((r) => !r.dismissed)
          .map((r) => (
            <ToolRequestCard
              key={r.id}
              request={r}
              onDismiss={onDismissToolRequest}
              onSaved={onSavedToolRequest}
            />
          ))}

        {/* Sending indicator — shows streaming text as it arrives, falls back to spinner */}
        {sending && (
          <div className="flex justify-start pt-1">
            {streamingText ? (
              <pre className="text-xs font-mono bg-muted rounded-lg px-3 py-2 whitespace-pre-wrap max-w-full overflow-x-auto text-foreground">
                {streamingText}
              </pre>
            ) : (
              <div className="bg-muted rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area — pinned to bottom */}
      <div className="shrink-0 px-4 pb-4 pt-2 border-t space-y-2">
        {showFinalize && (
          <Button
            size="sm"
            variant="outline"
            className="w-full gap-2"
            onClick={onFinalizePlan}
            disabled={finalizing || sending}
          >
            {finalizing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finalising
                plan…
              </>
            ) : (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> Finalise Plan
              </>
            )}
          </Button>
        )}
        <SlashCommandInput
          value={chatInput}
          onChange={onChatInputChange}
          onSend={(text) => {
            if (inputActive) onSend(text);
          }}
          commands={commands}
          busy={!inputActive || sending || finalizing || proceeding}
          placeholder={placeholder}
        />
        {sending ? (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">AI is thinking…</p>
            <button
              onClick={onCancel}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <span className="font-mono bg-muted px-1 rounded">Esc</span> cancel
            </button>
          </div>
        ) : inputActive ? (
          <p className="text-xs text-muted-foreground">Enter to send · Shift+Enter for newline</p>
        ) : null}
      </div>
    </div>
  );
}

// ── Ticket selector ───────────────────────────────────────────────────────────

interface TicketSelectorProps {
  sprintIssues: JiraIssue[];
  loading: boolean;
  onSelect: (issue: JiraIssue) => void;
  sessionKeys: Set<string>;
}

function TicketSelector({
  sprintIssues,
  loading,
  onSelect,
  sessionKeys,
}: TicketSelectorProps) {
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<JiraIssue[]>([]);
  const [searching, setSearching] = useState(false);
  const q = search.trim();

  useEffect(() => {
    if (!q) {
      setSearchResults([]);
      return;
    }
    const isKey = /^[A-Z]+-\d+$/i.test(q);
    const jql = isKey
      ? `key = "${q.toUpperCase()}"`
      : `text ~ "${q}" ORDER BY updated DESC`;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        setSearchResults(await searchJiraIssues(jql, 20));
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [q]);

  const list = useMemo(() => {
    if (!q) return sprintIssues;
    return fuzzyFilterIssues(q, mergeIssuesById(sprintIssues, searchResults));
  }, [q, sprintIssues, searchResults]);
  const busy = q ? searching && list.length === 0 : loading;

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <h2 className="text-base font-semibold mb-3">
          Select a Ticket to Implement
        </h2>
        <div className="relative">
          <Input
            placeholder="Fuzzy search by text or key (e.g. PROJ-123)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-4"
          />
        </div>
      </div>

      {busy ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />{" "}
          {q ? "Searching…" : "Loading sprint tickets…"}
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12">
          {q
            ? "No tickets found."
            : "No active sprint tickets assigned to you."}
        </p>
      ) : (
        <div className="space-y-2">
          {!q && (
            <p className="text-xs text-muted-foreground">
              Active sprint — {list.length} ticket{list.length !== 1 ? "s" : ""}{" "}
              assigned to you
            </p>
          )}
          {list.map((issue) => {
            const hasSession = sessionKeys.has(issue.key);
            return (
              <button
                key={issue.id}
                onClick={() => onSelect(issue)}
                className="w-full text-left px-4 py-3 rounded-md border bg-card/60 hover:bg-muted/60 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                  <Badge variant="outline" className="text-xs">
                    {issue.issueType}
                  </Badge>
                  {hasSession && (
                    <Badge
                      variant="secondary"
                      className="text-xs flex items-center gap-1"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse inline-block" />
                      In progress
                    </Badge>
                  )}
                  {issue.storyPoints != null && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {issue.storyPoints}pt
                    </span>
                  )}
                </div>
                <p className="text-sm font-medium leading-snug">
                  {issue.summary}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {issue.status}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Pipeline sidebar ──────────────────────────────────────────────────────────

interface PipelineSidebarProps {
  currentStage: Stage;
  completedStages: Set<Stage>;
  activeStage: Stage;
  pendingApproval: Stage | null;
  onClickStage: (stage: Stage) => void;
}

function PipelineSidebar({
  currentStage,
  completedStages,
  activeStage,
  pendingApproval,
  onClickStage,
}: PipelineSidebarProps) {
  const icons: Record<string, React.ReactNode> = {
    grooming: <BookOpen className="h-3.5 w-3.5" />,
    impact: <Shield className="h-3.5 w-3.5" />,
    triage: <ClipboardList className="h-3.5 w-3.5" />,
    plan: <ClipboardList className="h-3.5 w-3.5" />,
    implementation: <FileCode className="h-3.5 w-3.5" />,
    tests: <TestTube className="h-3.5 w-3.5" />,
    review: <Shield className="h-3.5 w-3.5" />,
    pr: <GitPullRequest className="h-3.5 w-3.5" />,
    retro: <BookOpen className="h-3.5 w-3.5" />,
  };

  return (
    <div className="min-h-0 w-48 shrink-0 overflow-y-auto border-r bg-muted/20 p-3 space-y-1">
      {STAGE_ORDER.map((stage) => {
        const done = completedStages.has(stage);
        const active = activeStage === stage;
        const running =
          currentStage === stage && !done && pendingApproval !== stage;
        const pending = pendingApproval === stage;
        const reachable = done || active || running || pending;
        return (
          <button
            key={stage}
            onClick={() => reachable && onClickStage(stage)}
            disabled={!reachable}
            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-xs transition-colors ${
              active
                ? "bg-primary text-primary-foreground font-medium"
                : pending
                  ? "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 font-medium hover:bg-amber-100 dark:hover:bg-amber-950/50 cursor-pointer"
                  : done
                    ? "text-foreground hover:bg-muted/60 cursor-pointer"
                    : "text-muted-foreground cursor-default opacity-50"
            }`}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            ) : pending ? (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            ) : done ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
            ) : (
              <span className="shrink-0 opacity-60">
                {icons[stage] ?? <Circle className="h-3.5 w-3.5" />}
              </span>
            )}
            <span>{STAGE_LABELS[stage]}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Stage → pipeline step mapping ────────────────────────────────────────────

function stageToStep(stage: Stage): number | undefined {
  if (stage === "select") return undefined;
  const map: Record<Exclude<Stage, "select">, number> = {
    grooming: 0,
    impact: 1,
    triage: 2,
    plan: 2,
    implementation: 3,
    tests: 4,
    review: 5,
    pr: 6,
    retro: 7,
    complete: 7,
  };
  return map[stage];
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function ImplementTicketScreen({
  credStatus,
  onBack,
}: ImplementTicketScreenProps) {
  const claudeAvailable = aiProviderComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  // ── Store bindings (persistent state — survives navigation) ──────────────────
  const {
    selectedIssue,
    currentStage,
    viewingStage,
    completedStages,
    pendingApproval,
    proceeding,
    grooming,
    impact,
    triageHistory,
    triageTurns,
    plan,
    implementation,
    implementationStreamText,
    buildVerification,
    buildCheckStreamText,
    tests,
    review,
    prDescription,
    createdPr,
    prSubmitStatus,
    prSubmitError,
    retrospective,
    kbSaved,
    groomingBlockers,

    groomingEdits,
    clarifyingQuestions,
    clarifyingQuestionsInitial,
    ambiguitiesInitial,
    groomingHighlights,
    showHighlights,
    filesRead,
    groomingChat,
    groomingBaseline,
    jiraUpdateStatus,
    jiraUpdateError,
    groomingProgress,
    groomingStreamText,
    impactStreamText,
    triageStreamText,
    planStreamText,
    testsStreamText,
    reviewStreamText,
    prStreamText,
    retroStreamText,
    checkpointStreamText,
    checkpointChats,
    errors,
    sessions: implementSessions,
  } = useImplementTicketStore();

  const store = useImplementTicketStore.getState;

  // ── Find-in-page search ──────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<"" | "no-match">("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isFind = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f";
      if (isFind) {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.select(), 0);
      } else if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchStatus("");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  function findNext(direction: "forward" | "backward") {
    if (!searchQuery.trim()) return;
    // window.find is non-standard but supported in WebKit/Chromium webviews.
    const found = (window as unknown as {
      find: (
        s: string,
        caseSensitive: boolean,
        backwards: boolean,
        wrap: boolean,
      ) => boolean;
    }).find(searchQuery, false, direction === "backward", true);
    setSearchStatus(found ? "" : "no-match");
  }

  // Auto-resume a stage that was interrupted when the app was closed last session.
  // consumePendingResume() returns the stage once and clears it, so this only fires once.
  useEffect(() => {
    const interrupted = consumePendingResume();
    if (interrupted) {
      store().retryStage(interrupted);
    }
  }, []);

  // Set of issue keys with cached (or active) pipeline sessions
  const sessionKeys = useMemo(
    () =>
      new Set([
        ...implementSessions.keys(),
        ...(selectedIssue ? [selectedIssue.key] : []),
      ]),
    [implementSessions, selectedIssue],
  );

  // ── Ephemeral UI state (local — reset on each visit is fine) ─────────────────
  const [sprintIssues, setSprintIssues] = useState<JiraIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [planFinalizing, setPlanFinalizing] = useState(false);
  const [meridianHeaderVisible, setMeridianHeaderVisible] = useState(false);
  const [splitPct, setSplitPct] = useState(62);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [toolRequests, setToolRequests] = useState<ToolRequest[]>([]);
  const [implementationTab, setImplementationTab] = useState<"status" | "diff">("status");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ── Resizable split pane (percentage-based) ───────────────────────────────────
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMouseMove = (ev: MouseEvent) => {
      const x = ev.clientX - rect.left;
      const pct = Math.min(80, Math.max(30, (x / rect.width) * 100));
      setSplitPct(pct);
    };
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  // ── Backend event listeners — write directly to store ────────────────────────
  // Each listener captures the session ID at event time and drops writes for stale sessions.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    const listenPromise = listen<{ phase: string; message: string }>(
      "grooming-progress",
      (event) => {
        const store = useImplementTicketStore.getState();
        const sessionId = store.activeSessionId;
        if (event.payload.phase === "done") {
          setTimeout(() => {
            if (
              useImplementTicketStore.getState().activeSessionId === sessionId
            ) {
              useImplementTicketStore.getState()._set({ groomingProgress: "" });
            }
          }, 1200);
        } else {
          store._set({ groomingProgress: event.payload.message });
        }
      },
    );

    listenPromise.then((f) => {
      unlistenFn = f;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      } else {
        listenPromise.then((f) => f());
      }
    };
  }, []);

  useEffect(() => {
    const acc = { text: "", sessionId: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let unlistenFn: (() => void) | null = null;
    const listenPromise = listen<{ delta: string }>(
      "grooming-stream",
      (event) => {
        const currentSessionId =
          useImplementTicketStore.getState().activeSessionId;
        if (acc.sessionId !== currentSessionId) {
          acc.text = "";
          acc.sessionId = currentSessionId;
        }
        acc.text += event.payload.delta;
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (
            useImplementTicketStore.getState().activeSessionId === acc.sessionId
          ) {
            useImplementTicketStore
              .getState()
              ._set({ groomingStreamText: acc.text });
          }
        }, 80);
      },
    );

    listenPromise.then((f) => {
      unlistenFn = f;
    });

    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (unlistenFn) {
        unlistenFn();
      } else {
        listenPromise.then((f) => f());
      }
    };
  }, []);

  useEffect(() => {
    const acc = { text: "", sessionId: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let unlistenFn: (() => void) | null = null;
    const listenPromise = listen<{ delta: string }>(
      "implementation-stream",
      (event) => {
        const currentSessionId =
          useImplementTicketStore.getState().activeSessionId;
        if (acc.sessionId !== currentSessionId) {
          acc.text = "";
          acc.sessionId = currentSessionId;
        }
        acc.text += event.payload.delta;
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (
            useImplementTicketStore.getState().activeSessionId === acc.sessionId
          ) {
            useImplementTicketStore
              .getState()
              ._set({ implementationStreamText: acc.text });
          }
        }, 80);
      },
    );

    listenPromise.then((f) => {
      unlistenFn = f;
    });

    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (unlistenFn) {
        unlistenFn();
      } else {
        listenPromise.then((f) => f());
      }
    };
  }, []);

  // Stream listeners for all other pipeline stages — same batched-flush pattern.
  useEffect(() => {
    type StreamKey =
      | "impactStreamText"
      | "triageStreamText"
      | "planStreamText"
      | "testsStreamText"
      | "reviewStreamText"
      | "prStreamText"
      | "retroStreamText"
      | "checkpointStreamText"
      | "buildCheckStreamText";
    const streams: Array<[string, StreamKey]> = [
      ["impact-stream", "impactStreamText"],
      ["triage-stream", "triageStreamText"],
      ["plan-stream", "planStreamText"],
      ["tests-stream", "testsStreamText"],
      ["review-stream", "reviewStreamText"],
      ["pr-stream", "prStreamText"],
      ["retro-stream", "retroStreamText"],
      ["checkpoint-chat-stream", "checkpointStreamText"],
      ["build-check-stream", "buildCheckStreamText"],
    ];
    const cleanups = streams.map(([event, key]) => {
      const acc = { text: "", sessionId: "" };
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const unlisten = listen<{ delta: string }>(event, (e) => {
        const currentSessionId =
          useImplementTicketStore.getState().activeSessionId;
        if (acc.sessionId !== currentSessionId) {
          acc.text = "";
          acc.sessionId = currentSessionId;
        }
        acc.text += e.payload.delta;
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (
            useImplementTicketStore.getState().activeSessionId === acc.sessionId
          ) {
            useImplementTicketStore
              .getState()
              ._set({ [key]: acc.text } as Record<StreamKey, string>);
          }
        }, 80);
      });
      return () => {
        if (flushTimer !== null) clearTimeout(flushTimer);
        unlisten.then((f) => f());
      };
    });
    return () => cleanups.forEach((f) => f());
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      name: string;
      description: string;
      why_needed: string;
      example_call: string;
    }>("agent-tool-request", (event) => {
      const { name, description, why_needed, example_call } = event.payload;
      setToolRequests((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${name}`,
          name,
          description,
          whyNeeded: why_needed,
          exampleCall: example_call,
          dismissed: false,
          saved: false,
        },
      ]);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // ── Load sprint issues ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!jiraAvailable) {
      setLoadingIssues(false);
      return;
    }
    getMySprintIssues()
      .then(setSprintIssues)
      .catch(() => {})
      .finally(() => setLoadingIssues(false));
  }, [jiraAvailable]);

  useEffect(() => {
    const t = window.setTimeout(() => setMeridianHeaderVisible(true), 0);
    return () => clearTimeout(t);
  }, []);

  const cancelledRef = useRef(false);

  function cancelChat() {
    cancelledRef.current = true;
    setChatSending(false);
  }

  // ── Unified chat send — routes to store based on current pipeline stage ───────
  // Accepts the text directly so slash-commands can send synthetic prompts
  // (e.g. /plan sends "Show the current implementation plan") without going
  // through the chatInput state, which SlashCommandInput may have already
  // cleared before invoking the callback.
  async function sendChatMessage(text?: string) {
    const msg = (text ?? chatInput).trim();
    if (!msg) return;
    if (text === undefined) setChatInput("");
    cancelledRef.current = false;
    setChatSending(true);
    try {
      const enriched = await enrichMessageWithUrls(msg);
      await store().sendPipelineMessage(enriched);
    } catch {
      /* handled in store */
    } finally {
      if (!cancelledRef.current) setChatSending(false);
    }
  }

  async function handleFinalizePlan() {
    setPlanFinalizing(true);
    try {
      await store().finalizePlan();
    } finally {
      setPlanFinalizing(false);
    }
  }

  const pipelineChatCommands: SlashCommand[] = useMemo(() => {
    // The "current" history depends on which slot is active. We merge every
    // active thread so /clear / /retry operate on whatever the user is
    // looking at — the pipeline UI shows all sections in one scrolling pane.
    const isCheckpointActive =
      pendingApproval !== null && pendingApproval !== "grooming";
    const activeStage: Stage | "triage" | "grooming" = isCheckpointActive
      ? (pendingApproval as Stage)
      : currentStage === "triage"
        ? "triage"
        : currentStage === "grooming" || pendingApproval === "grooming"
          ? "grooming"
          : "triage";
    const history: TriageMessage[] =
      activeStage === "triage"
        ? triageHistory
        : activeStage === "grooming"
          ? groomingChat
          : (checkpointChats[activeStage as Stage] ?? []);

    const clearActive = () => {
      // The chat panel is unified — it shows the grooming, triage, and every
      // checkpoint-chat section in one scroll. "/clear" matches that mental
      // model and wipes them all so the user actually sees the chat empty.
      // Stage outputs (grooming, plan, impact, etc.) are preserved; only the
      // back-and-forth conversations are cleared.
      useImplementTicketStore.setState({
        groomingChat: [],
        triageHistory: [],
        triageTurns: [],
        checkpointChats: {},
      });
    };

    const dropLastAssistant = () => {
      useImplementTicketStore.setState((s) => {
        if (activeStage === "triage") {
          const h = s.triageHistory;
          if (h.length === 0 || h[h.length - 1].role !== "assistant") return s;
          return { ...s, triageHistory: h.slice(0, -1) };
        }
        if (activeStage === "grooming") {
          const h = s.groomingChat;
          if (h.length === 0 || h[h.length - 1].role !== "assistant") return s;
          return { ...s, groomingChat: h.slice(0, -1) };
        }
        const stage = activeStage as Stage;
        const h = s.checkpointChats[stage] ?? [];
        if (h.length === 0 || h[h.length - 1].role !== "assistant") return s;
        return {
          ...s,
          checkpointChats: {
            ...s.checkpointChats,
            [stage]: h.slice(0, -1),
          },
        };
      });
    };

    const isTriageActive = currentStage === "triage" && pendingApproval === null;

    const baseCommands: SlashCommand[] = [
      ...createGlobalCommands({
        history,
        clearHistory: clearActive,
        sendMessage: (text: string) => sendChatMessage(text),
        removeLastAssistantMessage: dropLastAssistant,
      }),
    ];

    // Stage-specific commands. We expose everything unconditionally —
    // commands that don't apply to the current stage still resolve and
    // produce a contextual message. Filtering by stage would feel more
    // opinionated but also hide the capability from users exploring via /.
    const triageCommands: SlashCommand[] = [
      {
        name: "plan",
        description: "Show the current implementation plan",
        execute: async () => {
          await sendChatMessage(
            "Please share the current implementation plan in its latest form.",
          );
        },
      },
      {
        name: "files",
        description: "Glob the worktree for files matching a pattern",
        args: "<pattern>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a pattern, e.g. /files src/**/*.tsx");
            return;
          }
          await sendChatMessage(
            `Use glob_repo_files to list files matching \`${args.trim()}\`. Summarise the key ones.`,
          );
        },
      },
      {
        name: "grep",
        description: "Grep the worktree",
        args: "<pattern>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a pattern, e.g. /grep TODO");
            return;
          }
          await sendChatMessage(
            `Use grep_repo_files to find \`${args.trim()}\` in the worktree. Report top matches.`,
          );
        },
      },
      {
        name: "risk",
        description: "Ask the AI to summarise impact/risk findings",
        execute: async () => {
          await sendChatMessage(
            "Summarise the impact-analysis findings — what's risky about this change?",
          );
        },
      },
      {
        name: "finalize",
        description: "Finalise the plan (advances past Triage)",
        execute: async ({ toast: t }) => {
          if (!isTriageActive) {
            t.info("Finalise is only available during Triage");
            return;
          }
          await handleFinalizePlan();
        },
      },
    ];

    const checkpointCommands: SlashCommand[] = [
      {
        name: "approve",
        aliases: ["next"],
        description: "Approve the current stage (use the button above)",
        execute: ({ toast: t }) => {
          t.info("Use the Approve button to confirm this stage", {
            description:
              "Approval commits output to disk — surfaced as a button so it's unambiguous.",
          });
        },
      },
      {
        name: "reject",
        description: "Reject this stage with a reason",
        args: "<reason>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a reason, e.g. /reject needs more tests");
            return;
          }
          await sendChatMessage(
            `I'm rejecting this stage: ${args.trim()}. Please revise.`,
          );
        },
      },
      {
        name: "diff",
        description: "Ask the AI to summarise the current diff",
        execute: async () => {
          await sendChatMessage(
            "Summarise the current diff from the worktree — files touched and key changes.",
          );
        },
      },
      {
        name: "stage",
        description: "Show which pipeline stage is active",
        execute: ({ toast: t }) => {
          const label = pendingApproval
            ? `Pending approval: ${pendingApproval}`
            : `Current stage: ${currentStage}`;
          t("Stage", { description: label });
        },
      },
    ];

    return [...baseCommands, ...triageCommands, ...checkpointCommands];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentStage,
    pendingApproval,
    triageHistory,
    groomingChat,
    checkpointChats,
  ]);

  function dismissToolRequest(id: string) {
    setToolRequests((prev) =>
      prev.map((r) => (r.id === id ? { ...r, dismissed: true } : r)),
    );
  }
  function markToolRequestSaved(id: string) {
    setToolRequests((prev) =>
      prev.map((r) => (r.id === id ? { ...r, saved: true } : r)),
    );
  }

  // ── Stage content renderer ──────────────────────────────────────────────────

  // Start pipeline — delegate entirely to store
  const startPipeline = useCallback((issue: JiraIssue) => {
    store().startPipeline(issue);
  }, []);

  function renderCheckpoint(stage: Stage) {
    if (!completedStages.has(stage)) return null;
    return (
      <StageApprovalRow
        stage={stage}
        onProceed={() => store().proceedFromStage(stage)}
        proceeding={proceeding}
        hasBlockingIssues={
          stage === "review" &&
          (review?.findings.some((f) => f.severity === "blocking") ?? false)
        }
        onRetry={() => store().retryStage(stage)}
        disabledReason={
          stage === "pr" && !createdPr
            ? "Create the draft PR on Bitbucket before moving on."
            : undefined
        }
      />
    );
  }

  function renderStageContent(stage: Stage) {
    const err = errors[stage];
    if (err) {
      return (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 space-y-3">
          <p className="text-sm font-medium text-destructive">
            Error in {STAGE_LABELS[stage as keyof typeof STAGE_LABELS]}
          </p>
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
            {err}
          </pre>
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => store().retryStage(stage)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      );
    }

    if (stage === "grooming") {
      if (!grooming)
        return (
          <div className="space-y-3">
            <GroomingProgressBanner
              message={groomingProgress || "Running grooming analysis…"}
              streamText={groomingStreamText}
            />
          </div>
        );

      return (
        <div className="space-y-3">
          <GroomingPanel
            data={grooming}
            baseline={groomingBaseline}
            descriptionSections={selectedIssue?.descriptionSections}
            description={selectedIssue?.description}
            stepsToReproduce={selectedIssue?.stepsToReproduce}
            observedBehavior={selectedIssue?.observedBehavior}
            expectedBehavior={selectedIssue?.expectedBehavior}
            suggestedEdits={groomingEdits}
            clarifyingQuestions={clarifyingQuestions}
            clarifyingQuestionsInitial={clarifyingQuestionsInitial}
            ambiguitiesInitial={ambiguitiesInitial}
            highlights={groomingHighlights}
            showHighlights={showHighlights}
            onToggleHighlights={() => store().toggleHighlights()}
            filesRead={filesRead}
            onApproveEdit={(id) => store().handleApproveEdit(id)}
            onDeclineEdit={(id) => store().handleDeclineEdit(id)}
            onEditSuggested={(id, text) => store().handleEditSuggested(id, text)}
            onUpdateJira={() => store().pushGroomingToJira()}
            jiraUpdateStatus={jiraUpdateStatus}
            jiraUpdateError={jiraUpdateError}
          />
          {groomingBlockers.length > 0 && (
            <BlockerBanner blockers={groomingBlockers} />
          )}
          {renderCheckpoint("grooming")}
        </div>
      );
    }
    if (stage === "impact") {
      if (!impact)
        return (
          <StreamingLoader
            label="Running impact analysis…"
            streamText={impactStreamText}
          />
        );
      return (
        <>
          <ImpactPanel data={impact} />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "triage" || stage === "plan") {
      if (plan && completedStages.has("plan")) {
        return (
          <>
            <PlanPanel data={plan} />
            {renderCheckpoint("plan")}
          </>
        );
      }
      if (triageHistory.length === 0) {
        return (
          <StreamingLoader
            label="Starting triage conversation…"
            streamText={triageStreamText}
          />
        );
      }
      if (planFinalizing) {
        return (
          <StreamingLoader
            label="Finalising implementation plan…"
            streamText={planStreamText}
          />
        );
      }
      return (
        <div className="space-y-4">
          <TriagePanel
            history={triageHistory}
            turns={triageTurns}
            streamText={triageStreamText}
          />
          <div className="rounded-md border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            Refine via the chat on the right. Click{" "}
            <span className="font-medium text-foreground">Finalise Plan</span>{" "}
            when ready.
          </div>
        </div>
      );
    }
    if (stage === "implementation") {
      if (!implementation) {
        return (
          <StreamingLoader
            label="Writing code…"
            streamText={implementationStreamText}
          />
        );
      }
      // Implementation written but build check still running (no buildVerification yet,
      // but buildCheckStreamText is accumulating)
      if (!buildVerification && buildCheckStreamText) {
        return (
          <StreamingLoader
            label="Verifying build…"
            streamText={buildCheckStreamText}
          />
        );
      }
      return (
        <>
          <ImplementationPanel
            data={implementation}
            tab={implementationTab}
            buildVerification={buildVerification}
          />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "tests") {
      if (!tests)
        return (
          <StreamingLoader
            label="Writing tests…"
            streamText={testsStreamText}
          />
        );
      return (
        <>
          <TestsPanel data={tests} />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "review") {
      if (!review)
        return (
          <StreamingLoader
            label="Reviewing code changes…"
            streamText={reviewStreamText}
          />
        );
      return (
        <>
          <ReviewPanel data={review} />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "pr") {
      if (!prDescription)
        return (
          <StreamingLoader
            label="Generating PR description…"
            streamText={prStreamText}
          />
        );
      return (
        <>
          <PrPanel
            data={prDescription}
            createdPr={createdPr}
            submitStatus={prSubmitStatus}
            submitError={prSubmitError}
            onSubmit={() => store().submitDraftPr()}
          />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "retro") {
      if (!retrospective)
        return (
          <StreamingLoader
            label="Running retrospective…"
            streamText={retroStreamText}
          />
        );
      return (
        <>
          <RetroPanel
            data={retrospective}
            onSaveToKb={(entries) => store().saveToKnowledgeBase(entries)}
            kbSaved={kbSaved}
          />
          {currentStage !== "complete" && renderCheckpoint(stage)}
        </>
      );
    }
    return null;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      {/* Header */}
      <header className={cn(APP_HEADER_BAR, "z-20 shrink-0")}>
        <div className={cn(APP_HEADER_ROW_PANEL, "relative")}>
          {/* Back + title — left (same slot as other panels) */}
          <div className="relative z-10 flex min-w-0 shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={
                currentStage === "select"
                  ? onBack
                  : () => {
                      const cur = store();
                      // Save current session unless grooming never completed (stale in-flight run)
                      if (
                        cur.selectedIssue &&
                        cur.currentStage !== "select" &&
                        !(
                          cur.currentStage === "grooming" &&
                          cur.grooming === null
                        )
                      ) {
                        const newSessions = new Map(cur.sessions);
                        newSessions.set(
                          cur.selectedIssue.key,
                          snapshotSession(cur),
                        );
                        cur._set({ sessions: newSessions });
                      }
                      cur._set({
                        selectedIssue: null,
                        currentStage: "select",
                        isSessionActive: false,
                      });
                    }
              }
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className={cn(APP_HEADER_TITLE, "shrink-0")}>
              Implement a Ticket
            </span>
          </div>

          <div className="min-w-0 flex-1" aria-hidden />

          <Button
            variant="ghost"
            size="icon"
            className="relative z-30 shrink-0"
            onClick={() => {
              setSearchOpen((v) => !v);
              if (!searchOpen) {
                setTimeout(() => searchInputRef.current?.select(), 0);
              }
            }}
            title="Search this panel (⌘/Ctrl+F)"
          >
            <Search className="h-4 w-4" />
          </Button>
          <HeaderRecordButton className="relative z-30" />
          <HeaderSettingsButton className="relative z-30 shrink-0" />

          {/* Meridian mark centred in header; morphs to pipeline ring when a ticket run is active */}
          <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <div
              className={cn(
                "absolute bottom-0 left-1/2 flex h-14 min-h-0 -translate-x-1/2 justify-center overflow-hidden",
                currentStage !== "select"
                  ? "w-1/2 max-w-md"
                  : "w-auto max-w-md",
                meridianHeaderVisible ? "opacity-100" : "opacity-0",
              )}
              style={{
                transition:
                  "width 700ms ease-in-out, max-width 700ms ease-in-out, opacity 1000ms ease-out",
              }}
            >
              <PipelineProgress
                activeStep={
                  currentStage === "select"
                    ? undefined
                    : stageToStep(viewingStage)
                }
                logoAlign="center"
                className={`block h-full min-h-0 opacity-100 transition-opacity duration-300 ease-out ${
                  currentStage === "select" ? "w-auto max-h-14" : "w-full"
                }`}
              />
            </div>
          </div>
        </div>
      </header>

      {/* Find-in-page search bar */}
      {searchOpen && (
        <div className="shrink-0 border-b bg-muted/30 px-4 py-2 flex items-center gap-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchStatus("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                findNext(e.shiftKey ? "backward" : "forward");
              } else if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchStatus("");
              }
            }}
            placeholder="Find in panel… (Enter for next, Shift+Enter for previous)"
            className="flex-1 min-w-0 bg-background border border-input rounded-md px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          {searchStatus === "no-match" && searchQuery && (
            <span className="text-xs text-amber-600 dark:text-amber-400 shrink-0">
              No matches
            </span>
          )}
          <button
            onClick={() => findNext("backward")}
            disabled={!searchQuery.trim()}
            className="text-xs px-2 py-0.5 rounded border hover:bg-muted disabled:opacity-40 transition-colors"
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={() => findNext("forward")}
            disabled={!searchQuery.trim()}
            className="text-xs px-2 py-0.5 rounded border hover:bg-muted disabled:opacity-40 transition-colors"
            title="Next match (Enter)"
          >
            ↓
          </button>
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchStatus("");
            }}
            className="text-xs text-muted-foreground hover:text-foreground p-1"
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Ticket info bar — shown once a ticket is selected */}
      {selectedIssue && (
        <div className="shrink-0 px-4 py-1.5 border-b bg-muted/20 flex items-center gap-2 min-w-0">
          <JiraTicketLink
            ticketKey={selectedIssue.key}
            url={selectedIssue.url}
          />
          <span className="text-xs text-muted-foreground truncate flex-1">
            — {selectedIssue.summary}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => selectedIssue.url && openUrl(selectedIssue.url)}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1" /> JIRA
          </Button>
        </div>
      )}

      {/* Credential warnings */}
      {(!jiraAvailable || !claudeAvailable) && (
        <div className="shrink-0 px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-200">
          {!jiraAvailable && "JIRA credentials not configured. "}
          {!claudeAvailable &&
            "No AI provider configured — add an Anthropic key, Gemini key, or local LLM URL in Settings."}
        </div>
      )}

      {/* Body — full-width card; fills viewport below chrome so only the stage panel scrolls */}
      <div
        className={`flex min-h-0 flex-1 flex-col overflow-hidden ${currentStage === "select" ? "p-4" : "px-2 py-2"}`}
      >
        <div
          className={`flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl bg-background/60 ${currentStage === "select" ? "mx-auto max-w-3xl" : ""}`}
        >
          {currentStage === "select" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <TicketSelector
                sprintIssues={sprintIssues}
                loading={loadingIssues}
                onSelect={startPipeline}
                sessionKeys={sessionKeys}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {!sidebarCollapsed && (
                <PipelineSidebar
                  currentStage={currentStage}
                  completedStages={completedStages}
                  activeStage={viewingStage}
                  pendingApproval={pendingApproval}
                  onClickStage={(s) =>
                    store()._set({ viewingStage: s as Exclude<Stage, "select"> })
                  }
                />
              )}

              {/* ── Split container: stage content | divider | chat panel ── */}
              <div
                ref={splitContainerRef}
                className="flex min-h-0 flex-1 overflow-hidden"
              >
                {/* Left: stage content */}
                <div
                  style={{ width: `${splitPct}%` }}
                  className="flex-none flex flex-col min-h-0 overflow-hidden"
                >
                  <div className="shrink-0 px-5 pt-5">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setSidebarCollapsed((c) => !c)}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title={sidebarCollapsed ? "Show pipeline sidebar" : "Hide pipeline sidebar"}
                        >
                          {sidebarCollapsed ? (
                            <PanelLeftOpen className="h-4 w-4" />
                          ) : (
                            <PanelLeftClose className="h-4 w-4" />
                          )}
                        </button>
                        <h2 className="text-base font-semibold">
                          {viewingStage === "triage" &&
                          !completedStages.has("plan")
                            ? "Triage"
                            : viewingStage === "triage" ||
                                viewingStage === "plan"
                              ? "Implementation Plan"
                              : STAGE_LABELS[
                                  viewingStage as keyof typeof STAGE_LABELS
                                ]}
                        </h2>
                        {viewingStage !== "complete" && (
                          <button
                            onClick={() =>
                              store().retryStage(viewingStage as Stage)
                            }
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            title={`Re-run the ${
                              STAGE_LABELS[
                                viewingStage as keyof typeof STAGE_LABELS
                              ] ?? viewingStage
                            } agent`}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {viewingStage === "implementation" && implementation && (
                          <div className="flex gap-0.5">
                            {(["status", "diff"] as const).map((t) => (
                              <button
                                key={t}
                                onClick={() => setImplementationTab(t)}
                                className={cn(
                                  "text-xs px-2.5 py-0.5 rounded font-medium capitalize",
                                  implementationTab === t
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                                )}
                              >
                                {t === "status" ? "Status" : "Diff"}
                              </button>
                            ))}
                          </div>
                        )}
                        {currentStage === "complete" &&
                          viewingStage === "retro" && (
                            <p className="flex items-center gap-1 text-xs font-medium text-green-600">
                              <CheckCircle2 className="h-3 w-3" /> Pipeline
                              complete
                            </p>
                          )}
                      </div>
                      {completedStages.has(viewingStage as Stage) &&
                        (viewingStage === "grooming" ||
                          viewingStage === "impact" ||
                          viewingStage === "tests" ||
                          viewingStage === "review") && (
                          <CopyButton
                            text={
                              JSON.stringify(
                                viewingStage === "grooming"
                                  ? grooming
                                  : viewingStage === "impact"
                                    ? impact
                                    : viewingStage === "tests"
                                      ? tests
                                      : review,
                                null,
                                2,
                              ) ?? ""
                            }
                            label="Copy JSON"
                          />
                        )}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
                    {renderStageContent(viewingStage)}
                  </div>
                </div>

                {/* Drag divider */}
                <div
                  onMouseDown={onDividerMouseDown}
                  className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/30 active:bg-primary/50 transition-colors"
                />

                {/* Right: persistent chat panel */}
                <div
                  style={{ width: `${100 - splitPct}%` }}
                  className="flex-none min-h-0 overflow-hidden"
                >
                  <PipelineChatPanel
                    grooming={grooming}
                    groomingChat={groomingChat}
                    triageHistory={triageHistory}
                    checkpointChats={checkpointChats}
                    currentStage={currentStage}
                    pendingApproval={pendingApproval}
                    toolRequests={toolRequests}
                    onDismissToolRequest={dismissToolRequest}
                    onSavedToolRequest={markToolRequestSaved}
                    chatInput={chatInput}
                    onChatInputChange={setChatInput}
                    onSend={sendChatMessage}
                    onCancel={cancelChat}
                    onFinalizePlan={handleFinalizePlan}
                    sending={chatSending}
                    finalizing={planFinalizing}
                    proceeding={proceeding}
                    streamingText={
                      currentStage === "triage"
                        ? triageStreamText
                        : checkpointStreamText
                    }
                    commands={pipelineChatCommands}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
