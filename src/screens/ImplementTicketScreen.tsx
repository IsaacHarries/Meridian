import { useEffect, useState, useRef, useCallback } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  type JiraIssue,
  type CredentialStatus,
  type GroomingOutput,
  type ImpactOutput,
  type ImplementationPlan,
  type GuidanceOutput,
  type TestOutput,
  type PlanReviewOutput,
  type PrDescriptionOutput,
  type RetrospectiveOutput,
  type TriageMessage,
  type RetroKbEntry,
  type SkillType,
  anthropicComplete,
  jiraComplete,
  getMySprintIssues,
  searchJiraIssues,
  openUrl,
  runGroomingAgent,
  runImpactAnalysis,
  runTriageTurn,
  finalizeImplementationPlan,
  runImplementationGuidance,
  runTestSuggestions,
  runPlanReview,
  runPrDescriptionGen,
  runRetrospectiveAgent,
  parseAgentJson,
  saveKnowledgeEntry,
  loadAgentSkills,
} from "@/lib/tauri";

interface ImplementTicketScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Pipeline stage config ─────────────────────────────────────────────────────

type Stage =
  | "select"
  | "grooming"
  | "impact"
  | "triage"
  | "plan"
  | "guidance"
  | "tests"
  | "review"
  | "pr"
  | "retro"
  | "complete";

const STAGE_LABELS: Record<Exclude<Stage, "select">, string> = {
  grooming: "Grooming",
  impact: "Impact Analysis",
  triage: "Triage",
  plan: "Finalising Plan",
  guidance: "Implementation Guide",
  tests: "Test Suggestions",
  review: "Plan Review",
  pr: "PR Description",
  retro: "Retrospective",
  complete: "Complete",
};

