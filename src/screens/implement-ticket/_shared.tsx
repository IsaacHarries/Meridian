import { MarkdownBlock } from "@/components/MarkdownBlock";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type GroomingBlocker, type ImplementTicketState, type Stage } from "@/stores/implementTicket/types";
import {
    AlertTriangle,
    Check,
    ChevronDown,
    ChevronRight,
    Copy,
    Loader2,
    RefreshCw,
} from "lucide-react";
import { useState } from "react";

// ── Pipeline stage config ─────────────────────────────────────────────────────

export const STAGE_LABELS: Record<Exclude<Stage, "select">, string> = {
  grooming: "Grooming",
  impact: "Impact Analysis",
  triage: "Triage",
  plan: "Implementation Plan",
  implementation: "Implementation",
  replan: "Plan Revision",
  tests_plan: "Test Plan",
  tests: "Tests",
  review: "Code Review",
  pr: "PR Description",
  retro: "Retrospective",
  complete: "Complete",
};

export const STAGE_ORDER: Exclude<Stage, "select" | "complete">[] = [
  "grooming",
  "impact",
  "triage",
  "plan",
  "implementation",
  "tests_plan",
  "tests",
  "review",
  "pr",
  "retro",
];

export const NEXT_STAGE_LABEL: Partial<Record<Stage, string>> = {
  grooming: "Proceed to Impact Analysis",
  impact: "Proceed to Triage",
  plan: "Proceed to Implementation",
  implementation: "Proceed to Test Suggestions",
  tests: "Proceed to Code Review",
  review: "Proceed to PR Description",
  pr: "Proceed to Retrospective",
  retro: "Mark Pipeline Complete",
};

// ── Stage → pipeline step mapping ────────────────────────────────────────────

export function stageToStep(stage: Stage): number | undefined {
  if (stage === "select") return undefined;
  const map: Record<Exclude<Stage, "select">, number> = {
    grooming: 0,
    impact: 1,
    triage: 2,
    plan: 2,
    implementation: 3,
    // Plan revision is a sub-state of the implementation step in the
    // PipelineProgress visualisation — keep the same step index so the
    // progress bar doesn't visibly jump backward.
    replan: 3,
    // Test plan and final tests both fall under the "tests" pipeline-step.
    tests_plan: 4,
    tests: 4,
    review: 5,
    pr: 6,
    retro: 7,
    complete: 7,
  };
  return map[stage];
}

// ── Diff helpers ─────────────────────────────────────────────────────────────

/**
 * Diff two string arrays and return each item tagged as "added", "removed", or "unchanged".
 * Simple string equality — good enough for AC/dependencies/etc.
 */
