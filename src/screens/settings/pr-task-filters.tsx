import { useState, useEffect } from "react";
import { Filter, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type PrTaskFilter,
  type PrTaskFilterMode,
  getPrTaskFilters,
  setPrTaskFilters,
  newFilterId,
} from "@/lib/prTaskFilters";
import { usePrTasksStore } from "@/stores/prTasksStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const FILTER_MODE_LABELS: Record<PrTaskFilterMode, string> = {
  substring: "Contains",
  starts_with: "Starts with",
  ends_with: "Ends with",
  regex: "Regex",
};

export function PrTaskFiltersSection() {
  const filters = usePrTasksStore((s) => s.filters);
  const setStoreFilters = usePrTasksStore((s) => s.setFilters);
  const [loaded, setLoaded] = useState(false);
  const [savingErr, setSavingErr] = useState<string | null>(null);

  // Pull persisted filters once; the store's hydrateFilters runs at app
  // startup but mounting Settings before that finishes is possible
  // (e.g. when navigating from a deep link). Re-hydrate here so the
  // section reflects on-disk truth even if the store is empty.
  useEffect(() => {
    let alive = true;
    void getPrTaskFilters().then((f) => {
      if (!alive) return;
      // Only seed the store if it's empty — otherwise the store may
      // already hold a more recent in-memory edit.
      if (usePrTasksStore.getState().filters.length === 0 && f.length > 0) {
        setStoreFilters(f);
      }
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [setStoreFilters]);

  async function commit(next: PrTaskFilter[]) {
    setStoreFilters(next);
    try {
      await setPrTaskFilters(next);
      setSavingErr(null);
    } catch (e) {
      setSavingErr(e instanceof Error ? e.message : String(e));
    }
  }

  function addRule() {
    void commit([
      ...filters,
      {
        id: newFilterId(),
        pattern: "",
        mode: "substring",
        caseInsensitive: true,
        enabled: true,
      },
    ]);
  }

  function updateRule(id: string, patch: Partial<PrTaskFilter>) {
    const next = filters.map((f) => (f.id === id ? { ...f, ...patch } : f));
    void commit(next);
  }

  function removeRule(id: string) {
    void commit(filters.filter((f) => f.id !== id));
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              PR Task Filters
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Hide PR-tasks from the Tasks panel whose text matches any of
              these rules. A task is hidden if any enabled rule matches.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!loaded ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : filters.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No filters yet — every unresolved PR-task on your authored PRs
            shows up in the Tasks panel.
          </p>
        ) : (
          <div className="space-y-2">
            {filters.map((f) => (
              <PrTaskFilterRow
                key={f.id}
                filter={f}
                onChange={(patch) => updateRule(f.id, patch)}
                onRemove={() => removeRule(f.id)}
              />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={addRule}
          >
            <Plus className="h-3.5 w-3.5" />
            Add rule
          </Button>
          {savingErr && (
            <span className="text-xs text-destructive">{savingErr}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PrTaskFilterRow({
  filter,
  onChange,
  onRemove,
}: {
  filter: PrTaskFilter;
  onChange: (patch: Partial<PrTaskFilter>) => void;
  onRemove: () => void;
}) {
  // For regex rules, surface a parse error inline so a typo is obvious
  // before the user wonders why nothing's being filtered.
  let regexError: string | null = null;
  if (filter.mode === "regex" && filter.pattern) {
    try {
      new RegExp(filter.pattern);
    } catch (e) {
      regexError = e instanceof Error ? e.message : String(e);
    }
  }
  return (
    <div
      className={cn(
        "rounded-md border bg-muted/20 p-2 space-y-2",
        !filter.enabled && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <select
          value={filter.mode}
          onChange={(e) =>
            onChange({ mode: e.target.value as PrTaskFilterMode })
          }
          className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-none"
          aria-label="Match mode"
        >
          {(Object.keys(FILTER_MODE_LABELS) as PrTaskFilterMode[]).map((m) => (
            <option key={m} value={m}>
              {FILTER_MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <Input
          value={filter.pattern}
          onChange={(e) => onChange({ pattern: e.target.value })}
          placeholder={
            filter.mode === "regex"
              ? "^Verify .* deployed$"
              : "Verify deploy"
          }
          className="h-8 text-sm flex-1"
          spellCheck={false}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label="Remove rule"
          title="Remove rule"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-4 px-1 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-muted-foreground">
          <input
            type="checkbox"
            checked={filter.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            className="h-3 w-3 cursor-pointer"
          />
          Enabled
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-muted-foreground">
          <input
            type="checkbox"
            checked={filter.caseInsensitive}
            onChange={(e) => onChange({ caseInsensitive: e.target.checked })}
            className="h-3 w-3 cursor-pointer"
          />
          Case-insensitive
        </label>
      </div>
      {regexError && (
        <p className="text-xs text-destructive px-1">
          Invalid regex: {regexError}
        </p>
      )}
    </div>
  );
}
