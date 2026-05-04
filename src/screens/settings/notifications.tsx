import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToggleRow, useAppPreferencesEditor } from "./_shared";

export function NotificationsSettingsSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          Notifications & Token Budget
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Optional in-app alerts and a soft daily cap on cumulative LLM
          token usage. The token budget only surfaces a toast — it does
          not block agent runs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <ToggleRow
              label="Toast when a new PR-task is detected"
              helper="Triggered by the Tasks-panel poller when a teammate adds a task to one of your authored PRs."
              checked={prefs.notifyPrTaskAdded}
              onChange={(b) => void update("notifyPrTaskAdded", b)}
            />
            <ToggleRow
              label="Toast when an agent finishes a stage"
              helper="Fires on every interrupt the implement-ticket pipeline emits — useful when you've stepped away mid-run."
              checked={prefs.notifyAgentStageComplete}
              onChange={(b) => void update("notifyAgentStageComplete", b)}
            />
            <div className="space-y-1">
              <Label className="text-sm font-medium">Daily token budget</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={prefs.dailyTokenBudget ?? ""}
                  placeholder="Off"
                  min={1}
                  step={10_000}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === "") {
                      void update("dailyTokenBudget", null);
                      return;
                    }
                    const n = Number.parseInt(raw, 10);
                    if (Number.isFinite(n) && n > 0) {
                      void update("dailyTokenBudget", n);
                    }
                  }}
                  className="h-8 w-40 text-sm"
                />
                <span className="text-xs text-muted-foreground">tokens / day</span>
                {prefs.dailyTokenBudget !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => void update("dailyTokenBudget", null)}
                    title="Disable budget"
                  >
                    Off
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Surfaces a one-time toast when cumulative tokens for the
                local day exceed this value. Leave empty to disable.
              </p>
            </div>
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
