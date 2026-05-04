import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getGroomingTemplatePath, loadGroomingTemplate, revealGroomingTemplatesDir, saveGroomingTemplate, type GroomingTemplateKind } from "@/lib/tauri/templates";
import {
    AlertCircle,
    CheckCircle,
    FileText,
    FolderOpen,
    Loader2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type SectionStatus } from "./_shared";

const AC_PLACEHOLDER = `- <first acceptance criterion, written as a bullet>
- <second acceptance criterion>
- <third acceptance criterion>
`;

const STR_PLACEHOLDER = `1. <first step to reproduce, on its own line>
2. <second step>
3. <third step>
`;

function GroomingTemplateEditor({
  kind,
  label,
  description,
  placeholder,
}: {
  kind: GroomingTemplateKind;
  label: string;
  description: string;
  placeholder: string;
}) {
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState("");
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });

  useEffect(() => {
    loadGroomingTemplate(kind)
      .then((c) => {
        setContent(c);
        setBaseline(c);
      })
      .catch(() => {});
    getGroomingTemplatePath(kind)
      .then(setPath)
      .catch(() => {});
  }, [kind]);

  const dirty = content !== baseline;

  async function save() {
    setStatus({ state: "loading", message: "" });
    try {
      await saveGroomingTemplate(kind, content);
      setBaseline(content);
      setStatus({ state: "success", message: "Saved" });
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <Label
          htmlFor={`grooming-template-${kind}`}
          className="text-sm font-medium"
        >
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Textarea
        id={`grooming-template-${kind}`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder}
        className="min-h-[160px] font-mono text-sm resize-y leading-relaxed"
      />
      <div className="flex items-center justify-between gap-3">
        {path && (
          <p className="text-xs text-muted-foreground font-mono break-all">
            File: {path}
          </p>
        )}
        <Button
          onClick={save}
          disabled={!dirty || status.state === "loading"}
          size="sm"
          className="gap-2 ml-auto"
        >
          {status.state === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}
          Save
        </Button>
      </div>
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
    </div>
  );
}

export function GroomingTemplatesSection() {
  async function openFolder() {
    try {
      await revealGroomingTemplatesDir();
    } catch {
      /* silent — same folder as PR template, surfaced there too */
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Grooming Format Templates
        </CardTitle>
        <CardDescription>
          Formatting rules the Grooming agent follows when drafting ticket
          fields. Leave a template blank to let the agent choose its own format
          for that field.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <GroomingTemplateEditor
          kind="acceptance_criteria"
          label="Acceptance Criteria"
          description="Applied when the agent drafts or rewrites the acceptance_criteria field on Story/Task tickets."
          placeholder={AC_PLACEHOLDER}
        />
        <GroomingTemplateEditor
          kind="steps_to_reproduce"
          label="Steps to Reproduce"
          description="Applied when the agent drafts or rewrites the steps_to_reproduce field on Bug tickets."
          placeholder={STR_PLACEHOLDER}
        />
        <div className="pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={openFolder}
            className="gap-2"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open folder
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
