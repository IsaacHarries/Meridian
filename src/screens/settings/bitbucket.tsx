import { CredentialField } from "@/components/CredentialField";
import { BITBUCKET_SCOPES, ScopeList } from "@/components/ScopeList";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { getPreferences, setPreference } from "@/lib/preferences";
import { deleteCredential, getNonSecretConfig, saveCredential } from "@/lib/tauri/credentials";
import { testBitbucketStored, validateBitbucket } from "@/lib/tauri/providers";
import { Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
    MASKED_SENTINEL,
    SectionMessage,
    StatusBadge,
    VerifiedBadge,
    type SectionStatus,
    type TestResult,
} from "./_shared";

export function BitbucketSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [disableSslVerify, setDisableSslVerify] = useState(false);

  async function startEditing() {
    try {
      const config = await getNonSecretConfig();
      setWorkspace(config["bitbucket_workspace"] ?? "");
      setEmail(config["bitbucket_email"] ?? "");
      const hasStoredCreds = !!config["bitbucket_workspace"];
      setAccessToken(hasStoredCreds ? MASKED_SENTINEL : "");
    } catch {
      setWorkspace("");
      setEmail("");
      setAccessToken("");
    }
    setTestResult("untested");
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  // Load preference on mount
  useEffect(() => {
    getPreferences().then((prefs) => {
      setDisableSslVerify(prefs["bitbucket_disable_ssl_verify"] === "true");
    });
  }, []);

  async function handleSave() {
    if (!workspace.trim() || !email.trim() || !accessToken.trim()) return;
    setSavingBb(true);
    setStatus({ state: "loading", message: "Saving…" });
    try {
      await saveCredential("bitbucket_workspace", workspace.trim());
      await saveCredential("bitbucket_email", email.trim());
      if (accessToken !== MASKED_SENTINEL)
        await saveCredential("bitbucket_access_token", accessToken.trim());
      setTestResult("untested");
      setStatus({ state: "success", message: "Credentials saved." });
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    } finally {
      setSavingBb(false);
    }
  }

  async function handleTest() {
    setTestingBb(true);
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg =
        accessToken === MASKED_SENTINEL
          ? await testBitbucketStored()
          : await validateBitbucket(
              workspace.trim(),
              email.trim(),
              accessToken.trim(),
            );
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    } finally {
      setTestingBb(false);
    }
  }

  async function handleTestStored() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = await testBitbucketStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setWorkspace("");
    setEmail("");
    setAccessToken("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    for (const key of [
      "bitbucket_workspace",
      "bitbucket_email",
      "bitbucket_access_token",
      "bitbucket_username",
    ]) {
      try {
        await deleteCredential(key);
      } catch {
        /* already gone */
      }
    }
    setTestResult("untested");
    onSaved();
  }

  const canSaveBb = !!(workspace.trim() && email.trim() && accessToken.trim());
  const [savingBb, setSavingBb] = useState(false);
  const [testingBb, setTestingBb] = useState(false);

  // Save preference when toggled
  async function handleSslVerifyToggle(checked: boolean) {
    setDisableSslVerify(checked);
    await setPreference(
      "bitbucket_disable_ssl_verify",
      checked ? "true" : "false",
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Bitbucket</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              PR reviews, team metrics, and workload analysis
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Credentials/test/reset buttons */}
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
              {isConfigured ? "Update credentials" : "Add credentials"}
            </Button>
            {isConfigured && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestStored}
                disabled={status.state === "loading"}
              >
                {status.state === "loading" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                  </>
                ) : (
                  "Test connection"
                )}
              </Button>
            )}
            {isConfigured && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground gap-1"
                onClick={handleReset}
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ScopeList {...BITBUCKET_SCOPES} />
            <CredentialField
              id="s-bb-ws"
              label="Workspace slug"
              placeholder="your-workspace"
              value={workspace}
              onChange={(v) => {
                setWorkspace(v);
                setTestResult("untested");
              }}
              disabled={savingBb || testingBb}
              helperText="The short name in your Bitbucket workspace URL: bitbucket.org/your-workspace"
            />
            <CredentialField
              id="s-bb-email"
              label="Email"
              placeholder="you@yourcompany.com"
              value={email}
              onChange={(v) => {
                setEmail(v);
                setTestResult("untested");
              }}
              disabled={savingBb || testingBb}
              helperText="The email address you use to sign in to Bitbucket"
            />
            <CredentialField
              id="s-bb-token"
              label="Access Token"
              placeholder="ATCTT3x…"
              masked
              value={accessToken}
              onChange={(v) => {
                setAccessToken(v);
                setTestResult("untested");
              }}
              disabled={savingBb || testingBb}
              helperText={
                isConfigured && accessToken === MASKED_SENTINEL
                  ? "Token already saved — clear to enter a new one"
                  : "HTTP access token from Bitbucket workspace or repository settings → Access tokens."
              }
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!canSaveBb || savingBb || testingBb}
              >
                {savingBb ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Save credentials"
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={!canSaveBb || savingBb || testingBb}
              >
                {testingBb ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Test connection"
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* SSL Verification toggle is always visible */}
        <div className="flex items-center gap-2 pt-2">
          <Switch
            id="s-bb-disable-ssl-verify"
            checked={disableSslVerify}
            onCheckedChange={handleSslVerifyToggle}
          />
          <label
            htmlFor="s-bb-disable-ssl-verify"
            className="text-xs select-none"
          >
            Disable SSL Verification (insecure)
          </label>
        </div>

        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}
