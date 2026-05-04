import { Button } from "@/components/ui/button";
import { getCredentialStatus } from "@/lib/tauri/credentials";
import { getCopilotModels, startCopilotOauth, testCopilotStored } from "@/lib/tauri/providers";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ValidationMessage, type ValidationState } from "./_shared";

export function CopilotAuthForm({
  onAuthed,
  onCleared,
}: {
  onAuthed: (suggestedModel?: string) => void;
  onCleared: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testState, setTestState] = useState<ValidationState>("idle");
  const [testMessage, setTestMessage] = useState("");

  useEffect(() => {
    void getCredentialStatus().then((s) => {
      if (s.copilotApiKey) setSaved(true);
    }).catch(() => {});
  }, []);

  async function reportFirstModel() {
    try {
      const list = await getCopilotModels();
      onAuthed(list[0]?.[0]);
    } catch {
      onAuthed();
    }
  }

  async function handleConnect() {
    setImporting(true);
    setTestState("loading");
    setTestMessage("Opening browser for GitHub authorization…");
    try {
      const msg = await startCopilotOauth();
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

  async function handleTest() {
    setTestState("loading");
    setTestMessage("Testing connection…");
    try {
      const msg = await testCopilotStored();
      setTestState("success");
      setTestMessage(msg);
      await reportFirstModel();
    } catch (err) {
      setTestState("error");
      setTestMessage(String(err));
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        Requires an active GitHub Copilot subscription on your account.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="w-full gap-2"
        onClick={handleConnect}
        disabled={importing || testState === "loading"}
      >
        {importing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…</> : saved ? "Re-authorise GitHub" : "Connect with GitHub"}
      </Button>

      <ValidationMessage state={testState} message={testMessage} />

      {saved && (
        <Button variant="outline" size="sm" onClick={handleTest} disabled={importing || testState === "loading"}>
          {testState === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test connection"}
        </Button>
      )}
    </div>
  );
}
