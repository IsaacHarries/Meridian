import { useState, useEffect } from "react";
import { useTheme } from "@/providers/ThemeProvider";
import { type ThemeMode, type AccentColor, ACCENT_LABELS, ACCENT_SWATCH } from "@/lib/theme";
import { isMockMode, setMockMode } from "@/lib/tauri";
import { Sun, Moon, Monitor } from "lucide-react";
import { CheckCircle, AlertCircle, Loader2, X, RotateCcw, FlaskConical, Sparkles, ChevronRight, FlaskRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CredentialField } from "@/components/CredentialField";
import { ScopeList, JIRA_PERMISSIONS, BITBUCKET_SCOPES } from "@/components/ScopeList";
import {
  type CredentialStatus,
  anthropicComplete,
  jiraComplete,
  bitbucketComplete,
  getCredentialStatus,
  validateAnthropic,
  validateJira,
  validateBitbucket,
  deleteCredential,
  saveCredential,
  getActiveSprint,
  getOpenPrs,
} from "@/lib/tauri";

// ── Theme section ─────────────────────────────────────────────────────────────

const ACCENTS: AccentColor[] = ["slate", "blue", "violet", "green", "orange", "rose"];

const MODE_OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: "light",  label: "Light",  icon: <Sun className="h-4 w-4" /> },
  { value: "dark",   label: "Dark",   icon: <Moon className="h-4 w-4" /> },
  { value: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
];

