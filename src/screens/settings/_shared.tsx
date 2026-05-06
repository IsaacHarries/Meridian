import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    type AppPreferences,
    getAppPreferences,
    setAiDebugEnabled,
    setAnthropicMaxOutputTokens,
    setCopilotMaxOutputTokens,
    setDailyTokenBudget,
    setGeminiMaxOutputTokens,
    setMeetingsEmbeddingModel,
    setMeetingsSearchMinScore,
    setNotifyAgentStageComplete,
    setNotifyPrTaskAdded,
    setPrReviewDefaultChunkChars,
    setPrTasksPollIntervalMinutes,
    setStreamingPartialsEnabled,
    setWorkloadOverloadThresholdPct,
} from "@/lib/appPreferences";
import { BackgroundRenderer } from "@/lib/backgrounds/_registry";
import { clearMeetingsEmbeddings } from "@/lib/tauri/meetings";
import { setRuntimeOverloadPct } from "@/lib/workloadClassifier";
import { useAiDebugStore } from "@/stores/aiDebugStore";
import { setStreamingPartialsEnabledRuntime } from "@/stores/implementTicket/listeners";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

export const MASKED_SENTINEL = "••••••••";

export type SectionState =
  | "idle"
  | "editing"
  | "loading"
  | "success"
  | "error";

export interface SectionStatus {
  state: SectionState;
  message: string;
}

export type TestResult = "untested" | "success" | "error";

export function BgThumbnail({ id }: { id: string }) {
  return (
    <div className="w-full h-full overflow-hidden">
      <BackgroundRenderer id={id} />
    </div>
  );
}

export function StatusBadge({ complete }: { complete: boolean }) {
  return complete ? (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <CheckCircle className="h-3 w-3" /> Saved
    </Badge>
  ) : (
    <Badge variant="warning" className="gap-1">
      <AlertCircle className="h-3 w-3" /> Not configured
    </Badge>
  );
}

export function VerifiedBadge({ result }: { result: TestResult }) {
  if (result === "success") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle className="h-3 w-3" /> Connected
      </Badge>
    );
  }
  if (result === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="h-3 w-3" /> Failed
      </Badge>
    );
  }
  return null;
}

export function SectionMessage({
  state,
  message,
}: {
  state: SectionState;
  message: string;
}) {
  if (state === "idle" || state === "editing" || !message) return null;
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm mt-3 ${
        state === "loading"
          ? "bg-muted text-muted-foreground"
          : state === "success"
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-destructive/10 text-destructive"
      }`}
    >
      {state === "loading" && (
        <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />
      )}
      {state === "success" && (
        <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
      )}
      {state === "error" && <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      <span>{message}</span>
    </div>
  );
}

export function NumberPreferenceField({
  label,
  helper,
  value,
  defaultValue,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  helper?: string;
  value: number;
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step ?? 1}
          onChange={(e) => {
            const n = Number.parseFloat(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="h-8 w-32 text-sm"
        />
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
        {value !== defaultValue && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => onChange(defaultValue)}
            title={`Reset to default (${defaultValue})`}
          >
            Reset
          </Button>
        )}
      </div>
      {helper && (
        <p className="text-xs text-muted-foreground">
          {helper} {`Default: ${defaultValue}.`}
        </p>
      )}
    </div>
  );
}

export function ToggleRow({
  label,
  helper,
  checked,
  onChange,
}: {
  label: string;
  helper?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 cursor-pointer"
      />
      <div className="space-y-0.5">
        <span className="text-sm font-medium">{label}</span>
        {helper && (
          <p className="text-xs text-muted-foreground leading-snug">{helper}</p>
        )}
      </div>
    </label>
  );
}

export function useAppPreferencesEditor() {
  const [prefs, setPrefs] = useState<AppPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getAppPreferences().then((p) => {
      if (alive) setPrefs(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function update<K extends keyof AppPreferences>(
    key: K,
    value: AppPreferences[K],
  ): Promise<void> {
    setPrefs((prior) => (prior ? { ...prior, [key]: value } : prior));
    try {
      switch (key) {
        case "prReviewDefaultChunkChars":
          await setPrReviewDefaultChunkChars(value as number);
          break;
        case "prTasksPollIntervalMinutes":
          await setPrTasksPollIntervalMinutes(value as number);
          break;
        case "streamingPartialsEnabled":
          await setStreamingPartialsEnabled(value as boolean);
          // Update the runtime gate immediately so the next pipeline
          // event respects the new setting without an app restart.
          setStreamingPartialsEnabledRuntime(value as boolean);
          break;
        case "workloadOverloadThresholdPct":
          await setWorkloadOverloadThresholdPct(value as number);
          setRuntimeOverloadPct(value as number);
          break;
        case "dailyTokenBudget":
          await setDailyTokenBudget(value as number | null);
          break;
        case "notifyPrTaskAdded":
          await setNotifyPrTaskAdded(value as boolean);
          break;
        case "notifyAgentStageComplete":
          await setNotifyAgentStageComplete(value as boolean);
          break;
        case "aiDebugEnabled":
          await setAiDebugEnabled(value as boolean);
          // Mirror into the runtime store so the panel header reflects
          // the change immediately without waiting for a hydrate cycle.
          useAiDebugStore.setState({ enabled: value as boolean });
          break;
        case "meetingsEmbeddingModel":
          await setMeetingsEmbeddingModel(value as string);
          // Switching models invalidates existing embeddings — they're
          // not comparable across models. Clear; the backfill loop
          // will re-embed under the new model on its next tick.
          await clearMeetingsEmbeddings();
          break;
        case "meetingsSearchMinScore":
          await setMeetingsSearchMinScore(value as number);
          break;
        case "anthropicMaxOutputTokens":
          await setAnthropicMaxOutputTokens(value as number);
          break;
        case "geminiMaxOutputTokens":
          await setGeminiMaxOutputTokens(value as number);
          break;
        case "copilotMaxOutputTokens":
          await setCopilotMaxOutputTokens(value as number);
          break;
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return { prefs, error, update };
}
