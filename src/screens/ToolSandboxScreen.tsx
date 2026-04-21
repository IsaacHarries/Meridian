import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Play, Loader2, ClipboardCopy, Check, Cpu, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  APP_HEADER_BAR,
  APP_HEADER_ROW_PANEL,
  APP_HEADER_TITLE,
} from "@/components/appHeaderLayout";
import { runToolTest, runToolTestWithLlm, type LlmToolTestResult } from "@/lib/tauri";
import { listen } from "@tauri-apps/api/event";

interface ToolSandboxScreenProps {
  onBack: () => void;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

interface ParamDef {
  name: string;
  type: "string" | "integer";
  description: string;
  required: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  params: ParamDef[];
  defaultInput: Record<string, string | number>;
}

const TOOLS: ToolDef[] = [
  {
    name: "read_repo_file",
    description: "Read a source file from the configured git worktree.",
    params: [
      { name: "path", type: "string", required: true, description: "Relative path from repo root, e.g. src/index.ts" },
    ],
    defaultInput: { path: "src/index.ts" },
  },
  {
    name: "write_repo_file",
    description: "Write or overwrite a file in the git worktree with complete content.",
    params: [
      { name: "path", type: "string", required: true, description: "Relative path from repo root" },
      { name: "content", type: "string", required: true, description: "Complete file content" },
    ],
    defaultInput: { path: "sandbox-test.txt", content: "Hello from Meridian tool sandbox." },
  },
  {
    name: "grep_repo",
    description: "Search the codebase with a regex pattern.",
    params: [
      { name: "pattern", type: "string", required: true, description: "Extended regex pattern" },
      { name: "path", type: "string", required: false, description: "Optional subdirectory to restrict search" },
    ],
    defaultInput: { pattern: "export function", path: "src" },
  },
  {
    name: "fetch_url",
    description: "Fetch the plain-text content of a public URL.",
    params: [
      { name: "url", type: "string", required: true, description: "Full https:// URL" },
    ],
    defaultInput: { url: "https://example.com" },
  },
  {
    name: "search_jira",
    description: "Search JIRA tickets by keyword or JQL.",
    params: [
      { name: "query", type: "string", required: true, description: "Keyword or JQL, e.g. project = XYZ" },
    ],
    defaultInput: { query: "status = \"In Progress\"" },
  },
  {
    name: "get_jira_issue",
    description: "Fetch a specific JIRA ticket by key.",
    params: [
      { name: "key", type: "string", required: true, description: "JIRA issue key, e.g. PROJ-123" },
    ],
    defaultInput: { key: "PROJ-1" },
  },
  {
    name: "get_pr_diff",
    description: "Fetch the full diff of a Bitbucket pull request.",
    params: [
      { name: "pr_id", type: "integer", required: true, description: "Numeric Bitbucket PR ID" },
    ],
    defaultInput: { pr_id: 1 },
  },
  {
    name: "get_pr_comments",
    description: "Fetch comments on a Bitbucket pull request.",
    params: [
      { name: "pr_id", type: "integer", required: true, description: "Numeric Bitbucket PR ID" },
    ],
    defaultInput: { pr_id: 1 },
  },
  {
    name: "git_log",
    description: "Get recent git commit history, optionally filtered to a file.",
    params: [
      { name: "file", type: "string", required: false, description: "Optional file path to filter history" },
      { name: "max_commits", type: "integer", required: false, description: "Number of commits to return (default 20)" },
    ],
    defaultInput: { file: "", max_commits: 10 },
  },
  {
    name: "search_npm",
    description: "Search the npm registry for a JavaScript/TypeScript package.",
    params: [
      { name: "package", type: "string", required: true, description: "Package name or search term" },
    ],
    defaultInput: { package: "zustand" },
  },
  {
    name: "search_crates",
    description: "Search crates.io for a Rust crate.",
    params: [
      { name: "name", type: "string", required: true, description: "Crate name or search term" },
    ],
    defaultInput: { name: "serde" },
  },
  {
    name: "exec_in_worktree",
    description: "Run a shell command in the repo root and return combined stdout+stderr. Used for building, type-checking, running tests, etc.",
    params: [
      { name: "command", type: "string", required: true, description: "Shell command to run, e.g. pnpm build" },
      { name: "timeout_secs", type: "integer", required: false, description: "Timeout in seconds (max 300, default 120)" },
    ],
    defaultInput: { command: "pnpm build", timeout_secs: 120 },
  },
  {
    name: "glob_repo",
    description: "Find files in the repo by glob pattern. Returns matching paths relative to the repo root.",
    params: [
      { name: "pattern", type: "string", required: true, description: "Glob pattern, e.g. src/**/*.tsx or **/*.test.ts" },
    ],
    defaultInput: { pattern: "src/**/*.tsx" },
  },
  {
    name: "git_status",
    description: "Show current git working tree status — which files have been added, modified, or deleted.",
    params: [],
    defaultInput: {},
  },
  {
    name: "delete_repo_file",
    description: "Delete a file from the repo worktree.",
    params: [
      { name: "path", type: "string", required: true, description: "Relative path from repo root" },
    ],
    defaultInput: { path: "sandbox-test.txt" },
  },
  {
    name: "move_repo_file",
    description: "Move or rename a file within the repo worktree.",
    params: [
      { name: "from", type: "string", required: true, description: "Current relative path" },
      { name: "to", type: "string", required: true, description: "New relative path" },
    ],
    defaultInput: { from: "src/old.ts", to: "src/new.ts" },
  },
  {
    name: "get_repo_diff",
    description: "Get the full unified diff of all changes since branching from the base branch.",
    params: [],
    defaultInput: {},
  },
  {
    name: "web_search",
    description: "Search the web via DuckDuckGo and return top results with title, URL, and snippet.",
    params: [
      { name: "query", type: "string", required: true, description: "Search query, e.g. TypeScript cannot find module error" },
    ],
    defaultInput: { query: "TypeScript cannot find module error" },
  },
  {
    name: "get_file_at_base",
    description: "Read a file as it existed at the base branch before any implementation changes.",
    params: [
      { name: "path", type: "string", required: true, description: "Relative path from repo root" },
    ],
    defaultInput: { path: "src/index.ts" },
  },
  {
    name: "get_package_info",
    description: "Fetch README, version, peer deps, and exports for a specific npm or Rust crate package.",
    params: [
      { name: "package", type: "string", required: true, description: "Package name, e.g. zustand or serde" },
      { name: "ecosystem", type: "string", required: true, description: "'npm' or 'cargo'" },
    ],
    defaultInput: { package: "zustand", ecosystem: "npm" },
  },
];

// ── Provider definitions ──────────────────────────────────────────────────────

interface ProviderDef {
  id: string;
  label: string;
  description: string;
  toolStyle: "native" | "text-xml";
}

const PROVIDERS: ProviderDef[] = [
  {
    id: "direct",
    label: "Direct",
    description: "Execute the tool directly — no LLM involved. Verifies the tool itself works.",
    toolStyle: "native",
  },
  {
    id: "claude",
    label: "Claude",
    description: "Native JSON tool use via the Claude API. Most reliable tool-calling path.",
    toolStyle: "native",
  },
  {
    id: "gemini",
    label: "Gemini",
    description: "Text-based XML tool loop. Gemini must emit a well-formed XML tag for the call to succeed.",
    toolStyle: "text-xml",
  },
  {
    id: "copilot",
    label: "Copilot",
    description: "Text-based XML tool loop. GitHub Copilot must emit a well-formed XML tag for the call to succeed.",
    toolStyle: "text-xml",
  },
  {
    id: "local",
    label: "Local LLM",
    description: "Text-based XML tool loop. Local model must emit a well-formed XML tag for the call to succeed.",
    toolStyle: "text-xml",
  },
];

// ── Result display ────────────────────────────────────────────────────────────

interface RunResult {
  mode: "direct" | "llm";
  raw?: string;          // direct tool output
  llm?: LlmToolTestResult;
  streamLog?: string;    // streaming progress captured during LLM run
}

function ResultPanel({ result, onCopy, copied }: {
  result: RunResult;
  onCopy: () => void;
  copied: boolean;
}) {
  const isError = result.mode === "llm" && result.llm && !result.llm.ok;

  return (
    <div className="min-h-0 flex-1 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Result
          </p>
          {result.mode === "llm" && result.llm && (
            <Badge
              className={cn(
                "text-[10px] px-1.5 py-0",
                result.llm.ok
                  ? "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30"
                  : "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
              )}
            >
              {result.llm.ok ? "Tool Called ✓" : "Tool Failed ✗"}
            </Badge>
          )}
        </div>
        <button
          onClick={onCopy}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {result.mode === "llm" && result.streamLog && (
        <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
            LLM Stream
          </p>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-muted-foreground max-h-28 overflow-y-auto">
            {result.streamLog}
          </pre>
        </div>
      )}

      <pre
        className={cn(
          "min-h-0 flex-1 overflow-auto rounded-md border p-3 text-xs font-mono whitespace-pre-wrap break-all",
          isError
            ? "border-red-300 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300"
            : "bg-muted/30",
        )}
      >
        {result.mode === "direct"
          ? result.raw
          : result.llm?.ok
            ? result.llm.llm_response
            : result.llm?.error}
      </pre>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ToolSandboxScreen({ onBack }: ToolSandboxScreenProps) {
  const [selectedTool, setSelectedTool] = useState<ToolDef>(TOOLS[0]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderDef>(PROVIDERS[0]);
  const [paramValues, setParamValues] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(TOOLS[0].defaultInput).map(([k, v]) => [k, String(v)]),
    ),
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [streamLog, setStreamLog] = useState("");
  const unlistenRef = useRef<(() => void) | null>(null);

  // Listen for streaming events from the LLM tool loop
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ delta: string }>("tool-sandbox-stream", (ev) => {
      setStreamLog((prev) => prev + ev.payload.delta);
    }).then((fn) => {
      unlisten = fn;
      unlistenRef.current = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  function selectTool(tool: ToolDef) {
    setSelectedTool(tool);
    setParamValues(
      Object.fromEntries(
        Object.entries(tool.defaultInput).map(([k, v]) => [k, String(v)]),
      ),
    );
    setResult(null);
  }

  function buildInput() {
    const input: Record<string, string | number> = {};
    for (const p of selectedTool.params) {
      const raw = paramValues[p.name] ?? "";
      if (p.type === "integer") {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) input[p.name] = n;
      } else if (raw !== "") {
        input[p.name] = raw;
      }
    }
    return input;
  }

  async function runTool() {
    setRunning(true);
    setResult(null);
    setStreamLog("");
    const inputJson = JSON.stringify(buildInput());

    try {
      if (selectedProvider.id === "direct") {
        const raw = await runToolTest(selectedTool.name, inputJson);
        setResult({ mode: "direct", raw });
      } else {
        const llm = await runToolTestWithLlm(selectedProvider.id, selectedTool.name, inputJson);
        setResult({ mode: "llm", llm, streamLog });
      }
    } catch (e) {
      setResult({
        mode: "llm",
        llm: {
          ok: false,
          provider: selectedProvider.id,
          tool_name: selectedTool.name,
          error: String(e),
        },
      });
    } finally {
      setRunning(false);
    }
  }

  // Capture stream log into result after run completes
  useEffect(() => {
    if (!running && result?.mode === "llm" && streamLog) {
      setResult((prev) => prev ? { ...prev, streamLog } : prev);
    }
  }, [running]);

  function copyOutput() {
    const text =
      result?.mode === "direct"
        ? result.raw ?? ""
        : result?.llm?.llm_response ?? result?.llm?.error ?? "";
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <header className={cn(APP_HEADER_BAR, "z-20 shrink-0")}>
        <div className={APP_HEADER_ROW_PANEL}>
          <Button variant="ghost" size="icon" className="shrink-0" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className={cn(APP_HEADER_TITLE, "shrink-0")}>Tool Sandbox</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden px-2 py-2 gap-2">
        {/* Left column: tools + providers */}
        <div className="w-52 shrink-0 flex flex-col gap-3 overflow-y-auto">
          {/* Tool list */}
          <div className="rounded-xl bg-background/60 p-2 flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-2 py-1">
              Tools
            </p>
            {TOOLS.map((tool) => (
              <button
                key={tool.name}
                onClick={() => selectTool(tool)}
                className={cn(
                  "text-left px-2 py-1.5 rounded-md text-sm transition-colors",
                  selectedTool.name === tool.name
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
              >
                <code className="text-xs font-mono">{tool.name}</code>
              </button>
            ))}
          </div>

          {/* Provider list */}
          <div className="rounded-xl bg-background/60 p-2 flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-2 py-1">
              LLM Provider
            </p>
            {PROVIDERS.map((prov) => (
              <button
                key={prov.id}
                onClick={() => setSelectedProvider(prov)}
                className={cn(
                  "text-left px-2 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5",
                  selectedProvider.id === prov.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
              >
                {prov.id === "direct" ? (
                  <Wrench className="h-3 w-3 shrink-0" />
                ) : (
                  <Cpu className="h-3 w-3 shrink-0" />
                )}
                <span className="text-xs">{prov.label}</span>
                {prov.toolStyle === "text-xml" && (
                  <span className={cn(
                    "ml-auto text-[9px] font-mono rounded px-1",
                    selectedProvider.id === prov.id
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}>
                    XML
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Main panel */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl bg-background/60 p-4">
          {/* Tool + provider header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <code className="text-sm font-mono font-semibold">{selectedTool.name}</code>
                <Badge variant="outline" className="text-xs">tool</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{selectedTool.description}</p>
            </div>
            <div className="text-right shrink-0">
              <div className="flex items-center gap-1.5 justify-end mb-0.5">
                {selectedProvider.id !== "direct" && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] px-1.5 py-0",
                      selectedProvider.toolStyle === "native"
                        ? "border-blue-500/40 text-blue-600 dark:text-blue-400"
                        : "border-amber-500/40 text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {selectedProvider.toolStyle === "native" ? "native tool use" : "text-xml loop"}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground max-w-56 text-right">
                {selectedProvider.description}
              </p>
            </div>
          </div>

          {/* Parameters */}
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Parameters
            </p>
            {selectedTool.params.map((p) => (
              <div key={p.name} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-mono font-medium">{p.name}</label>
                  <span className="text-xs text-muted-foreground">({p.type})</span>
                  {p.required && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0">required</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{p.description}</p>
                <Textarea
                  value={paramValues[p.name] ?? ""}
                  onChange={(e) =>
                    setParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                  }
                  className="min-h-[36px] resize-y text-xs font-mono"
                  rows={p.name === "content" ? 6 : 1}
                />
              </div>
            ))}
          </div>

          <Button
            onClick={runTool}
            disabled={running}
            className="self-start"
            size="sm"
          >
            {running ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Running…</>
            ) : (
              <><Play className="h-3.5 w-3.5 mr-1.5" />
                {selectedProvider.id === "direct" ? "Run Tool" : `Test via ${selectedProvider.label}`}
              </>
            )}
          </Button>

          {/* Live stream while running */}
          {running && streamLog && selectedProvider.id !== "direct" && (
            <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                LLM Stream
              </p>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-muted-foreground max-h-28 overflow-y-auto">
                {streamLog}
              </pre>
            </div>
          )}

          {/* Result */}
          {result && (
            <ResultPanel result={result} onCopy={copyOutput} copied={copied} />
          )}
        </div>
      </div>
    </div>
  );
}
