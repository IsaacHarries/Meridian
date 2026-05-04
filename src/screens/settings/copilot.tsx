import { CredentialField } from "@/components/CredentialField";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { setPreference } from "@/lib/preferences";
import { deleteCredential, getNonSecretConfig, saveCredential } from "@/lib/tauri/credentials";
import { addCustomCopilotModel, getCopilotModels, getCustomCopilotModels, pingCopilot, removeCustomCopilotModel, startCopilotOauth, testCopilotStored, validateCopilot } from "@/lib/tauri/providers";
import { cn } from "@/lib/utils";
import { useAiSelectionStore } from "@/stores/aiSelectionStore";
import { listen } from "@tauri-apps/api/event";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
    MASKED_SENTINEL,
    SectionMessage,
    StatusBadge,
    VerifiedBadge,
    type SectionStatus,
    type TestResult,
} from "./_shared";

export function CopilotSection({
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
  const [connecting, setConnecting] = useState(false);
  const [models, setModels] = useState<[string, string][]>([]);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [customModelDraft, setCustomModelDraft] = useState("");
  const [customModelErr, setCustomModelErr] = useState("");
  const [savingCustom, setSavingCustom] = useState(false);

  async function refreshModelLists() {
    const [list, custom] = await Promise.all([
      getCopilotModels(),
      getCustomCopilotModels(),
    ]);
    setModels(list);
    setCustomModels(custom);
  }

  useEffect(() => {
    refreshModelLists().catch((err) => {
      if (isConfigured) {
        setStatus({
          state: "error",
          message: `Failed to load models: ${err}`,
        });
      }
    });
    getNonSecretConfig()
      .then((cfg) => {
        if (cfg.copilot_model) setSelectedModel(cfg.copilot_model);
        if (cfg.copilot_auth_method === "oauth") setAuthMethod("oauth");
      })
      .catch(() => {});
  }, [isConfigured]);

  async function handleAddCustomModel() {
    const id = customModelDraft.trim();
    if (!id) return;
    setSavingCustom(true);
    setCustomModelErr("");
    try {
      const updated = await addCustomCopilotModel(id);
      setCustomModels(updated);
      setModels(await getCopilotModels());
      useAiSelectionStore.getState().invalidateModels("copilot");
      setCustomModelDraft("");
      if (!selectedModel) handleModelChange(id);
    } catch (err) {
      setCustomModelErr(String(err));
    } finally {
      setSavingCustom(false);
    }
  }

  async function handleRemoveCustomModel(id: string) {
    try {
      const updated = await removeCustomCopilotModel(id);
      setCustomModels(updated);
      setModels(await getCopilotModels());
      useAiSelectionStore.getState().invalidateModels("copilot");
      if (selectedModel === id) handleModelChange("");
    } catch (err) {
      setCustomModelErr(String(err));
    }
  }

  async function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    try {
      await setPreference("copilot_model", modelId);
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
      await saveCredential("copilot_auth_method", method);
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

  async function handleConnectGithub() {
    setConnecting(true);
    setStatus({
      state: "loading",
      message: "Opening browser for GitHub authorization…",
    });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen("copilot-oauth-code", (event) => {
        const payload = event.payload as {
          userCode: string;
          verificationUri: string;
        };
        setStatus({
          state: "loading",
          message: `Please open ${payload.verificationUri} and enter code: ${payload.userCode}`,
        });
      });
      await saveCredential("copilot_auth_method", "oauth");
      const msg = await startCopilotOauth();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
      refreshModelLists().catch((err) => {
        setStatus({
          state: "error",
          message: `${msg} (but failed to load models: ${err})`,
        });
      });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    } finally {
      if (unlisten) unlisten();
      setConnecting(false);
    }
  }

  async function handleSave() {
    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
    setStatus({ state: "loading", message: "Saving and testing…" });
    try {
      await saveCredential("copilot_auth_method", "api_key");
      const msg = await validateCopilot(apiKey.trim());
      const verified = msg.toLowerCase().includes("successfully");
      setTestResult(verified ? "success" : "untested");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
      refreshModelLists().catch((err) => {
        setStatus({
          state: "error",
          message: `${msg} (but failed to load models: ${err})`,
        });
      });
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
          ? await testCopilotStored()
          : await validateCopilot(apiKey.trim());
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
      const msg = await testCopilotStored();
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
      const msg = await pingCopilot();
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
      await deleteCredential("copilot_api_key");
      await saveCredential("copilot_auth_method", "api_key");
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
            <CardTitle className="text-base">GitHub Copilot</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Use your GitHub Copilot subscription for AI features
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
            GitHub Account
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
                id="settings-copilot-token"
                label="GitHub Token"
                placeholder="AIza…"
                masked
                value={apiKey}
                onChange={(v) => {
                  setApiKey(v);
                  setTestResult("untested");
                }}
                disabled={status.state === "loading"}
              />
              <p className="text-[11px] text-muted-foreground -mt-1">
                Get a free key (or enable pay-as-you-go) at{" "}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  github.com/settings/tokens
                </a>
              </p>
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
              Sign in with your GitHub account to use your Copilot subscription.
              A browser window will open on github.com/login/device. The
              one-time code has been copied to your clipboard — paste it and
              approve to finish sign-in.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnectGithub}
                disabled={connecting || status.state === "loading"}
                className="gap-1.5"
              >
                {connecting ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Connecting…
                  </>
                ) : isConfigured ? (
                  "Re-authorize"
                ) : (
                  "Connect with GitHub"
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
          </div>
        )}

        <SectionMessage {...status} />

        {/* Model picker — visible when Copilot is configured */}
        {isConfigured && models.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t">
            <label className="text-xs font-medium text-muted-foreground">
              Default Copilot Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {!selectedModel && <option value="">— select a model —</option>}
              {models.length === 0 && !selectedModel && (
                <option value="" disabled>
                  Loading models...
                </option>
              )}
              {models.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Used when GitHub Copilot is the active provider. Includes GPT-4o,
              o3-mini, and Claude 3.5 Sonnet.
            </p>

            <div className="pt-2 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Custom models
              </label>
              <p className="text-[11px] text-muted-foreground -mt-0.5">
                Add any model ID supported by GitHub Copilot (e.g.{" "}
                <code>o1-preview</code>). Useful when a new model ships before
                Meridian's built-in list is updated.
              </p>
              <div className="flex gap-2">
                <Input
                  value={customModelDraft}
                  onChange={(e) => {
                    setCustomModelDraft(e.target.value);
                    if (customModelErr) setCustomModelErr("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddCustomModel();
                    }
                  }}
                  placeholder="o3-mini…"
                  disabled={savingCustom}
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddCustomModel}
                  disabled={!customModelDraft.trim() || savingCustom}
                >
                  {savingCustom ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Add"
                  )}
                </Button>
              </div>
              {customModelErr && (
                <p className="text-[11px] text-destructive">{customModelErr}</p>
              )}
              {customModels.length > 0 && (
                <ul className="space-y-1 pt-1">
                  {customModels.map((id) => (
                    <li
                      key={id}
                      className="flex items-center justify-between rounded-md border px-2 py-1 text-xs"
                    >
                      <code className="font-mono">{id}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveCustomModel(id)}
                        aria-label={`Remove ${id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
