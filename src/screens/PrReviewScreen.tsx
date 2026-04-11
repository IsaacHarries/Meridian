import { useEffect, useState, useCallback, useRef } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  type BitbucketPr,
  type BitbucketComment,
  type JiraIssue,
  type CredentialStatus,
  type ReviewReport,
  type ReviewFinding,
  type ReviewLens,
  anthropicComplete,
  bitbucketComplete,
  jiraComplete,
  getOpenPrs,
  getPrsForReview,
  getPrDiff,
  getPrComments,
  getIssue,
  getNonSecretConfig,
  reviewPr,
  parseReviewReport,
  openUrl,
} from "@/lib/tauri";
import { JiraTicketLink } from "@/components/JiraTicketLink";

interface PrReviewScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_DIFF_CHARS = 120_000;

function prAge(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function sanitizeId(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

function compileReviewText(
  pr: BitbucketPr,
  diff: string,
  comments: BitbucketComment[],
  issue: JiraIssue | null
): string {
  const lines: string[] = [];

  lines.push("=== PULL REQUEST ===");
  lines.push(`PR #${pr.id}: ${pr.title}`);
  lines.push(`Author: ${pr.author.displayName}`);
  lines.push(`Branch: ${pr.sourceBranch} → ${pr.destinationBranch}`);
  lines.push(`Created: ${pr.createdOn.slice(0, 10)} | Updated: ${pr.updatedOn.slice(0, 10)}`);
  if (pr.description) {
    lines.push("");
    lines.push("Description:");
    lines.push(pr.description);
  }

  if (issue) {
    lines.push("");
    lines.push("=== LINKED JIRA TICKET ===");
    lines.push(`${issue.key}: ${issue.summary}`);
    if (issue.description) lines.push(issue.description);
  }

  const topLevelComments = comments.filter((c) => c.parentId == null && !c.inline);
  if (topLevelComments.length > 0) {
    lines.push("");
    lines.push("=== EXISTING REVIEW COMMENTS ===");
    for (const c of topLevelComments.slice(0, 20)) {
      lines.push(`[${c.author.displayName}]: ${c.content}`);
    }
  }

  const inlineComments = comments.filter((c) => c.inline);
  if (inlineComments.length > 0) {
    lines.push("");
    lines.push("=== INLINE COMMENTS ===");
    for (const c of inlineComments.slice(0, 30)) {
      const loc = c.inline ? `${c.inline.path}${c.inline.toLine ? ` L${c.inline.toLine}` : ""}` : "";
      lines.push(`[${c.author.displayName} on ${loc}]: ${c.content}`);
    }
  }

  lines.push("");
  lines.push("=== DIFF ===");
  const trimmedDiff =
    diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated — showing first 120k characters]"
      : diff;
  lines.push(trimmedDiff);

  return lines.join("\n");
}

// ── Diff viewer ───────────────────────────────────────────────────────────────

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

function DiffLine({ line }: { line: string }) {
  let cls = "text-muted-foreground";
  if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30";
  else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30";
  else if (line.startsWith("@@")) cls = "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/20";
  else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
    cls = "text-muted-foreground font-medium";
  }
  return <div className={`font-mono text-xs leading-5 px-2 whitespace-pre ${cls}`}>{line || " "}</div>;
}

interface DiffSectionCardProps {
  section: DiffSection;
  highlighted: boolean;
  sectionRef: (el: HTMLDivElement | null) => void;
}

function DiffSectionCard({ section, highlighted, sectionRef }: DiffSectionCardProps) {
  const [expanded, setExpanded] = useState(true);

  // Auto-expand when highlighted
  useEffect(() => {
    if (highlighted) setExpanded(true);
  }, [highlighted]);

  const addedLines = section.lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removedLines = section.lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  return (
    <div
      ref={sectionRef}
      id={`diff-file-${sanitizeId(section.path)}`}
      className={`border rounded-md overflow-hidden transition-colors ${
        highlighted ? "border-primary shadow-sm" : "border-border"
      }`}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/40 hover:bg-muted/70 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="flex-1 text-xs font-mono truncate">{section.path}</span>
        <span className="text-xs text-green-600 shrink-0">+{addedLines}</span>
        <span className="text-xs text-red-500 shrink-0 ml-1">-{removedLines}</span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-1" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-1" />
        )}
      </button>
      {expanded && (
        <div className="overflow-x-auto">
          {section.lines.map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </div>
      )}
    </div>
  );
}

interface DiffViewerProps {
  diff: string;
  highlightedFile: string | null;
}

function DiffViewer({ diff, highlightedFile }: DiffViewerProps) {
  const sections = parseDiffSections(diff);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Scroll to highlighted file
  useEffect(() => {
    if (!highlightedFile) return;
    const el = sectionRefs.current.get(highlightedFile);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [highlightedFile]);

  if (!diff) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground border rounded-md border-dashed">
        Diff not loaded
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sections.map((section) => (
        <DiffSectionCard
          key={section.path}
          section={section}
          highlighted={highlightedFile === section.path}
          sectionRef={(el) => {
            if (el) sectionRefs.current.set(section.path, el);
            else sectionRefs.current.delete(section.path);
          }}
        />
      ))}
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
  onJumpToFile: (path: string) => void;
}

