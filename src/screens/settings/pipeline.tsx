import { Activity, Gauge, ListTodo } from "lucide-react";
import { APP_PREFERENCE_DEFAULTS } from "@/lib/appPreferences";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  NumberPreferenceField,
  ToggleRow,
  useAppPreferencesEditor,
} from "./_shared";

// ── Implementation pipeline tunables ──────────────────────────────────────────

export function PipelineSettingsSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Implement Ticket Pipeline
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Tunables for the per-stage agents and the build-verify sub-loop.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <NumberPreferenceField
              label="Build-check timeout"
              helper="Per-attempt wall-clock cap on the build command."
              value={prefs.buildCheckTimeoutSecs}
              defaultValue={APP_PREFERENCE_DEFAULTS.buildCheckTimeoutSecs}
              min={10}
              max={1800}
              step={30}
              unit="seconds"
              onChange={(n) => void update("buildCheckTimeoutSecs", n)}
            />
            <NumberPreferenceField
              label="Build-check max attempts"
              helper="Combined build + fix iterations before the pipeline gives up."
              value={prefs.buildCheckMaxAttempts}
              defaultValue={APP_PREFERENCE_DEFAULTS.buildCheckMaxAttempts}
              min={1}
              max={10}
              onChange={(n) => void update("buildCheckMaxAttempts", n)}
            />
            <ToggleRow
              label="Stream partial output into stage panels"
              helper="When on, each stage's structured panel fills in field-by-field as the agent emits JSON. Off renders the whole panel at once when the stage finishes (less busy, slightly later)."
              checked={prefs.streamingPartialsEnabled}
              onChange={(b) => void update("streamingPartialsEnabled", b)}
            />
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// ── PR Review tunables ────────────────────────────────────────────────────────

export function PrReviewSettingsSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          PR Review
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Limits applied when sending PR diffs to the reviewer agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <NumberPreferenceField
            label="Default chunk size (cloud models)"
            helper="Maximum characters per chunk before the workflow splits a large diff into a multi-pass review. Local models stay pinned to 12,000 — the constraint there is the model's context window."
            value={prefs.prReviewDefaultChunkChars}
            defaultValue={APP_PREFERENCE_DEFAULTS.prReviewDefaultChunkChars}
            min={4_000}
            max={200_000}
            step={4_000}
            unit="characters"
            onChange={(n) => void update("prReviewDefaultChunkChars", n)}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// ── Sprint Dashboard tunables ────────────────────────────────────────────────

export function SprintDashboardSettingsSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Sprint Dashboard
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Workload classification thresholds for the per-developer load
          status (Overloaded / Balanced / Underutilised).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <NumberPreferenceField
            label="Overload threshold"
            helper="A developer is flagged Overloaded when their remaining ticket count exceeds this percentage of the team average. The Underutilised threshold is mirrored around 100% (e.g. 140 → > 140% overloaded, < 60% underutilised)."
            value={prefs.workloadOverloadThresholdPct}
            defaultValue={APP_PREFERENCE_DEFAULTS.workloadOverloadThresholdPct}
            min={101}
            max={199}
            step={5}
            unit="% of team avg"
            onChange={(n) => void update("workloadOverloadThresholdPct", n)}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

export function PrTasksPollIntervalSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ListTodo className="h-4 w-4 text-muted-foreground" />
          Tasks panel sync
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          How often the Tasks panel polls Bitbucket for new PR-tasks.
          The panel also refreshes on window focus and when you open it,
          so a longer interval is safe.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <NumberPreferenceField
            label="Poll interval"
            value={prefs.prTasksPollIntervalMinutes}
            defaultValue={APP_PREFERENCE_DEFAULTS.prTasksPollIntervalMinutes}
            min={5}
            max={1440}
            step={15}
            unit="minutes"
            onChange={(n) => void update("prTasksPollIntervalMinutes", n)}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