const STAGE_ORDER: Exclude<Stage, "select" | "complete">[] = [
  "grooming", "impact", "triage", "plan", "guidance", "tests", "review", "pr", "retro",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function compileTicketText(issue: JiraIssue): string {
  const lines = [
    `Ticket: ${issue.key}`,
    `Title: ${issue.summary}`,
    `Type: ${issue.issueType}`,
    issue.storyPoints != null ? `Story points: ${issue.storyPoints}` : null,
    issue.priority ? `Priority: ${issue.priority}` : null,
    `Status: ${issue.status}`,
    issue.epicSummary ? `Epic: ${issue.epicSummary}${issue.epicKey ? ` (${issue.epicKey})` : ""}` : null,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : null,
    issue.assignee ? `Assignee: ${issue.assignee.displayName}` : null,
    "",
    issue.description ? `Description:\n${issue.description}` : "Description: (none)",
  ];
  return lines.filter(Boolean).join("\n");
}

function compilePipelineContext(
  ticketText: string,
  grooming: GroomingOutput | null,
  impact: ImpactOutput | null,
  skills: Partial<Record<SkillType, string>> = {}
): string {
  const parts: string[] = [];
  if (skills.grooming)        parts.push(`=== GROOMING CONVENTIONS (follow these) ===\n${skills.grooming}`);
  if (skills.patterns)        parts.push(`=== CODEBASE PATTERNS (follow these) ===\n${skills.patterns}`);
  if (skills.implementation)  parts.push(`=== IMPLEMENTATION STANDARDS (follow these) ===\n${skills.implementation}`);
  parts.push(`=== TICKET ===\n${ticketText}`);
  if (grooming) parts.push(`=== GROOMING ANALYSIS ===\n${JSON.stringify(grooming, null, 2)}`);
  if (impact)   parts.push(`=== IMPACT ANALYSIS ===\n${JSON.stringify(impact, null, 2)}`);
  return parts.join("\n\n");
}

function prependSkill(text: string, skill: string | undefined, label: string): string {
  if (!skill) return text;
  return `=== ${label} (follow these) ===\n${skill}\n\n${text}`;
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isoNow() { return new Date().toISOString(); }

// ── Grooming blocker detection ────────────────────────────────────────────────

interface GroomingBlocker {
  id: string;
  severity: "blocking" | "warning";
  message: string;
  detail: string;
}

function detectGroomingBlockers(issue: JiraIssue, grooming: GroomingOutput): GroomingBlocker[] {
  const blockers: GroomingBlocker[] = [];
  const type = issue.issueType.toLowerCase();
  const isTaskOrStory = type === "story" || type === "task";

  if (!issue.description || issue.description.trim().length < 10) {
    blockers.push({
      id: "no-description",
      severity: "blocking",
      message: "Missing description",
      detail: "This ticket has no description. Implementation intent cannot be determined — update JIRA before proceeding.",
    });
  }

  if (isTaskOrStory && grooming.acceptance_criteria.length === 0) {
    blockers.push({
      id: "no-ac",
      severity: "blocking",
      message: "No acceptance criteria",
      detail: `${issue.issueType} tickets must have acceptance criteria before implementation begins. There is no definition of done.`,
    });
  }

  if (isTaskOrStory && issue.storyPoints == null) {
    blockers.push({
      id: "no-points",
      severity: "warning",
      message: "No story point estimate",
      detail: `This ${issue.issueType} has no story point estimate. Consider updating JIRA before starting implementation.`,
    });
  }

  return blockers;
}

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

// ── Stage output panels ───────────────────────────────────────────────────────

function GroomingPanel({ data }: { data: GroomingOutput }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="secondary">{data.ticket_type}</Badge>
        <Badge variant={data.estimated_complexity === "high" ? "destructive" : data.estimated_complexity === "medium" ? "secondary" : "outline"}>
          {data.estimated_complexity} complexity
        </Badge>
      </div>
      <p className="text-sm leading-relaxed">{data.ticket_summary}</p>
      <CollapsibleList title="Acceptance Criteria" items={data.acceptance_criteria} icon={<ClipboardList className="h-4 w-4 text-muted-foreground" />} />
      <CollapsibleList title="Relevant Areas" items={data.relevant_areas.map(a => `${a.area} — ${a.reason}`)} icon={<FileCode className="h-4 w-4 text-muted-foreground" />} />
      <CollapsibleList title="Ambiguities" items={data.ambiguities} icon={<AlertTriangle className="h-4 w-4 text-amber-500" />} />
      <CollapsibleList title="Dependencies" items={data.dependencies} />
      {data.grooming_notes && (
        <p className="text-sm text-muted-foreground italic">{data.grooming_notes}</p>
      )}
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
  guidance: "Proceed to Test Suggestions",
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
}

function CheckpointFooter({
  stage, onProceed, proceeding, hasBlockingIssues,
  chat, input, onInputChange, onSend, sending,
}: CheckpointFooterProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatOpen) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, chatOpen]);

  const nextLabel = NEXT_STAGE_LABEL[stage] ?? "Proceed";

  return (
    <div className="mt-5 border-t pt-4 space-y-3">
      {/* Collapsible follow-up chat */}
      <div>
        <button
          onClick={() => setChatOpen(!chatOpen)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${chatOpen ? "rotate-90" : ""}`} />
          Ask a follow-up question
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
                placeholder="Ask about these findings…"
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
}

function TicketSelector({ sprintIssues, loading, onSelect }: TicketSelectorProps) {
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
          {list.map((issue) => (
            <button
              key={issue.id}
              onClick={() => onSelect(issue)}
              className="w-full text-left px-4 py-3 rounded-md border bg-card/60 hover:bg-muted/60 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                <Badge variant="outline" className="text-xs">{issue.issueType}</Badge>
                {issue.storyPoints != null && (
                  <span className="ml-auto text-xs text-muted-foreground">{issue.storyPoints}pt</span>
                )}
              </div>
              <p className="text-sm font-medium leading-snug">{issue.summary}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{issue.status}</p>
            </button>
          ))}
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
    grooming:  0,
    impact:    1,
    triage:    2,
    plan:      2,
    guidance:  3,
    tests:     4,
    review:    5,
    pr:        6,
    retro:     7,
    complete:  7,
  };
  return map[stage];
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function ImplementTicketScreen({ credStatus, onBack }: ImplementTicketScreenProps) {
  const claudeAvailable = anthropicComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  // Ticket selection
  const [sprintIssues, setSprintIssues] = useState<JiraIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(true);
  const [selectedIssue, setSelectedIssue] = useState<JiraIssue | null>(null);

  // Pipeline state
  const [currentStage, setCurrentStage] = useState<Stage>("select");
  const [viewingStage, setViewingStage] = useState<Stage>("grooming");
  const [completedStages, setCompletedStages] = useState<Set<Stage>>(new Set());

  // Agent outputs
  const [grooming, setGrooming] = useState<GroomingOutput | null>(null);
  const [impact, setImpact] = useState<ImpactOutput | null>(null);
  const [triageHistory, setTriageHistory] = useState<TriageMessage[]>([]);
  const [triageInput, setTriageInput] = useState("");
  const [triageSending, setTriageSending] = useState(false);
  const [triaFinalizing, setTriaFinalizing] = useState(false);
  const [plan, setPlan] = useState<ImplementationPlan | null>(null);
  const [guidance, setGuidance] = useState<GuidanceOutput | null>(null);
  const [tests, setTests] = useState<TestOutput | null>(null);
  const [review, setReview] = useState<PlanReviewOutput | null>(null);
  const [prDescription, setPrDescription] = useState<PrDescriptionOutput | null>(null);
  const [retrospective, setRetrospective] = useState<RetrospectiveOutput | null>(null);
  const [kbSaved, setKbSaved] = useState(false);

  // Per-stage error
  const [errors, setErrors] = useState<Partial<Record<Stage, string>>>({});

  // Approval gate — which stage is waiting for user approval before advancing
  const [pendingApproval, setPendingApproval] = useState<Stage | null>(null);
  const [proceeding, setProceeding] = useState(false);

  // Grooming blockers
  const [groomingBlockers, setGroomingBlockers] = useState<GroomingBlocker[]>([]);

  // Checkpoint conversations (follow-up chat at each stage's approval gate)
  const [checkpointChats, setCheckpointChats] = useState<Partial<Record<Stage, TriageMessage[]>>>({});
  const [checkpointInput, setCheckpointInput] = useState("");
  const [checkpointSending, setCheckpointSending] = useState(false);

  // Refs for pipeline data — avoids stale closures in async stage functions
  const groomingRef = useRef<GroomingOutput | null>(null);
  const impactRef = useRef<ImpactOutput | null>(null);
  const planRef = useRef<ImplementationPlan | null>(null);
  const guidanceRef = useRef<GuidanceOutput | null>(null);
  const testsRef = useRef<TestOutput | null>(null);
  const reviewRef = useRef<PlanReviewOutput | null>(null);
  const ticketTextRef = useRef<string>("");

  /** Fade in header meridian (PipelineProgress) over 1s when this screen mounts. */
  const [meridianHeaderVisible, setMeridianHeaderVisible] = useState(false);

  const ticketText = selectedIssue ? compileTicketText(selectedIssue) : "";
  // Keep ref in sync with the current ticket text
  ticketTextRef.current = ticketText;

  function markComplete(stage: Stage) {
    setCompletedStages((prev) => new Set([...prev, stage]));
  }

  function setError(stage: Stage, err: string) {
    setErrors((prev) => ({ ...prev, [stage]: err }));
  }

  // Load sprint issues assigned to the current user
  useEffect(() => {
    if (!jiraAvailable) { setLoadingIssues(false); return; }
    getMySprintIssues().then(setSprintIssues).catch(() => {}).finally(() => setLoadingIssues(false));
  }, [jiraAvailable]);

  useEffect(() => {
    const t = window.setTimeout(() => setMeridianHeaderVisible(true), 0);
    return () => clearTimeout(t);
  }, []);

  // Stable ref for skills — loaded once at pipeline start, used throughout
  const skillsRef = useRef<Partial<Record<SkillType, string>>>({});

  // Start pipeline — runs Grooming only, then waits for user approval
  const startPipeline = useCallback(async (issue: JiraIssue) => {
    setSelectedIssue(issue);
    setCurrentStage("grooming");
    setViewingStage("grooming");
    setCompletedStages(new Set());
    setPendingApproval(null);
    setGroomingBlockers([]);
    setCheckpointChats({});
    setCheckpointInput("");
    setGrooming(null); setImpact(null); setPlan(null);
    setGuidance(null); setTests(null); setReview(null);
    setPrDescription(null); setRetrospective(null);
    setTriageHistory([]); setTriageInput(""); setErrors({});
    groomingRef.current = null; impactRef.current = null;
    planRef.current = null; guidanceRef.current = null;
    testsRef.current = null; reviewRef.current = null;

    const text = compileTicketText(issue);
    ticketTextRef.current = text;

    try {
      skillsRef.current = await loadAgentSkills();
    } catch { skillsRef.current = {}; }

    // Agent 1: Grooming
    try {
      const groomingInput = prependSkill(text, skillsRef.current.grooming, "GROOMING CONVENTIONS");
      const raw = await runGroomingAgent(groomingInput);
      const data = parseAgentJson<GroomingOutput>(raw);
      if (!data) throw new Error("Could not parse grooming output");
      groomingRef.current = data;
      setGrooming(data);
      markComplete("grooming");
      // Detect blockers before presenting to user
      setGroomingBlockers(detectGroomingBlockers(issue, data));
      // ── CHECKPOINT: wait for user approval ──
      setPendingApproval("grooming");
    } catch (e) {
      setError("grooming", String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Individual stage runners (each called after user approves the previous) ──

  async function runImpactStage() {
    setCurrentStage("impact");
    setViewingStage("impact");
    try {
      const impactInput = prependSkill(ticketTextRef.current, skillsRef.current.patterns, "CODEBASE PATTERNS");
      const raw = await runImpactAnalysis(impactInput, JSON.stringify(groomingRef.current));
      const data = parseAgentJson<ImpactOutput>(raw);
      if (!data) throw new Error("Could not parse impact output");
      impactRef.current = data;
      setImpact(data);
      markComplete("impact");
      // ── CHECKPOINT ──
      setPendingApproval("impact");
    } catch (e) {
      setError("impact", String(e));
    }
  }

  async function runTriageStage() {
    setCurrentStage("triage");
    setViewingStage("triage");
    const contextText = compilePipelineContext(
      ticketTextRef.current, groomingRef.current, impactRef.current, skillsRef.current
    );
    setTriageSending(true);
    try {
      const initialMessage = "Please analyse this ticket and propose a concrete implementation approach. Ask any clarifying questions you need answered before we can finalise the plan.";
      const response = await runTriageTurn(
        contextText,
        JSON.stringify([{ role: "user", content: initialMessage }])
      );
      setTriageHistory([
        { role: "user" as const, content: initialMessage },
        { role: "assistant" as const, content: response },
      ]);
    } catch (e) {
      setError("triage", String(e));
    } finally {
      setTriageSending(false);
    }
  }

  async function sendTriageMessage() {
    if (!triageInput.trim()) return;
    const userMsg: TriageMessage = { role: "user", content: triageInput.trim() };
    const newHistory = [...triageHistory, userMsg];
    setTriageHistory(newHistory);
    setTriageInput("");
    setTriageSending(true);
    try {
      const contextText = compilePipelineContext(
        ticketTextRef.current, groomingRef.current, impactRef.current, skillsRef.current
      );
      const response = await runTriageTurn(contextText, JSON.stringify(newHistory));
      setTriageHistory([...newHistory, { role: "assistant", content: response }]);
    } catch (e) {
      setError("triage", String(e));
    } finally {
      setTriageSending(false);
    }
  }

  async function finalizePlan() {
    setTriaFinalizing(true);
    setCurrentStage("plan");
    try {
      const contextText = compilePipelineContext(
        ticketTextRef.current, groomingRef.current, impactRef.current, skillsRef.current
      );
      const raw = await finalizeImplementationPlan(contextText, JSON.stringify(triageHistory));
      const data = parseAgentJson<ImplementationPlan>(raw);
      if (!data) throw new Error("Could not parse plan output");
      planRef.current = data;
      setPlan(data);
      markComplete("triage");
      markComplete("plan");
      setViewingStage("plan");
      // ── CHECKPOINT: user reviews the plan before implementation begins ──
      setPendingApproval("plan");
    } catch (e) {
      setError("plan", String(e));
    } finally {
      setTriaFinalizing(false);
    }
  }

  async function runGuidanceStage() {
    const skills = skillsRef.current;
    const planJson = JSON.stringify(planRef.current);
    setCurrentStage("guidance");
    setViewingStage("guidance");
    try {
      const guidanceInput = prependSkill(
        prependSkill(ticketTextRef.current, skills.patterns, "CODEBASE PATTERNS"),
        skills.implementation, "IMPLEMENTATION STANDARDS"
      );
      const raw = await runImplementationGuidance(guidanceInput, planJson);
      const data = parseAgentJson<GuidanceOutput>(raw);
      if (!data) throw new Error("Could not parse guidance output");
      guidanceRef.current = data;
      setGuidance(data);
      markComplete("guidance");
      // ── CHECKPOINT ──
      setPendingApproval("guidance");
    } catch (e) {
      setError("guidance", String(e));
    }
  }

  async function runTestsStage() {
    const planJson = JSON.stringify(planRef.current);
    setCurrentStage("tests");
    setViewingStage("tests");
    try {
      const raw = await runTestSuggestions(planJson, JSON.stringify(guidanceRef.current));
      const data = parseAgentJson<TestOutput>(raw);
      if (!data) throw new Error("Could not parse test output");
      testsRef.current = data;
      setTests(data);
      markComplete("tests");
      // ── CHECKPOINT ──
      setPendingApproval("tests");
    } catch (e) {
      setError("tests", String(e));
    }
  }

  async function runReviewStage() {
    const skills = skillsRef.current;
    const planJson = JSON.stringify(planRef.current);
    setCurrentStage("review");
    setViewingStage("review");
    try {
      const reviewPlanJson = skills.review
        ? `=== REVIEW STANDARDS (follow these) ===\n${skills.review}\n\n${planJson}`
        : planJson;
      const raw = await runPlanReview(
        reviewPlanJson, JSON.stringify(guidanceRef.current), JSON.stringify(testsRef.current)
      );
      const data = parseAgentJson<PlanReviewOutput>(raw);
      if (!data) throw new Error("Could not parse review output");
      reviewRef.current = data;
      setReview(data);
      markComplete("review");
      // ── CHECKPOINT ──
      setPendingApproval("review");
    } catch (e) {
      setError("review", String(e));
    }
  }

  async function runPrStage() {
    const planJson = JSON.stringify(planRef.current);
    setCurrentStage("pr");
    setViewingStage("pr");
    try {
      const raw = await runPrDescriptionGen(
        ticketTextRef.current, planJson, JSON.stringify(reviewRef.current)
      );
      const data = parseAgentJson<PrDescriptionOutput>(raw);
      if (!data) throw new Error("Could not parse PR description output");
      setPrDescription(data);
      markComplete("pr");
      // ── CHECKPOINT ──
      setPendingApproval("pr");
    } catch (e) {
      setError("pr", String(e));
    }
  }

  async function runRetroStage() {
    const planJson = JSON.stringify(planRef.current);
    setCurrentStage("retro");
    setViewingStage("retro");
    try {
      const raw = await runRetrospectiveAgent(
        ticketTextRef.current, planJson, JSON.stringify(reviewRef.current)
      );
      const data = parseAgentJson<RetrospectiveOutput>(raw);
      if (!data) throw new Error("Could not parse retrospective output");
      setRetrospective(data);
      markComplete("retro");
      // ── CHECKPOINT ──
      setPendingApproval("retro");
    } catch (e) {
      setError("retro", String(e));
    }
  }

  // Dispatch from one approval gate to the next stage runner
  async function proceedFromStage(stage: Stage) {
    setPendingApproval(null);
    setProceeding(true);
    try {
      switch (stage) {
        case "grooming":   await runImpactStage(); break;
        case "impact":     await runTriageStage(); break;
        case "plan":       await runGuidanceStage(); break;
        case "guidance":   await runTestsStage(); break;
        case "tests":      await runReviewStage(); break;
        case "review":     await runPrStage(); break;
        case "pr":         await runRetroStage(); break;
        case "retro":      setCurrentStage("complete"); break;
      }
    } finally {
      setProceeding(false);
    }
  }

  // Follow-up chat at any stage's checkpoint (uses runTriageTurn with stage context)
  async function sendCheckpointMessage(stage: Stage) {
    const msg = checkpointInput.trim();
    if (!msg) return;
    setCheckpointInput("");

    const stageOutput =
      stage === "grooming" ? groomingRef.current :
      stage === "impact"   ? impactRef.current :
      stage === "plan"     ? planRef.current :
      stage === "guidance" ? guidanceRef.current :
      stage === "tests"    ? testsRef.current :
      stage === "review"   ? reviewRef.current :
      stage === "pr"       ? prDescription :
      stage === "retro"    ? retrospective : null;

    const context = [
      compilePipelineContext(ticketTextRef.current, groomingRef.current, impactRef.current, skillsRef.current),
      stageOutput ? `=== ${(STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? stage).toUpperCase()} OUTPUT ===\n${JSON.stringify(stageOutput, null, 2)}` : "",
    ].filter(Boolean).join("\n\n");

    const prev = checkpointChats[stage] ?? [];
    const newHistory: TriageMessage[] = [...prev, { role: "user" as const, content: msg }];
    setCheckpointChats((c) => ({ ...c, [stage]: newHistory }));
    setCheckpointSending(true);
    try {
      const response = await runTriageTurn(context, JSON.stringify(newHistory));
      setCheckpointChats((c) => ({
        ...c,
        [stage]: [...(c[stage] ?? newHistory), { role: "assistant" as const, content: response }],
      }));
    } catch { /* silently drop — chat is non-critical */ }
    finally { setCheckpointSending(false); }
  }

  async function saveToKnowledgeBase(entries: RetroKbEntry[]) {
    const now = isoNow();
    for (const entry of entries) {
      await saveKnowledgeEntry({
        id: newId(),
        entryType: entry.type,
        title: entry.title,
        body: entry.body,
        tags: ["auto-generated", selectedIssue?.key ?? "unknown"],
        createdAt: now,
        updatedAt: now,
        linkedJiraKey: selectedIssue?.key ?? null,
        linkedPrId: null,
      });
    }
    setKbSaved(true);
  }

  // ── Stage content renderer ──────────────────────────────────────────────────

  function renderCheckpoint(stage: Stage) {
    // Only show the checkpoint footer if this is the current pending stage
    // (or a past stage — user can revisit and still chat)
    if (!completedStages.has(stage)) return null;
    const isPending = pendingApproval === stage;
    const isRetro = stage === "retro";
    const hasReviewBlockers = stage === "review" && review?.findings.some(f => f.severity === "blocking");
    return (
      <CheckpointFooter
        stage={stage}
        onProceed={() => isRetro ? proceedFromStage(stage) : proceedFromStage(stage)}
        proceeding={proceeding && pendingApproval === null && currentStage !== stage}
        hasBlockingIssues={stage === "grooming" ? groomingBlockers.some(b => b.severity === "blocking") : hasReviewBlockers ?? false}
        chat={checkpointChats[stage] ?? []}
        input={isPending || viewingStage === stage ? checkpointInput : ""}
        onInputChange={(v) => setCheckpointInput(v)}
        onSend={() => sendCheckpointMessage(stage)}
        sending={checkpointSending && viewingStage === stage}
      />
    );
  }

  function renderStageContent(stage: Stage) {
    const err = errors[stage];
    if (err) {
      return (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
          <p className="text-sm font-medium text-destructive mb-1">Error in {STAGE_LABELS[stage as keyof typeof STAGE_LABELS]}</p>
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{err}</pre>
        </div>
      );
    }

    if (stage === "grooming") {
      if (!grooming) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Running grooming analysis…</div>;
      return (
        <>
          <GroomingPanel data={grooming} />
          {groomingBlockers.length > 0 && <div className="mt-3"><BlockerBanner blockers={groomingBlockers} /></div>}
          {renderCheckpoint(stage)}
        </>
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
          <RetroPanel data={retrospective} onSaveToKb={saveToKnowledgeBase} kbSaved={kbSaved} />
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
              onClick={currentStage === "select" ? onBack : () => { setSelectedIssue(null); setCurrentStage("select"); }}
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
          {!claudeAvailable && "Anthropic API key not configured — agents unavailable."}
        </div>
      )}

      {/* Body — centred card; fills viewport below chrome so only the stage panel scrolls */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden rounded-xl bg-background/60">
          {currentStage === "select" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <TicketSelector sprintIssues={sprintIssues} loading={loadingIssues} onSelect={startPipeline} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <PipelineSidebar
                currentStage={currentStage}
                completedStages={completedStages}
                activeStage={viewingStage}
                pendingApproval={pendingApproval}
                onClickStage={setViewingStage}
              />

              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="max-w-2xl shrink-0 px-5 pt-5">
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
                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
                  <div className="max-w-2xl">{renderStageContent(viewingStage)}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
