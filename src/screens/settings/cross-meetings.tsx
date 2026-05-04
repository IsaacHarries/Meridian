import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_PREFERENCE_DEFAULTS } from "@/lib/appPreferences";
import { getMeetingsIndexStatus, reindexAllMeetings, type MeetingsIndexStatus } from "@/lib/tauri/meetings";
import { probeOllama, type OllamaProbe } from "@/lib/tauri/misc";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppPreferencesEditor } from "./_shared";

export function CrossMeetingsSearchSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  const [status, setStatus] = useState<MeetingsIndexStatus | null>(null);
  const [probe, setProbe] = useState<OllamaProbe | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [draftModel, setDraftModel] = useState<string>("");

  // Keep the input box in sync with the persisted value when the user
  // first opens the screen (or after a successful save).
  useEffect(() => {
    if (prefs?.meetingsEmbeddingModel) {
      setDraftModel(prefs.meetingsEmbeddingModel);
    }
  }, [prefs?.meetingsEmbeddingModel]);

  // Refresh the index counts + Ollama probe on mount and whenever the
  // model changes (so the "X / Y embedded" line reflects the active
  // model's coverage rather than a previous model's).
  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        getMeetingsIndexStatus(),
        probeOllama(prefs?.meetingsEmbeddingModel),
      ]);
      setStatus(s);
      setProbe(p);
    } catch {
      /* probe is best-effort */
    }
  }, [prefs?.meetingsEmbeddingModel]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleSaveModel() {
    const next = draftModel.trim();
    if (!next || next === prefs?.meetingsEmbeddingModel) return;
    await update("meetingsEmbeddingModel", next);
    void refresh();
  }

  async function handleReindex() {
    setReindexing(true);
    try {
      await reindexAllMeetings();
      void refresh();
    } finally {
      setReindexing(false);
    }
  }

  const probeColor =
    probe?.status === "available"
      ? "text-emerald-500"
      : probe?.status === "model_missing"
        ? "text-amber-500"
        : probe?.status === "unreachable"
          ? "text-red-500"
          : "text-muted-foreground";
  const probeLabel =
    probe?.status === "available"
      ? `Ollama ready · ${probe.dimensions ?? "?"} dims`
      : probe?.status === "model_missing"
        ? "Model not installed"
        : probe?.status === "unreachable"
          ? "Ollama not reachable"
          : probe?.status === "not_configured"
            ? "Ollama URL not configured"
            : "Probing…";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          Cross-meetings search
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Indexes every meeting's transcript locally. Keyword search via SQLite
          FTS5 always works; semantic (embedding) search runs against a local
          Ollama model — embeddings backfill in the background whenever Ollama
          is reachable, so you can record meetings with Ollama off and still get
          semantic hits later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Embedding model</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={draftModel}
                  onChange={(e) => setDraftModel(e.target.value)}
                  placeholder={APP_PREFERENCE_DEFAULTS.meetingsEmbeddingModel}
                  className="h-8 text-sm font-mono"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleSaveModel()}
                  disabled={
                    !draftModel.trim() ||
                    draftModel.trim() === prefs.meetingsEmbeddingModel
                  }
                >
                  Save
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Default: <code className="text-foreground">nomic-embed-text</code>.
                Anything Ollama can serve as an embedding model works (e.g.{" "}
                <code className="text-foreground">mxbai-embed-large</code>,{" "}
                <code className="text-foreground">snowflake-arctic-embed</code>).
                Saving a new value clears existing embeddings and re-runs the
                backfill under the new model.
              </p>
            </div>

            <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    probe?.status === "available"
                      ? "bg-emerald-500"
                      : probe?.status === "model_missing"
                        ? "bg-amber-500"
                        : probe?.status === "unreachable"
                          ? "bg-red-500"
                          : "bg-muted-foreground",
                  )}
                />
                <span className={cn("font-medium", probeColor)}>{probeLabel}</span>
                {probe?.message && (
                  <span className="text-muted-foreground">— {probe.message}</span>
                )}
              </div>
              {status && (
                <p className="text-xs text-muted-foreground">
                  {status.embeddedSegments.toLocaleString()} of{" "}
                  {status.totalSegments.toLocaleString()} segments embedded
                  {status.totalSegments > 0 && (
                    <>
                      {" "}({((status.embeddedSegments / status.totalSegments) * 100).toFixed(0)}%)
                    </>
                  )}{" "}
                  · {status.meetingsIndexed.toLocaleString()} meeting
                  {status.meetingsIndexed === 1 ? "" : "s"} indexed
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">
                  Search relevance threshold
                </Label>
                <span className="text-xs font-mono text-muted-foreground">
                  {prefs.meetingsSearchMinScore.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={prefs.meetingsSearchMinScore}
                onChange={(e) =>
                  void update(
                    "meetingsSearchMinScore",
                    Number.parseFloat(e.target.value),
                  )
                }
                className="w-full accent-primary"
              />
              <p className="text-[11px] text-muted-foreground">
                Cosine similarity floor — hits below this score are
                hidden from search results and the chat agent.
                Calibrated for nomic-embed-text on English prose:
                <span className="text-emerald-500"> ≥ 0.70 paraphrase</span>{" "}
                ·
                <span className="text-yellow-500"> ≥ 0.55 likely relevant</span>{" "}
                ·
                <span className="text-orange-500"> ≥ 0.45 loosely related</span>{" "}
                ·
                <span className="text-red-500"> &lt; 0.45 noise</span>.
                Default: {APP_PREFERENCE_DEFAULTS.meetingsSearchMinScore.toFixed(2)}.
                Raise to be stricter; lower for broader recall.
              </p>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleReindex()}
              disabled={reindexing}
            >
              {reindexing ? "Reindexing…" : "Reindex all meetings"}
            </Button>
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
