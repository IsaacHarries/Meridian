import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type JiraSprint } from "@/lib/tauri/jira";
import { ChevronDown, ChevronRight, GitPullRequest } from "lucide-react";
import { useState } from "react";
import { avgMergeHours, formatDuration, sprintPrs } from "./_shared";

export function PrActivityCard({
  sprint,
  allPrs,
}: {
  sprint: JiraSprint;
  allPrs: BitbucketPr[];
}) {
  const [showPrs, setShowPrs] = useState(false);
  const prs = sprintPrs(allPrs, sprint);
  const avg = avgMergeHours(prs);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <GitPullRequest className="h-4 w-4" />
          Pull Requests
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold tabular-nums">{prs.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Merged this sprint</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums">
              {avg !== null ? formatDuration(avg) : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Avg time to merge</p>
          </div>
        </div>

        {prs.length > 0 && (
          <div className="border-t pt-3">
            <button
              onClick={() => setShowPrs((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
            >
              {showPrs ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              View {prs.length} merged PR{prs.length !== 1 ? "s" : ""}
            </button>
            {showPrs && (
              <ul className="mt-2 space-y-1">
                {prs.map((pr) => (
                  <li key={pr.id} className="flex items-center gap-2 text-xs py-0.5">
                    <span className="font-mono text-muted-foreground shrink-0">#{pr.id}</span>
                    <span className="truncate text-muted-foreground">{pr.title}</span>
                    <span className="shrink-0 text-muted-foreground/60 ml-auto">
                      {formatDuration(
                        Math.round(
                          (new Date(pr.updatedOn).getTime() -
                            new Date(pr.createdOn).getTime()) /
                            3_600_000
                        )
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {prs.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-1">
            No merged PRs recorded for this sprint period.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