function FindingCard({ finding, onJumpToFile }: FindingCardProps) {
  const [expanded, setExpanded] = useState(finding.severity === "blocking");

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
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t bg-muted/20 space-y-2">
          <p className="text-sm text-muted-foreground leading-relaxed">{finding.description}</p>
          {finding.file && (
            <button
              onClick={() => onJumpToFile(finding.file!)}
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-mono"
            >
              <FileCode className="h-3 w-3" />
              {finding.file}
              {finding.line_range && ` ${finding.line_range}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface LensPanelProps {
  lens: ReviewLens;
  onJumpToFile: (path: string) => void;
}

function LensPanel({ lens, onJumpToFile }: LensPanelProps) {
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
              <FindingCard key={i} finding={f} onJumpToFile={onJumpToFile} />
            ))}
          </div>
        </>
      )}
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
}

function PrSelector({ prsForReview, allOpenPrs, loading, onSelect, jiraBaseUrl, myAccountId }: PrSelectorProps) {
  const [showAll, setShowAll] = useState(false);
  const list = showAll ? allOpenPrs : prsForReview;

  function PrRow({ pr }: { pr: BitbucketPr }) {
    const iApproved = myAccountId
      ? pr.reviewers.some((r) => r.user.accountId === myAccountId && r.approved)
      : false;

    return (
      <button
        onClick={() => onSelect(pr)}
        className="w-full text-left px-4 py-3 rounded-md border hover:bg-muted/60 transition-colors space-y-1"
      >
        <div className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs font-mono text-muted-foreground">#{pr.id}</span>
          {iApproved && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> Approved
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
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">
          {showAll ? "All open PRs" : "PRs assigned to you for review"}
        </h2>
        <Button variant="outline" size="sm" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show mine only" : "Show all open"}
        </Button>
      </div>

      {list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-2">
          <GitPullRequest className="h-8 w-8 opacity-40" />
          <p className="text-sm">
            {showAll ? "No open PRs found." : "No PRs assigned to you for review."}
          </p>
          {!showAll && (
            <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
              Show all open PRs
            </Button>
          )}
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
  const claudeAvailable = anthropicComplete(credStatus);
  const bbAvailable = bitbucketComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  // PR list state
  const [prsForReview, setPrsForReview] = useState<BitbucketPr[]>([]);
  const [allOpenPrs, setAllOpenPrs] = useState<BitbucketPr[]>([]);
  const [loadingPrs, setLoadingPrs] = useState(true);
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [myAccountId, setMyAccountId] = useState("");

  // Selected PR state
  const [selectedPr, setSelectedPr] = useState<BitbucketPr | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [comments, setComments] = useState<BitbucketComment[]>([]);
  const [linkedIssue, setLinkedIssue] = useState<JiraIssue | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Review state
  const [reviewing, setReviewing] = useState(false);
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [highlightedFile, setHighlightedFile] = useState<string | null>(null);

  const [copiedSummary, setCopiedSummary] = useState(false);

  // Load PR lists on mount
  useEffect(() => {
    getNonSecretConfig().then((cfg) => {
      setJiraBaseUrl(cfg["jira_base_url"] ?? "");
      setMyAccountId(cfg["jira_account_id"] ?? "");
    }).catch(() => {});
    if (!bbAvailable) { setLoadingPrs(false); return; }
    Promise.allSettled([getPrsForReview(), getOpenPrs()]).then(([forReview, allOpen]) => {
      if (forReview.status === "fulfilled") setPrsForReview(forReview.value.filter((pr) => !pr.draft));
      if (allOpen.status === "fulfilled") setAllOpenPrs(allOpen.value.filter((pr) => !pr.draft));
      setLoadingPrs(false);
    });
  }, [bbAvailable]);

  const selectPr = useCallback(async (pr: BitbucketPr) => {
    setSelectedPr(pr);
    setDiff("");
    setComments([]);
    setLinkedIssue(null);
    setReport(null);
    setRawError(null);
    setLoadingDetails(true);

    const fetches: Promise<void>[] = [
      getPrDiff(pr.id).then(setDiff).catch(() => {}),
      getPrComments(pr.id).then(setComments).catch(() => {}),
    ];

    if (pr.jiraIssueKey && jiraAvailable) {
      fetches.push(getIssue(pr.jiraIssueKey).then(setLinkedIssue).catch(() => {}));
    }

    await Promise.allSettled(fetches);
    setLoadingDetails(false);
  }, [jiraAvailable]);

  async function runReview() {
    if (!selectedPr) return;
    setReviewing(true);
    setReport(null);
    setRawError(null);
    try {
      const text = compileReviewText(selectedPr, diff, comments, linkedIssue);
      const raw = await reviewPr(text);
      const parsed = parseReviewReport(raw);
      if (parsed) {
        setReport(parsed);
      } else {
        setRawError(raw);
      }
    } catch (e) {
      setRawError(String(e));
    } finally {
      setReviewing(false);
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
    ] as const) {
      const lens = report.lenses[key];
      if (lens.findings.length > 0) {
        lines.push(`\n**${label}** — ${lens.assessment}`);
        for (const f of lens.findings) {
          lines.push(`- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line_range ? " " + f.line_range : ""})` : ""}`);
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
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <div className="border-b bg-background/95 backdrop-blur sticky top-0 z-20">
        <div className="px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={selectedPr ? () => { setSelectedPr(null); setReport(null); } : onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold leading-none">PR Review Assistant</h1>
            {selectedPr && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                #{selectedPr.id} — {selectedPr.title}
              </p>
            )}
          </div>
          {selectedPr && (
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => selectedPr?.url && openUrl(selectedPr.url)}
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1" /> Bitbucket
              </Button>
              {linkedIssue && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => linkedIssue.url && openUrl(linkedIssue.url)}
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1" /> {linkedIssue.key}
                </Button>
              )}
              {report && (
                <Button variant="ghost" size="sm" onClick={copySummary} className="gap-1">
                  {copiedSummary ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedSummary ? "Copied" : "Copy report"}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Credential warnings */}
      {(!bbAvailable || !claudeAvailable) && (
        <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-200">
          {!bbAvailable && "Bitbucket credentials not configured. "}
          {!claudeAvailable && "Anthropic API key not configured — AI review unavailable."}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {!selectedPr ? (
          /* PR selector */
          <div className="px-6 py-6">
            <PrSelector
              prsForReview={prsForReview}
              allOpenPrs={allOpenPrs}
              loading={loadingPrs}
              onSelect={selectPr}
              jiraBaseUrl={jiraBaseUrl}
              myAccountId={myAccountId}
            />
          </div>
        ) : (
          /* Review layout */
          <div className="flex h-full" style={{ height: "calc(100vh - 57px)" }}>
            {/* Left: diff viewer */}
            <div className="flex-1 overflow-y-auto border-r p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Diff</p>
                {loadingDetails && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                  </span>
                )}
              </div>
              {diff ? (
                <DiffViewer diff={diff} highlightedFile={highlightedFile} />
              ) : loadingDetails ? null : (
                <div className="flex items-center justify-center h-48 text-sm text-muted-foreground border rounded-md border-dashed">
                  No diff available
                </div>
              )}
            </div>

            {/* Right: review panel */}
            <div className="w-[420px] shrink-0 overflow-y-auto flex flex-col">
              {/* Run button + overall verdict */}
              <div className="p-4 border-b space-y-3">
                <div className="flex items-center gap-2">
                  <Button
                    onClick={runReview}
                    disabled={reviewing || !claudeAvailable || loadingDetails}
                    className="gap-2 flex-1"
                  >
                    {reviewing ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> Reviewing…</>
                    ) : report ? (
                      <><RefreshCw className="h-4 w-4" /> Re-run review</>
                    ) : (
                      <><Sparkles className="h-4 w-4" /> Run AI Review</>
                    )}
                  </Button>
                </div>

                {report && !reviewing && (
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
                  </div>
                )}

                {rawError && !reviewing && (
                  <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                    <p className="text-xs font-medium text-destructive mb-1">Review error</p>
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                      {rawError}
                    </pre>
                  </div>
                )}
              </div>

              {/* Tabs */}
              {report && !reviewing && (
                <div className="flex-1 overflow-y-auto p-4">
                  <Tabs defaultValue="acceptance_criteria">
                    <TabsList className="grid grid-cols-4 w-full">
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
                    </TabsList>

                    <TabsContent value="acceptance_criteria" className="mt-4">
                      <LensPanel lens={report.lenses.acceptance_criteria} onJumpToFile={setHighlightedFile} />
                    </TabsContent>
                    <TabsContent value="security" className="mt-4">
                      <LensPanel lens={report.lenses.security} onJumpToFile={setHighlightedFile} />
                    </TabsContent>
                    <TabsContent value="logic" className="mt-4">
                      <LensPanel lens={report.lenses.logic} onJumpToFile={setHighlightedFile} />
                    </TabsContent>
                    <TabsContent value="quality" className="mt-4">
                      <LensPanel lens={report.lenses.quality} onJumpToFile={setHighlightedFile} />
                    </TabsContent>
                  </Tabs>
                </div>
              )}

              {!report && !reviewing && (
                <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-6 text-center">
                  Run the AI review to see findings across four lenses
                </div>
              )}

              {reviewing && (
                <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Analysing diff…
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
