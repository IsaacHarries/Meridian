import { Button } from "@/components/ui/button";
import { setPreference } from "@/lib/preferences";
import { getCredentialStatus } from "@/lib/tauri/credentials";
import { useAiSelectionStore, type AiProvider } from "@/stores/aiSelectionStore";
import { ArrowRight, ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
    PROVIDER_ORDER,
    ProviderCard,
    TOTAL_STEPS,
    type ProviderAuthState,
} from "./_shared";

export function AiProvidersStep({
  onNext,
  onBack,
  stepNum,
}: {
  onNext: () => void;
  onBack: () => void;
  stepNum: number;
}) {
  const [authState, setAuthState] = useState<Record<AiProvider, ProviderAuthState>>({
    claude: { authed: false },
    gemini: { authed: false },
    copilot: { authed: false },
    local: { authed: false },
  });
  const [expanded, setExpanded] = useState<AiProvider | null>("claude");

  // Reflect already-saved credentials so navigating back to this step
  // shows what's done. Same pattern the previous Anthropic step used.
  useEffect(() => {
    void getCredentialStatus().then((s) => {
      setAuthState((prev) => ({
        ...prev,
        claude: { ...prev.claude, authed: !!s.anthropicApiKey },
        gemini: { ...prev.gemini, authed: !!s.geminiApiKey },
        copilot: { ...prev.copilot, authed: !!s.copilotApiKey },
        local: { ...prev.local, authed: !!s.localLlmUrl },
      }));
    });
  }, []);

  const onProviderAuthed = useCallback(
    (provider: AiProvider, suggestedModel?: string) => {
      setAuthState((prev) => ({
        ...prev,
        [provider]: { authed: true, suggestedModel: suggestedModel ?? prev[provider].suggestedModel },
      }));
    },
    [],
  );

  const onProviderCleared = useCallback((provider: AiProvider) => {
    setAuthState((prev) => ({
      ...prev,
      [provider]: { authed: false },
    }));
  }, []);

  async function handleNext() {
    // Pick the first authenticated provider in PROVIDER_ORDER as the
    // default. The user's per-provider model preference is read from the
    // saved config (each section writes <provider>_model on connect/save)
    // — fall back to undefined and let aiSelectionStore.refreshFromPrefs
    // resolve from `<provider>_model` keys later. We always set the
    // provider so the default picker has something to work with even
    // before the user lands on Settings.
    for (const p of PROVIDER_ORDER) {
      if (authState[p].authed) {
        await setPreference("ai_default_provider", p);
        const suggested = authState[p].suggestedModel;
        if (suggested) {
          await setPreference("ai_default_model", suggested);
        }
        break;
      }
    }
    void useAiSelectionStore.getState().refreshFromPrefs();
    onNext();
  }

  const anyAuthed = PROVIDER_ORDER.some((p) => authState[p].authed);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3">
          Step {stepNum} of {TOTAL_STEPS}
        </p>
        <h2 className="text-xl font-semibold">AI Providers</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect at least one provider. The first one you authenticate becomes
          your default — you can change this and add more anytime in Settings.
        </p>
      </div>

      <div className="space-y-2">
        {PROVIDER_ORDER.map((p) => (
          <ProviderCard
            key={p}
            provider={p}
            state={authState[p]}
            expanded={expanded === p}
            onToggleExpand={() => setExpanded(expanded === p ? null : p)}
            onAuthed={(suggestedModel) => onProviderAuthed(p, suggestedModel)}
            onCleared={() => onProviderCleared(p)}
          />
        ))}
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
        <Button className="flex-1" onClick={handleNext} disabled={!anyAuthed}>
          {anyAuthed ? "Continue" : "Connect at least one provider"}
          {anyAuthed && <ArrowRight className="h-4 w-4" />}
        </Button>
      </div>

      {!anyAuthed && (
        <button
          onClick={onNext}
          className="w-full text-xs text-muted-foreground hover:text-foreground text-center"
        >
          Skip for now (you can configure providers later in Settings)
        </button>
      )}
    </div>
  );
}
