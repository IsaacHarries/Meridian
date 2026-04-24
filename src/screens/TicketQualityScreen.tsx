import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { JiraTicketLink } from "@/components/JiraTicketLink";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import { createGlobalCommands, type SlashCommand } from "@/lib/slashCommands";
import {
  ArrowLeft,
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Calendar,
  AlertTriangle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkflowPanelHeader, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type JiraIssue,
  type JiraSprint,
  type CredentialStatus,
  type SuggestedEditField,
  type GroomingOutput,
  type GroomingChatResponse,
  aiProviderComplete,
  jiraComplete,
  getAllActiveSprints,
  getFutureSprints,
  getSprintIssues,
  getIssue,
  searchJiraIssues,
  runGroomingAgent,
  runGroomingFileProbe,
  runGroomingChatTurn,
  grepGroomingFiles,
  readGroomingFile,
  syncGroomingWorktree,
  validateGroomingWorktree,
  updateJiraFields,
  parseAgentJson,
  openUrl,
} from "@/lib/tauri";

interface TicketQualityScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── State model ───────────────────────────────────────────────────────────────

interface GroomChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface DraftChange {
  id: string;
  field: SuggestedEditField;
  section: string;
  current: string | null;
  suggested: string;
  editedSuggested: string;
  userEdited: boolean;
  reasoning: string;
  status: "pending" | "approved" | "declined";
  applyResult?: "ok" | "error";
  applyError?: string;
}

interface GroomSession {
  issue: JiraIssue;
  chat: GroomChatMessage[];
  drafts: DraftChange[];
  thinking: boolean;
  applying: boolean;
  probeStatus: string;
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
  if (issue.description) { lines.push("Description:"); lines.push(issue.description); }
  else { lines.push("Description: (none)"); }
  if (issue.acceptanceCriteria) { lines.push(""); lines.push("Acceptance Criteria:"); lines.push(issue.acceptanceCriteria); }
  if (issue.stepsToReproduce) { lines.push(""); lines.push("Steps to Reproduce:"); lines.push(issue.stepsToReproduce); }
  if (issue.observedBehavior) { lines.push(""); lines.push("Observed Behavior:"); lines.push(issue.observedBehavior); }
  if (issue.expectedBehavior) { lines.push(""); lines.push("Expected Behavior:"); lines.push(issue.expectedBehavior); }
  return lines.join("\n");
}