export function diffStringArrays(
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

// ── BlockerBanner ────────────────────────────────────────────────────────────

export function BlockerBanner({ blockers }: { blockers: GroomingBlocker[] }) {
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

// ── CollapsibleList ──────────────────────────────────────────────────────────

export function CollapsibleList({
  title,
  items,
  icon,
  loading,
  skeletonCount = 3,
}: {
  title: string;
  items: string[];
  icon?: React.ReactNode;
  /** When true and `items` is empty, render the section with skeleton
   *  glow rows instead of hiding it entirely — keeps the panel layout
   *  stable while the agent is still streaming. */
  loading?: boolean;
  skeletonCount?: number;
}) {
  const [open, setOpen] = useState(true);
  const skeletonMode = items.length === 0 && loading;
  if (items.length === 0 && !loading) return null;
  return (
    <div className="border rounded-md overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className="flex-1 text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">
          {skeletonMode ? "…" : items.length}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <ul className="px-3 pb-2 pt-1 space-y-1">
          {skeletonMode ? (
            <>
              {Array.from({ length: skeletonCount }).map((_, i) => (
                <li key={i} className="flex gap-2 items-center py-0.5">
                  <span className="text-muted-foreground/40 shrink-0">·</span>
                  <Skeleton
                    className="h-3"
                    style={{ width: ["88%", "72%", "94%", "80%"][i % 4] }}
                  />
                </li>
              ))}
            </>
          ) : (
            items.map((item, i) => (
              <li key={i} className="text-sm text-muted-foreground flex gap-2">
                <span className="text-muted-foreground shrink-0">·</span>
                <span>{item}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ── CopyButton ───────────────────────────────────────────────────────────────

export function CopyButton({
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

// ── CollapsibleSection (used by description + bug detail panels) ─────────────

export function CollapsibleSection({
  heading,
  content,
}: {
  heading: string | null;
  content: string;
}) {
  const [open, setOpen] = useState(true);
  if (!heading) {
    // Preamble prose (before first heading) — always shown inline without toggle.
    const trimmed = content.trim();
    if (!trimmed) return null;
    return (
      <div className="px-3 py-2">
        <MarkdownBlock text={trimmed} />
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
          {/* Rendered through MarkdownBlock so embedded JIRA-attachment
              images surface (the Rust ADF→markdown pass emits `![alt](url)`
              for media nodes; everything else round-trips as plain prose). */}
          <MarkdownBlock text={content.trim()} />
        </div>
      )}
    </div>
  );
}

// ── DiffedCollapsibleList ────────────────────────────────────────────────────

interface DiffedListProps {
  title: string;
  items: { text: string; status: "added" | "removed" | "unchanged" }[];
  icon?: React.ReactNode;
  hasChanges: boolean;
}

export function DiffedCollapsibleList({
  title,
  items,
  icon,
  hasChanges,
  loading,
}: DiffedListProps & { loading?: boolean }) {
  const [open, setOpen] = useState(true);
  if (items.length === 0 && !loading) return null;
  const skeletonMode = items.length === 0 && loading;
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
          {skeletonMode
            ? "…"
            : items.filter((i) => i.status !== "removed").length}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <ul className="px-3 pb-2 pt-1 space-y-1">
          {skeletonMode ? (
            <>
              {Array.from({ length: 3 }).map((_, i) => (
                <li key={i} className="flex gap-2 items-center py-0.5">
                  <span className="text-muted-foreground/40 shrink-0">·</span>
                  <Skeleton
                    className="h-3"
                    style={{ width: ["86%", "70%", "92%"][i % 3] }}
                  />
                </li>
              ))}
            </>
          ) : (
            items.map((item, i) => (
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
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ── ResolvableList ───────────────────────────────────────────────────────────
// Renders the union of `initial` and `current`, marking items missing from
// `current` as resolved (strikethrough). Used for clarifying questions so
// the engineer can see what was answered without losing the original list.

export function ResolvableList({
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

// ── RevisionRow (triage revisions timeline entry) ────────────────────────────

export interface TriageRevision {
  /** The user's clarification that triggered this revision. */
  clarification: string;
  /** The agent's proposal that was current *before* this clarification was sent. */
  previousProposal: string;
}

export function summarizeClarification(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 110 ? oneLine.slice(0, 107) + "…" : oneLine;
}

export function RevisionRow({
  revision,
  index,
}: {
  revision: TriageRevision;
  index: number;
}) {
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
            <p className="text-xs leading-relaxed whitespace-pre-wrap">
              {revision.clarification}
            </p>
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

// ── StreamingLoader ──────────────────────────────────────────────────────────

export function StreamingLoader({
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

// ── StageApprovalRow ─────────────────────────────────────────────────────────

interface StageApprovalRowProps {
  stage: Stage;
  onProceed: () => void;
  proceeding: boolean;
  hasBlockingIssues?: boolean;
  onRetry?: () => void;
  disabledReason?: string;
}

export function StageApprovalRow({
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

// ── PipelineActivityStrip ────────────────────────────────────────────────────
//
// Live "what is the agent doing right now" line that sits between the
// chat thread and the input. Shows the active pipeline node, the file
// the implementation node is currently writing (with x/N progress),
// and the most recent tool call (read/write/grep/glob). A Stop button
// aborts the run — useful when the user spots a runaway loop or the
// model picking the wrong file path before tokens leak away.
//
// Pure-presentational; the parent owns the activity snapshot via the
// implementTicketStore listener so the strip just renders it.

export const ACTIVITY_NODE_LABELS: Record<string, string> = {
  grooming: "Grooming",
  impact: "Impact analysis",
  triage: "Triage",
  do_plan: "Implementation plan",
  implementation: "Implementation",
  verification: "Verifying change",
  test_plan: "Test plan",
  test_gen: "Writing tests",
  code_review: "Code review",
  pr_description: "PR description",
  do_retrospective: "Retrospective",
  orchestrator: "Agent thinking",
  tool: "Tool",
};

export function PipelineActivityStrip({
  activity,
  onStop,
}: {
  activity: NonNullable<ImplementTicketState["pipelineActivity"]>;
  onStop: () => void;
}) {
  const label = ACTIVITY_NODE_LABELS[activity.node] ?? activity.node;
  const fileLine =
    activity.file && activity.totalFiles
      ? `${activity.file} (${activity.fileIndex}/${activity.totalFiles})`
      : null;
  const toolLine = activity.tool
    ? `→ ${activity.tool}${activity.toolArg ? ` ${activity.toolArg}` : ""}`
    : null;
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 flex items-center gap-2 text-[11px]">
      <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
      <div className="flex-1 min-w-0 leading-tight">
        <div className="font-medium text-foreground/90 truncate">
          {label}
          {fileLine && (
            <span className="text-muted-foreground font-normal">
              {" "}
              · {fileLine}
            </span>
          )}
        </div>
        {toolLine && (
          <div className="text-muted-foreground font-mono text-[10px] truncate">
            {toolLine}
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[11px] shrink-0"
        onClick={onStop}
        title="Stop the active pipeline run"
      >
        Stop
      </Button>
    </div>
  );
}

