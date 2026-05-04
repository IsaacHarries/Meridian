import { CredentialField } from "@/components/CredentialField";
import { Button } from "@/components/ui/button";
import { getCredentialStatus } from "@/lib/tauri/credentials";
import { getClaudeModels, startClaudeOauth, testAnthropicStored, validateAnthropic } from "@/lib/tauri/providers";
import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { MASKED_SENTINEL, ValidationMessage, type ValidationState } from "./_shared";

export function ClaudeAuthForm({
  onAuthed,
  onCleared,
}: {
  onAuthed: (suggestedModel?: string) => void;
  onCleared: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<ValidationState>("idle");
  const [testMessage, setTestMessage] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void getCredentialStatus()
      .then((status) => {
        if (status.anthropicApiKey) {
          setApiKey(MASKED_SENTINEL);
          setSaved(true);
        }
      })
      .catch(() => {});
  }, []);

  async function reportFirstClaudeModel() {
    try {
      const list = await getClaudeModels();
      const first = list[0]?.[0];
      onAuthed(first);
    } catch {
      onAuthed();
    }
  }

  async function handleImportClaudePro() {
    setImporting(true);
    setTestState("loading");
    setTestMessage("Opening browser for Claude authorization…");
    try {
      const msg = await startClaudeOauth();
      setApiKey(MASKED_SENTINEL);
      setSaved(true);
      setTestState("success");
      setTestMessage(msg);
      await reportFirstClaudeModel();
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
      const msg = await validateAnthropic(apiKey.trim());
      setSaved(true);
      setTestState("success");
      setTestMessage(msg);
      await reportFirstClaudeModel();
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
        ? await testAnthropicStored()
        : await validateAnthropic(apiKey.trim());
      setTestState("success");
      setTestMessage(msg);
      await reportFirstClaudeModel();
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
    }
  }

  const isNewKey = apiKey !== MASKED_SENTINEL && apiKey.trim().length > 0;
  const canTest = !!apiKey.trim();

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <div>
          <p className="text-xs font-medium">Use Claude Pro or Max subscription</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            A browser window will open to claude.ai — no CLI required.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={handleImportClaudePro}
          disabled={importing || testState === "loading"}
        >
          {importing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…</> : "Connect with Claude"}
        </Button>
      </div>

      <div className="relative flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="text-[11px] text-muted-foreground shrink-0">or use an API key</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <CredentialField
        id="anthropic-key"
        label="API Key"
        placeholder="sk-ant-api03-… or sk-ant-oat01-…"
        masked
        value={apiKey}
        onChange={(v) => { setApiKey(v); setSaved(false); setTestState("idle"); setTestMessage(""); }}
        disabled={saving || importing || testState === "loading"}
        helperText={saved && apiKey === MASKED_SENTINEL ? "Credential already saved — clear to enter a new one" : "API key from platform.anthropic.com"}
      />

      <ValidationMessage state={testState} message={testMessage} />

      <div className="flex items-center justify-between gap-2">
        <a
          href="https://platform.claude.com/api-keys"
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
            <Button variant="outline" size="sm" onClick={handleTest} disabled={!canTest || importing || testState === "loading"}>
              {testState === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test connection"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
