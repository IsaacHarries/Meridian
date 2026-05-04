import { useState, useEffect } from "react";
import { useTimeTrackingStore } from "@/stores/timeTrackingStore";
import {
  MIN_IDLE_THRESHOLD_MIN,
  MAX_IDLE_THRESHOLD_MIN,
} from "@/lib/timeTracking";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function TimeTrackingSection() {
  const settings = useTimeTrackingStore((s) => s.settings);
  const setIdleFallbackEnabled = useTimeTrackingStore(
    (s) => s.setIdleFallbackEnabled,
  );
  const setIdleThresholdMin = useTimeTrackingStore(
    (s) => s.setIdleThresholdMin,
  );
  const setDailyTargetHours = useTimeTrackingStore(
    (s) => s.setDailyTargetHours,
  );
  const setChipHiddenInHeader = useTimeTrackingStore(
    (s) => s.setChipHiddenInHeader,
  );
  const setTrackingEnabled = useTimeTrackingStore((s) => s.setTrackingEnabled);

  // Local mirror of the threshold so users can type freely without each
  // keystroke clamping mid-edit. The actual store value is updated on blur.
  const [thresholdDraft, setThresholdDraft] = useState(
    String(settings.idleThresholdMin),
  );
  const [targetDraft, setTargetDraft] = useState(
    String(settings.dailyTargetHours),
  );

  // Resync drafts if the store changes via another path (e.g. a future
  // import/export). Comparing to the source of truth avoids stuck stale
  // drafts after store-side normalisation.
  useEffect(() => {
    setThresholdDraft(String(settings.idleThresholdMin));
  }, [settings.idleThresholdMin]);
  useEffect(() => {
    setTargetDraft(String(settings.dailyTargetHours));
  }, [settings.dailyTargetHours]);

  function commitThreshold() {
    const parsed = Number.parseInt(thresholdDraft, 10);
    if (Number.isFinite(parsed)) setIdleThresholdMin(parsed);
    else setThresholdDraft(String(settings.idleThresholdMin));
  }
  function commitTarget() {
    const parsed = Number.parseFloat(targetDraft);
    if (Number.isFinite(parsed) && parsed > 0) setDailyTargetHours(parsed);
    else setTargetDraft(String(settings.dailyTargetHours));
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Work Hours Tracking</CardTitle>
        <CardDescription>
          Tracks how long you've worked today by listening for screen lock,
          sleep, and idle. Anything beyond your daily target is banked toward a
          running overtime balance you can cash in later in the week.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="time-tracking-enabled" className="font-normal">
              Enable time tracking
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Master switch. When off, no new segments are recorded and the
              header chip disappears. Existing history is preserved.
            </p>
          </div>
          <Switch
            id="time-tracking-enabled"
            checked={settings.trackingEnabled}
            onCheckedChange={setTrackingEnabled}
          />
        </div>
        {/* The remaining controls are only meaningful while tracking is on,
            so dim them visually when it's off — but keep them mounted so
            the user can pre-configure before flipping the master back on. */}
        <div
          className={`space-y-5 border-t pt-4 ${
            settings.trackingEnabled ? "" : "opacity-50 pointer-events-none"
          }`}
          aria-disabled={!settings.trackingEnabled}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="time-tracking-target" className="font-normal">
                Daily target (hours)
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                How long counts as a full day's work.
              </p>
            </div>
            <Input
              id="time-tracking-target"
              type="number"
              min={0.5}
              max={24}
              step={0.5}
              value={targetDraft}
              onChange={(e) => setTargetDraft(e.target.value)}
              onBlur={commitTarget}
              className="w-24 text-right"
            />
          </div>
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <div className="min-w-0">
              <Label
                htmlFor="time-tracking-chip-visible"
                className="font-normal"
              >
                Show stopwatch in header
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                The compact "today / target" chip in the top bar. Hide it from
                its own popover; flip back on here or in the Time Tracking
                workflow.
              </p>
            </div>
            <Switch
              id="time-tracking-chip-visible"
              checked={!settings.chipHiddenInHeader}
              onCheckedChange={(checked) => setChipHiddenInHeader(!checked)}
            />
          </div>
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <div className="min-w-0">
              <Label
                htmlFor="time-tracking-idle-enabled"
                className="font-normal"
              >
                Pause on idle
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Stop tracking when there's been no keyboard or mouse activity
                for the threshold below. Disable if long builds frequently keep
                you at your desk without input.
              </p>
            </div>
            <Switch
              id="time-tracking-idle-enabled"
              checked={settings.idleFallbackEnabled}
              onCheckedChange={setIdleFallbackEnabled}
            />
          </div>
          {settings.idleFallbackEnabled && (
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label
                  htmlFor="time-tracking-idle-threshold"
                  className="font-normal"
                >
                  Idle threshold (minutes)
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Between {MIN_IDLE_THRESHOLD_MIN} and {MAX_IDLE_THRESHOLD_MIN}.
                </p>
              </div>
              <Input
                id="time-tracking-idle-threshold"
                type="number"
                min={MIN_IDLE_THRESHOLD_MIN}
                max={MAX_IDLE_THRESHOLD_MIN}
                step={1}
                value={thresholdDraft}
                onChange={(e) => setThresholdDraft(e.target.value)}
                onBlur={commitThreshold}
                className="w-24 text-right"
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
