import { CheckCircle, XCircle, Loader2, ChevronDown, ChevronRight, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { AiProvider } from "@/stores/aiSelectionStore";
import { ClaudeAuthForm } from "./claude-auth-form";
import { GeminiAuthForm } from "./gemini-auth-form";
import { CopilotAuthForm } from "./copilot-auth-form";
import { LocalLlmAuthForm } from "./local-llm-auth-form";

export const MASKED_SENTINEL = "••••••••";

export const TOTAL_STEPS = 4;

export type ValidationState = "idle" | "loading" | "success" | "error";

export interface ProviderAuthState {
  authed: boolean;
  /** Optional model id surfaced to the default-picker logic when this
   *  provider becomes the default. Resolved from the per-provider model
   *  list whenever auth completes — harmless when null. */
  suggestedModel?: string;
}

export const PROVIDER_ORDER: AiProvider[] = ["claude", "gemini", "copilot", "local"];

export const PROVIDER_BLURB: Record<AiProvider, string> = {
  claude: "Anthropic's Claude — recommended default. Use a Pro / Max subscription via OAuth, or an API key.",
  gemini: "Google's Gemini — use a personal Google account via CodeAssist OAuth, or an API key from AI Studio.",
  copilot: "GitHub Copilot — sign in with your existing Copilot subscription.",
  local: "Run models locally via Ollama or any OpenAI-compatible server. No subscription needed.",
};

export const PROVIDER_TITLE: Record<AiProvider, string> = {
  claude: "Claude (Anthropic)",
  gemini: "Gemini (Google)",
  copilot: "GitHub Copilot",
  local: "Local LLM (Ollama)",
};

export function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i < current
              ? "bg-primary w-6"
              : i === current
              ? "bg-primary w-10"
              : "bg-muted w-6"
          }`}
        />
      ))}
    </div>
  );
}

export function ValidationMessage({ state, message }: { state: ValidationState; message: string }) {
  if (state === "idle" || !message) return null;
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${
        state === "loading"
          ? "bg-muted text-muted-foreground"
          : state === "success"
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-destructive/10 text-destructive"
      }`}
    >
      {state === "loading" && <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />}
      {state === "success" && <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      {state === "error" && <XCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      <span>{message}</span>
    </div>
  );
}

export function ProviderCard({
  provider,
  state,
  expanded,
  onToggleExpand,
  onAuthed,
  onCleared,
}: {
  provider: AiProvider;
  state: ProviderAuthState;
  expanded: boolean;
  onToggleExpand: () => void;
  onAuthed: (suggestedModel?: string) => void;
  onCleared: () => void;
}) {
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <button
          type="button"
          onClick={onToggleExpand}
          className="w-full flex items-start gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{PROVIDER_TITLE[provider]}</p>
              {state.authed ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                  <CheckCircle className="h-3 w-3" /> Connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <AlertCircle className="h-3 w-3" /> Not connected
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {PROVIDER_BLURB[provider]}
            </p>
          </div>
        </button>

        {expanded && (
          <div className="pt-1 pl-6">
            {provider === "claude" && (
              <ClaudeAuthForm onAuthed={onAuthed} onCleared={onCleared} />
            )}
            {provider === "gemini" && (
              <GeminiAuthForm onAuthed={onAuthed} onCleared={onCleared} />
            )}
            {provider === "copilot" && (
              <CopilotAuthForm onAuthed={onAuthed} onCleared={onCleared} />
            )}
            {provider === "local" && (
              <LocalLlmAuthForm onAuthed={onAuthed} onCleared={onCleared} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
