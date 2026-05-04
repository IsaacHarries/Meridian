import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setLocalLlmUrlCache } from "@/lib/tauri/core";
import { deleteCredential, getNonSecretConfig, saveCredential } from "@/lib/tauri/credentials";
import { getLocalModels, testLocalLlmStored, validateLocalLlm } from "@/lib/tauri/providers";
import { useAiSelectionStore } from "@/stores/aiSelectionStore";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
    type SectionStatus,
    type TestResult,
    SectionMessage,
    StatusBadge,
    VerifiedBadge,
} from "./_shared";

export function LocalLlmSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [models, setModels] = useState<[string, string][]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [customModel, setCustomModel] = useState("");

  useEffect(() => {
    getNonSecretConfig()
      .then((cfg) => {
        if (cfg.local_llm_url) {
          setServerUrl(cfg.local_llm_url);
          setLocalLlmUrlCache(cfg.local_llm_url);
        }
        if (cfg.local_llm_model) setSelectedModel(cfg.local_llm_model);
      })
      .catch(() => {});
    if (isConfigured) {
      getLocalModels()
        .then(setModels)
        .catch(() => {});
    }
  }, [isConfigured]);

  async function handleModelChange(value: string) {
    setSelectedModel(value);
    try {
      await saveCredential("local_llm_model", value);
      void useAiSelectionStore.getState().refreshFromPrefs();
    } catch {
      /* non-critical */
    }
  }

  function startEditing() {
    setApiKey("");
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    setEditing(true);
  }

  async function handleSave() {
    if (!serverUrl.trim()) return;
    setStatus({ state: "loading", message: "Connecting…" });
    try {
      const msg = await validateLocalLlm(serverUrl.trim(), apiKey.trim());
      setLocalLlmUrlCache(serverUrl.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
      // Drop any cached "local" model list in the AI selection store so the
      // per-panel model picker fetches a fresh list against the new URL.
      useAiSelectionStore.getState().invalidateModels("local");
      const list = await getLocalModels();
      setModels(list);
      if (list.length > 0 && !selectedModel) {
        handleModelChange(list[0][0]);
      }
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTestStored() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = await testLocalLlmStored();
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
      await deleteCredential("local_llm_url");
      setTestResult("untested");
      setModels([]);
      useAiSelectionStore.getState().invalidateModels("local");
      onSaved();
    } catch {
      /* fine */
    }
  }

  async function handleRefreshModels() {
    setStatus({ state: "loading", message: "Refreshing model list…" });
    try {
      const list = await getLocalModels();
      setModels(list);
      setStatus({
        state: list.length > 0 ? "success" : "idle",
        message:
          list.length > 0
            ? `${list.length} model${list.length !== 1 ? "s" : ""} found.`
            : "No models found. Make sure at least one model is pulled in Ollama.",
      });
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  const displayModels =
    models.length > 0
      ? models
      : selectedModel
        ? ([[selectedModel, selectedModel]] as [string, string][])
        : [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Local LLM</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Ollama, LM Studio, Jan, or any OpenAI-compatible server
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
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
              {isConfigured ? "Update server" : "Add server"}
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
                className="text-destructive hover:text-destructive"
                onClick={handleReset}
              >
                Remove
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Server URL</Label>
              <Input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="text-xs h-8 font-mono mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Ollama default:{" "}
                <code className="bg-muted px-1 rounded">
                  http://localhost:11434
                </code>
                {" · "}LM Studio:{" "}
                <code className="bg-muted px-1 rounded">
                  http://localhost:1234
                </code>
              </p>
            </div>
            <div>
              <Label className="text-xs">
                API Key{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Leave blank if not required"
                className="text-xs h-8 font-mono mt-1"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!serverUrl.trim() || status.state === "loading"}
              >
                {status.state === "loading" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Save & Test"
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <SectionMessage state={status.state} message={status.message} />

        {isConfigured && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Model</Label>
              <button
                onClick={handleRefreshModels}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Refresh list
              </button>
            </div>
            {displayModels.length > 0 ? (
              <select
                value={selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
                className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 text-foreground"
              >
                {displayModels.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                onBlur={() => {
                  if (customModel.trim()) handleModelChange(customModel.trim());
                }}
                placeholder="e.g. llama3.2:latest"
                className="text-xs h-8 font-mono"
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
