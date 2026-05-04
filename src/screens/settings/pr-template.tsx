import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getPreferences, setPreference } from "@/lib/preferences";
import { getPrTemplatePath, loadPrTemplate, revealPrTemplateDir, savePrTemplate, type PrTemplateMode } from "@/lib/tauri/templates";
import {
    AlertCircle,
    CheckCircle,
    FileText,
    FolderOpen,
    Loader2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type SectionStatus } from "./_shared";

const PR_TEMPLATE_PLACEHOLDER = `## Summary
<1–2 sentence summary of what changed and why>

## Changes
- <bullet points of the key changes>

## Testing
<how this was tested — unit tests, manual steps, etc.>

## Linked ticket
<JIRA key and URL>
`;

export function PrTemplateSection() {
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState("");
  const [mode, setMode] = useState<PrTemplateMode>("guide");
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });

  useEffect(() => {
    loadPrTemplate()
      .then((c) => {
        setContent(c);
        setBaseline(c);
      })
      .catch(() => {});
    getPreferences().then((prefs) => {
      const m = prefs["pr_template_mode"];
      setMode(m === "strict" ? "strict" : "guide");
    });
    getPrTemplatePath()
      .then(setPath)
      .catch(() => {});
  }, []);

  const dirty = content !== baseline;

  async function save() {
    setStatus({ state: "loading", message: "" });
    try {
      await savePrTemplate(content);
      setBaseline(content);
      setStatus({ state: "success", message: "Saved" });
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  async function toggleMode(next: boolean) {
    const value: PrTemplateMode = next ? "strict" : "guide";
    setMode(value);
    try {
      await setPreference("pr_template_mode", value);
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  async function openFolder() {
    try {
      await revealPrTemplateDir();
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          PR Description Template
        </CardTitle>
        <CardDescription>
          Markdown template the PR Description agent uses when drafting the PR
          body in the Implement a Ticket workflow. Leave blank to let the agent
          choose its own structure.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="pr-template-mode" className="text-sm font-medium">
              Strictly enforce template
            </Label>
            <p className="text-xs text-muted-foreground max-w-md">
              {mode === "strict"
                ? "Agent must follow the template exactly — same headings, same order. Sections with no content get 'N/A'."
                : "Template is a guide — the agent follows it where it fits but may adapt or omit sections for simple PRs."}
            </p>
          </div>
          <Switch
            id="pr-template-mode"
            checked={mode === "strict"}
            onCheckedChange={toggleMode}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pr-template-content">Template</Label>
          <Textarea
            id="pr-template-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={PR_TEMPLATE_PLACEHOLDER}
            className="min-h-[320px] font-mono text-sm resize-y leading-relaxed"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={openFolder}
            className="gap-2"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open folder
          </Button>
          <Button
            onClick={save}
            disabled={!dirty || status.state === "loading"}
            size="sm"
            className="gap-2"
          >
            {status.state === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Save
          </Button>
        </div>

        {path && (
          <p className="text-xs text-muted-foreground font-mono break-all">
            File: {path}
          </p>
        )}
        {status.state === "success" && (
          <p className="text-xs text-emerald-600 flex items-center gap-1">
            <CheckCircle className="h-3 w-3" /> {status.message}
          </p>
        )}
        {status.state === "error" && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> {status.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
