import { useState, useEffect } from "react";
import { CheckCircle, XCircle, Loader2, ExternalLink, ArrowRight, ChevronLeft, FlaskRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CredentialField } from "@/components/CredentialField";
import { ScopeList, JIRA_PERMISSIONS, BITBUCKET_SCOPES } from "@/components/ScopeList";
import {
  saveCredential,
  validateAnthropic,
  validateJira,
  validateBitbucket,
  testAnthropicStored,
  testJiraStored,
  testBitbucketStored,
  getNonSecretConfig,
  getCredentialStatus,
  setMockMode,
} from "@/lib/tauri";

const MASKED_SENTINEL = "••••••••";

type ValidationState = "idle" | "loading" | "success" | "error";


interface OnboardingScreenProps {
  onComplete: () => void;
  onMockMode?: () => void;
}

const TOTAL_STEPS = 4;

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i < current
              ? "bg-primary w-6"
              : i === current
              ? "bg-primary w-10"
              : "bg-muted w-6"
          }`}
        />
      ))}
    </div>
  );
}

function ValidationMessage({ state, message }: { state: ValidationState; message: string }) {
  if (state === "idle" || !message) return null;
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${
        state === "loading"
          ? "bg-muted text-muted-foreground"
          : state === "success"
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-destructive/10 text-destructive"
      }`}
    >
      {state === "loading" && <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />}
      {state === "success" && <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      {state === "error" && <XCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      <span>{message}</span>
    </div>
  );
}

