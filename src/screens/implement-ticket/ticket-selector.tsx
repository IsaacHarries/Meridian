import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { fuzzyFilterIssues, mergeIssuesById } from "@/lib/fuzzySearch";
import { type JiraIssue, searchJiraIssues } from "@/lib/tauri/jira";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface TicketSelectorProps {
  sprintIssues: JiraIssue[];
  loading: boolean;
  onSelect: (issue: JiraIssue) => void;
  sessionKeys: Set<string>;
}

export function TicketSelector({
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
