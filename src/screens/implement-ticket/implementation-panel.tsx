import { Button } from "@/components/ui/button";
import { type ImplementationOutput } from "@/lib/tauri/workflows";
import { type VerificationOutput, getFileAtBase, readRepoFile, writeRepoFile } from "@/lib/tauri/worktree";
import { cn } from "@/lib/utils";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { AlertTriangle, Check, FileCode, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CollapsibleList } from "./_shared";
import { VerificationOutputPanel } from "./build-verification-panel";

export function ImplementationStatusContent({
  data,
  verificationOutput,
}: {
  data: ImplementationOutput;
  verificationOutput: VerificationOutput | null;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">{data.summary}</p>
      {verificationOutput && <VerificationOutputPanel result={verificationOutput} />}
      {data.files_changed.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
            <FileCode className="h-4 w-4 text-muted-foreground" /> Files changed
            ({data.files_changed.length})
          </div>
          <div className="divide-y">
            {data.files_changed.map((f, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-0.5">
                  <code className="text-xs font-mono">{f.path}</code>
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      f.action === "created"
                        ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                        : f.action === "deleted"
                          ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                          : "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                    }`}
                  >
                    {f.action}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{f.summary}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {data.deviations.length > 0 && (
        <div className="border border-amber-300 rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/30 text-sm font-medium flex items-center gap-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" /> Deviations from plan (
            {data.deviations.length})
          </div>
          <div className="divide-y">
            {data.deviations.map((d, i) => (
              <p key={i} className="px-3 py-2 text-sm text-muted-foreground">
                {d}
              </p>
            ))}
          </div>
        </div>
      )}
      {data.skipped.length > 0 && (
        <CollapsibleList
          title={`Skipped files (${data.skipped.length})`}
          items={data.skipped}
          icon={<AlertTriangle className="h-4 w-4 text-red-500" />}
        />
      )}
    </div>
  );
}

interface FileDiffState {
  original: string;
  modified: string;
  loading: boolean;
  saving: boolean;
  saved: boolean;
}

export function ImplementationDiffContent({ data }: { data: ImplementationOutput }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(
    data.files_changed.length > 0 ? data.files_changed[0].path : null,
  );
  const [fileStates, setFileStates] = useState<Record<string, FileDiffState>>({});
  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);

  useEffect(() => {
    if (!selectedFile) return;
    if (fileStates[selectedFile]) return;
    setFileStates((prev) => ({
      ...prev,
      [selectedFile]: { original: "", modified: "", loading: true, saving: false, saved: false },
    }));
    Promise.all([
      getFileAtBase(selectedFile).catch(() => ""),
      readRepoFile(selectedFile).catch(() => ""),
    ]).then(([original, modified]) => {
      setFileStates((prev) => ({
        ...prev,
        [selectedFile]: { original, modified, loading: false, saving: false, saved: false },
      }));
    });
  }, [selectedFile]);

  const handleSave = useCallback(async () => {
    if (!selectedFile) return;
    const editor = editorRef.current;
    if (!editor) return;
    const modifiedModel = editor.getModifiedEditor().getModel();
    if (!modifiedModel) return;
    const content = modifiedModel.getValue();
    setFileStates((prev) => ({
      ...prev,
      [selectedFile]: { ...prev[selectedFile], saving: true, saved: false },
    }));
    try {
      await writeRepoFile(selectedFile, content);
      setFileStates((prev) => ({
        ...prev,
        [selectedFile]: { ...prev[selectedFile], modified: content, saving: false, saved: true },
      }));
      setTimeout(() => {
        setFileStates((prev) => ({
          ...prev,
          [selectedFile]: { ...prev[selectedFile], saved: false },
        }));
      }, 2000);
    } catch {
      setFileStates((prev) => ({
        ...prev,
        [selectedFile]: { ...prev[selectedFile], saving: false },
      }));
    }
  }, [selectedFile]);

  const currentState = selectedFile ? fileStates[selectedFile] : null;

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex flex-wrap gap-1">
        {data.files_changed.map((f) => (
          <button
            key={f.path}
            onClick={() => setSelectedFile(f.path)}
            className={cn(
              "text-xs font-mono px-2 py-1 rounded border truncate max-w-[240px]",
              selectedFile === f.path
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted/40 text-muted-foreground border-transparent hover:border-border",
            )}
            title={f.path}
          >
            {f.path.split("/").pop()}
          </button>
        ))}
      </div>
      {selectedFile && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <code className="truncate">{selectedFile}</code>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs px-2 ml-2 shrink-0"
            onClick={handleSave}
            disabled={!currentState || currentState.loading || currentState.saving}
          >
            {currentState?.saving ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : currentState?.saved ? (
              <Check className="h-3 w-3 mr-1 text-green-500" />
            ) : null}
            {currentState?.saved ? "Saved" : "Save"}
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 rounded border overflow-hidden">
        {!selectedFile ? (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            No files changed
          </div>
        ) : currentState?.loading ? (
          <div className="flex items-center justify-center h-32 gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading diff…
          </div>
        ) : (
          <DiffEditor
            height="100%"
            original={currentState?.original ?? ""}
            modified={currentState?.modified ?? ""}
            language={getLanguageForPath(selectedFile)}
            theme="vs-dark"
            options={{
              readOnly: false,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
            }}
            onMount={(editor) => {
              editorRef.current = editor;
            }}
          />
        )}
      </div>
    </div>
  );
}

function getLanguageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    rs: "rust", py: "python", go: "go",
    json: "json", toml: "toml", yaml: "yaml", yml: "yaml",
    md: "markdown", css: "css", html: "html",
    sh: "shell", bash: "shell",
  };
  return map[ext] ?? "plaintext";
}

export function ImplementationPanel({
  data,
  tab,
  verificationOutput,
}: {
  data: ImplementationOutput;
  tab: "status" | "diff";
  verificationOutput: VerificationOutput | null;
}) {
  return tab === "status" ? (
    <ImplementationStatusContent data={data} verificationOutput={verificationOutput} />
  ) : (
    <ImplementationDiffContent data={data} />
  );
}
