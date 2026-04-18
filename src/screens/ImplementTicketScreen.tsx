import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { PipelineProgress } from "@/components/PipelineProgress";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import {
  APP_HEADER_BAR,
  APP_HEADER_ROW_PANEL,
  APP_HEADER_TITLE,
} from "@/components/appHeaderLayout";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import {
  ArrowLeft,
  Loader2,
  CheckCircle2,
  Circle,
  ChevronRight,
  Send,
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  type JiraIssue,
  type DescriptionSection,
  type CredentialStatus,
  type GroomingOutput,
  type SuggestedEdit,
  type ImpactOutput,
  type ImplementationPlan,
  type GuidanceOutput,
  type ImplementationOutput,
  type TestOutput,
  type PlanReviewOutput,
  type PrDescriptionOutput,
  type RetrospectiveOutput,
  type TriageMessage,
  type RetroKbEntry,
  aiProviderComplete,
  jiraComplete,
  getMySprintIssues,
  searchJiraIssues,
  openUrl,
} from "@/lib/tauri";
import {
  useImplementTicketStore,
  snapshotSession,
  type Stage,
  type GroomingBlocker,
} from "@/stores/implementTicketStore";
import { enrichMessageWithUrls } from "@/lib/urlFetch";
import { ToolRequestCard, type ToolRequest } from "@/components/ToolRequestCard";

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
  plan: "Finalising Plan",
  guidance: "Implementation Guide",
  implementation: "Implementation",
  tests: "Test Suggestions",
  review: "Plan Review",
  pr: "PR Description",
  retro: "Retrospective",
  complete: "Complete",
};