function statusAge(issue: JiraIssue): string {
  const days = Math.floor((Date.now() - new Date(issue.updated).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function resolveJiraFieldId(field: SuggestedEditField, issue: JiraIssue): string | null {
  if (field === "summary") return "summary";
  if (field === "description") return "description";
  return issue.discoveredFieldIds?.[field] ?? null;
}

function getCurrentFieldValue(field: SuggestedEditField, issue: JiraIssue): string | null {
  switch (field) {
    case "acceptance_criteria": return issue.acceptanceCriteria ?? null;
    case "steps_to_reproduce":  return issue.stepsToReproduce ?? null;
    case "observed_behavior":   return issue.observedBehavior ?? null;
    case "expected_behavior":   return issue.expectedBehavior ?? null;
    case "description":         return issue.description ?? null;
    case "summary":             return issue.summary ?? null;
    default:                    return null;
  }
}

function suggestedEditsToDraftChanges(edits: GroomingOutput["suggested_edits"], issue: JiraIssue): DraftChange[] {
  // Merge duplicate fields into a single edit (agent occasionally emits multiple AC sections).
  const merged = new Map<string, GroomingOutput["suggested_edits"][number]>();
  for (const e of edits) {
    const existing = merged.get(e.field);
    if (existing) {
      existing.suggested = `${existing.suggested.trimEnd()}\n${e.suggested.trimStart()}`;
      existing.reasoning = `${existing.reasoning} ${e.reasoning}`;
    } else {
      merged.set(e.field, { ...e });
    }
  }
  return Array.from(merged.values()).map((e) => ({
    id: e.id, field: e.field, section: e.section,
    // Agent sometimes returns current: null even when the field has a value.
    // Fall back to the actual field value from the fetched issue.
    current: e.current ?? getCurrentFieldValue(e.field, issue),
    suggested: e.suggested, editedSuggested: e.suggested,
    userEdited: false, reasoning: e.reasoning, status: "pending",
  }));
}

function buildOpeningMessage(issue: JiraIssue, output: GroomingOutput): string {
  const { clarifying_questions: questions, ticket_summary } = output;
  if (questions && questions.length > 0) {
    const qs = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    return `I've reviewed **${issue.key}**. ${ticket_summary}\n\nI have a few questions before finalising:\n\n${qs}`;
  }
  const n = output.suggested_edits.length;
  if (n === 0) return `I've reviewed **${issue.key}**. ${ticket_summary}\n\nThe ticket looks well-formed. Is there anything you'd like me to clarify or adjust?`;
  return `I've reviewed **${issue.key}**. ${ticket_summary}\n\nI've drafted ${n} suggested change${n === 1 ? "" : "s"} — review them in the Draft Changes panel below.`;
}

// ── Field diagnostics ─────────────────────────────────────────────────────────

function FieldDiagnostics({ issue }: { issue: JiraIssue }) {
  const [open, setOpen] = useState(false);
  const fields = [
    { label: "Description", value: issue.description },
    { label: "Acceptance Criteria", value: issue.acceptanceCriteria },
    { label: "Steps to Reproduce", value: issue.stepsToReproduce },
    { label: "Observed Behavior", value: issue.observedBehavior },
    { label: "Expected Behavior", value: issue.expectedBehavior },
  ];
  const missing = fields.filter((f) => !f.value);
  const present = fields.filter((f) => !!f.value);

  return (
    <div className="mt-2">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Fields received
        <span className="text-emerald-600 font-medium">{present.length} ✓</span>
        {missing.length > 0 && <span className="text-amber-500 font-medium">{missing.length} missing</span>}
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {fields.map((f) => (
            <div key={f.label} className="flex items-start gap-2 text-xs">
              {f.value ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" /> : <XCircle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />}
              <span className={f.value ? "text-foreground" : "text-muted-foreground"}>
                {f.label}
                {f.value && <span className="text-muted-foreground ml-1">— {f.value.slice(0, 60)}{f.value.length > 60 ? "…" : ""}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Ticket summary card ───────────────────────────────────────────────────────

function TicketSummaryCard({ issue, onReanalyze, analyzing }: { issue: JiraIssue; onReanalyze: () => void; analyzing: boolean }) {
  return (
    <Card className="shrink-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <JiraTicketLink ticketKey={issue.key} url={issue.url} />
              <Badge variant="outline" className="text-xs">{issue.issueType}</Badge>
              {issue.storyPoints != null && <Badge variant="secondary" className="text-xs">{issue.storyPoints} pts</Badge>}
              {issue.priority && <Badge variant="outline" className="text-xs">{issue.priority}</Badge>}
            </div>
            <CardTitle className="text-base leading-snug">{issue.summary}</CardTitle>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={onReanalyze} disabled={analyzing} title="Re-run AI analysis from scratch">
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${analyzing ? "animate-spin" : ""}`} /> Re-analyse
            </Button>
            <Button variant="outline" size="sm" onClick={() => issue.url && openUrl(issue.url)} title="Open in JIRA">
              <ExternalLink className="h-3.5 w-3.5 mr-1" /> JIRA
            </Button>
          </div>
        </div>
        {issue.epicSummary && <p className="text-xs text-muted-foreground mt-1">Epic: {issue.epicSummary}</p>}
      </CardHeader>
      <CardContent className="pt-0 border-t">
        <FieldDiagnostics issue={issue} />
      </CardContent>
    </Card>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: GroomChatMessage }) {
  const isAssistant = msg.role === "assistant";
  return (
    <div className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${isAssistant ? "bg-muted text-foreground rounded-tl-sm" : "bg-primary text-primary-foreground rounded-tr-sm"}`}>
        {msg.content}
      </div>
    </div>
  );
}

// ── Chat panel ────────────────────────────────────────────────────────────────

function ChatPanel({
  messages,
  thinking,
  probeStatus,
  onSend,
  commands,
}: {
  messages: GroomChatMessage[];
  thinking: boolean;
  probeStatus: string;
  onSend: (text: string) => void;
  commands: SlashCommand[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, thinking]);

  return (
    <Card className="flex flex-col min-h-0 flex-1">
      <CardHeader className="pb-2 shrink-0 border-b">
        <CardTitle className="text-sm font-semibold">Grooming Assistant</CardTitle>
        <p className="text-xs text-muted-foreground">Ask questions or request field changes — e.g. "update the AC to…"</p>
      </CardHeader>
      <CardContent className="flex flex-col flex-1 min-h-0 pt-3">
        <div className="flex-1 overflow-y-auto space-y-3 pr-1 min-h-0">
          {messages.length === 0 && !thinking && (
            <p className="text-xs text-muted-foreground text-center pt-4 leading-relaxed">
              The assistant will appear here after the initial analysis.<br />
              You can ask it to refine any draft field.
            </p>
          )}
          {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}
          {thinking && (
            <div className="flex justify-start">
              <div className="bg-muted text-muted-foreground px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {probeStatus || "Thinking…"}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="pt-3 border-t shrink-0">
          <SlashCommandInput
            value={value}
            onChange={setValue}
            onSend={(text) => onSend(text)}
            commands={commands}
            busy={thinking}
            placeholder='Ask a question or say "update the AC to…". Enter to send. / for commands.'
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Draft field row ───────────────────────────────────────────────────────────

function DraftFieldRow({ draft, issue, highlighted, onApprove, onDecline, onEditSuggested }: {
  draft: DraftChange; issue: JiraIssue; highlighted?: boolean;
  onApprove: (id: string) => void; onDecline: (id: string) => void;
  onEditSuggested: (id: string, value: string) => void;
}) {
  const [showFull, setShowFull] = useState(false);
  const cannotResolve = resolveJiraFieldId(draft.field, issue) === null;

  const statusBadge =
    draft.status === "approved"
      ? <Badge className="text-xs bg-green-600 hover:bg-green-600 text-white">{draft.applyResult === "ok" ? "Applied ✓" : "Approved"}</Badge>
      : draft.status === "declined"
      ? <Badge variant="outline" className="text-xs text-muted-foreground">Declined</Badge>
      : <Badge variant="secondary" className="text-xs">Pending</Badge>;

  const borderClass = highlighted
    ? "border-primary/70 bg-primary/5 dark:bg-primary/10"
    : draft.status === "approved"
    ? "border-green-200 dark:border-green-900 bg-green-50/30 dark:bg-green-950/20"
    : "";

  return (
    <div className={`border rounded-lg p-3 space-y-2 transition-colors duration-700 ${borderClass} ${draft.status === "declined" ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{draft.section}</span>
        {statusBadge}
      </div>
      {draft.userEdited && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0" /> You've edited this — AI may have updated its suggestion separately
        </p>
      )}
      {cannotResolve && draft.status !== "declined" && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0" /> Field ID not auto-discovered — cannot apply to JIRA
        </p>
      )}
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-0.5">Current</p>
        {draft.current
          ? <div className="relative">
              <p className={`text-xs text-muted-foreground leading-relaxed ${showFull ? "" : "line-clamp-3"}`}>{draft.current}</p>
              {draft.current.length > 200 && <button className="text-xs text-primary mt-0.5" onClick={() => setShowFull((v) => !v)}>{showFull ? "Show less" : "Show more"}</button>}
            </div>
          : <p className="text-xs text-muted-foreground italic">(none)</p>}
      </div>
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-0.5">Proposed</p>
        <Textarea value={draft.editedSuggested} onChange={(e) => onEditSuggested(draft.id, e.target.value)} rows={4} className="text-xs resize-y" disabled={draft.status === "declined"} />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{draft.reasoning}</p>
      {draft.applyResult === "error" && draft.applyError && (
        <p className="text-xs text-destructive leading-relaxed">{draft.applyError}</p>
      )}
      <div className="flex gap-2">
        {draft.status === "pending" && <>
          <Button size="sm" variant="default" className="h-7 text-xs" onClick={() => onApprove(draft.id)} disabled={cannotResolve}>Approve</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onDecline(draft.id)}>Decline</Button>
        </>}
        {draft.status === "approved" && draft.applyResult !== "ok" && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onDecline(draft.id)}>Decline</Button>
        )}
        {draft.status === "declined" && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onApprove(draft.id)} disabled={cannotResolve}>Re-approve</Button>
        )}
      </div>
    </div>
  );
}

// ── Draft changes panel ───────────────────────────────────────────────────────

function DraftChangesPanel({ drafts, issue, applying, highlightedIds, onApprove, onDecline, onEditSuggested, onApply }: {
  drafts: DraftChange[]; issue: JiraIssue; applying: boolean; highlightedIds: Set<string>;
  onApprove: (id: string) => void; onDecline: (id: string) => void;
  onEditSuggested: (id: string, value: string) => void; onApply: () => void;
}) {
  const approved = drafts.filter((d) => d.status === "approved");
  const pending = drafts.filter((d) => d.status === "pending");
  const declined = drafts.filter((d) => d.status === "declined");

  return (
    <Card className="shrink-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-semibold">Draft Changes</CardTitle>
          <Button size="sm" onClick={onApply} disabled={approved.length === 0 || applying} className="h-7 text-xs gap-1.5">
            {applying ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying…</> : <>Apply {approved.length > 0 ? `${approved.length} ` : ""}changes to JIRA</>}
          </Button>
        </div>
        {drafts.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">{approved.length} approved · {pending.length} pending · {declined.length} declined</p>
        )}
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {drafts.length === 0
          ? <p className="text-sm text-muted-foreground italic text-center py-4">No changes proposed yet</p>
          : drafts.map((draft) => (
              <DraftFieldRow key={draft.id} draft={draft} issue={issue} highlighted={highlightedIds.has(draft.id)} onApprove={onApprove} onDecline={onDecline} onEditSuggested={onEditSuggested} />
            ))}
      </CardContent>
    </Card>
  );
}

// ── Ticket selector ───────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = {
  highest: 0, critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4, trivial: 4,
};

function priorityRank(p: string | null): number {
  return p != null ? (PRIORITY_ORDER[p.toLowerCase()] ?? 2) : 2;
}

function priorityColor(p: string | null): string {
  switch (p?.toLowerCase()) {
    case "highest": case "critical": return "text-red-600 dark:text-red-400";
    case "high":    return "text-orange-500 dark:text-orange-400";
    case "medium":  return "text-yellow-500 dark:text-yellow-400";
    case "low":     return "text-blue-500 dark:text-blue-400";
    case "lowest":  case "trivial": return "text-muted-foreground";
    default:        return "text-muted-foreground";
  }
}

function issueKeyNumber(key: string): number {
  const m = key.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

type SortField = "priority" | "key";
type SortDir   = "asc" | "desc";

function sortIssues(issues: JiraIssue[], field: SortField, dir: SortDir): JiraIssue[] {
  return [...issues].sort((a, b) => {
    const cmp = field === "priority"
      ? priorityRank(a.priority) - priorityRank(b.priority)
      : issueKeyNumber(a.key) - issueKeyNumber(b.key);
    return dir === "asc" ? cmp : -cmp;
  });
}

function SortButton({ label, field, current, dir, onClick }: {
  label: string; field: SortField; current: SortField; dir: SortDir;
  onClick: (f: SortField) => void;
}) {
  const active = current === field;
  const Icon = active ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button onClick={() => onClick(field)}
      className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${active ? "border-primary text-primary bg-primary/5" : "border-input text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}>
      <Icon className="h-3 w-3" />{label}
    </button>
  );
}

function TicketSelector({ sprints, selectedSprintId, onSelectSprint, sprintIssues, loadingIssues, selected, onSelect }: {
  sprints: JiraSprint[]; selectedSprintId: number | null;
  onSelectSprint: (sprint: JiraSprint) => void;
  sprintIssues: JiraIssue[]; loadingIssues: boolean;
  selected: JiraIssue | null; onSelect: (issue: JiraIssue) => void;
}) {
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<JiraIssue[]>([]);
  const [searching, setSearching] = useState(false);
  const [sortField, setSortField] = useState<SortField>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const q = search.trim();

  function handleSortClick(field: SortField) {
    if (sortField === field) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  }

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

  const rawList = q ? searchResults : sprintIssues;
  const displayList = sortIssues(rawList, sortField, sortDir);
  const showLoading = q ? searching : loadingIssues;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {sprints.length > 0 && (
        <div className="shrink-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Calendar className="h-3 w-3" /> Sprint</p>
          <select value={selectedSprintId ?? ""} onChange={(e) => { const s = sprints.find((sp) => sp.id === Number(e.target.value)); if (s) onSelectSprint(s); }}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
            {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === "future" ? " · upcoming" : ""}</option>)}
          </select>
        </div>
      )}
      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input placeholder="Search tickets or enter key (e.g. PROJ-123)…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Sort:</span>
        <SortButton label="Priority" field="priority" current={sortField} dir={sortDir} onClick={handleSortClick} />
        <SortButton label="Key" field="key" current={sortField} dir={sortDir} onClick={handleSortClick} />
      </div>
      <div className="flex-1 min-h-0 space-y-1 overflow-y-auto pr-1">
        {showLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />{q ? "Searching…" : "Loading sprint tickets…"}
          </div>
        )}
        {!showLoading && displayList.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">{q ? "No tickets found." : "No tickets in this sprint."}</p>
        )}
        {!showLoading && displayList.map((issue) => {
          const isSelected = selected?.id === issue.id;
          return (
            <button key={issue.id} onClick={() => onSelect(issue)}
              className={`w-full text-left px-3 py-2.5 rounded-md border transition-colors hover:bg-muted/60 ${isSelected ? "border-primary bg-primary/5" : "border-transparent"}`}>
              <div className="flex items-center gap-2">
                <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                <Badge variant="outline" className="text-xs py-0 h-5">{issue.issueType}</Badge>
                {issue.storyPoints != null && <span className="ml-auto text-xs text-muted-foreground shrink-0">{issue.storyPoints}pt</span>}
              </div>
              <p className="text-sm mt-0.5 leading-snug line-clamp-2">{issue.summary}</p>
              <div className="flex items-center gap-2 mt-1">
                {issue.priority && (
                  <span className={`text-xs font-medium ${priorityColor(issue.priority)}`}>{issue.priority}</span>
                )}
                {issue.priority && <span className="text-xs text-muted-foreground">·</span>}
                <span className="text-xs text-muted-foreground">{issue.status}</span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs text-muted-foreground">{statusAge(issue)}</span>
              </div>
            </button>
          );
        })}
      </div>
      {!q && !loadingIssues && sprintIssues.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">{sprintIssues.length} tickets · Search to find any backlog ticket</p>
      )}
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function TicketQualityScreen({ credStatus, onBack }: TicketQualityScreenProps) {
  const [sprints, setSprints] = useState<JiraSprint[]>([]);
  const [selectedSprintId, setSelectedSprintId] = useState<number | null>(null);
  const [sprintIssues, setSprintIssues] = useState<JiraIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(true);
  const [session, setSession] = useState<GroomSession | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(new Set());
  const recentlyUpdatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Resizable pane widths ─────────────────────────────────────────────────
  const [leftWidth, setLeftWidth] = useState(340);
  const [chatWidth, setChatWidth] = useState(360);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartValRef = useRef(0);

  const makeDragHandler = useCallback(
    (setter: (w: number) => void, min: number, max: number, inverted = false) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        isDraggingRef.current = true;
        dragStartXRef.current = e.clientX;
        dragStartValRef.current = inverted ? chatWidth : leftWidth;
        const onMouseMove = (ev: MouseEvent) => {
          if (!isDraggingRef.current) return;
          const delta = inverted
            ? dragStartXRef.current - ev.clientX
            : ev.clientX - dragStartXRef.current;
          setter(Math.min(max, Math.max(min, dragStartValRef.current + delta)));
        };
        const onMouseUp = () => {
          isDraggingRef.current = false;
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("mouseup", onMouseUp);
        };
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      },
    [leftWidth, chatWidth]
  );

  const onLeftDividerMouseDown = makeDragHandler(setLeftWidth, 240, 520);
  const onChatDividerMouseDown = makeDragHandler(setChatWidth, 280, 600, true);

  const claudeAvailable = aiProviderComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  useEffect(() => {
    if (!jiraAvailable) { setLoadingIssues(false); return; }
    Promise.all([
      getAllActiveSprints().catch(() => [] as JiraSprint[]),
      getFutureSprints(5).catch(() => [] as JiraSprint[]),
    ]).then(([active, future]) => {
      const all = [...active, ...future];
      setSprints(all);
      if (all.length > 0) setSelectedSprintId(all[0].id);
    });
  }, [jiraAvailable]);

  useEffect(() => {
    if (selectedSprintId === null) { setSprintIssues([]); setLoadingIssues(false); return; }
    setLoadingIssues(true);
    getSprintIssues(selectedSprintId).then(setSprintIssues).catch(() => setSprintIssues([])).finally(() => setLoadingIssues(false));
  }, [selectedSprintId]);

  const selectSprint = useCallback((sprint: JiraSprint) => {
    setSelectedSprintId(sprint.id);
    setSession(null);
    setInitError(null);
  }, []);

  async function startGroomingSession(issue: JiraIssue) {
    setInitError(null);
    let freshIssue: JiraIssue;
    try {
      freshIssue = await getIssue(issue.key);
    } catch (e) {
      // Log so we can see what failed, but continue with the sprint-list snapshot
      console.warn("[Meridian] getIssue failed, using sprint-list snapshot:", e);
      freshIssue = issue;
    }

    // Debug: log what fields Meridian actually received so we can verify
    // custom fields (AC, steps, behavior) are populated. Remove once confirmed.
    console.debug("[Meridian] freshIssue fields for", freshIssue.key, {
      acceptanceCriteria: freshIssue.acceptanceCriteria,
      stepsToReproduce: freshIssue.stepsToReproduce,
      observedBehavior: freshIssue.observedBehavior,
      expectedBehavior: freshIssue.expectedBehavior,
      discoveredFieldIds: freshIssue.discoveredFieldIds,
    });

    const sessionKey = freshIssue.key;
    setSession({ issue: freshIssue, chat: [], drafts: [], thinking: true, applying: false, probeStatus: "" });
    try {
      const ticketText = compileTicketText(freshIssue);

      // Pull latest on the grooming worktree, then probe for relevant files
      let fileContentsBlock = "";
      let worktreeContext = "";
      try {
        await syncGroomingWorktree();
        const worktreeInfo = await validateGroomingWorktree();
        worktreeContext = `\n\n=== CODEBASE CONTEXT ===\nWorktree: ${worktreeInfo.path}\nBranch: ${worktreeInfo.branch}`;
        const ticketWithContext = ticketText + worktreeContext;

        setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: "Identifying relevant files…" } : prev);
        const probeRaw = await runGroomingFileProbe(ticketWithContext);
        const probe = parseAgentJson<{ files: string[]; grep_patterns: string[] }>(probeRaw);
        if (probe) {
          const MAX_TOTAL = 40 * 1024;
          let totalSize = 0;
          const parts: string[] = [];
          for (const filePath of (probe.files ?? []).slice(0, 12)) {
            try {
              setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: `Reading ${filePath}…` } : prev);
              const content = await readGroomingFile(filePath);
              const chunk = `--- ${filePath} ---\n${content}\n`;
              if (totalSize + chunk.length > MAX_TOTAL) break;
              parts.push(chunk);
              totalSize += chunk.length;
            } catch { /* skip missing files */ }
          }
          for (const pattern of (probe.grep_patterns ?? []).slice(0, 6)) {
            try {
              setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: `Searching for "${pattern}"…` } : prev);
              const lines = await grepGroomingFiles(pattern);
              if (lines.length === 0) continue;
              const chunk = `--- grep: ${pattern} ---\n${lines.join("\n")}\n`;
              if (totalSize + chunk.length > MAX_TOTAL) break;
              parts.push(chunk);
              totalSize += chunk.length;
            } catch { /* skip */ }
          }
          if (parts.length > 0) fileContentsBlock = parts.join("\n");
        }
      } catch { /* no worktree configured — proceed without codebase context */ }

      setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: "" } : prev);
      const ticketWithContext = ticketText + worktreeContext;
      const raw = await runGroomingAgent(ticketWithContext, fileContentsBlock);
      const output = parseAgentJson<GroomingOutput>(raw);
      if (!output) throw new Error("Could not parse grooming response.");
      const drafts = suggestedEditsToDraftChanges(output.suggested_edits, freshIssue);
      const openingMsg = buildOpeningMessage(freshIssue, output);
      setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, drafts, chat: [{ role: "assistant", content: openingMsg }], thinking: false } : prev);
    } catch (e) {
      setInitError(String(e));
      setSession((prev) => (prev?.issue.key === sessionKey ? { ...prev, thinking: false } : prev));
    }
  }

  const selectTicket = useCallback((issue: JiraIssue) => {
    const hasUnapplied = session?.drafts.some((d) => d.status === "approved" && d.applyResult !== "ok");
    if (hasUnapplied && !confirm("You have approved changes not yet applied to JIRA. Leave anyway?")) return;
    startGroomingSession(issue);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function sendChatMessage(text: string) {
    if (!session) return;
    const issueKey = session.issue.key;
    const userMsg: GroomChatMessage = { role: "user", content: text };
    setSession((prev) => prev ? { ...prev, chat: [...prev.chat, userMsg], thinking: true } : prev);
    try {
      const ticketText = compileTicketText(session.issue);
      const contextText = `=== TICKET ===\n${ticketText}\n\n=== CURRENT DRAFT CHANGES ===\n${JSON.stringify(session.drafts)}`;
      const historyJson = JSON.stringify([...session.chat, userMsg]);
      const raw = await runGroomingChatTurn(contextText, historyJson);
      const response = parseAgentJson<GroomingChatResponse>(raw);
      if (!response) {
        // Model returned prose instead of JSON — show it directly as the assistant reply
        setSession((prev) => {
          if (!prev || prev.issue.key !== issueKey) return prev;
          return { ...prev, chat: [...prev.chat, { role: "assistant", content: raw.trim() }], thinking: false };
        });
        return;
      }
      setSession((prev) => {
        // Discard if the user switched tickets while this request was in-flight
        if (!prev || prev.issue.key !== issueKey) return prev;
        let drafts = [...prev.drafts];
        const touchedIds: string[] = [];
        for (const updated of response.updated_edits) {
          const idx = drafts.findIndex((d) => d.id === updated.id);
          if (idx >= 0) {
            const existing = drafts[idx];
            drafts[idx] = { ...existing, suggested: updated.suggested, editedSuggested: existing.userEdited ? existing.editedSuggested : updated.suggested, reasoning: updated.reasoning };
          } else {
            drafts.push({
              id: updated.id, field: updated.field, section: updated.section,
              current: updated.current ?? getCurrentFieldValue(updated.field, prev.issue),
              suggested: updated.suggested, editedSuggested: updated.suggested,
              userEdited: false, reasoning: updated.reasoning, status: "pending",
            });
          }
          touchedIds.push(updated.id);
        }
        if (touchedIds.length > 0) {
          setRecentlyUpdated(new Set(touchedIds));
          if (recentlyUpdatedTimerRef.current) clearTimeout(recentlyUpdatedTimerRef.current);
          recentlyUpdatedTimerRef.current = setTimeout(() => setRecentlyUpdated(new Set()), 2500);
        }
        return { ...prev, drafts, chat: [...prev.chat, { role: "assistant", content: response.message }], thinking: false };
      });
    } catch (e) {
      setSession((prev) => {
        if (!prev || prev.issue.key !== issueKey) return prev;
        return { ...prev, chat: [...prev.chat, { role: "assistant", content: `Sorry, something went wrong: ${String(e)}` }], thinking: false };
      });
    }
  }

  function approveDraft(id: string) {
    setSession((prev) => prev ? { ...prev, drafts: prev.drafts.map((d) => d.id === id ? { ...d, status: "approved", applyResult: undefined, applyError: undefined } : d) } : prev);
  }
  function declineDraft(id: string) {
    setSession((prev) => prev ? { ...prev, drafts: prev.drafts.map((d) => d.id === id ? { ...d, status: "declined" } : d) } : prev);
  }
  function editSuggested(id: string, value: string) {
    setSession((prev) => prev ? { ...prev, drafts: prev.drafts.map((d) => d.id === id ? { ...d, editedSuggested: value, userEdited: value !== d.suggested } : d) } : prev);
  }

  async function applyChanges() {
    if (!session) return;
    const toApply = session.drafts.filter((d) => d.status === "approved" && d.applyResult !== "ok");
    if (toApply.length === 0) return;
    setSession((prev) => (prev ? { ...prev, applying: true } : prev));
    const results: Record<string, { ok: boolean; error?: string }> = {};
    for (const draft of toApply) {
      const fieldId = resolveJiraFieldId(draft.field, session.issue);
      if (!fieldId) { results[draft.id] = { ok: false, error: "Field ID not auto-discovered." }; continue; }
      try {
        await updateJiraFields(session.issue.key, JSON.stringify({ [fieldId]: draft.editedSuggested }));
        results[draft.id] = { ok: true };
      } catch (e) {
        results[draft.id] = { ok: false, error: String(e) };
      }
    }
    const freshIssue = await getIssue(session.issue.key).catch(() => session.issue);
    setSession((prev) => prev ? {
      ...prev, issue: freshIssue, applying: false,
      drafts: prev.drafts.map((d) => {
        const r = results[d.id];
        if (!r) return d;
        return { ...d, applyResult: r.ok ? "ok" : "error", applyError: r.error, current: r.ok ? d.editedSuggested : d.current };
      }),
    } : prev);
  }

  const selectedSprint = sprints.find((s) => s.id === selectedSprintId) ?? null;

  const groomingCommands: SlashCommand[] = useMemo(() => {
    const history = session?.chat ?? [];
    return [
      ...createGlobalCommands({
        history,
        clearHistory: () => {
          setSession((prev) => (prev ? { ...prev, chat: [] } : prev));
        },
        sendMessage: (text: string) => sendChatMessage(text),
        removeLastAssistantMessage: () => {
          setSession((prev) => {
            if (!prev) return prev;
            const chat = prev.chat;
            if (chat.length === 0 || chat[chat.length - 1].role !== "assistant") return prev;
            return { ...prev, chat: chat.slice(0, -1) };
          });
        },
      }),
      {
        name: "blockers",
        description: "Show grooming blockers the assistant flagged",
        execute: ({ toast: t }) => {
          if (!session) { t.info("No session active"); return; }
          const blockers = session.drafts
            .filter((d) => d.reasoning?.toLowerCase().includes("block"))
            .map((d) => `• ${d.field}: ${d.reasoning}`);
          if (blockers.length === 0) {
            t.info("No blockers flagged in the current session");
            return;
          }
          t("Blockers", { description: blockers.join("\n") });
        },
      },
      {
        name: "ac",
        description: "Show the current acceptance criteria",
        execute: async () => {
          await sendChatMessage("Show me the current acceptance criteria verbatim.");
        },
      },
      {
        name: "revise",
        description: "Ask the assistant to revise a specific field",
        args: "<field>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a field name, e.g. /revise acceptance-criteria");
            return;
          }
          await sendChatMessage(`Please revise the ${args.trim()} field and surface a new suggested value.`);
        },
      },
      {
        name: "apply",
        description: "Push all approved field revisions to JIRA",
        execute: async ({ toast: t }) => {
          if (!session) { t.info("No session active"); return; }
          const toApply = session.drafts.filter((d) => d.status === "approved" && d.applyResult !== "ok");
          if (toApply.length === 0) {
            t.info("Nothing to apply — approve some changes first");
            return;
          }
          await applyChanges();
          t.success(`Applied ${toApply.length} change${toApply.length === 1 ? "" : "s"}`);
        },
      },
      {
        name: "template",
        description: "Remind the assistant of the grooming format template",
        execute: async () => {
          await sendChatMessage(
            "What's the active grooming format template you're working against?",
          );
        },
      },
    ];
    // sendChatMessage + applyChanges close over `session`, so we tie the
    // memo to that. They're stable otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <WorkflowPanelHeader
        leading={
          <>
            <Button variant="ghost" size="icon" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
            <div className="min-w-0">
              <h1 className={`${APP_HEADER_TITLE} leading-none`}>Groom Tickets</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {selectedSprint ? `${selectedSprint.name}${selectedSprint.state === "future" ? " · upcoming" : ""}` : "AI-assisted ticket grooming with JIRA write-back"}
              </p>
            </div>
          </>
        }
      />

      {/* Credential warnings */}
      {(!jiraAvailable || !claudeAvailable) && (
        <div className="shrink-0 px-4 pt-3 space-y-2">
          {!jiraAvailable && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              JIRA credentials not configured — ticket search unavailable.
            </div>
          )}
          {!claudeAvailable && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              No AI provider configured — grooming assistant unavailable.
            </div>
          )}
        </div>
      )}

      {/* Three-pane resizable layout — flush edge to edge */}
      <div className="flex-1 min-h-0 flex flex-row overflow-hidden">

        {/* ── Left pane: ticket selector ── */}
        <div className="flex flex-col min-h-0 p-4 pr-0" style={{ width: leftWidth, minWidth: leftWidth, maxWidth: leftWidth }}>
          <Card className="flex flex-col flex-1 min-h-0">
            <CardHeader className="pb-3 shrink-0">
              <CardTitle className="text-sm font-semibold">Select a Ticket</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 flex flex-col flex-1 min-h-0">
              <TicketSelector
                sprints={sprints} selectedSprintId={selectedSprintId} onSelectSprint={selectSprint}
                sprintIssues={sprintIssues} loadingIssues={loadingIssues}
                selected={session?.issue ?? null} onSelect={selectTicket}
              />
            </CardContent>
          </Card>
        </div>

        {/* ── Drag handle 1 (left ↔ middle) ── */}
        <div
          onMouseDown={onLeftDividerMouseDown}
          className="w-1.5 shrink-0 mx-2 rounded-full cursor-col-resize hover:bg-muted-foreground/30 active:bg-muted-foreground/50 transition-colors self-stretch mt-4 mb-4"
          title="Drag to resize"
        />

        {/* ── Middle pane: ticket summary + draft changes (scrollable) ── */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto py-4 gap-4 pr-0">
          {!session && !initError && (
            <div className="flex items-center justify-center rounded-lg border border-dashed h-48 text-muted-foreground text-sm mx-2">
              Select a ticket to start an AI grooming session
            </div>
          )}

          {session && (
            <>
              <div className="mx-2"><TicketSummaryCard issue={session.issue} onReanalyze={() => startGroomingSession(session.issue)} analyzing={session.thinking} /></div>

              {initError && !session.thinking && (
                <Card className="border-destructive/50 shrink-0 mx-2">
                  <CardContent className="pt-4 space-y-3">
                    <p className="text-sm text-destructive">{initError}</p>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => startGroomingSession(session.issue)}>
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </Button>
                  </CardContent>
                </Card>
              )}

              <div className="mx-2">
                <DraftChangesPanel
                  drafts={session.drafts} issue={session.issue} applying={session.applying}
                  highlightedIds={recentlyUpdated}
                  onApprove={approveDraft} onDecline={declineDraft} onEditSuggested={editSuggested}
                  onApply={applyChanges}
                />
              </div>
            </>
          )}
        </div>

        {/* ── Drag handle 2 (middle ↔ chat) ── */}
        <div
          onMouseDown={onChatDividerMouseDown}
          className="w-1.5 shrink-0 mx-2 rounded-full cursor-col-resize hover:bg-muted-foreground/30 active:bg-muted-foreground/50 transition-colors self-stretch mt-4 mb-4"
          title="Drag to resize"
        />

        {/* ── Right pane: grooming assistant (flush to right edge, always visible) ── */}
        <div className="flex flex-col min-h-0 py-4 pl-0 pr-4" style={{ width: chatWidth, minWidth: chatWidth, maxWidth: chatWidth }}>
          {session ? (
            <ChatPanel messages={session.chat} thinking={session.thinking} probeStatus={session.probeStatus} onSend={sendChatMessage} commands={groomingCommands} />
          ) : (
            <Card className="flex flex-col flex-1 min-h-0">
              <CardHeader className="pb-2 shrink-0 border-b">
                <CardTitle className="text-sm font-semibold">Grooming Assistant</CardTitle>
                <p className="text-xs text-muted-foreground">Ask questions or request field changes</p>
              </CardHeader>
              <CardContent className="flex-1 flex items-center justify-center">
                <p className="text-xs text-muted-foreground text-center leading-relaxed">
                  Select a ticket to start<br />a grooming session
                </p>
              </CardContent>
            </Card>
          )}
        </div>

      </div>
    </div>
  );
}
