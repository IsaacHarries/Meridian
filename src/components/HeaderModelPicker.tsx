import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cpu, Loader2, Lock, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useAiSelectionStore,
  type AiProvider,
  type PanelId,
  type StageId,
  PROVIDER_LABELS,
  STAGE_LABELS,
  PANEL_LABELS,
} from "@/stores/aiSelectionStore";

const PROVIDER_OPTIONS: AiProvider[] = ["claude", "gemini", "copilot", "local"];

type Scope = "stage" | "panel";

export function HeaderModelPicker({
  panel,
  stage,
  className,
}: {
  panel: PanelId;
  stage?: StageId | null;
  className?: string;
}) {
  const hydrated = useAiSelectionStore((s) => s.hydrated);
  const hydrate = useAiSelectionStore((s) => s.hydrate);
  const refresh = useAiSelectionStore((s) => s.refreshFromPrefs);
  const loadModels = useAiSelectionStore((s) => s.loadModels);
  const setPanelOverride = useAiSelectionStore((s) => s.setPanelOverride);
  const setStageOverride = useAiSelectionStore((s) => s.setStageOverride);
  const modelsByProvider = useAiSelectionStore((s) => s.modelsByProvider);
  const modelsLoading = useAiSelectionStore((s) => s.modelsLoading);
  const stageOverrides = useAiSelectionStore((s) => s.stageOverrides);
  const resolve = useAiSelectionStore((s) => s.resolve);

  // Re-render whenever any selection-relevant slice changes.
  useAiSelectionStore((s) => s.priority);
  useAiSelectionStore((s) => s.panelOverrides);
  useAiSelectionStore((s) => s.stageOverrides);
  useAiSelectionStore((s) => s.providerDefaultModel);

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );

  const stageScopable = panel === "implement_ticket" && !!stage;
  const [scope, setScope] = useState<Scope>(
    stageScopable ? "stage" : "panel",
  );

  useEffect(() => {
    setScope(stageScopable ? "stage" : "panel");
  }, [stageScopable, stage]);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useLayoutEffect(() => {
    if (!open) return;
    function reposition() {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      setAnchor({ top: r.bottom + 8, right: window.innerWidth - r.right });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const resolved = resolve(panel, stage ?? undefined);
  const stageHasOverride = stage ? !!stageOverrides[stage] : false;

  // The provider currently shown in the picker body. When locked, always the
  // locked provider. Otherwise, the resolved one (or the first option).
  const [draftProvider, setDraftProvider] = useState<AiProvider>(
    resolved.provider,
  );

  useEffect(() => {
    setDraftProvider(resolved.provider);
  }, [open, resolved.provider]);

  useEffect(() => {
    if (!open) return;
    void loadModels(draftProvider);
  }, [open, draftProvider, loadModels]);

  const models = modelsByProvider[draftProvider] ?? [];
  const loadingModels = !!modelsLoading[draftProvider];

  async function selectModel(modelId: string) {
    if (resolved.locked) {
      // Locked: write override on the locked provider only.
      const value = { provider: resolved.provider, model: modelId };
      if (scope === "stage" && stage) {
        await setStageOverride(stage, value);
      } else {
        await setPanelOverride(panel, value);
      }
    } else {
      const value = { provider: draftProvider, model: modelId };
      if (scope === "stage" && stage) {
        await setStageOverride(stage, value);
      } else {
        await setPanelOverride(panel, value);
      }
    }
    setOpen(false);
  }

  async function clearStageOverride() {
    if (!stage) return;
    await setStageOverride(stage, null);
  }

  const buttonLabel = (() => {
    if (!resolved.model) return PROVIDER_LABELS[resolved.provider];
    const list = modelsByProvider[resolved.provider] ?? [];
    const display = list.find((m) => m[0] === resolved.model)?.[1];
    return display || resolved.model;
  })();

  return (
    <div className={cn("relative", className)}>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title={
          resolved.locked
            ? `Locked to ${PROVIDER_LABELS[resolved.provider]} via Settings → AI Provider Priority`
            : "Change AI provider/model for this panel"
        }
        className="h-9 gap-1.5 px-2.5"
      >
        {resolved.locked ? (
          <Lock className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="text-[11px] font-medium leading-tight">
          {PROVIDER_LABELS[resolved.provider]}
        </span>
        <span className="text-[11px] text-muted-foreground leading-tight max-w-[120px] truncate">
          {buttonLabel}
        </span>
      </Button>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            style={{
              position: "fixed",
              top: anchor.top,
              right: anchor.right,
              zIndex: 100,
            }}
            className="w-80 rounded-lg border bg-popover text-popover-foreground shadow-lg"
          >
            <div className="px-3 py-2.5 border-b">
              <p className="text-xs font-semibold">
                {PANEL_LABELS[panel]}
                {stage ? ` · ${STAGE_LABELS[stage]}` : ""}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {resolved.locked
                  ? `Locked to ${PROVIDER_LABELS[resolved.provider]} — change priority in Settings to switch provider.`
                  : resolved.source === "stage"
                    ? "Using stage override."
                    : resolved.source === "panel"
                      ? "Using panel override."
                      : "Using default fallback order."}
              </p>
            </div>

            {stageScopable && (
              <div className="px-3 pt-2.5 pb-2 border-b">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
                  Apply selection to
                </p>
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    className={cn(
                      "rounded px-2 py-1.5 text-xs",
                      scope === "stage"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted hover:bg-muted/70",
                    )}
                    onClick={() => setScope("stage")}
                  >
                    This stage
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded px-2 py-1.5 text-xs",
                      scope === "panel"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted hover:bg-muted/70",
                    )}
                    onClick={() => setScope("panel")}
                  >
                    Whole panel
                  </button>
                </div>
              </div>
            )}

            {!resolved.locked && (
              <div className="px-3 pt-2.5 pb-2 border-b">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
                  Provider
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {PROVIDER_OPTIONS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={cn(
                        "rounded px-2 py-1.5 text-xs",
                        draftProvider === p
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted hover:bg-muted/70",
                      )}
                      onClick={() => setDraftProvider(p)}
                    >
                      {PROVIDER_LABELS[p]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="px-3 pt-2.5 pb-2.5">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
                Model
              </p>
              {loadingModels ? (
                <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                  Loading models…
                </div>
              ) : models.length === 0 ? (
                <p className="py-3 text-xs text-muted-foreground">
                  No models available for{" "}
                  {PROVIDER_LABELS[draftProvider]}. Configure it in Settings.
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto space-y-0.5">
                  {models.map(([id, label]) => {
                    const active =
                      resolved.provider === draftProvider &&
                      resolved.model === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        className={cn(
                          "w-full rounded px-2 py-1.5 text-left text-xs",
                          active
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-muted/70",
                        )}
                        onClick={() => void selectModel(id)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {stageHasOverride && stage && (
              <button
                type="button"
                onClick={() => void clearStageOverride()}
                className="w-full px-3 py-2 border-t text-xs text-muted-foreground hover:bg-muted/60 flex items-center justify-center gap-1.5 rounded-b-lg"
              >
                <RotateCcw className="h-3 w-3" />
                Reset stage to panel default
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