const STAGE_ORDER: Exclude<Stage, "select" | "complete">[] = [
  "grooming", "impact", "triage", "plan", "guidance", "implementation", "tests", "review", "pr", "retro",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
// compileTicketText, compilePipelineContext, detectGroomingBlockers, GroomingBlocker
// are now imported from the store.

function BlockerBanner({ blockers }: { blockers: GroomingBlocker[] }) {
  if (blockers.length === 0) return null;
  const hasBlocking = blockers.some((b) => b.severity === "blocking");
  return (
    <div className={`rounded-md border p-3 space-y-2 ${hasBlocking ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30" : "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"}`}>
      <div className={`flex items-center gap-2 text-sm font-medium ${hasBlocking ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"}`}>
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {hasBlocking ? "Blocking issues — resolve before proceeding" : "Warnings — review before proceeding"}
      </div>
      {blockers.map((b) => (
        <div key={b.id} className="pl-6 space-y-0.5">
          <div className={`flex items-center gap-1.5 text-xs font-medium ${b.severity === "blocking" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"}`}>
            <span className={`px-1.5 py-0.5 rounded ${b.severity === "blocking" ? "bg-red-100 dark:bg-red-900" : "bg-amber-100 dark:bg-amber-900"}`}>{b.severity}</span>
            {b.message}
          </div>
          <p className={`text-xs ${b.severity === "blocking" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>{b.detail}</p>
        </div>
      ))}
    </div>
  );
}

// ── Small display components ──────────────────────────────────────────────────

function RiskBadge({ level }: { level: "low" | "medium" | "high" }) {
  const cls =
    level === "high" ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" :
    level === "medium" ? "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300" :
    "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{level} risk</span>;
}

function ConfidenceBadge({ level }: { level: "ready" | "needs_attention" | "requires_rework" }) {
  if (level === "ready") return <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">Ready</span>;
  if (level === "needs_attention") return <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">Needs attention</span>;
  return <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">Requires rework</span>;
}

function CollapsibleList({ title, items, icon }: { title: string; items: string[]; icon?: React.ReactNode }) {
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
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
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

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <Button variant="ghost" size="sm" onClick={copy} className="gap-1.5 h-7 text-xs">
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
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

  const headingPattern = /^(?:h[1-6]\.\s*(.+)|#{1,3}\s+(.+)|(\*{1,2})(.+)\3\s*$)/;
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
  return sections.filter(s => s.heading !== null || s.content.trim().length > 0);
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
        <div className="px-3 py-2 bg-muted/30 text-sm font-medium">Description</div>
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
        <CollapsibleSection key={i} heading={section.heading} content={section.content} />
      ))}
    </div>
  );
}

function CollapsibleSection({ heading, content }: { heading: string | null; content: string }) {
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
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
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
  next: string[]
): { text: string; status: "added" | "removed" | "unchanged" }[] {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const result: { text: string; status: "added" | "removed" | "unchanged" }[] = [];
  for (const item of next) {
    result.push({ text: item, status: prevSet.has(item) ? "unchanged" : "added" });
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

function DiffedCollapsibleList({ title, items, icon, hasChanges }: DiffedListProps) {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;
  return (
    <div className={`border rounded-md overflow-hidden ${hasChanges ? "border-blue-300 dark:border-blue-700" : ""}`}>
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
        <span className="text-xs text-muted-foreground">{items.filter(i => i.status !== "removed").length}</span>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
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
                {item.status === "added" ? "+" : item.status === "removed" ? "−" : "·"}
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

function GroomingProgressBanner({ message, streamText }: { message: string; streamText: string }) {
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
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
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
}: {
  edit: SuggestedEdit;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
}) {
  const isPending = edit.status === "pending";
  const isApproved = edit.status === "approved";
  const isDeclined = edit.status === "declined";

  return (
    <div className={`border rounded-md overflow-hidden transition-opacity ${isDeclined ? "opacity-40" : ""}`}>
      {/* Header */}
      <div className={`px-3 py-2 flex items-center justify-between text-sm font-medium ${
        isApproved ? "bg-green-50 dark:bg-green-950/30 border-b border-green-200 dark:border-green-800" :
        isDeclined ? "bg-muted/30 border-b" :
        "bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800"
      }`}>
        <div className="flex items-center gap-2">
          {isApproved && <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />}
          {isDeclined && <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
          {isPending && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
          <span className={isDeclined ? "line-through text-muted-foreground" : ""}>{edit.section}</span>
          {edit.current === null && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">missing</span>
          )}
        </div>
        {isPending && (
          <div className="flex items-center gap-1">
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
          </div>
        )}
        {isApproved && (
          <button onClick={() => onDecline(edit.id)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Undo
          </button>
        )}
        {isDeclined && (
          <button onClick={() => onApprove(edit.id)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Restore
          </button>
        )}
      </div>
      {/* Diff */}
      {!isDeclined && (
        <div className="divide-y text-xs font-mono">
          {edit.current !== null && (
            <div className="px-3 py-2 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 whitespace-pre-wrap leading-relaxed">
              <span className="select-none mr-1 opacity-60">−</span>{edit.current}
            </div>
          )}
          <div className="px-3 py-2 bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-300 whitespace-pre-wrap leading-relaxed">
            <span className="select-none mr-1 opacity-60">+</span>{edit.suggested}
          </div>
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

function ClarifyingQuestionsCard({
  questions,
  onDismiss,
}: {
  questions: string[];
  onDismiss: () => void;
}) {
  if (questions.length === 0) return null;
  return (
    <div className="border border-amber-300 dark:border-amber-700 rounded-md overflow-hidden">
      <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4" />
          Questions from the agent
        </div>
        <button onClick={onDismiss} className="text-xs text-muted-foreground hover:text-foreground">
          Dismiss
        </button>
      </div>
      <ul className="divide-y">
        {questions.map((q, i) => (
          <li key={i} className="px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
            {i + 1}. {q}
          </li>
        ))}
      </ul>
      <div className="px-3 py-2 border-t text-xs text-muted-foreground">
        Answer these in the chat below ↓
      </div>
    </div>
  );
}

function FilesReadPanel({ files }: { files: string[] }) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  return (
    <div className="border rounded-md overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-2 flex items-center justify-between text-sm bg-muted/20 hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <FileCode className="h-4 w-4" />
          <span>{files.length} file{files.length !== 1 ? "s" : ""} read from codebase</span>
        </div>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="divide-y">
          {files.map((f, i) => (
            <li key={i} className="px-3 py-1.5 text-xs font-mono text-muted-foreground">{f}</li>
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
  filesRead: string[];
  onApproveEdit: (id: string) => void;
  onDeclineEdit: (id: string) => void;
  onDismissQuestions: () => void;
  onUpdateJira: () => void;
  jiraUpdateStatus: "idle" | "saving" | "saved" | "error";
  jiraUpdateError: string;
}

function GroomingPanel({
  data, baseline, descriptionSections, description,
  stepsToReproduce, observedBehavior, expectedBehavior,
  suggestedEdits, clarifyingQuestions, filesRead,
  onApproveEdit, onDeclineEdit, onDismissQuestions,
  onUpdateJira, jiraUpdateStatus, jiraUpdateError,
}: GroomingPanelProps) {
  const hasDiff = baseline != null;

  const relevantItems = hasDiff
    ? diffStringArrays(
        baseline!.relevant_areas.map(a => `${a.area} — ${a.reason}`),
        data.relevant_areas.map(a => `${a.area} — ${a.reason}`)
      )
    : data.relevant_areas.map(a => ({ text: `${a.area} — ${a.reason}`, status: "unchanged" as const }));

  const ambiguityItems = hasDiff
    ? diffStringArrays(baseline!.ambiguities, data.ambiguities)
    : data.ambiguities.map(t => ({ text: t, status: "unchanged" as const }));

  const depItems = hasDiff
    ? diffStringArrays(baseline!.dependencies, data.dependencies)
    : data.dependencies.map(t => ({ text: t, status: "unchanged" as const }));

  const summaryChanged = hasDiff && baseline!.ticket_summary !== data.ticket_summary;

  const pendingCount = suggestedEdits.filter(e => e.status === "pending").length;
  const approvedCount = suggestedEdits.filter(e => e.status === "approved").length;

  return (
    <div className="space-y-3">
      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="secondary">{data.ticket_type}</Badge>
        <Badge variant={data.estimated_complexity === "high" ? "destructive" : data.estimated_complexity === "medium" ? "secondary" : "outline"}>
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
      <div className={`rounded px-2 py-1 -mx-2 ${summaryChanged ? "bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800" : ""}`}>
        <p className="text-sm leading-relaxed">{data.ticket_summary}</p>
        {summaryChanged && (
          <p className="text-xs text-muted-foreground line-through mt-0.5">{baseline!.ticket_summary}</p>
        )}
      </div>

      {/* Clarifying questions — shown prominently when present */}
      <ClarifyingQuestionsCard questions={clarifyingQuestions} onDismiss={onDismissQuestions} />

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
          {stepsToReproduce && <CollapsibleSection heading="Steps to Reproduce" content={stepsToReproduce} />}
          {observedBehavior && <CollapsibleSection heading="Observed Behavior" content={observedBehavior} />}
          {expectedBehavior && <CollapsibleSection heading="Expected Behavior" content={expectedBehavior} />}
        </div>
      )}

      {/* Suggested edits — the heart of the new grooming flow */}
      {suggestedEdits.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Suggested ticket improvements
          </p>
          {suggestedEdits.map(edit => (
            <SuggestedEditCard
              key={edit.id}
              edit={edit}
              onApprove={onApproveEdit}
              onDecline={onDeclineEdit}
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
              title={approvedCount === 0 ? "Approve at least one suggested edit first" : `Push ${approvedCount} approved edit${approvedCount !== 1 ? "s" : ""} to JIRA`}
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
              <span className="text-xs text-orange-600 leading-tight" title={jiraUpdateError}>
                {jiraUpdateError.startsWith("Saved.") ? jiraUpdateError : "Error saving — check console"}
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
        hasChanges={relevantItems.some(i => i.status !== "unchanged")}
      />
      <DiffedCollapsibleList
        title="Ambiguities"
        items={ambiguityItems}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        hasChanges={ambiguityItems.some(i => i.status !== "unchanged")}
      />
      <DiffedCollapsibleList
        title="Dependencies"
        items={depItems}
        hasChanges={depItems.some(i => i.status !== "unchanged")}
      />
      {data.grooming_notes && (
        <p className="text-sm text-muted-foreground italic">{data.grooming_notes}</p>
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
        <p className="text-sm text-muted-foreground">{data.risk_justification}</p>
      </div>
      <CollapsibleList title="Affected Areas" items={data.affected_areas} />
      <CollapsibleList title="Potential Regressions" items={data.potential_regressions} icon={<AlertTriangle className="h-4 w-4 text-amber-500" />} />
      <CollapsibleList title="Cross-cutting Concerns" items={data.cross_cutting_concerns} />
      <CollapsibleList title="Files Needing Consistent Updates" items={data.files_needing_consistent_updates} icon={<FileCode className="h-4 w-4 text-muted-foreground" />} />
      {data.recommendations && (
        <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30 px-3 py-2">
          <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-1">Recommendations</p>
          <p className="text-sm text-blue-700 dark:text-blue-300">{data.recommendations}</p>
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
            <FileCode className="h-4 w-4 text-muted-foreground" /> Files ({data.files.length})
          </div>
          <div className="divide-y">
            {data.files.map((f, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-0.5">
                  <code className="text-xs font-mono">{f.path}</code>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    f.action === "create" ? "bg-green-100 text-green-700" :
                    f.action === "delete" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
                  }`}>{f.action}</span>
                </div>
                <p className="text-sm text-muted-foreground">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      <CollapsibleList title="Order of Operations" items={data.order_of_operations} />
      <CollapsibleList title="Edge Cases to Handle" items={data.edge_cases} icon={<AlertTriangle className="h-4 w-4 text-amber-500" />} />
      <CollapsibleList title="Do NOT Change" items={data.do_not_change} icon={<Shield className="h-4 w-4 text-red-500" />} />
      <CollapsibleList title="Assumptions" items={data.assumptions} />
      <CollapsibleList title="Open Questions" items={data.open_questions} icon={<AlertTriangle className="h-4 w-4 text-amber-500" />} />
    </div>
  );
}

function GuidancePanel({ data }: { data: GuidanceOutput }) {
  return (
    <div className="space-y-3">
      {data.steps.map((step) => (
        <div key={step.step} className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 flex items-center gap-2">
            <span className="text-xs font-bold text-primary rounded-full border border-primary w-5 h-5 flex items-center justify-center shrink-0">{step.step}</span>
            <span className="text-sm font-medium flex-1">{step.title}</span>
            <code className="text-xs font-mono text-muted-foreground">{step.file}</code>
          </div>
          <div className="px-3 py-2 space-y-1.5">
            <p className="text-sm"><span className="font-medium">Action:</span> {step.action}</p>
            <p className="text-sm text-muted-foreground">{step.details}</p>
            {step.code_hints && (
              <pre className="text-xs font-mono bg-muted/50 rounded p-2 whitespace-pre-wrap">{step.code_hints}</pre>
            )}
          </div>
        </div>
      ))}
      <CollapsibleList title="Patterns to Follow" items={data.patterns_to_follow} />
      <CollapsibleList title="Common Pitfalls" items={data.common_pitfalls} icon={<AlertTriangle className="h-4 w-4 text-amber-500" />} />
      <CollapsibleList title="Definition of Done" items={data.definition_of_done} icon={<CheckCircle2 className="h-4 w-4 text-green-500" />} />
    </div>
  );
}

function ImplementationPanel({ data }: { data: ImplementationOutput }) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">{data.summary}</p>
      {data.files_changed.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <FileCode className="h-4 w-4 text-muted-foreground" /> Files changed ({data.files_changed.length})
          </div>
          <div className="divide-y">
            {data.files_changed.map((f, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-0.5">
                  <code className="text-xs font-mono">{f.path}</code>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    f.action === "created" ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" :
                    f.action === "deleted" ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" :
                    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                  }`}>{f.action}</span>
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
            <AlertTriangle className="h-4 w-4" /> Deviations from plan ({data.deviations.length})
          </div>
          <div className="divide-y">
            {data.deviations.map((d, i) => (
              <p key={i} className="px-3 py-2 text-sm text-muted-foreground">{d}</p>
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

function TestsPanel({ data }: { data: TestOutput }) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">{data.test_strategy}</p>
      {data.unit_tests.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <TestTube className="h-4 w-4 text-muted-foreground" /> Unit Tests ({data.unit_tests.length})
          </div>
          <div className="divide-y">
            {data.unit_tests.map((t, i) => (
              <div key={i} className="px-3 py-2">
                <p className="text-sm font-medium">{t.description}</p>
                <p className="text-xs text-muted-foreground mb-1">Target: <code>{t.target}</code></p>
                <ul className="space-y-0.5">
                  {t.cases.map((c, j) => <li key={j} className="text-sm text-muted-foreground flex gap-2"><span>·</span>{c}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
      {data.integration_tests.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <TestTube className="h-4 w-4 text-blue-500" /> Integration Tests ({data.integration_tests.length})
          </div>
          <div className="divide-y">
            {data.integration_tests.map((t, i) => (
              <div key={i} className="px-3 py-2">
                <p className="text-sm font-medium">{t.description}</p>
                {t.setup && <p className="text-xs text-muted-foreground mb-1">Setup: {t.setup}</p>}
                <ul className="space-y-0.5">
                  {t.cases.map((c, j) => <li key={j} className="text-sm text-muted-foreground flex gap-2"><span>·</span>{c}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
      <CollapsibleList title="Edge Cases to Test" items={data.edge_cases_to_test} />
      {data.coverage_notes && <p className="text-sm text-muted-foreground italic">{data.coverage_notes}</p>}
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
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                  f.severity === "blocking" ? "bg-red-100 text-red-700" :
                  f.severity === "non_blocking" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"
                }`}>{f.severity}</span>
                <span className="text-sm font-medium">{f.area}</span>
              </div>
              <p className="text-sm text-muted-foreground">{f.feedback}</p>
            </div>
          ))}
        </div>
      )}
      <CollapsibleList title="Address Before Starting" items={data.things_to_address} icon={<AlertTriangle className="h-4 w-4 text-red-500" />} />
      <CollapsibleList title="Keep in Mind While Implementing" items={data.things_to_watch} />
    </div>
  );
}