// Step 1: Welcome
function WelcomeStep({ onNext, onMockMode }: { onNext: () => void; onMockMode?: () => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Welcome to Meridian</h1>
        <p className="text-muted-foreground max-w-sm mx-auto">
          Your personal engineering productivity hub. Let's connect your tools to get started.
        </p>
      </div>

      <div className="space-y-3">
        {[
          { icon: "🤖", title: "AI-powered workflows", desc: "Claude agents handle implementation planning, PR reviews, and code analysis" },
          { icon: "📋", title: "JIRA integration", desc: "Tickets, sprint dashboards, and retrospectives pulled directly from your workspace" },
          { icon: "🔀", title: "Bitbucket integration", desc: "PR reviews, team metrics, and workload balancing from your repos" },
        ].map((item) => (
          <div key={item.title} className="flex items-start gap-3 rounded-lg border p-3">
            <span className="text-xl">{item.icon}</span>
            <div>
              <p className="text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-center text-muted-foreground">
        You'll need API keys for Anthropic, JIRA, and Bitbucket.
      </p>

      <Button className="w-full" size="lg" onClick={onNext}>
        Get started <ArrowRight className="h-4 w-4" />
      </Button>

      {onMockMode && (
        <div className="border-t pt-4">
          <button
            onClick={onMockMode}
            className="w-full flex items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
          >
            <FlaskRound className="h-3.5 w-3.5" />
            Try with mock data (no JIRA or Bitbucket needed)
          </button>
        </div>
      )}
    </div>
  );
}

// Step 2: Anthropic
function AnthropicStep({
  onNext,
  onBack,
  stepNum,
}: {
  onNext: () => void;
  onBack: () => void;
  stepNum: number;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<ValidationState>("idle");
  const [testMessage, setTestMessage] = useState("");

  // On mount, check if a key is already stored and reflect that in the UI
  useEffect(() => {
    getCredentialStatus().then(status => {
      if (status.anthropicApiKey) {
        setApiKey(MASKED_SENTINEL);
        setSaved(true);
      }
    }).catch(() => {});
  }, []);

  async function handleSaveAndTest() {
    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
    setSaving(true);
    setTestState("loading");
    setTestMessage("Saving and testing connection…");
    try {
      // validate_anthropic saves first, then tests — returns Ok even if network blocked
      const msg = await validateAnthropic(apiKey.trim());
      setSaved(true);
      setTestState("success");
      setTestMessage(msg);
    } catch (err) {
      // Only a hard error (e.g. empty key, save failure) lands here
      setTestState("error");
      setTestMessage(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestState("loading");
    setTestMessage("Testing connection…");
    try {
      const msg = apiKey === MASKED_SENTINEL
        ? await testAnthropicStored()
        : await validateAnthropic(apiKey.trim());
      setTestState("success");
      setTestMessage(msg);
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
    }
  }

  const canTest = !!apiKey.trim();
  const isNewKey = apiKey !== MASKED_SENTINEL && apiKey.trim().length > 0;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3">
          Step {stepNum} of {TOTAL_STEPS}
        </p>
        <h2 className="text-xl font-semibold">Anthropic API Key</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Powers all Claude agents in Meridian.
        </p>
      </div>

      <CredentialField
        id="anthropic-key"
        label="API Key"
        placeholder="sk-ant-api03-…"
        masked
        value={apiKey}
        onChange={(v) => { setApiKey(v); setSaved(false); setTestState("idle"); setTestMessage(""); }}
        disabled={saving || testState === "loading"}
        helperText={saved && apiKey === MASKED_SENTINEL ? "Key already saved — clear to enter a new one" : "Find this at platform.claude.com → API Keys"}
      />

      <ValidationMessage state={testState} message={testMessage} />

      <a
        href="https://platform.claude.com/api-keys"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Get an API key <ExternalLink className="h-3 w-3" />
      </a>

      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>

        {isNewKey ? (
          // New key entered — save & test in one step
          <Button
            className="flex-1"
            onClick={handleSaveAndTest}
            disabled={saving || testState === "loading"}
          >
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : "Save key"}
          </Button>
        ) : saved ? (
          // Key already stored — offer test and next
          <>
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={!canTest || testState === "loading"}
            >
              {testState === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test connection"}
            </Button>
            <Button onClick={onNext}>
              Next <ArrowRight className="h-4 w-4" />
            </Button>
          </>
        ) : (
          // Nothing entered yet
          <Button className="flex-1" disabled>Save key</Button>
        )}
      </div>

      {!saved && (
        <button
          onClick={onNext}
          className="w-full text-xs text-muted-foreground hover:text-foreground text-center"
        >
          Skip for now
        </button>
      )}
    </div>
  );
}

// Step 3: JIRA
function JiraStep({
  onNext,
  onBack,
  stepNum,
}: {
  onNext: () => void;
  onBack: () => void;
  stepNum: number;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<ValidationState>("idle");
  const [testMessage, setTestMessage] = useState("");

  // Pre-populate from stored values when navigating back to this step
  useEffect(() => {
    getNonSecretConfig().then(config => {
      if (config["jira_base_url"] || config["jira_email"]) {
        setBaseUrl(config["jira_base_url"] ?? "");
        setEmail(config["jira_email"] ?? "");
        setApiToken(MASKED_SENTINEL);
        setSaved(true);
      }
    }).catch(() => {});
  }, []);

  async function handleSave() {
    if (!baseUrl.trim() || !email.trim() || !apiToken.trim()) return;
    setSaving(true);
    try {
      await saveCredential("jira_base_url", baseUrl.trim());
      await saveCredential("jira_email", email.trim());
      if (apiToken !== MASKED_SENTINEL) {
        await saveCredential("jira_api_token", apiToken.trim());
      }
      setSaved(true);
      setTestState("idle");
      setTestMessage("");
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestState("loading");
    setTestMessage("Connecting to JIRA…");
    try {
      const msg = apiToken === MASKED_SENTINEL
        ? await testJiraStored()
        : await validateJira(baseUrl.trim(), email.trim(), apiToken.trim());
      setTestState("success");
      setTestMessage(msg);
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
    }
  }

  const hasInput = baseUrl.trim() && email.trim() && apiToken.trim();
  const canTest = hasInput;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3">
          Step {stepNum} of {TOTAL_STEPS}
        </p>
        <h2 className="text-xl font-semibold">JIRA Credentials</h2>
        <p className="text-sm text-muted-foreground mt-1">
          For sprint dashboards, ticket details, and standup briefings.
        </p>
      </div>

      <ScopeList {...JIRA_PERMISSIONS} />

      <div className="space-y-3">
        <CredentialField
          id="jira-url"
          label="Workspace URL"
          placeholder="https://yourcompany.atlassian.net"
          value={baseUrl}
          onChange={(v) => { setBaseUrl(v); setSaved(false); }}
          disabled={saving || testState === "loading"}
        />
        <CredentialField
          id="jira-email"
          label="Email"
          placeholder="you@yourcompany.com"
          value={email}
          onChange={(v) => { setEmail(v); setSaved(false); }}
          disabled={saving || testState === "loading"}
        />
        <CredentialField
          id="jira-token"
          label="API Token"
          placeholder="ATATT3x…"
          masked
          value={apiToken}
          onChange={(v) => { setApiToken(v); setSaved(false); }}
          disabled={saving || testState === "loading"}
          helperText={saved && apiToken === MASKED_SENTINEL ? "Token already saved — clear to enter a new one" : "Classic API token from id.atlassian.com → Security → API tokens. Must be a classic token (starts with ATATT3x, no scope picker) — not an OAuth 2.0 scoped token."}
        />
      </div>

      <ValidationMessage state={testState} message={testMessage} />

      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
        <Button
          className="flex-1"
          onClick={handleSave}
          disabled={!hasInput || saving}
        >
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : "Save credentials"}
        </Button>
        {saved && (
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={!canTest || testState === "loading"}
          >
            {testState === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
          </Button>
        )}
        {saved && (
          <Button onClick={onNext}>
            Next <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>

      {!saved && (
        <button
          onClick={onNext}
          className="w-full text-xs text-muted-foreground hover:text-foreground text-center"
        >
          Skip for now
        </button>
      )}
    </div>
  );
}

// Step 4: Bitbucket
function BitbucketStep({
  onNext,
  onBack,
  stepNum,
}: {
  onNext: () => void;
  onBack: () => void;
  stepNum: number;
}) {
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<ValidationState>("idle");
  const [testMessage, setTestMessage] = useState("");

  // Pre-populate from stored values when navigating back to this step
  useEffect(() => {
    getNonSecretConfig().then(config => {
      if (config["bitbucket_workspace"]) {
        setWorkspace(config["bitbucket_workspace"]);
        setEmail(config["bitbucket_email"] ?? "");
        setAccessToken(MASKED_SENTINEL);
        setSaved(true);
      }
    }).catch(() => {});
  }, []);

  async function handleSave() {
    if (!workspace.trim() || !email.trim() || !accessToken.trim()) return;
    setSaving(true);
    try {
      await saveCredential("bitbucket_workspace", workspace.trim());
      await saveCredential("bitbucket_email", email.trim());
      if (accessToken !== MASKED_SENTINEL) {
        await saveCredential("bitbucket_access_token", accessToken.trim());
      }
      setSaved(true);
      setTestState("idle");
      setTestMessage("");
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestState("loading");
    setTestMessage("Connecting to Bitbucket…");
    try {
      const msg = accessToken === MASKED_SENTINEL
        ? await testBitbucketStored()
        : await validateBitbucket(workspace.trim(), email.trim(), accessToken.trim());
      setTestState("success");
      setTestMessage(msg);
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
    }
  }

  const hasInput = workspace.trim() && email.trim() && accessToken.trim();
  const canTest = hasInput;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3">
          Step {stepNum} of {TOTAL_STEPS}
        </p>
        <h2 className="text-xl font-semibold">Bitbucket Credentials</h2>
        <p className="text-sm text-muted-foreground mt-1">
          For PR reviews, team metrics, and workload analysis.
        </p>
      </div>

      <ScopeList {...BITBUCKET_SCOPES} />

      <div className="space-y-3">
        <CredentialField
          id="bb-workspace"
          label="Workspace slug"
          placeholder="your-workspace"
          value={workspace}
          onChange={(v) => { setWorkspace(v); setSaved(false); }}
          disabled={saving || testState === "loading"}
          helperText="The slug from your Bitbucket workspace URL"
        />
        <CredentialField
          id="bb-email"
          label="Email"
          placeholder="you@yourcompany.com"
          value={email}
          onChange={(v) => { setEmail(v); setSaved(false); }}
          disabled={saving || testState === "loading"}
          helperText="The email address associated with your Bitbucket account"
        />
        <CredentialField
          id="bb-token"
          label="Access Token"
          placeholder="ATCTT3x…"
          masked
          value={accessToken}
          onChange={(v) => { setAccessToken(v); setSaved(false); }}
          disabled={saving || testState === "loading"}
          helperText={saved && accessToken === MASKED_SENTINEL ? "Token already saved — clear to enter a new one" : "Workspace or repository HTTP access token — generate at bitbucket.org → Workspace settings → Access tokens"}
        />
      </div>

      <ValidationMessage state={testState} message={testMessage} />

      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
        <Button
          className="flex-1"
          onClick={handleSave}
          disabled={!hasInput || saving}
        >
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : "Save credentials"}
        </Button>
        {saved && (
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={!canTest || testState === "loading"}
          >
            {testState === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
          </Button>
        )}
        {saved && (
          <Button onClick={onNext}>
            Done <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>

      {!saved && (
        <button
          onClick={onNext}
          className="w-full text-xs text-muted-foreground hover:text-foreground text-center"
        >
          Skip for now
        </button>
      )}
    </div>
  );
}

export function OnboardingScreen({ onComplete, onMockMode }: OnboardingScreenProps) {
  const [step, setStep] = useState(0);

  function handleMockMode() {
    setMockMode(true);
    onMockMode?.();
    onComplete();
  }

  const steps = [
    <WelcomeStep key="welcome" onNext={() => setStep(1)} onMockMode={handleMockMode} />,
    <AnthropicStep key="anthropic" onNext={() => setStep(2)} onBack={() => setStep(0)} stepNum={1} />,
    <JiraStep key="jira" onNext={() => setStep(3)} onBack={() => setStep(1)} stepNum={2} />,
    <BitbucketStep key="bitbucket" onNext={onComplete} onBack={() => setStep(2)} stepNum={3} />,
  ];

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {step > 0 && (
          <div className="mb-6 flex justify-center">
            <StepIndicator current={step} total={TOTAL_STEPS} />
          </div>
        )}
        <Card>
          <CardContent className="pt-6 pb-6">{steps[step]}</CardContent>
        </Card>
      </div>
    </div>
  );
}
