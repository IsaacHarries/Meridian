import { MarkdownBlock } from "@/components/MarkdownBlock";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { currentModelKeyFor } from "@/lib/tauri/core";
import { type JiraIssue, type JiraSprint } from "@/lib/tauri/jira";
import { type MeetingRecord, listMeetings } from "@/lib/tauri/meetings";
import { generateSprintRetrospective } from "@/lib/tauri/workflows";
import { extractTiptapPlainText } from "@/lib/tiptapText";
import { subscribeWorkflowStream } from "@/lib/workflowStream";
import { useTokenUsageStore } from "@/stores/tokenUsageStore";
import {
    AlertTriangle,
    Check,
    Copy,
    Loader2,
    RefreshCw,
    Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { isDone } from "./_shared";

// Compact "X ago" formatter for the cached-summary timestamp. Seconds-precise
// freshness isn't useful here — minutes/hours/days is what matters for
// deciding whether to regenerate.
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Selects meetings whose start time falls within the sprint window. The
// boundary check is loose on purpose: sprint dates often have time-of-day
// noise, and a meeting started slightly before/after still belongs to the
// sprint conversationally.
function meetingsInSprint(
  sprint: JiraSprint,
  meetings: MeetingRecord[],
): MeetingRecord[] {
  const start = sprint.startDate ?? "";
  const end = sprint.endDate ?? "9999";
  return meetings
    .filter((m) => m.startedAt >= start && m.startedAt <= end)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function formatMeetingsBlock(meetings: MeetingRecord[]): string {
  if (meetings.length === 0) {
    return "Meetings captured this sprint: none.";
  }
  const lines: string[] = [`Meetings captured this sprint (${meetings.length}):`];
  for (const m of meetings) {
    const date = m.startedAt.slice(0, 10);
    const kind = m.kind === "notes" ? "notes" : "transcript";
    const tagStr = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
    const title = m.title.trim() || "(untitled)";
    lines.push("");
    lines.push(`— ${date} · ${title} · ${kind}${tagStr}`);
    if (m.summary) {
      lines.push(`  Summary: ${m.summary.replace(/\s+/g, " ").trim()}`);
    } else if (m.kind === "notes") {
      // No summary yet — include the user's notes verbatim. Notes are stored
      // as TipTap JSON; flatten to markdown-ish plain text so the retro agent
      // can read them.
      const plain = extractTiptapPlainText(m.notes);
      if (plain) {
        lines.push("  Notes:");
        for (const ln of plain.split("\n")) {
          lines.push(`    ${ln}`);
        }
      }
    }
    if (m.decisions.length > 0) {
      lines.push(`  Decisions: ${m.decisions.join("; ")}`);
    }
    if (m.actionItems.length > 0) {
      lines.push(`  Action items: ${m.actionItems.join("; ")}`);
    }
  }
  return lines.join("\n");
}

function buildSprintContext(
  sprint: JiraSprint,
  issues: JiraIssue[],
  prs: BitbucketPr[],
  meetings: MeetingRecord[],
): string {
  const done = issues.filter((i) => isDone(i, sprint.endDate));
  const committed = issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const completed = done.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const carryOver = issues.filter((i) => !isDone(i, sprint.endDate));
  const sprintPrsLocal = prs.filter((pr) => {
    const start = sprint.startDate ?? "";
    const end = sprint.endDate ?? "9999";
    return pr.updatedOn >= start && pr.updatedOn <= end;
  });
  const merged = sprintPrsLocal.filter((pr) => pr.state === "MERGED");
  const avgMerge =
    merged.length > 0
      ? Math.round(
          merged.reduce(
            (s, pr) =>
              s +
              (new Date(pr.updatedOn).getTime() - new Date(pr.createdOn).getTime()) /
                3_600_000,
            0
          ) / merged.length
        )
      : null;

  const devMap = new Map<string, { done: number; total: number; pts: number }>();
  for (const issue of issues) {
    const name = issue.assignee?.displayName ?? "Unassigned";
    if (!devMap.has(name)) devMap.set(name, { done: 0, total: 0, pts: 0 });
    const entry = devMap.get(name)!;
    entry.total++;
    entry.pts += issue.storyPoints ?? 0;
    if (isDone(issue, sprint.endDate)) entry.done++;
  }

  const lines: string[] = [
    `Sprint: ${sprint.name}`,
    sprint.goal ? `Goal: ${sprint.goal}` : "",
    `Dates: ${sprint.startDate?.slice(0, 10) ?? "?"} → ${sprint.endDate?.slice(0, 10) ?? "?"}`,
    "",
    `Story points: ${completed} completed / ${committed} committed (${committed > 0 ? Math.round((completed / committed) * 100) : 0}%)`,
    `Tickets: ${done.length} done / ${issues.length} total`,
    carryOver.length > 0
      ? `Carry-over (not completed): ${carryOver.map((i) => `${i.key} "${i.summary}"`).join(", ")}`
      : "No carry-over tickets.",
    "",
    `PRs merged this sprint: ${merged.length}`,
    `Total PRs: ${sprintPrsLocal.length}`,
    avgMerge !== null ? `Average time to merge: ${avgMerge}h` : "",
    "",
    "Team breakdown:",
    ...Array.from(devMap.entries()).map(
      ([name, d]) =>
        `  ${name}: ${d.done}/${d.total} tickets done, ${d.pts} story points`
    ),
    "",
    "=== MEETINGS ===",
    formatMeetingsBlock(meetings),
  ];

  return lines.filter((l) => l !== "").join("\n");
}

export function AiSummaryPanel({
  sprint,
  issues,
  prs,
  cachedSummary,
  cachedSummaryAt,
  onSummaryGenerated,
}: {
  sprint: JiraSprint;
  issues: JiraIssue[];
  prs: BitbucketPr[];
  cachedSummary?: string;
  cachedSummaryAt?: string;
  onSummaryGenerated?: (summary: string) => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    cachedSummary ? "done" : "idle",
  );
  const [summary, setSummary] = useState(cachedSummary ?? "");
  const [generatedAt, setGeneratedAt] = useState<string | undefined>(cachedSummaryAt);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Re-seed when the parent swaps to a different sprint's cached data, so
  // sprint navigation shows the correct cached summary instead of stale state
  // from the previously-viewed sprint.
  useEffect(() => {
    setSummary(cachedSummary ?? "");
    setGeneratedAt(cachedSummaryAt);
    setState(cachedSummary ? "done" : "idle");
    setError("");
  }, [sprint.id, cachedSummary, cachedSummaryAt]);

  async function generate() {
    setState("loading");
    setError("");
    setSummary("");
    const stream = await subscribeWorkflowStream(
      "sprint-retrospective-workflow-event",
      (text) => setSummary(text),
      {
        onUsage: (usage) =>
          useTokenUsageStore
            .getState()
            .setCurrentCallUsage(
              "retrospectives",
              usage,
              currentModelKeyFor("retrospectives"),
            ),
      },
    );
    try {
      // Pull meetings on demand rather than at screen mount — that way a
      // recently-recorded meeting is always reflected without a refresh.
      const allMeetings = await listMeetings().catch(() => [] as MeetingRecord[]);
      const sprintMeetings = meetingsInSprint(sprint, allMeetings);
      const context = buildSprintContext(sprint, issues, prs, sprintMeetings);
      const result = await generateSprintRetrospective(context);
      setSummary(result);
      setGeneratedAt(new Date().toISOString());
      setState("done");
      onSummaryGenerated?.(result);
    } catch (e) {
      setError(String(e));
      setState("error");
    } finally {
      await stream.dispose();
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-purple-400" />
              AI Retrospective Summary
            </CardTitle>
            {state === "done" && generatedAt && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Generated {formatRelativeTime(generatedAt)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {state === "done" && (
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={handleCopy}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
            <Button
              size="sm"
              variant={state === "done" ? "outline" : "default"}
              className="gap-1.5"
              onClick={generate}
              disabled={state === "loading"}
            >
              {state === "loading" ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…</>
              ) : state === "done" ? (
                <><RefreshCw className="h-3.5 w-3.5" /> Regenerate</>
              ) : (
                <><Sparkles className="h-3.5 w-3.5" /> Generate summary</>
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {state === "idle" && (
          <p className="text-sm text-muted-foreground">
            Generate a retrospective summary — what went well, what could improve, patterns,
            and suggested discussion points for the retro meeting.
          </p>
        )}
        {state === "loading" && !summary && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            The AI is analysing the sprint…
          </div>
        )}
        {state === "loading" && summary && <MarkdownBlock text={summary} />}
        {state === "error" && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}
        {state === "done" && <MarkdownBlock text={summary} />}
      </CardContent>
    </Card>
  );
}
