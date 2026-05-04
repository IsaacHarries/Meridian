import { CredentialField } from "@/components/CredentialField";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { setPreference } from "@/lib/preferences";
import { deleteCredential, getNonSecretConfig, saveCredential } from "@/lib/tauri/credentials";
import { getClaudeModels, pingAnthropic, startClaudeOauth, testAnthropicStored, validateAnthropic } from "@/lib/tauri/providers";
import { cn } from "@/lib/utils";
import { useAiSelectionStore } from "@/stores/aiSelectionStore";
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

export function AnthropicSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [authMethod, setAuthMethod] = useState<"api_key" | "oauth">("api_key");
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [importing, setImporting] = useState(false);
  const [models, setModels] = useState<[string, string][]>([]);
  const [selectedModel, setSelectedModel] = useState("");

  useEffect(() => {
    getClaudeModels()
      .then(setModels)
      .catch(() => {});
    getNonSecretConfig()
      .then((cfg) => {
        if (cfg.claude_model) setSelectedModel(cfg.claude_model);
        if (cfg.claude_auth_method === "oauth") setAuthMethod("oauth");
      })
      .catch(() => {});
  }, []);

  async function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    try {
      await setPreference("claude_model", modelId);
      void useAiSelectionStore.getState().refreshFromPrefs();
    } catch {
      /* non-critical */
    }
  }

  async function handleAuthMethodChange(method: "api_key" | "oauth") {
    setAuthMethod(method);
    setEditing(false);
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    try {
      await saveCredential("claude_auth_method", method);
    } catch {
      /* non-critical */
    }
  }

  function startEditing() {
    setApiKey(isConfigured ? MASKED_SENTINEL : "");
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    setEditing(true);
  }

  async function handleImportClaudePro() {
    setImporting(true);
    setStatus({
      state: "loading",
      message: "Opening browser for Claude authorization…",
    });
    try {
      const msg = await startClaudeOauth();
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
      const msg =
        apiKey === MASKED_SENTINEL
          ? await testAnthropicStored()
          : await validateAnthropic(apiKey.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTestStored() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = await testAnthropicStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handlePing() {
    setStatus({ state: "loading", message: "Sending test message…" });
    setTestResult("untested");
    try {
      const msg = await pingAnthropic();
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
      /* fine if not present */
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Anthropic</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Claude authentication for all AI workflows
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Auth method toggle */}
        <div className="flex rounded-md border overflow-hidden w-fit">
          <button
            onClick={() => handleAuthMethodChange("api_key")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              authMethod === "api_key"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            API Key
          </button>
          <button
            onClick={() => handleAuthMethodChange("oauth")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors border-l",
              authMethod === "oauth"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            Claude.ai
          </button>
        </div>

        {/* API Key flow */}
        {authMethod === "api_key" &&
          (!editing ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={startEditing}>
                {isConfigured ? "Update key" : "Add key"}
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
                  variant="outline"
                  size="sm"
                  onClick={handlePing}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send test message"
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
              <CredentialField
                id="settings-anthropic-key"
                label="API Key"
                placeholder="sk-ant-api03-…"
                masked
                value={apiKey}
                onChange={(v) => {
                  setApiKey(v);
                  setTestResult("untested");
                }}
                disabled={status.state === "loading"}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={
                    !apiKey.trim() ||
                    apiKey === MASKED_SENTINEL ||
                    status.state === "loading"
                  }
                >
                  {status.state === "loading" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Save key"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTest}
                  disabled={!apiKey.trim() || status.state === "loading"}
                >
                  Test connection
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ))}

        {/* OAuth flow */}
        {authMethod === "oauth" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Authorize Meridian to use your Claude.ai account. A browser window
              will open to complete sign-in — no API key or CLI required.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleImportClaudePro}
                disabled={importing || status.state === "loading"}
                className="gap-1.5"
              >
                {importing ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Connecting…
                  </>
                ) : isConfigured ? (
                  "Re-authorize"
                ) : (
                  "Connect with Claude"
                )}
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
                  variant="outline"
                  size="sm"
                  onClick={handlePing}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send test message"
                  )}
                </Button>
              )}
            </div>
          </div>
        )}

        <SectionMessage {...status} />

        {/* Model picker — visible when Anthropic is configured */}
        {isConfigured && models.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t">
            <label className="text-xs font-medium text-muted-foreground">
              Default Claude Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {!selectedModel && <option value="">— select a model —</option>}
              {models.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Used for all AI features. Sonnet is recommended for quality; Haiku
              is faster and lower cost.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
