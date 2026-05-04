import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { getOpenPrs } from "@/lib/tauri/bitbucket";
import { getActiveSprint } from "@/lib/tauri/jira";
import { debugJiraEndpoints } from "@/lib/tauri/providers";
import { FlaskConical, Loader2 } from "lucide-react";
import { useState } from "react";

type DataTestState = "idle" | "loading" | "success" | "error";

export function DataTestSection({
  fullyConfigured,
}: {
  fullyConfigured: boolean;
}) {
  const [state, setState] = useState<DataTestState>("idle");
  const [result, setResult] = useState("");
  const [diagState, setDiagState] = useState<DataTestState>("idle");
  const [diagResult, setDiagResult] = useState("");

  async function runTest() {
    setState("loading");
    setResult("");
    try {
      const sprint = await getActiveSprint();
      const prs = await getOpenPrs();
      const lines: string[] = [];
      if (sprint) {
        lines.push(`Active sprint: "${sprint.name}" (${sprint.state})`);
        if (sprint.endDate) {
          const days = Math.ceil(
            (new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000,
          );
          lines.push(
            `  ${days > 0 ? `${days} days remaining` : "Sprint ended"}`,
          );
        }
      } else {
        lines.push("No active sprint found.");
      }
      lines.push(`Open PRs in repo: ${prs.length}`);
      if (prs.length > 0) {
        lines.push(`  e.g. "#${prs[0].id} — ${prs[0].title.slice(0, 60)}"`);
      }
      setResult(lines.join("\n"));
      setState("success");
    } catch (err) {
      setResult(String(err));
      setState("error");
    }
  }

  async function runDiag() {
    setDiagState("loading");
    setDiagResult("");
    try {
      const report = await debugJiraEndpoints();
      setDiagResult(report);
      setDiagState("success");
    } catch (err) {
      setDiagResult(String(err));
      setDiagState("error");
    }
  }

  const loading = state === "loading" || diagState === "loading";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div>
          <CardTitle className="text-base">Data connection test</CardTitle>
          <CardDescription className="text-xs mt-0.5">
            Verify JIRA and Bitbucket are returning live data
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={runTest}
            disabled={!fullyConfigured || loading}
            className="gap-1.5"
          >
            {state === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5" />
            )}
            {state === "loading" ? "Fetching…" : "Run test"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={runDiag}
            disabled={loading}
            className="gap-1.5"
          >
            {diagState === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5" />
            )}
            {diagState === "loading" ? "Running…" : "JIRA endpoint diagnostics"}
          </Button>
        </div>
        {!fullyConfigured && (
          <p className="text-xs text-muted-foreground">
            Complete credentials and configuration above first.
          </p>
        )}
        {result && (
          <div
            className={`rounded-md px-3 py-2 text-xs font-mono whitespace-pre-wrap ${
              state === "success"
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive"
            }`}
          >
            {result}
          </div>
        )}
        {diagResult && (
          <div className="rounded-md px-3 py-2 text-xs font-mono whitespace-pre-wrap max-h-96 overflow-y-auto bg-muted text-muted-foreground border">
            {diagResult}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
