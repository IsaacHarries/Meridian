import { useEffect, useState, useCallback } from "react";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import {
  ArrowLeft,
  Search,
  Sparkles,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Copy,
  Check,
  ExternalLink,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  type JiraIssue,
  type CredentialStatus,
  type QualityReport,
  type QualityCriterion,
  anthropicComplete,
  jiraComplete,
  getActiveSprintIssues,
  searchJiraIssues,
  assessTicketQuality,
  parseQualityReport,
  openUrl,
} from "@/lib/tauri";

interface TicketQualityScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function compileTicketText(issue: JiraIssue): string {
  const lines: string[] = [];
  lines.push(`Ticket: ${issue.key}`);
  lines.push(`Title: ${issue.summary}`);
  lines.push(`Type: ${issue.issueType}`);
  if (issue.storyPoints != null) lines.push(`Story points: ${issue.storyPoints}`);
  if (issue.priority) lines.push(`Priority: ${issue.priority}`);
  lines.push(`Status: ${issue.status}`);
  if (issue.epicSummary) lines.push(`Epic: ${issue.epicSummary}${issue.epicKey ? ` (${issue.epicKey})` : ""}`);
  if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(", ")}`);
  if (issue.assignee) lines.push(`Assignee: ${issue.assignee.displayName}`);
  lines.push("");
  if (issue.description) {
    lines.push("Description:");
    lines.push(issue.description);
  } else {
    lines.push("Description: (none)");
  }
  return lines.join("\n");
}

function statusAge(issue: JiraIssue): string {
  const updated = new Date(issue.updated);
  const days = Math.floor((Date.now() - updated.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

// ── Overall badge ─────────────────────────────────────────────────────────────

function OverallBadge({ overall }: { overall: QualityReport["overall"] }) {
  if (overall === "ready") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 font-semibold text-sm">
        <CheckCircle2 className="h-4 w-4" /> Ready
      </span>
    );
  }
  if (overall === "needs_work") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 font-semibold text-sm">
        <AlertCircle className="h-4 w-4" /> Needs work
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 font-semibold text-sm">
      <XCircle className="h-4 w-4" /> Not ready
    </span>
  );
}

// ── Criterion row ─────────────────────────────────────────────────────────────

function CriterionRow({ criterion }: { criterion: QualityCriterion }) {
  const [open, setOpen] = useState(false);

  const icon =
    criterion.result === "pass" ? (
      <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
    ) : criterion.result === "partial" ? (
      <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
    ) : (
      <XCircle className="h-4 w-4 text-red-500 shrink-0" />
    );

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className="flex-1 text-sm font-medium">{criterion.name}</span>
        <span className={`text-xs font-medium ${
          criterion.result === "pass" ? "text-green-600" :
          criterion.result === "partial" ? "text-amber-500" : "text-red-500"
        }`}>
          {criterion.result === "pass" ? "Pass" : criterion.result === "partial" ? "Partial" : "Fail"}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>
      {open && (
        <div className="px-4 pb-3 pt-0 text-sm text-muted-foreground border-t bg-muted/20">
          <p className="mt-2 leading-relaxed">{criterion.feedback}</p>
        </div>
      )}
    </div>
  );
}

// ── Quality report panel ──────────────────────────────────────────────────────

interface ReportPanelProps {
  report: QualityReport;
  rawFallback: string | null;
}

function ReportPanel({ report, rawFallback: _ }: ReportPanelProps) {
  const [copiedImprovements, setCopiedImprovements] = useState(false);
  const [copiedQuestions, setCopiedQuestions] = useState(false);

  async function copyImprovements() {
    await navigator.clipboard.writeText(report.suggested_improvements);
    setCopiedImprovements(true);
    setTimeout(() => setCopiedImprovements(false), 2000);
  }

  async function copyQuestions() {
    await navigator.clipboard.writeText(report.open_questions.join("\n"));
    setCopiedQuestions(true);
    setTimeout(() => setCopiedQuestions(false), 2000);
  }

  const passCount = report.criteria.filter((c) => c.result === "pass").length;
  const total = report.criteria.length;

  return (
    <div className="space-y-5">
      {/* Overall */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <OverallBadge overall={report.overall} />
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{report.summary}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-2xl font-bold">{passCount}/{total}</p>
              <p className="text-xs text-muted-foreground">criteria passed</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Criteria checklist */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Readiness Checklist</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {report.criteria.map((c) => (
            <CriterionRow key={c.name} criterion={c} />
          ))}
        </CardContent>
      </Card>

      {/* Open questions */}
      {report.open_questions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">Open Questions</CardTitle>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={copyQuestions}>
                {copiedQuestions ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedQuestions ? "Copied" : "Copy"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <ol className="space-y-2">
              {report.open_questions.map((q, i) => (
                <li key={i} className="flex gap-2.5 text-sm">
                  <span className="text-muted-foreground font-medium shrink-0">{i + 1}.</span>
                  <span className="leading-relaxed">{q}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {/* Suggested improvements */}
      {report.suggested_improvements && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">Suggested Improvements</CardTitle>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={copyImprovements}>
                {copiedImprovements ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedImprovements ? "Copied" : "Copy"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
              {report.suggested_improvements}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Ticket selector panel ─────────────────────────────────────────────────────

interface TicketSelectorProps {
  sprintIssues: JiraIssue[];
  loadingIssues: boolean;
  selected: JiraIssue | null;
  onSelect: (issue: JiraIssue) => void;
}

function TicketSelector({ sprintIssues, loadingIssues, selected, onSelect }: TicketSelectorProps) {
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<JiraIssue[]>([]);
  const [searching, setSearching] = useState(false);

  const q = search.trim();

  // Debounced JQL search
  useEffect(() => {
    if (!q) {
      setSearchResults([]);
      return;
    }
    // If it looks like a ticket key, search by key; otherwise text search
    const isKey = /^[A-Z]+-\d+$/i.test(q);
    const jql = isKey
      ? `key = "${q.toUpperCase()}"`
      : `text ~ "${q}" ORDER BY updated DESC`;

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchJiraIssues(jql, 20);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [q]);

  const displayList = q ? searchResults : sprintIssues;
  const showLoading = q ? searching : loadingIssues;

  function issueRow(issue: JiraIssue) {
    const isSelected = selected?.id === issue.id;
    return (
      <button
        key={issue.id}
        onClick={() => onSelect(issue)}
        className={`w-full text-left px-3 py-2.5 rounded-md border transition-colors hover:bg-muted/60 ${
          isSelected ? "border-primary bg-primary/5" : "border-transparent"
        }`}
      >
        <div className="flex items-center gap-2">
          <JiraTicketLink ticketKey={issue.key} url={issue.url} />
          <Badge variant="outline" className="text-xs py-0 h-5">{issue.issueType}</Badge>
          {issue.storyPoints != null && (
            <span className="ml-auto text-xs text-muted-foreground shrink-0">{issue.storyPoints}pt</span>
          )}
        </div>
        <p className="text-sm mt-0.5 leading-snug line-clamp-2">{issue.summary}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">{issue.status}</span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">{statusAge(issue)}</span>
        </div>
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          placeholder="Search tickets or enter key (e.g. PROJ-123)…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="space-y-1 max-h-96 overflow-y-auto pr-1">
        {showLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {q ? "Searching…" : "Loading sprint issues…"}
          </div>
        )}

        {!showLoading && displayList.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            {q ? "No tickets found." : "No active sprint tickets found."}
          </p>
        )}

        {!showLoading && displayList.map(issueRow)}
      </div>

      {!q && !loadingIssues && sprintIssues.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {sprintIssues.length} active sprint tickets · Search to find backlog tickets
        </p>
      )}
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function TicketQualityScreen({ credStatus, onBack }: TicketQualityScreenProps) {
  const [sprintIssues, setSprintIssues] = useState<JiraIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(true);

  const [selected, setSelected] = useState<JiraIssue | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [report, setReport] = useState<QualityReport | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);

  const claudeAvailable = anthropicComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  // Load sprint issues
  useEffect(() => {
    if (!jiraAvailable) {
      setLoadingIssues(false);
      return;
    }
    getActiveSprintIssues()
      .then(setSprintIssues)
      .catch(() => {})
      .finally(() => setLoadingIssues(false));
  }, [jiraAvailable]);

  const selectTicket = useCallback((issue: JiraIssue) => {
    setSelected(issue);
    setReport(null);
    setRawError(null);
  }, []);

  async function runAssessment() {
    if (!selected) return;
    setAssessing(true);
    setReport(null);
    setRawError(null);
    try {
      const ticketText = compileTicketText(selected);
      const raw = await assessTicketQuality(ticketText);
      const parsed = parseQualityReport(raw);
      if (parsed) {
        setReport(parsed);
      } else {
        setRawError(raw);
      }
    } catch (e) {
      setRawError(String(e));
    } finally {
      setAssessing(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <div className="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold leading-none">Ticket Quality Checker</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Assess tickets for sprint readiness before planning
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex items-center">
        <div className="w-full max-w-5xl mx-auto px-6 py-6 bg-background/60 rounded-xl">
        {/* Credential warnings */}
        {!jiraAvailable && (
          <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            JIRA credentials not configured — ticket search unavailable.
          </div>
        )}
        {!claudeAvailable && (
          <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            Anthropic API key not configured — quality assessment unavailable.
          </div>
        )}

        <div className="grid grid-cols-[380px_1fr] gap-6 items-start">
          {/* Left: ticket selector */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Select a Ticket</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <TicketSelector
                  sprintIssues={sprintIssues}
                  loadingIssues={loadingIssues}
                  selected={selected}
                  onSelect={selectTicket}
                />
              </CardContent>
            </Card>
          </div>

          {/* Right: selected ticket + report */}
          <div className="space-y-4">
            {!selected && (
              <div className="flex items-center justify-center rounded-lg border border-dashed h-48 text-muted-foreground text-sm">
                Select a ticket to assess its sprint readiness
              </div>
            )}

            {selected && (
              <>
                {/* Ticket summary card */}
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <JiraTicketLink ticketKey={selected.key} url={selected.url} />
                          <Badge variant="outline" className="text-xs">{selected.issueType}</Badge>
                          {selected.storyPoints != null && (
                            <Badge variant="secondary" className="text-xs">{selected.storyPoints} pts</Badge>
                          )}
                          {selected.priority && (
                            <Badge variant="outline" className="text-xs">{selected.priority}</Badge>
                          )}
                        </div>
                        <CardTitle className="text-base leading-snug">{selected.summary}</CardTitle>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => selected.url && openUrl(selected.url)}
                        title="Open in JIRA"
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-1" /> JIRA
                      </Button>
                    </div>

                    {selected.epicSummary && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Epic: {selected.epicSummary}
                      </p>
                    )}
                    {selected.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {selected.labels.map((l) => (
                          <span key={l} className="px-1.5 py-0.5 rounded bg-muted text-xs text-muted-foreground">
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                  </CardHeader>

                  {selected.description && (
                    <CardContent className="pt-0">
                      <p className="text-xs text-muted-foreground font-medium mb-1">Description</p>
                      <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed line-clamp-6">
                        {selected.description}
                      </pre>
                    </CardContent>
                  )}
                </Card>

                {/* Run button */}
                <div className="flex items-center gap-3">
                  <Button
                    onClick={runAssessment}
                    disabled={assessing || !claudeAvailable}
                    className="gap-2"
                  >
                    {assessing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Assessing…
                      </>
                    ) : report ? (
                      <>
                        <RefreshCw className="h-4 w-4" />
                        Re-assess
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Run Quality Check
                      </>
                    )}
                  </Button>
                  {report && !assessing && (
                    <p className="text-xs text-muted-foreground">Assessment complete</p>
                  )}
                </div>

                {/* Raw error fallback */}
                {rawError && !assessing && (
                  <Card className="border-destructive/50">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-destructive">Assessment error</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono">
                        {rawError}
                      </pre>
                    </CardContent>
                  </Card>
                )}

                {/* Report */}
                {report && !assessing && (
                  <ReportPanel report={report} rawFallback={null} />
                )}
              </>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
