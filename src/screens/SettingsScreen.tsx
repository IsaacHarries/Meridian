import { useState, useEffect } from "react";
import { useTheme } from "@/providers/ThemeProvider";
import { type AccentColor, ACCENT_LABELS, ACCENT_SWATCH } from "@/lib/theme";
import { isMockMode, setMockMode } from "@/lib/tauri";
import { BACKGROUNDS, CATEGORY_LABELS, BackgroundRenderer, type BgCategory, getBackgroundId, setBackgroundId } from "@/lib/backgrounds";
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
  jiraCredentialsSet,
  bitbucketComplete,
  bitbucketCredentialsSet,
  getCredentialStatus,
  getNonSecretConfig,
  validateAnthropic,
  validateJira,
  validateBitbucket,
  testAnthropicStored,
  testJiraStored,
  testBitbucketStored,
  debugJiraEndpoints,
  deleteCredential,
  saveCredential,
  getActiveSprint,
  getOpenPrs,
  importClaudeProToken,
  getClaudeModels,
} from "@/lib/tauri";

// ── Theme section ─────────────────────────────────────────────────────────────

const ACCENTS: AccentColor[] = ["slate", "blue", "violet", "green", "orange", "rose"];


const BG_CATEGORIES: BgCategory[] = ["meridian", "space", "jwst", "abstract", "patterns", "minimal"];

