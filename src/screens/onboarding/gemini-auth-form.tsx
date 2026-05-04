import { CredentialField } from "@/components/CredentialField";
import { Button } from "@/components/ui/button";
import { getCredentialStatus } from "@/lib/tauri/credentials";
import { getGeminiModels, startGeminiOauth, testGeminiStored, validateGemini } from "@/lib/tauri/providers";
import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { MASKED_SENTINEL, ValidationMessage, type ValidationState } from "./_shared";

export function GeminiAuthForm({
  onAuthed,
  onCleared,
}: {
  onAuthed: (suggestedModel?: string) => void;
  onCleared: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testState, setTestState] = useState<ValidationState>("idle");
  const [testMessage, setTestMessage] = useState("");

  useEffect(() => {
    void getCredentialStatus().then((s) => {
      if (s.geminiApiKey) {
        setApiKey(MASKED_SENTINEL);
        setSaved(true);
      }
    }).catch(() => {});
  }, []);

  async function reportFirstModel() {
    try {
      const list = await getGeminiModels();
      onAuthed(list[0]?.[0]);
    } catch {
      onAuthed();
    }
  }

  async function handleConnectOauth() {
    setImporting(true);
    setTestState("loading");
    setTestMessage("Opening browser for Google authorization…");
    try {
      const msg = await startGeminiOauth();
      setSaved(true);
      setTestState("success");
      setTestMessage(msg);
      await reportFirstModel();
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
      onCleared();
    } finally {
      setImporting(false);
    }
  }

  async function handleSaveAndTest() {
    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
    setSaving(true);
    setTestState("loading");
    setTestMessage("Saving and testing connection…");
    try {
      const msg = await validateGemini(apiKey.trim());
      setSaved(true);
      setTestState("success");
      setTestMessage(msg);
      await reportFirstModel();
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
    setTestMessage("Testing connection…");
    try {
      const msg = apiKey === MASKED_SENTINEL
        ? await testGeminiStored()
        : await validateGemini(apiKey.trim());
      setTestState("success");
      setTestMessage(msg);
      await reportFirstModel();
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
    }
  }

  const isNewKey = apiKey !== MASKED_SENTINEL && apiKey.trim().length > 0;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <div>
          <p className="text-xs font-medium">Sign in with Google</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Uses Code Assist on your personal Google account — no API key
            required.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={handleConnectOauth}
          disabled={importing || testState === "loading"}
        >
          {importing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…</> : "Connect with Google"}
        </Button>
      </div>

      <div className="relative flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="text-[11px] text-muted-foreground shrink-0">or use an API key</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <CredentialField
        id="gemini-key"
        label="API Key"
        placeholder="AIza…"
        masked
        value={apiKey}
        onChange={(v) => { setApiKey(v); setSaved(false); setTestState("idle"); setTestMessage(""); }}
        disabled={saving || importing || testState === "loading"}
        helperText={saved && apiKey === MASKED_SENTINEL ? "Credential already saved — clear to enter a new one" : "API key from aistudio.google.com"}
      />

      <ValidationMessage state={testState} message={testMessage} />

      <div className="flex items-center justify-between gap-2">
        <a
          href="https://aistudio.google.com/app/apikey"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          Get an API key <ExternalLink className="h-3 w-3" />
        </a>
        <div className="flex gap-2">
          {isNewKey ? (
            <Button size="sm" onClick={handleSaveAndTest} disabled={saving || importing}>
              {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</> : "Save key"}
            </Button>
          ) : saved ? (
            <Button variant="outline" size="sm" onClick={handleTest} disabled={importing || testState === "loading"}>
              {testState === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test connection"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