function PrPanel({ data }: { data: PrDescriptionOutput }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground font-medium mb-1">PR Title</p>
          <p className="text-sm font-semibold">{data.title}</p>
        </div>
        <CopyButton text={`${data.title}\n\n${data.description}`} label="Copy PR" />
      </div>
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-1">Description</p>
        <pre className="text-sm font-sans leading-relaxed whitespace-pre-wrap bg-muted/30 rounded-md p-3 max-h-80 overflow-y-auto">
          {data.description}
        </pre>
      </div>
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
      <CollapsibleList title="What Went Well" items={data.what_went_well} icon={<CheckCircle2 className="h-4 w-4 text-green-500" />} />
      <CollapsibleList title="What Could Improve" items={data.what_could_improve} icon={<AlertTriangle className="h-4 w-4 text-amber-500" />} />
      <CollapsibleList title="Patterns Identified" items={data.patterns_identified} />
      {data.agent_skill_suggestions.length > 0 && (
        <CollapsibleList
          title="Agent Skill Suggestions"
          items={data.agent_skill_suggestions.map(s => `${s.skill}: ${s.suggestion}`)}
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
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onSaveToKb(data.knowledge_base_entries)}>
                Save to KB
              </Button>
            ) : (
              <span className="text-xs text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> Saved</span>
            )}
          </div>
          <div className="divide-y">
            {data.knowledge_base_entries.map((e, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-0.5">
                  <Badge variant="outline" className="text-xs">{e.type}</Badge>
                  <span className="text-sm font-medium">{e.title}</span>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2">{e.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Checkpoint footer (approval gate + follow-up chat) ───────────────────────

const NEXT_STAGE_LABEL: Partial<Record<Stage, string>> = {
  grooming: "Proceed to Impact Analysis",
  impact: "Proceed to Triage",
  plan: "Proceed to Implementation Guidance",
  guidance: "Proceed to Implementation",
  implementation: "Proceed to Test Suggestions",
  tests: "Proceed to Code Review",
  review: "Proceed to PR Description",
  pr: "Proceed to Retrospective",
  retro: "Mark Pipeline Complete",
};

interface CheckpointFooterProps {
  stage: Stage;
  onProceed: () => void;
  proceeding: boolean;
  hasBlockingIssues?: boolean;
  chat: TriageMessage[];
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  // grooming stage only
  groomingChatLabel?: string;
  toolRequests?: ToolRequest[];
  onDismissToolRequest?: (id: string) => void;
  onSavedToolRequest?: (id: string) => void;
}

function CheckpointFooter({
  stage, onProceed, proceeding, hasBlockingIssues,
  chat, input, onInputChange, onSend, sending,
  groomingChatLabel,
  toolRequests = [],
  onDismissToolRequest,
  onSavedToolRequest,
}: CheckpointFooterProps) {
  const [chatOpen, setChatOpen] = useState(stage === "grooming"); // auto-open for grooming
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatOpen) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, chatOpen]);

  const nextLabel = NEXT_STAGE_LABEL[stage] ?? "Proceed";
  const chatToggleLabel = groomingChatLabel ?? "Ask a follow-up question";

  return (
    <div className="mt-5 border-t pt-4 space-y-3">
      {/* Collapsible conversation */}
      <div>
        <button
          onClick={() => setChatOpen(!chatOpen)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${chatOpen ? "rotate-90" : ""}`} />
          {chatToggleLabel}
          {chat.length > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-muted text-xs font-medium">
              {Math.ceil(chat.length / 2)}
            </span>
          )}
        </button>

        {chatOpen && (
          <div className="mt-2 space-y-2">
            {chat.length > 0 && (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {chat.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                      msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}>
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                ))}
                {toolRequests.filter(r => !r.dismissed).map(r => (
                  <ToolRequestCard
                    key={r.id}
                    request={r}
                    onDismiss={onDismissToolRequest ?? (() => {})}
                    onSaved={onSavedToolRequest ?? (() => {})}
                  />
                ))}
                {sending && (
                  <div className="flex justify-start">
                    <div className="bg-muted rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            )}
            <div className="flex gap-2">
              <Textarea
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                placeholder={stage === "grooming"
                  ? "Suggest changes to the ticket, acceptance criteria, or scope…"
                  : "Ask about these findings…"}
                className="min-h-[52px] resize-none text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && input.trim()) {
                    e.preventDefault();
                    onSend();
                  }
                }}
                disabled={sending || proceeding}
              />
              <Button size="icon" onClick={onSend} disabled={!input.trim() || sending || proceeding} title="Send (⌘↵)">
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">⌘↵ to send</p>
          </div>
        )}
      </div>

      {/* Approval button row */}
      <div className="flex items-center justify-between gap-3">
        {hasBlockingIssues && (
          <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Blocking issues present — proceeding not recommended
          </p>
        )}
        <Button
          onClick={onProceed}
          disabled={proceeding}
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
    </div>
  );
}

// ── Triage chat UI ────────────────────────────────────────────────────────────

interface TriageChatProps {
  history: TriageMessage[];
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onFinalize: () => void;
  sending: boolean;
  finalizing: boolean;
}

function TriageChat({ history, input, onInputChange, onSend, onFinalize, sending, finalizing }: TriageChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-3 pr-1">
        {history.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2.5 text-sm leading-relaxed ${
              msg.role === "user"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-foreground"
            }`}>
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-3 py-2.5 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="Respond to the agent's questions or provide clarification…"
          className="min-h-[60px] resize-none text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && input.trim()) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={sending || finalizing}
        />
        <div className="flex flex-col gap-2">
          <Button
            size="icon"
            onClick={onSend}
            disabled={!input.trim() || sending || finalizing}
            title="Send (⌘↵)"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">⌘↵ to send</p>
        <Button
          onClick={onFinalize}
          disabled={sending || finalizing || history.length === 0}
          className="gap-2"
        >
          {finalizing ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Finalising plan…</>
          ) : (
            <><CheckCircle2 className="h-4 w-4" /> Finalise Plan →</>
          )}
        </Button>
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

function TicketSelector({ sprintIssues, loading, onSelect, sessionKeys }: TicketSelectorProps) {
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<JiraIssue[]>([]);
  const [searching, setSearching] = useState(false);
  const q = search.trim();

  useEffect(() => {
    if (!q) { setSearchResults([]); return; }
    const isKey = /^[A-Z]+-\d+$/i.test(q);
    const jql = isKey ? `key = "${q.toUpperCase()}"` : `text ~ "${q}" ORDER BY updated DESC`;
    const timer = setTimeout(async () => {
      setSearching(true);
      try { setSearchResults(await searchJiraIssues(jql, 20)); }
      catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 500);
    return () => clearTimeout(timer);
  }, [q]);

  const list = q ? searchResults : sprintIssues;
  const busy = q ? searching : loading;

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <h2 className="text-base font-semibold mb-3">Select a Ticket to Implement</h2>
        <div className="relative">
          <Input
            placeholder="Search by text or key (e.g. PROJ-123)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-4"
          />
        </div>
      </div>

      {busy ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> {q ? "Searching…" : "Loading sprint tickets…"}
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12">
          {q ? "No tickets found." : "No active sprint tickets assigned to you."}
        </p>
      ) : (
        <div className="space-y-2">
          {!q && <p className="text-xs text-muted-foreground">Active sprint — {list.length} ticket{list.length !== 1 ? "s" : ""} assigned to you</p>}
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
                  <Badge variant="outline" className="text-xs">{issue.issueType}</Badge>
                  {hasSession && (
                    <Badge variant="secondary" className="text-xs flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse inline-block" />
                      In progress
                    </Badge>
                  )}
                  {issue.storyPoints != null && (
                    <span className="ml-auto text-xs text-muted-foreground">{issue.storyPoints}pt</span>
                  )}
                </div>
                <p className="text-sm font-medium leading-snug">{issue.summary}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{issue.status}</p>
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

function PipelineSidebar({ currentStage, completedStages, activeStage, pendingApproval, onClickStage }: PipelineSidebarProps) {
  const icons: Record<string, React.ReactNode> = {
    grooming: <BookOpen className="h-3.5 w-3.5" />,
    impact: <Shield className="h-3.5 w-3.5" />,
    triage: <ClipboardList className="h-3.5 w-3.5" />,
    plan: <ClipboardList className="h-3.5 w-3.5" />,
    guidance: <FileCode className="h-3.5 w-3.5" />,
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
        const running = currentStage === stage && !done && pendingApproval !== stage;
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
              <span className="shrink-0 opacity-60">{icons[stage] ?? <Circle className="h-3.5 w-3.5" />}</span>
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
    grooming:       0,
    impact:         1,
    triage:         2,
    plan:           2,
    guidance:       2,
    implementation: 3,
    tests:          4,
    review:         5,
    pr:             6,
    retro:          7,
    complete:       7,
  };
  return map[stage];
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function ImplementTicketScreen({ credStatus, onBack }: ImplementTicketScreenProps) {
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
    plan,
    guidance,
    implementation,
    implementationStreamText,
    tests,
    review,
    prDescription,
    retrospective,
    kbSaved,
    groomingBlockers,
    groomingEdits,
    clarifyingQuestions,
    filesRead,
    groomingChat,
    groomingBaseline,
    jiraUpdateStatus,
    jiraUpdateError,
    groomingProgress,
    groomingStreamText,
    checkpointChats,
    errors,
    sessions: implementSessions,
  } = useImplementTicketStore();

  const store = useImplementTicketStore.getState;
  // Set of issue keys with cached (or active) pipeline sessions
  const sessionKeys = useMemo(
    () => new Set([...implementSessions.keys(), ...(selectedIssue ? [selectedIssue.key] : [])]),
    [implementSessions, selectedIssue]
  );

  // ── Ephemeral UI state (local — reset on each visit is fine) ─────────────────
  const [sprintIssues, setSprintIssues] = useState<JiraIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(true);
  const [triageInput, setTriageInput] = useState("");
  const [triageSending, setTriageSending] = useState(false);
  const [triaFinalizing, setTriaFinalizing] = useState(false);
  const [checkpointInput, setCheckpointInput] = useState("");
  const [checkpointSending, setCheckpointSending] = useState(false);
  const [groomingChatInput, setGroomingChatInput] = useState("");
  const [groomingChatSending, setGroomingChatSending] = useState(false);
  const [meridianHeaderVisible, setMeridianHeaderVisible] = useState(false);
  const [chatPaneWidth, setChatPaneWidth] = useState<number>(320);
  const [toolRequests, setToolRequests] = useState<ToolRequest[]>([]);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);

  // ── Resizable grooming split pane ────────────────────────────────────────────
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = chatPaneWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = dragStartXRef.current - ev.clientX;
      const next = Math.min(600, Math.max(240, dragStartWidthRef.current + delta));
      setChatPaneWidth(next);
    };
    const onMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [chatPaneWidth]);

  // ── Backend event listeners — write directly to store ────────────────────────
  // Each listener captures the session ID at event time and drops writes for stale sessions.
  useEffect(() => {
    const unlisten = listen<{ phase: string; message: string }>("grooming-progress", (event) => {
      const store = useImplementTicketStore.getState();
      const sessionId = store.activeSessionId;
      if (event.payload.phase === "done") {
        setTimeout(() => {
          if (useImplementTicketStore.getState().activeSessionId === sessionId) {
            useImplementTicketStore.getState()._set({ groomingProgress: "" });
          }
        }, 1200);
      } else {
        store._set({ groomingProgress: event.payload.message });
      }
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    const acc = { text: "", sessionId: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = listen<{ delta: string }>("grooming-stream", (event) => {
      const currentSessionId = useImplementTicketStore.getState().activeSessionId;
      if (acc.sessionId !== currentSessionId) {
        acc.text = "";
        acc.sessionId = currentSessionId;
      }
      acc.text += event.payload.delta;
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (useImplementTicketStore.getState().activeSessionId === acc.sessionId) {
          useImplementTicketStore.getState()._set({ groomingStreamText: acc.text });
        }
      }, 80);
    });
    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    const acc = { text: "", sessionId: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = listen<{ delta: string }>("implementation-stream", (event) => {
      const currentSessionId = useImplementTicketStore.getState().activeSessionId;
      if (acc.sessionId !== currentSessionId) {
        acc.text = "";
        acc.sessionId = currentSessionId;
      }
      acc.text += event.payload.delta;
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (useImplementTicketStore.getState().activeSessionId === acc.sessionId) {
          useImplementTicketStore.getState()._set({ implementationStreamText: acc.text });
        }
      }, 80);
    });
    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      unlisten.then(f => f());
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

  // ── Load sprint issues ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!jiraAvailable) { setLoadingIssues(false); return; }
    getMySprintIssues().then(setSprintIssues).catch(() => {}).finally(() => setLoadingIssues(false));
  }, [jiraAvailable]);

  useEffect(() => {
    const t = window.setTimeout(() => setMeridianHeaderVisible(true), 0);
    return () => clearTimeout(t);
  }, []);

  // ── Triage send (local input, store actions) ─────────────────────────────────
  async function sendTriageMessage() {
    if (!triageInput.trim()) return;
    const input = triageInput.trim();
    setTriageInput("");
    setTriageSending(true);
    try {
      const enriched = await enrichMessageWithUrls(input);
      await store().sendTriageMessage(enriched);
    } catch { /* handled in store */ }
    finally { setTriageSending(false); }
  }

  async function finalizePlan() {
    setTriaFinalizing(true);
    try {
      await store().finalizePlan();
    } finally {
      setTriaFinalizing(false);
    }
  }

  async function sendCheckpointMessage(stage: Stage) {
    const msg = checkpointInput.trim();
    if (!msg) return;
    setCheckpointInput("");
    setCheckpointSending(true);
    try {
      const enriched = await enrichMessageWithUrls(msg);
      await store().sendCheckpointMessage(stage, enriched);
    } finally {
      setCheckpointSending(false);
    }
  }

  async function sendGroomingChatMessage() {
    const msg = groomingChatInput.trim();
    if (!msg) return;
    setGroomingChatInput("");
    setGroomingChatSending(true);
    try {
      const enriched = await enrichMessageWithUrls(msg);
      await store().sendGroomingChatMessage(enriched);
    } finally {
      setGroomingChatSending(false);
    }
  }

  function dismissToolRequest(id: string) {
    setToolRequests(prev => prev.map(r => r.id === id ? { ...r, dismissed: true } : r));
  }
  function markToolRequestSaved(id: string) {
    setToolRequests(prev => prev.map(r => r.id === id ? { ...r, saved: true } : r));
  }

  // ── Stage content renderer ──────────────────────────────────────────────────

  // Start pipeline — delegate entirely to store
  const startPipeline = useCallback((issue: JiraIssue) => {
    store().startPipeline(issue);
  }, []);

  function renderCheckpoint(stage: Stage) {
    // Grooming has its own inline conversation UI — skip the generic footer for it
    if (stage === "grooming") return null;
    // Only show the checkpoint footer if this is the current pending stage
    // (or a past stage — user can revisit and still chat)
    if (!completedStages.has(stage)) return null;
    const isPending = pendingApproval === stage;
    return (
      <CheckpointFooter
        stage={stage}
        onProceed={() => store().proceedFromStage(stage)}
        proceeding={proceeding && pendingApproval === null && currentStage !== stage}
        hasBlockingIssues={stage === "review" && (review?.findings.some(f => f.severity === "blocking") ?? false)}
        chat={checkpointChats[stage] ?? []}
        input={isPending || viewingStage === stage ? checkpointInput : ""}
        onInputChange={(v) => setCheckpointInput(v)}
        onSend={() => sendCheckpointMessage(stage)}
        sending={checkpointSending && viewingStage === stage}
        toolRequests={toolRequests}
        onDismissToolRequest={dismissToolRequest}
        onSavedToolRequest={markToolRequestSaved}
      />
    );
  }

  function renderStageContent(stage: Stage) {
    const err = errors[stage];
    if (err) {
      return (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 space-y-3">
          <p className="text-sm font-medium text-destructive">Error in {STAGE_LABELS[stage as keyof typeof STAGE_LABELS]}</p>
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{err}</pre>
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
      if (!grooming) return (
        <div className="space-y-3 max-w-lg">
          <GroomingProgressBanner message={groomingProgress || "Running grooming analysis…"} streamText={groomingStreamText} />
        </div>
      );

      // Two-column layout: grooming panel on the left, refine chat on the right.
      // Both columns are independently scrollable and fill the available height.
      // The parent container's max-w-2xl constraint is lifted for this stage (see render below).
      return (
        <div className="flex min-h-0 h-full">
          {/* ── Left: grooming analysis panel ── */}
          <div className="flex-1 min-w-0 overflow-y-auto space-y-3 pr-1">
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
            filesRead={filesRead}
            onApproveEdit={(id) => store().handleApproveEdit(id)}
            onDeclineEdit={(id) => store().handleDeclineEdit(id)}
            onDismissQuestions={() => store()._set({ clarifyingQuestions: [] })}
            onUpdateJira={() => store().pushGroomingToJira()}
            jiraUpdateStatus={jiraUpdateStatus}
            jiraUpdateError={jiraUpdateError}
          />
            {groomingBlockers.length > 0 && <BlockerBanner blockers={groomingBlockers} />}
          </div>

          {/* ── Drag handle ── */}
          {completedStages.has("grooming") && (
            <div
              onMouseDown={onDividerMouseDown}
              className="w-1.5 shrink-0 mx-2 rounded-full cursor-col-resize hover:bg-muted-foreground/30 active:bg-muted-foreground/50 transition-colors"
              title="Drag to resize"
            />
          )}

          {/* ── Right: refine chat panel ── */}
          {completedStages.has("grooming") && (
            <div
              className="shrink-0 flex flex-col min-h-0 border-l pl-5"
              style={{ width: chatPaneWidth }}
            >
              {/* Header */}
              <div className="shrink-0 pb-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Refine this ticket
                </p>
              </div>

              <p className="text-xs text-muted-foreground shrink-0 pb-2">
                Answer the agent's questions or suggest changes to the ticket.
              </p>

              {/* Chat history — scrollable, fills available height */}
              <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1 pb-2">
                {groomingChat.length === 0 && !groomingChatSending && (
                  <p className="text-xs text-muted-foreground italic text-center pt-4">
                    No messages yet. Approve or decline edits on the left, or type a question or suggestion below.
                  </p>
                )}
                {groomingChat.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                      msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}>
                      <p className="whitespace-pre-wrap">{
                        msg.role === "assistant"
                          ? msg.content.replace(/```json[\s\S]*?```/g, "").trim() || msg.content
                          : msg.content
                      }</p>
                    </div>
                  </div>
                ))}
                {/* Tool request cards — shown inline after chat messages */}
                {toolRequests.filter(r => !r.dismissed).map(r => (
                  <ToolRequestCard
                    key={r.id}
                    request={r}
                    onDismiss={dismissToolRequest}
                    onSaved={markToolRequestSaved}
                  />
                ))}
                {groomingChatSending && (
                  <div className="flex justify-start">
                    <div className="bg-muted rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…
                    </div>
                  </div>
                )}
              </div>

              {/* Input — pinned to bottom */}
              <div className="shrink-0 space-y-2 pt-2 border-t">
                <div className="flex gap-2">
                  <Textarea
                    value={groomingChatInput}
                    onChange={(e) => setGroomingChatInput(e.target.value)}
                    placeholder="Suggest changes or ask questions…"
                    className="min-h-[52px] resize-none text-sm"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && groomingChatInput.trim()) {
                        e.preventDefault();
                        sendGroomingChatMessage();
                      }
                    }}
                    disabled={groomingChatSending || proceeding}
                  />
                  <Button
                    size="icon"
                    onClick={sendGroomingChatMessage}
                    disabled={!groomingChatInput.trim() || groomingChatSending || proceeding}
                    title="Send (⌘↵)"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">⌘↵ to send</p>

                {/* Proceed button */}
                <div className="flex items-center justify-between gap-2 border-t pt-2">
                  {groomingBlockers.some(b => b.severity === "blocking") && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      Blocking issues
                    </p>
                  )}
                  <Button
                    onClick={() => store().proceedFromStage("grooming")}
                    disabled={proceeding}
                    variant={groomingBlockers.some(b => b.severity === "blocking") ? "outline" : "default"}
                    size="sm"
                    className="gap-1.5 ml-auto text-xs"
                  >
                    {proceeding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {groomingBlockers.some(b => b.severity === "blocking")
                      ? "Proceed anyway"
                      : "Proceed to Impact Analysis"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }
    if (stage === "impact") {
      if (!impact) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Running impact analysis…</div>;
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
      return (
        <TriageChat
          history={triageHistory}
          input={triageInput}
          onInputChange={setTriageInput}
          onSend={sendTriageMessage}
          onFinalize={finalizePlan}
          sending={triageSending}
          finalizing={triaFinalizing}
        />
      );
    }
    if (stage === "guidance") {
      if (!guidance) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Generating implementation guidance…</div>;
      return (
        <>
          <GuidancePanel data={guidance} />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "implementation") {
      if (!implementation) {
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Writing code…
            </div>
            {implementationStreamText && (
              <pre className="text-xs font-mono bg-muted/50 rounded p-3 whitespace-pre-wrap overflow-auto max-h-96 border">
                {implementationStreamText}
              </pre>
            )}
          </div>
        );
      }
      return (
        <>
          <ImplementationPanel data={implementation} />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "tests") {
      if (!tests) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Generating test suggestions…</div>;
      return (
        <>
          <TestsPanel data={tests} />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "review") {
      if (!review) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reviewing the plan…</div>;
      return (
        <>
          <ReviewPanel data={review} />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "pr") {
      if (!prDescription) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Generating PR description…</div>;
      return (
        <>
          <PrPanel data={prDescription} />
          {renderCheckpoint(stage)}
        </>
      );
    }
    if (stage === "retro") {
      if (!retrospective) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Running retrospective…</div>;
      return (
        <>
          <RetroPanel data={retrospective} onSaveToKb={(entries) => store().saveToKnowledgeBase(entries)} kbSaved={kbSaved} />
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
              onClick={currentStage === "select" ? onBack : () => {
                const cur = store();
                // Save current session unless grooming never completed (stale in-flight run)
                if (
                  cur.selectedIssue &&
                  cur.currentStage !== "select" &&
                  !(cur.currentStage === "grooming" && cur.grooming === null)
                ) {
                  const newSessions = new Map(cur.sessions);
                  newSessions.set(cur.selectedIssue.key, snapshotSession(cur));
                  cur._set({ sessions: newSessions });
                }
                cur._set({ selectedIssue: null, currentStage: "select", isSessionActive: false });
              }}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className={cn(APP_HEADER_TITLE, "shrink-0")}>Implement a Ticket</span>
          </div>

          <div className="min-w-0 flex-1" aria-hidden />

          <HeaderSettingsButton className="relative z-30 shrink-0" />

          {/* Meridian mark centred in header; morphs to pipeline ring when a ticket run is active */}
          <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <div
              className={cn(
                "absolute bottom-0 left-1/2 flex h-14 min-h-0 -translate-x-1/2 justify-center overflow-hidden",
                currentStage !== "select" ? "w-1/2 max-w-md" : "w-auto max-w-md",
                meridianHeaderVisible ? "opacity-100" : "opacity-0"
              )}
              style={{
                transition:
                  "width 700ms ease-in-out, max-width 700ms ease-in-out, opacity 1000ms ease-out",
              }}
            >
              <PipelineProgress
                activeStep={currentStage === "select" ? undefined : stageToStep(viewingStage)}
                logoAlign="center"
                className={`block h-full min-h-0 opacity-100 transition-opacity duration-300 ease-out ${
                  currentStage === "select" ? "w-auto max-h-14" : "w-full"
                }`}
              />
            </div>
          </div>
        </div>
      </header>

      {/* Ticket info bar — shown once a ticket is selected */}
      {selectedIssue && (
        <div className="shrink-0 px-4 py-1.5 border-b bg-muted/20 flex items-center gap-2 min-w-0">
          <JiraTicketLink ticketKey={selectedIssue.key} url={selectedIssue.url} />
          <span className="text-xs text-muted-foreground truncate flex-1">— {selectedIssue.summary}</span>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => selectedIssue.url && openUrl(selectedIssue.url)}>
            <ExternalLink className="h-3.5 w-3.5 mr-1" /> JIRA
          </Button>
        </div>
      )}

      {/* Credential warnings */}
      {(!jiraAvailable || !claudeAvailable) && (
        <div className="shrink-0 px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-200">
          {!jiraAvailable && "JIRA credentials not configured. "}
          {!claudeAvailable && "No AI provider configured — add an Anthropic key, Gemini key, or local LLM URL in Settings."}
        </div>
      )}

      {/* Body — full-width card; fills viewport below chrome so only the stage panel scrolls */}
      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${currentStage === "select" ? "p-4" : "px-2 py-2"}`}>
        <div className={`flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl bg-background/60 ${currentStage === "select" ? "mx-auto max-w-3xl" : ""}`}>
          {currentStage === "select" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <TicketSelector sprintIssues={sprintIssues} loading={loadingIssues} onSelect={startPipeline} sessionKeys={sessionKeys} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <PipelineSidebar
                currentStage={currentStage}
                completedStages={completedStages}
                activeStage={viewingStage}
                pendingApproval={pendingApproval}
                onClickStage={(s) => store()._set({ viewingStage: s as Exclude<Stage, "select"> })}
              />

              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="shrink-0 px-5 pt-5">
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-semibold">
                        {viewingStage === "triage" && !completedStages.has("plan")
                          ? "Triage"
                          : viewingStage === "triage" || viewingStage === "plan"
                            ? "Implementation Plan"
                            : STAGE_LABELS[viewingStage as keyof typeof STAGE_LABELS]}
                      </h2>
                      {currentStage === "complete" && viewingStage === "retro" && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-green-600">
                          <CheckCircle2 className="h-3 w-3" /> Pipeline complete
                        </p>
                      )}
                    </div>
                    {completedStages.has(viewingStage as Stage) &&
                      viewingStage !== "triage" &&
                      viewingStage !== "plan" && (
                        <CopyButton
                          text={
                            JSON.stringify(
                              viewingStage === "grooming"
                                ? grooming
                                : viewingStage === "impact"
                                  ? impact
                                  : viewingStage === "guidance"
                                    ? guidance
                                    : viewingStage === "tests"
                                      ? tests
                                      : viewingStage === "review"
                                        ? review
                                        : null,
                              null,
                              2
                            ) ?? ""
                          }
                          label="Copy JSON"
                        />
                      )}
                  </div>
                </div>
                <div className={`min-h-0 flex-1 ${viewingStage === "grooming" && grooming ? "overflow-hidden px-5 pb-5 flex flex-col" : "overflow-y-auto px-5 pb-5"}`}>
                  <div className={viewingStage === "grooming" && grooming ? "flex-1 min-h-0" : ""}>{renderStageContent(viewingStage)}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