function ThemeSection() {
  const { config, setMode, setAccent } = useTheme();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Appearance</CardTitle>
        <CardDescription>Choose your preferred colour mode and accent colour.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Mode */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Mode</p>
          <div className="flex gap-2">
            {MODE_OPTIONS.map(({ value, label, icon }) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                className={`flex items-center gap-2 px-4 py-2 rounded-md border text-sm transition-colors ${
                  config.mode === value
                    ? "border-primary bg-primary text-primary-foreground font-medium"
                    : "border-border hover:bg-muted"
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Accent */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Accent colour</p>
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((accent) => (
              <button
                key={accent}
                onClick={() => setAccent(accent)}
                title={ACCENT_LABELS[accent]}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm transition-colors ${
                  config.accent === accent
                    ? "border-primary ring-2 ring-primary ring-offset-2 font-medium"
                    : "border-border hover:bg-muted"
                }`}
              >
                <span
                  className="w-3.5 h-3.5 rounded-full shrink-0"
                  style={{ background: ACCENT_SWATCH[accent] }}
                />
                {ACCENT_LABELS[accent]}
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

type SectionState = "idle" | "editing" | "loading" | "success" | "error";

interface SectionStatus {
  state: SectionState;
  message: string;
}

interface SettingsScreenProps {
  onClose: () => void;
  onNavigate?: (screen: string) => void;
}

function StatusBadge({ complete }: { complete: boolean }) {
  return complete ? (
    <Badge variant="success" className="gap-1">
      <CheckCircle className="h-3 w-3" /> Connected
    </Badge>
  ) : (
    <Badge variant="warning" className="gap-1">
      <AlertCircle className="h-3 w-3" /> Not configured
    </Badge>
  );
}

function SectionMessage({ state, message }: { state: SectionState; message: string }) {
  if (state === "idle" || state === "editing" || !message) return null;
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm mt-3 ${
        state === "loading"
          ? "bg-muted text-muted-foreground"
          : state === "success"
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-destructive/10 text-destructive"
      }`}
    >
      {state === "loading" && <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />}
      {state === "success" && <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      {state === "error" && <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      <span>{message}</span>
    </div>
  );
}

function AnthropicSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });

  async function handleSave() {
    if (!apiKey.trim()) return;
    setStatus({ state: "loading", message: "Saving…" });
    try {
      await saveCredential("anthropic_api_key", apiKey.trim());
      setSaved(true);
      setStatus({ state: "success", message: "API key saved." });
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTest() {
    setStatus({ state: "loading", message: "Testing connection…" });
    try {
      const msg = await validateAnthropic(apiKey.trim());
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setSaved(false);
    setApiKey("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    try {
      await deleteCredential("anthropic_api_key");
      onSaved();
    } catch {
      // If it doesn't exist, that's fine
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Anthropic</CardTitle>
            <CardDescription className="text-xs mt-0.5">Claude API key for all AI workflows</CardDescription>
          </div>
          <StatusBadge complete={isConfigured} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {isConfigured ? "Update key" : "Add key"}
            </Button>
            {isConfigured && (
              <Button variant="ghost" size="sm" className="text-muted-foreground gap-1" onClick={handleReset}>
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <CredentialField
              id="settings-anthropic-key"
              label="API Key"
              placeholder="sk-ant-api03-…"
              masked
              value={apiKey}
              onChange={(v) => { setApiKey(v); setSaved(false); }}
              disabled={status.state === "loading"}
            />
            <div className="flex gap-2">
              {!saved ? (
                <Button size="sm" onClick={handleSave} disabled={!apiKey.trim() || status.state === "loading"}>
                  {status.state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save key"}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={handleTest} disabled={status.state === "loading"}>
                  {status.state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test connection"}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                {saved ? "Done" : "Cancel"}
              </Button>
            </div>
          </div>
        )}
        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}

function JiraSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });

  async function handleSave() {
    setStatus({ state: "loading", message: "Validating…" });
    try {
      const msg = await validateJira(baseUrl, email, apiToken);
      setStatus({ state: "success", message: msg });
      setEditing(false);
      setBaseUrl(""); setEmail(""); setApiToken("");
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleReset() {
    for (const key of ["jira_base_url", "jira_email", "jira_api_token"]) {
      try { await deleteCredential(key); } catch { /* already gone */ }
    }
    onSaved();
  }

  const hasInput = baseUrl.trim() && email.trim() && apiToken.trim();

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">JIRA</CardTitle>
            <CardDescription className="text-xs mt-0.5">Sprint data, tickets, and standup briefings</CardDescription>
          </div>
          <StatusBadge complete={isConfigured} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {isConfigured ? "Update credentials" : "Add credentials"}
            </Button>
            {isConfigured && (
              <Button variant="ghost" size="sm" className="text-muted-foreground gap-1" onClick={handleReset}>
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ScopeList {...JIRA_PERMISSIONS} />
            <CredentialField id="s-jira-url" label="Workspace URL" placeholder="https://yourcompany.atlassian.net" value={baseUrl} onChange={setBaseUrl} disabled={status.state === "loading"} />
            <CredentialField id="s-jira-email" label="Email" placeholder="you@yourcompany.com" value={email} onChange={setEmail} disabled={status.state === "loading"} />
            <CredentialField id="s-jira-token" label="API Token" placeholder="ATATT3x…" masked value={apiToken} onChange={setApiToken} disabled={status.state === "loading"} helperText="Generate at id.atlassian.com → Manage profile → Security → API tokens" />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={!hasInput || status.state === "loading"}>
                {status.state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Validate & save"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setStatus({ state: "idle", message: "" }); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}

function BitbucketSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });

  async function handleSave() {
    setStatus({ state: "loading", message: "Validating…" });
    try {
      const msg = await validateBitbucket(workspace, accessToken);
      setStatus({ state: "success", message: msg });
      setEditing(false);
      setWorkspace(""); setAccessToken("");
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleReset() {
    for (const key of ["bitbucket_workspace", "bitbucket_access_token", "bitbucket_username"]) {
      try { await deleteCredential(key); } catch { /* already gone */ }
    }
    onSaved();
  }

  const hasInput = workspace.trim() && accessToken.trim();

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Bitbucket</CardTitle>
            <CardDescription className="text-xs mt-0.5">PR reviews, team metrics, and workload analysis</CardDescription>
          </div>
          <StatusBadge complete={isConfigured} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {isConfigured ? "Update credentials" : "Add credentials"}
            </Button>
            {isConfigured && (
              <Button variant="ghost" size="sm" className="text-muted-foreground gap-1" onClick={handleReset}>
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ScopeList {...BITBUCKET_SCOPES} />
            <CredentialField id="s-bb-ws" label="Workspace slug" placeholder="your-workspace" value={workspace} onChange={setWorkspace} disabled={status.state === "loading"} helperText="The slug from your Bitbucket workspace URL" />
            <CredentialField id="s-bb-token" label="Access Token" placeholder="ATCTT3x…" masked value={accessToken} onChange={setAccessToken} disabled={status.state === "loading"} helperText="Workspace or repository HTTP access token" />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={!hasInput || status.state === "loading"}>
                {status.state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Validate & save"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setStatus({ state: "idle", message: "" }); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}

// ── Configuration section (non-secret app settings) ──────────────────────────

function ConfigSection({
  jiraBoardId,
  bitbucketRepoSlug,
  onSaved,
}: {
  jiraBoardId: boolean;
  bitbucketRepoSlug: boolean;
  onSaved: () => void;
}) {
  const [boardId, setBoardId] = useState("");
  const [repoSlug, setRepoSlug] = useState("");
  const [editing, setEditing] = useState(!jiraBoardId || !bitbucketRepoSlug);
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });

  async function handleSave() {
    if (!boardId.trim() && !repoSlug.trim()) return;
    setStatus({ state: "loading", message: "Saving…" });
    try {
      if (boardId.trim()) await saveCredential("jira_board_id", boardId.trim());
      if (repoSlug.trim()) await saveCredential("bitbucket_repo_slug", repoSlug.trim());
      setStatus({ state: "success", message: "Configuration saved." });
      setEditing(false);
      setBoardId("");
      setRepoSlug("");
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  const allSet = jiraBoardId && bitbucketRepoSlug;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Configuration</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Which board and repository to work with
            </CardDescription>
          </div>
          {allSet ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle className="h-3 w-3" /> Configured
            </Badge>
          ) : (
            <Badge variant="warning" className="gap-1">
              <AlertCircle className="h-3 w-3" /> Incomplete
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Update configuration
          </Button>
        ) : (
          <div className="space-y-3">
            <CredentialField
              id="cfg-board-id"
              label="JIRA Board ID"
              placeholder="15"
              value={boardId}
              onChange={setBoardId}
              disabled={status.state === "loading"}
              helperText="Found in your JIRA board URL: /jira/software/projects/…/boards/15"
            />
            <CredentialField
              id="cfg-repo-slug"
              label="Bitbucket Repository Slug"
              placeholder="my-repo"
              value={repoSlug}
              onChange={setRepoSlug}
              disabled={status.state === "loading"}
              helperText="The repo slug from your Bitbucket URL: /repositories/workspace/my-repo"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={
                  (!boardId.trim() && !repoSlug.trim()) || status.state === "loading"
                }
              >
                {status.state === "loading" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Save"
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setStatus({ state: "idle", message: "" });
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}

// ── Data test section ─────────────────────────────────────────────────────────

// ── Mock mode section ─────────────────────────────────────────────────────────

function MockModeSection({ onToggle }: { onToggle: () => void }) {
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
              Replace JIRA and Bitbucket API calls with realistic local mock data. Useful for
              testing without API access. Claude AI calls still use your real Anthropic key.
            </p>
          </div>
          <Button
            variant={enabled ? "default" : "outline"}
            size="sm"
            onClick={toggle}
            className={enabled ? "bg-amber-500 hover:bg-amber-600 text-white shrink-0" : "shrink-0"}
          >
            {enabled ? "Disable" : "Enable"}
          </Button>
        </div>
        {enabled && (
          <p className="text-xs text-amber-600 mt-3 pl-13 ml-13">
            Restart or navigate back to landing to reload data with mock mode active.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

type DataTestState = "idle" | "loading" | "success" | "error";

function DataTestSection({ fullyConfigured }: { fullyConfigured: boolean }) {
  const [state, setState] = useState<DataTestState>("idle");
  const [result, setResult] = useState("");

  async function runTest() {
    setState("loading");
    setResult("");
    try {
      const [sprint, prs] = await Promise.all([getActiveSprint(), getOpenPrs()]);
      const lines: string[] = [];
      if (sprint) {
        lines.push(`Active sprint: "${sprint.name}" (${sprint.state})`);
        if (sprint.endDate) {
          const days = Math.ceil(
            (new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000
          );
          lines.push(`  ${days > 0 ? `${days} days remaining` : "Sprint ended"}`);
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
        <Button
          variant="outline"
          size="sm"
          onClick={runTest}
          disabled={!fullyConfigured || state === "loading"}
          className="gap-1.5"
        >
          {state === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FlaskConical className="h-3.5 w-3.5" />
          )}
          {state === "loading" ? "Fetching…" : "Run test"}
        </Button>
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
      </CardContent>
    </Card>
  );
}

// ── Main Settings screen ──────────────────────────────────────────────────────

export function SettingsScreen({ onClose, onNavigate }: SettingsScreenProps) {
  const [credStatus, setCredStatus] = useState<CredentialStatus | null>(null);

  async function refresh() {
    const s = await getCredentialStatus();
    setCredStatus(s);
  }

  // Re-evaluate credential status after mock mode toggle so the UI reflects
  // the (now overridden) status immediately.
  function handleMockToggle() {
    refresh();
  }

  useEffect(() => {
    refresh();
  }, []);

  const fullyConfigured = credStatus
    ? anthropicComplete(credStatus) &&
      jiraComplete(credStatus) &&
      bitbucketComplete(credStatus)
    : false;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-2xl mx-auto px-6 h-14 flex items-center justify-between">
          <h1 className="font-semibold">Settings</h1>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8 space-y-8">
        {credStatus ? (
          <>
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Credentials
              </h2>
              <AnthropicSection
                isConfigured={anthropicComplete(credStatus)}
                onSaved={refresh}
              />
              <JiraSection isConfigured={jiraComplete(credStatus)} onSaved={refresh} />
              <BitbucketSection
                isConfigured={bitbucketComplete(credStatus)}
                onSaved={refresh}
              />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Configuration
              </h2>
              <ConfigSection
                jiraBoardId={credStatus.jiraBoardId}
                bitbucketRepoSlug={credStatus.bitbucketRepoSlug}
                onSaved={refresh}
              />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Appearance
              </h2>
              <ThemeSection />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Development
              </h2>
              <MockModeSection onToggle={handleMockToggle} />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Verify
              </h2>
              <DataTestSection fullyConfigured={fullyConfigured} />
            </section>

            {onNavigate && (
              <section className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  AI Agents
                </h2>
                <Card
                  className="cursor-pointer hover:bg-muted/40 transition-colors"
                  onClick={() => onNavigate("agent-skills")}
                >
                  <CardContent className="flex items-center gap-4 py-4">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                      <Sparkles className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">Agent Skills</p>
                      <p className="text-xs text-muted-foreground">
                        Configure domain knowledge injected into AI agents — grooming
                        conventions, codebase patterns, implementation standards, review
                        criteria
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </CardContent>
                </Card>
              </section>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        <div className="text-xs text-muted-foreground space-y-1 border-t pt-6">
          <p>All credentials are stored in your macOS Keychain and never leave your machine.</p>
          <p>
            They are used exclusively in the Tauri backend layer and never exposed to the UI.
          </p>
        </div>
      </main>
    </div>
  );
}
