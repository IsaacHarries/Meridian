import { FlaskConical } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToggleRow, useAppPreferencesEditor } from "./_shared";

export function AiDebugSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          AI traffic debug capture
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          When enabled, every LLM round-trip (system prompt, messages,
          response, token usage, latency) is captured into the in-app
          debug panel. Use this to inspect prompts, find waste, and
          tune workflows. Off by default — capture sends prompt JSON
          across the IPC channel for every call.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <ToggleRow
            label="Log AI traffic to debug panel"
            helper="Takes effect on the next workflow run — currently in-flight runs aren't retroactively captured."
            checked={prefs.aiDebugEnabled}
            onChange={(b) => void update("aiDebugEnabled", b)}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
