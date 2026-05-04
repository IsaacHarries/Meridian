import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { fuzzyFilterIssues, mergeIssuesById } from "@/lib/fuzzySearch";
import { priorityColor } from "@/lib/priority";
import { type JiraIssue, type JiraSprint, searchJiraIssues } from "@/lib/tauri/jira";
import {
    ArrowDown,
    ArrowUp,
    ArrowUpDown,
    Calendar,
    Loader2,
    Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { statusAge } from "./_shared";

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

export function TicketSelector({ sprints, selectedSprintId, onSelectSprint, sprintIssues, loadingIssues, selected, onSelect }: {
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

  const rawList = useMemo(() => {
    if (!q) return sprintIssues;
    return fuzzyFilterIssues(q, mergeIssuesById(sprintIssues, searchResults));
  }, [q, sprintIssues, searchResults]);
  const displayList = sortIssues(rawList, sortField, sortDir);
  const showLoading = q ? searching && rawList.length === 0 : loadingIssues;

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
        <Input placeholder="Fuzzy search tickets or enter key (e.g. PROJ-123)…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
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
