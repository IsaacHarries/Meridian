import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isMockClaudeMode, isMockMode, setMockClaudeMode, setMockMode } from "@/lib/tauri/core";
import { AlertCircle, FlaskConical, FlaskRound } from "lucide-react";
import { useState } from "react";

export function MockModeSection({ onToggle }: { onToggle: () => void }) {
  const [enabled, setEnabled] = useState(isMockMode());

  function toggle() {
    const next = !enabled;
    setMockMode(next);
    setEnabled(next);
    onToggle();
  }

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start gap-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 shrink-0">
            <FlaskRound className="h-4 w-4 text-amber-500" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-medium">Mock Data Mode</p>
              {enabled && (
                <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-xs">
                  Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Replace JIRA and Bitbucket API calls with realistic local mock
              data. Useful for testing without API access. Claude still calls
              the API unless{" "}
              <span className="font-medium text-foreground">
                Mock AI responses
              </span>{" "}
              is enabled below.
            </p>
          </div>
          <Button
            variant={enabled ? "default" : "outline"}
            size="sm"
            onClick={toggle}
            className={
              enabled
                ? "bg-amber-500 hover:bg-amber-600 text-white shrink-0"
                : "shrink-0"
            }
          >
            {enabled ? "Disable" : "Enable"}
          </Button>
        </div>
        {enabled && (
          <div className="mt-3 ml-13 flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2">
            <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Navigate back to the landing screen to reload data sources with
              mock mode active.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MockClaudeModeSection({ onToggle }: { onToggle: () => void }) {
  const [enabled, setEnabled] = useState(isMockClaudeMode());

  function toggle() {
    const next = !enabled;
    setMockClaudeMode(next);
    setEnabled(next);
    onToggle();
  }

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start gap-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 shrink-0">
            <FlaskConical className="h-4 w-4 text-violet-500" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-medium">Mock AI responses</p>
              {enabled && (
                <Badge className="bg-violet-500/15 text-violet-600 border-violet-500/30 text-xs">
                  Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Return pre-recorded agent responses for pipelines, retros,
              workload, ticket quality, and PR review — no Anthropic API calls
              made. JIRA and Bitbucket are unaffected (enable Mock Data Mode for
              those).
            </p>
          </div>
          <Button
            variant={enabled ? "default" : "outline"}
            size="sm"
            onClick={toggle}
            className={
              enabled
                ? "bg-violet-600 hover:bg-violet-700 text-white shrink-0"
                : "shrink-0"
            }
          >
            {enabled ? "Disable" : "Enable"}
          </Button>
        </div>
        {enabled && (
          <div className="mt-3 ml-13 flex items-start gap-2 rounded-md bg-violet-500/10 border border-violet-500/20 px-3 py-2">
            <AlertCircle className="h-3.5 w-3.5 text-violet-600 shrink-0 mt-0.5" />
            <p className="text-xs text-violet-700 dark:text-violet-400">
              Anthropic is treated as configured while this is on. Re-run any
              workflow to see pre-recorded output.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
