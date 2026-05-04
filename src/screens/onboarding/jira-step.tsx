import { CredentialField } from "@/components/CredentialField";
import { JIRA_PERMISSIONS, ScopeList } from "@/components/ScopeList";
import { Button } from "@/components/ui/button";
import { getNonSecretConfig, saveCredential } from "@/lib/tauri/credentials";
import { testJiraStored, validateJira } from "@/lib/tauri/providers";
import { ArrowRight, ChevronLeft, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { MASKED_SENTINEL, TOTAL_STEPS, ValidationMessage, type ValidationState } from "./_shared";

export function JiraStep({
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
          For sprint dashboards and ticket details.
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
