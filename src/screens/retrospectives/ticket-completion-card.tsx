import { JiraTicketLink } from "@/components/JiraTicketLink";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type JiraIssue, type JiraSprint } from "@/lib/tauri/jira";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { isDone } from "./_shared";

export function TicketCompletionCard({ sprint, issues }: { sprint: JiraSprint; issues: JiraIssue[] }) {
  const [showCarryOver, setShowCarryOver] = useState(false);
  const done = issues.filter((i) => isDone(i, sprint.endDate));
  const carryOver = issues.filter((i) => !isDone(i, sprint.endDate));
  const pct = issues.length > 0 ? Math.round((done.length / issues.length) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Ticket Completion</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold tabular-nums">{issues.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Committed</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums text-emerald-600">{done.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Completed</p>
          </div>
          <div>
            <p
              className={`text-2xl font-bold tabular-nums ${
                carryOver.length === 0
                  ? "text-emerald-600"
                  : carryOver.length <= 2
                  ? "text-amber-500"
                  : "text-red-500"
              }`}
            >
              {carryOver.length}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Carry-over</p>
          </div>
        </div>

        {issues.length > 0 && (
          <div className="h-3 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        {carryOver.length > 0 && (
          <div className="border-t pt-3">
            <button
              onClick={() => setShowCarryOver((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
            >
              {showCarryOver ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {carryOver.length} ticket{carryOver.length !== 1 ? "s" : ""} not completed
            </button>
            {showCarryOver && (
              <ul className="mt-2 space-y-1">
                {carryOver.map((issue) => (
                  <li key={issue.key} className="flex items-center gap-2 text-xs py-0.5">
                    <JiraTicketLink ticketKey={issue.key} url={issue.url} />
                    <span className="truncate text-muted-foreground">{issue.summary}</span>
                    <Badge variant="secondary" className="text-[10px] shrink-0 ml-auto">
                      {issue.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
