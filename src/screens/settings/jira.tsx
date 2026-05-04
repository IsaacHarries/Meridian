import { CredentialField } from "@/components/CredentialField";
import { JIRA_PERMISSIONS, ScopeList } from "@/components/ScopeList";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { deleteCredential, getNonSecretConfig, saveCredential } from "@/lib/tauri/credentials";
import { testJiraStored, validateJira } from "@/lib/tauri/providers";
import { Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
    MASKED_SENTINEL,
    SectionMessage,
    StatusBadge,
    VerifiedBadge,
    type SectionStatus,
    type TestResult,
} from "./_shared";

export function JiraSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");

  async function startEditing() {
    try {
      const config = await getNonSecretConfig();
      setBaseUrl(config["jira_base_url"] ?? "");
      setEmail(config["jira_email"] ?? "");
      const hasStoredCreds = !!(
        config["jira_base_url"] || config["jira_email"]
      );
      setApiToken(hasStoredCreds ? MASKED_SENTINEL : "");
    } catch {
      setBaseUrl("");
      setEmail("");
      setApiToken("");
    }
    setTestResult("untested");
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  async function handleSave() {
    if (!baseUrl.trim() || !email.trim() || !apiToken.trim()) return;
    setSavingJira(true);
    setStatus({ state: "loading", message: "Saving…" });
    try {
      await saveCredential("jira_base_url", baseUrl.trim());
      await saveCredential("jira_email", email.trim());
      if (apiToken !== MASKED_SENTINEL) {
        // Strip ALL whitespace — API tokens never contain spaces or newlines,
        // and paste events in password fields can introduce them invisibly.
        const cleanToken = apiToken.replace(/\s/g, "");
        await saveCredential("jira_api_token", cleanToken);
      }
      setTestResult("untested");
      setStatus({ state: "success", message: "Credentials saved." });
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    } finally {
      setSavingJira(false);
    }
  }

  async function handleTest() {
    setTestingJira(true);
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg =
        apiToken === MASKED_SENTINEL
          ? await testJiraStored()
          : await validateJira(baseUrl.trim(), email.trim(), apiToken.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    } finally {
      setTestingJira(false);
    }
  }

  async function handleTestStored() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = await testJiraStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setBaseUrl("");
    setEmail("");
    setApiToken("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    for (const key of ["jira_base_url", "jira_email", "jira_api_token"]) {
      try {
        await deleteCredential(key);
      } catch {
        /* already gone */
      }
    }
    setTestResult("untested");
    onSaved();
  }

  const canSave = !!(baseUrl.trim() && email.trim() && apiToken.trim());
  const [savingJira, setSavingJira] = useState(false);
  const [testingJira, setTestingJira] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">JIRA</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Sprint data and ticket details
            </CardDescription>
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
            <ScopeList {...JIRA_PERMISSIONS} />
            <CredentialField
              id="s-jira-url"
              label="Workspace URL"
              placeholder="https://yourcompany.atlassian.net"
              value={baseUrl}
              onChange={(v) => {
                setBaseUrl(v);
                setTestResult("untested");
              }}
              disabled={savingJira || testingJira}
            />
            <CredentialField
              id="s-jira-email"
              label="Email"
              placeholder="you@yourcompany.com"
              value={email}
              onChange={(v) => {
                setEmail(v);
                setTestResult("untested");
              }}
              disabled={savingJira || testingJira}
            />
            <CredentialField
              id="s-jira-token"
              label="API Token"
              placeholder="ATATT3x…"
              masked
              value={apiToken}
              onChange={(v) => {
                setApiToken(v);
                setTestResult("untested");
              }}
              disabled={savingJira || testingJira}
              helperText={
                isConfigured && apiToken === MASKED_SENTINEL
                  ? "Token already saved — clear to replace"
                  : "Go to id.atlassian.com → Security → API tokens and create a classic token (starts with ATATT3x)."
              }
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!canSave || savingJira || testingJira}
              >
                {savingJira ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Save credentials"
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={!canSave || savingJira || testingJira}
              >
                {testingJira ? (
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
        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}