function ThemeSection() {
  const { config, setAccent } = useTheme();
  const [selectedBg, setSelectedBg] = useState(() => getBackgroundId());

  function pickBackground(id: string) {
    setSelectedBg(id);
    setBackgroundId(id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Appearance</CardTitle>
        <CardDescription>Choose your accent colour and background.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">

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

        {/* Background */}
        <div className="space-y-3">
          <p className="text-sm font-medium">Background</p>
          {BG_CATEGORIES.map((cat) => {
            const bgs = BACKGROUNDS.filter((b) => b.category === cat);
            return (
              <div key={cat}>
                <p className="text-xs text-muted-foreground mb-2">{CATEGORY_LABELS[cat]}</p>
                <div className="flex flex-wrap gap-2">
                  {bgs.map((bg) => (
                    <button
                      key={bg.id}
                      onClick={() => pickBackground(bg.id)}
                      title={bg.name}
                      className={`relative rounded-md border overflow-hidden transition-all ${
                        selectedBg === bg.id
                          ? "border-primary ring-2 ring-primary ring-offset-2"
                          : "border-border hover:border-primary/50"
                      }`}
                      style={{ width: 88, height: 56 }}
                    >
                      {/* Thumbnail — mini render of the background */}
                      <div className="absolute inset-0 bg-background" />
                      <div className="absolute inset-0">
                        <BgThumbnail id={bg.id} />
                      </div>
                      {/* Label overlay */}
                      <div className="absolute bottom-0 inset-x-0 bg-background/80 backdrop-blur-sm px-1 py-0.5">
                        <p className="text-[10px] text-center font-medium leading-tight truncate">{bg.name}</p>
                      </div>
                      {selectedBg === bg.id && (
                        <div className="absolute top-1 right-1 w-3 h-3 rounded-full bg-primary" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function BgThumbnail({ id }: { id: string }) {
  return (
    <div className="w-full h-full overflow-hidden">
      <BackgroundRenderer id={id} />
    </div>
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
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <CheckCircle className="h-3 w-3" /> Saved
    </Badge>
  ) : (
    <Badge variant="warning" className="gap-1">
      <AlertCircle className="h-3 w-3" /> Not configured
    </Badge>
  );
}

type TestResult = "untested" | "success" | "error";

function VerifiedBadge({ result }: { result: TestResult }) {
  if (result === "success") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle className="h-3 w-3" /> Connected
      </Badge>
    );
  }
  if (result === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="h-3 w-3" /> Failed
      </Badge>
    );
  }
  return null;
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
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [importing, setImporting] = useState(false);
  const [models, setModels] = useState<[string, string][]>([]);
  const [selectedModel, setSelectedModel] = useState("");

  useEffect(() => {
    getClaudeModels().then(setModels).catch(() => {});
    getNonSecretConfig().then(cfg => {
      if (cfg.claude_model) setSelectedModel(cfg.claude_model);
    }).catch(() => {});
  }, []);

  async function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    try {
      await saveCredential("claude_model", modelId);
    } catch { /* non-critical */ }
  }

  function startEditing() {
    setApiKey(isConfigured ? MASKED_SENTINEL : "");
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    setEditing(true);
  }

  async function handleImportClaudePro() {
    setImporting(true);
    setStatus({ state: "loading", message: "Reading Claude Pro token from keychain…" });
    try {
      const msg = await importClaudeProToken();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    } finally {
      setImporting(false);
    }
  }

  async function handleSave() {
    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
    setStatus({ state: "loading", message: "Saving and testing…" });
    try {
      const msg = await validateAnthropic(apiKey.trim());
      // validate_anthropic may succeed even if network is blocked (returns Ok with a warning)
      // only mark as verified if it explicitly says "successfully"
      const verified = msg.toLowerCase().includes("successfully");
      setTestResult(verified ? "success" : "untested");
      setStatus({ state: "success", message: msg });
      onSaved();
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTest() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = apiKey === MASKED_SENTINEL
        ? await testAnthropicStored()
        : await validateAnthropic(apiKey.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setApiKey("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    try {
      await deleteCredential("anthropic_api_key");
      setTestResult("untested");
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
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
              {isConfigured ? "Update key" : "Add key"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleImportClaudePro}
              disabled={importing || status.state === "loading"}
              className="gap-1.5"
            >
              {importing ? <><Loader2 className="h-3 w-3 animate-spin" /> Importing…</> : "Use Claude Pro / Max"}
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
              placeholder="sk-ant-api03-… or sk-ant-oat01-…"
              masked
              value={apiKey}
              onChange={(v) => { setApiKey(v); setTestResult("untested"); }}
              disabled={status.state === "loading"}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={!apiKey.trim() || apiKey === MASKED_SENTINEL || status.state === "loading"}>
                {status.state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save key"}
              </Button>
              <Button size="sm" variant="outline" onClick={handleTest} disabled={!apiKey.trim() || status.state === "loading"}>
                Test connection
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>Cancel</Button>
            </div>
          </div>
        )}
        <SectionMessage {...status} />
        {/* Model picker — visible when Anthropic is configured */}
        {isConfigured && models.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t">
            <label className="text-xs font-medium text-muted-foreground">Claude Model</label>
            <select
              value={selectedModel}
              onChange={e => handleModelChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {!selectedModel && <option value="">— select a model —</option>}
              {models.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Used for all AI features. Sonnet is recommended for quality; Haiku is faster and lower cost.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const MASKED_SENTINEL = "••••••••";

function JiraSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [testResult, setTestResult] = useState<TestResult>("untested");

  async function startEditing() {
    try {
      const config = await getNonSecretConfig();
      setBaseUrl(config["jira_base_url"] ?? "");
      setEmail(config["jira_email"] ?? "");
      const hasStoredCreds = !!(config["jira_base_url"] || config["jira_email"]);
      setApiToken(hasStoredCreds ? MASKED_SENTINEL : "");
    } catch {
      setBaseUrl(""); setEmail(""); setApiToken("");
    }
    setTestResult("untested");
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  async function handleSave() {
    if (!baseUrl.trim() || !email.trim() || !apiToken.trim()) return;
    setStatus({ state: "loading", message: "Saving…" });
    try {
      await saveCredential("jira_base_url", baseUrl.trim());
      await saveCredential("jira_email", email.trim());
      if (apiToken !== MASKED_SENTINEL) {
        // Strip ALL whitespace — API tokens never contain spaces or newlines,
        // and paste events in password fields can introduce them invisibly.
        const cleanToken = apiToken.replace(/\s/g, "");
        if (cleanToken.length !== apiToken.trim().length) {
          console.warn(`JIRA token had embedded whitespace stripped: raw length ${apiToken.length} → clean length ${cleanToken.length}`);
        }
        console.log(`Saving JIRA API token (length: ${cleanToken.length}, prefix: ${cleanToken.slice(0, 8)}, suffix: ${cleanToken.slice(-4)})`);
        await saveCredential("jira_api_token", cleanToken);
      }
      setTestResult("untested");
      setStatus({ state: "success", message: "Credentials saved." });
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTest() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = apiToken === MASKED_SENTINEL
        ? await testJiraStored()
        : await validateJira(baseUrl.trim(), email.trim(), apiToken.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setBaseUrl(""); setEmail(""); setApiToken("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    for (const key of ["jira_base_url", "jira_email", "jira_api_token"]) {
      try { await deleteCredential(key); } catch { /* already gone */ }
    }
    setTestResult("untested");
    onSaved();
  }

  const hasInput = baseUrl.trim() && email.trim() && apiToken.trim();
  const canTest = !!(baseUrl.trim() && email.trim() && apiToken.trim());

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">JIRA</CardTitle>
            <CardDescription className="text-xs mt-0.5">Sprint data, tickets, and standup briefings</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
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
            <CredentialField id="s-jira-url" label="Workspace URL" placeholder="https://yourcompany.atlassian.net" value={baseUrl} onChange={(v) => { setBaseUrl(v); setTestResult("untested"); }} disabled={status.state === "loading"} />
            <CredentialField id="s-jira-email" label="Email" placeholder="you@yourcompany.com" value={email} onChange={(v) => { setEmail(v); setTestResult("untested"); }} disabled={status.state === "loading"} />
            <CredentialField id="s-jira-token" label="API Token" placeholder="ATATT3x…" masked value={apiToken} onChange={(v) => { setApiToken(v); setTestResult("untested"); }} disabled={status.state === "loading"} helperText={isConfigured && apiToken === MASKED_SENTINEL ? "Token already saved — clear to replace" : "Classic API token from id.atlassian.com → Security → API tokens. Must be a classic token (starts with ATATT3x, no scope picker) — not an OAuth 2.0 scoped token."} />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={!hasInput || status.state === "loading"}>
                {status.state === "loading" && !status.message.includes("Testing") ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save credentials"}
              </Button>
              <Button size="sm" variant="outline" onClick={handleTest} disabled={!canTest || status.state === "loading"}>
                {status.state === "loading" && status.message.includes("Testing") ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test connection"}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>Cancel</Button>
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
  const [email, setEmail] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [testResult, setTestResult] = useState<TestResult>("untested");

  async function startEditing() {
    try {
      const config = await getNonSecretConfig();
      setWorkspace(config["bitbucket_workspace"] ?? "");
      setEmail(config["bitbucket_email"] ?? "");
      const hasStoredCreds = !!config["bitbucket_workspace"];
      setAccessToken(hasStoredCreds ? MASKED_SENTINEL : "");
    } catch {
      setWorkspace(""); setEmail(""); setAccessToken("");
    }
    setTestResult("untested");
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  async function handleSave() {
    if (!workspace.trim() || !email.trim() || !accessToken.trim()) return;
    setStatus({ state: "loading", message: "Saving…" });
    try {
      await saveCredential("bitbucket_workspace", workspace.trim());
      await saveCredential("bitbucket_email", email.trim());
      if (accessToken !== MASKED_SENTINEL) await saveCredential("bitbucket_access_token", accessToken.trim());
      setTestResult("untested");
      setStatus({ state: "success", message: "Credentials saved." });
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTest() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = accessToken === MASKED_SENTINEL
        ? await testBitbucketStored()
        : await validateBitbucket(workspace.trim(), email.trim(), accessToken.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setWorkspace(""); setEmail(""); setAccessToken("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    for (const key of ["bitbucket_workspace", "bitbucket_email", "bitbucket_access_token", "bitbucket_username"]) {
      try { await deleteCredential(key); } catch { /* already gone */ }
    }
    setTestResult("untested");
    onSaved();
  }

  const hasInput = workspace.trim() && email.trim() && accessToken.trim();
  const canTest = !!(workspace.trim() && email.trim() && accessToken.trim());

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Bitbucket</CardTitle>
            <CardDescription className="text-xs mt-0.5">PR reviews, team metrics, and workload analysis</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
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
            <CredentialField id="s-bb-ws" label="Workspace slug" placeholder="your-workspace" value={workspace} onChange={(v) => { setWorkspace(v); setTestResult("untested"); }} disabled={status.state === "loading"} helperText="The slug from your Bitbucket workspace URL" />
            <CredentialField id="s-bb-email" label="Email" placeholder="you@yourcompany.com" value={email} onChange={(v) => { setEmail(v); setTestResult("untested"); }} disabled={status.state === "loading"} helperText="The email address associated with your Bitbucket account" />
            <CredentialField id="s-bb-token" label="Access Token" placeholder="ATCTT3x…" masked value={accessToken} onChange={(v) => { setAccessToken(v); setTestResult("untested"); }} disabled={status.state === "loading"} helperText={isConfigured && accessToken === MASKED_SENTINEL ? "Token already saved — clear to enter a new one" : "Workspace or repository HTTP access token"} />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={!hasInput || status.state === "loading"}>
                {status.state === "loading" && !status.message.includes("Testing") ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save credentials"}
              </Button>
              <Button size="sm" variant="outline" onClick={handleTest} disabled={!canTest || status.state === "loading"}>
                {status.state === "loading" && status.message.includes("Testing") ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test connection"}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>Cancel</Button>
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

  async function startEditing() {
    try {
      const config = await getNonSecretConfig();
      setBoardId(config["jira_board_id"] ?? "");
      setRepoSlug(config["bitbucket_repo_slug"] ?? "");
    } catch {
      setBoardId(""); setRepoSlug("");
    }
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  // Auto-load on first mount if already in editing state (incomplete config)
  useEffect(() => {
    if (editing) {
      getNonSecretConfig().then(config => {
          setBoardId(prev => prev || (config["jira_board_id"] ?? ""));
          setRepoSlug(prev => prev || (config["bitbucket_repo_slug"] ?? ""));
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (!boardId.trim() && !repoSlug.trim()) return;
    setStatus({ state: "loading", message: "Saving…" });
    try {
      if (boardId.trim()) await saveCredential("jira_board_id", boardId.trim());
      if (repoSlug.trim()) await saveCredential("bitbucket_repo_slug", repoSlug.trim());
      setStatus({ state: "success", message: "Configuration saved." });
      setEditing(false);
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
          <Button variant="outline" size="sm" onClick={startEditing}>
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
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-2xl mx-auto px-6 h-14 flex items-center justify-between">
          <h1 className="font-semibold">Settings</h1>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8 space-y-8 bg-background/60 rounded-xl">
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
              <JiraSection isConfigured={jiraCredentialsSet(credStatus)} onSaved={refresh} />
              <BitbucketSection
                isConfigured={bitbucketCredentialsSet(credStatus)}
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
