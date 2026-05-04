import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type JiraIssue, type JiraSprint } from "@/lib/tauri/jira";
import { isDone, totalPoints } from "./_shared";

export function VelocityCard({ sprint, issues }: { sprint: JiraSprint; issues: JiraIssue[] }) {
  const committed = totalPoints(issues);
  const completed = totalPoints(issues.filter((i) => isDone(i, sprint.endDate)));
  const pct = committed > 0 ? Math.round((completed / committed) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Velocity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold tabular-nums">{committed}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Committed pts</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums text-emerald-600">{completed}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Completed pts</p>
          </div>
          <div>
            <p
              className={`text-2xl font-bold tabular-nums ${
                pct >= 80
                  ? "text-emerald-600"
                  : pct >= 60
                  ? "text-amber-500"
                  : "text-red-500"
              }`}
            >
              {pct}%
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Completion rate</p>
          </div>
        </div>

        {committed > 0 && (
          <div className="space-y-1">
            <div className="h-3 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{completed} done</span>
              <span>{committed - completed} not completed</span>
            </div>
          </div>
        )}

        {sprint.goal && (
          <p className="text-xs text-muted-foreground border-t pt-3 italic">
            Goal: {sprint.goal}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
