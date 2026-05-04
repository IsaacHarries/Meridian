import { CredentialField } from "@/components/CredentialField";
import { Button } from "@/components/ui/button";
import { getNonSecretConfig } from "@/lib/tauri/credentials";
import { testLocalLlmStored, validateLocalLlm } from "@/lib/tauri/providers";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ValidationMessage, type ValidationState } from "./_shared";

export function LocalLlmAuthForm({
  onAuthed,
  onCleared,
}: {
  onAuthed: (suggestedModel?: string) => void;
  onCleared: () => void;
}) {
  const [url, setUrl] = useState("http://localhost:11434");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testState, setTestState] = useState<ValidationState>("idle");
  const [testMessage, setTestMessage] = useState("");

  useEffect(() => {
    void getNonSecretConfig().then((cfg) => {
      if (cfg.local_llm_url) {
        setUrl(cfg.local_llm_url);
        setSaved(true);
      }
    }).catch(() => {});
  }, []);

  async function handleSave() {
    if (!url.trim()) return;
    setSaving(true);
    setTestState("loading");
    setTestMessage("Probing local server…");
    try {
      const msg = await validateLocalLlm(url.trim(), "");
      setSaved(true);
      setTestState("success");
      setTestMessage(msg);
      // Local LLM has no per-provider model list at this stage (the URL
      // determines what's available) — let the default-picker fall
      // through to the user's eventual `local_llm_model` selection.
      onAuthed();
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
      onCleared();
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestState("loading");
    setTestMessage("Probing local server…");
    try {
      const msg = await testLocalLlmStored();
      setTestState("success");
      setTestMessage(msg);
      onAuthed();
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
    }
  }

  return (
    <div className="space-y-3">
      <CredentialField
        id="ollama-url"
        label="Server URL"
        placeholder="http://localhost:11434"
        value={url}
        onChange={(v) => { setUrl(v); setSaved(false); setTestState("idle"); setTestMessage(""); }}
        disabled={saving || testState === "loading"}
        helperText="Ollama or any OpenAI-compatible chat-completions endpoint"
      />

      <ValidationMessage state={testState} message={testMessage} />

      <div className="flex gap-2 justify-end">
        <Button size="sm" onClick={handleSave} disabled={saving || !url.trim()}>
          {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</> : "Save URL"}
        </Button>
        {saved && (
          <Button variant="outline" size="sm" onClick={handleTest} disabled={testState === "loading"}>
            {testState === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test"}
          </Button>
        )}
      </div>
    </div>
  );
}
