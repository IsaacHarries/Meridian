import { CredentialField } from "@/components/CredentialField";
import { BITBUCKET_SCOPES, ScopeList } from "@/components/ScopeList";
import { Button } from "@/components/ui/button";
import { getNonSecretConfig, saveCredential } from "@/lib/tauri/credentials";
import { testBitbucketStored, validateBitbucket } from "@/lib/tauri/providers";
import { ArrowRight, ChevronLeft, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { MASKED_SENTINEL, TOTAL_STEPS, ValidationMessage, type ValidationState } from "./_shared";

export function BitbucketStep({
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
