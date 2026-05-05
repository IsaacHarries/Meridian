/**
 * Layout shell that hosts the `AiDebugPanel` in one of four slots:
 *
 *   - "bottom" / "right" / "left": split off a strip from the main
 *     window for the panel, with a draggable divider.
 *   - "window": pop the panel out into its own Tauri WebviewWindow
 *     so the user can drag it to a second monitor.
 *   - "hidden": panel is collapsed away; main app fills the viewport.
 *
 * Critical: the children (the entire app) must NOT unmount when the
 * dock mode changes. We always render the same outer `<div>` wrapper
 * with children at a stable JSX position (gridArea: "main"); the
 * panel and divider are conditionally rendered as siblings. React
 * preserves the children subtree across mode toggles, so workflow
 * state and the current screen survive a Cmd-Shift-D press.
 */

import { useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useAiDebugStore } from "@/stores/aiDebugStore";
import type { AiDebugDockMode } from "@/lib/appPreferences";
import { AiDebugPanel } from "@/components/AiDebugPanel";
import { openAiDebugWindow, closeAiDebugWindow } from "@/lib/aiDebugWindow";

export function AiDebugDock({ children }: { children: React.ReactNode }) {
  const dockMode = useAiDebugStore((s) => s.dockMode);
  const setDockMode = useAiDebugStore((s) => s.setDockMode);
  const panelSize = useAiDebugStore((s) => s.panelSize);
  const setPanelSize = useAiDebugStore((s) => s.setPanelSize);

  // Toggle the popped-out window when the dock mode changes to/from
  // "window". The window subscribes to the same store, so it stays in
  // sync with the main pane's enable/clear actions automatically.
  useEffect(() => {
    if (dockMode === "window") {
      void openAiDebugWindow();
    } else {
      void closeAiDebugWindow();
    }
  }, [dockMode]);

  // The inline panel only renders for the three split modes. For
  // "hidden" and "window" we still render the wrapper (so children stay
  // mounted) but pass `orientation = null` to skip the panel slot.
  const splitOrientation: "bottom" | "right" | "left" | null =
    dockMode === "hidden" || dockMode === "window" ? null : dockMode;

  return (
    <DockSplit
      orientation={splitOrientation}
      panelSize={panelSize}
      onPanelSizeChange={setPanelSize}
      panelSlot={
        <AiDebugPanel
          onClose={() => void setDockMode("hidden")}
          controls={<DockModePicker mode={dockMode} setMode={setDockMode} />}
        />
      }
    >
      {children}
    </DockSplit>
  );
}

function DockModePicker({
  mode,
  setMode,
}: {
  mode: AiDebugDockMode;
  setMode: (m: AiDebugDockMode) => Promise<void>;
}) {
  const opts: { mode: AiDebugDockMode; label: string }[] = [
    { mode: "bottom", label: "↓" },
    { mode: "right", label: "→" },
    { mode: "left", label: "←" },
    { mode: "window", label: "⧉" },
  ];
  return (
    <div className="flex items-center gap-0.5">
      {opts.map((opt) => (
        <Button
          key={opt.mode}
          variant={mode === opt.mode ? "default" : "ghost"}
          size="icon"
          className="h-7 w-7 text-[11px]"
          onClick={() => void setMode(opt.mode)}
          title={`Dock ${opt.mode}`}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

function DockSplit({
  orientation,
  panelSize,
  onPanelSizeChange,
  panelSlot,
  children,
}: {
  orientation: "bottom" | "right" | "left" | null;
  panelSize: number;
  onPanelSizeChange: (px: number) => void;
  panelSlot: React.ReactNode;
  children: React.ReactNode;
}) {
  const draggingRef = useRef(false);
  const startRef = useRef({ pos: 0, size: 0 });

  const onDividerDown = (e: React.MouseEvent) => {
    if (!orientation) return;
    e.preventDefault();
    draggingRef.current = true;
    startRef.current = {
      pos: orientation === "bottom" ? e.clientY : e.clientX,
      size: panelSize,
    };
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const cur = orientation === "bottom" ? ev.clientY : ev.clientX;
      const delta = cur - startRef.current.pos;
      // Bottom dock: dragging up grows the panel, so subtract.
      // Right dock: dragging left grows the panel, so subtract too.
      // Left dock: dragging right grows the panel, so add.
      const sign = orientation === "left" ? 1 : -1;
      const next = startRef.current.size + sign * delta;
      onPanelSizeChange(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Single grid layout, parameterised by orientation. Named grid areas
  // ("main" / "divider" / "panel") let us keep the children div at a
  // STABLE JSX position regardless of mode — switching modes only
  // changes CSS, never the React tree, so children never unmount.
  const containerStyle = useMemo<React.CSSProperties>(() => {
    const base: React.CSSProperties = {
      display: "grid",
      height: "100dvh",
      width: "100vw",
    };
    if (!orientation) {
      return {
        ...base,
        gridTemplateRows: "1fr",
        gridTemplateColumns: "1fr",
        gridTemplateAreas: '"main"',
      };
    }
    if (orientation === "bottom") {
      return {
        ...base,
        gridTemplateColumns: "1fr",
        gridTemplateRows: `1fr 4px ${panelSize}px`,
        gridTemplateAreas: '"main" "divider" "panel"',
      };
    }
    if (orientation === "right") {
      return {
        ...base,
        gridTemplateRows: "1fr",
        gridTemplateColumns: `1fr 4px ${panelSize}px`,
        gridTemplateAreas: '"main divider panel"',
      };
    }
    return {
      ...base,
      gridTemplateRows: "1fr",
      gridTemplateColumns: `${panelSize}px 4px 1fr`,
      gridTemplateAreas: '"panel divider main"',
    };
  }, [orientation, panelSize]);

  const dividerStyle: React.CSSProperties = orientation
    ? {
        gridArea: "divider",
        cursor: orientation === "bottom" ? "ns-resize" : "ew-resize",
        background: "var(--border)",
      }
    : {};

  return (
    <div style={containerStyle}>
      {/*
        Children always live in this single div at this single JSX position.
        `min-h-0 min-w-0` lets the grid track size it correctly; `overflow-y-auto`
        is the safety net for screens that use `min-h-screen` (which would
        otherwise overflow the smaller grid track when a dock is active).
        Screens that already use `h-full` / `h-dvh` fit exactly and the
        scrollbar never appears.
      */}
      <div
        style={{ gridArea: "main" }}
        className="min-h-0 min-w-0 overflow-y-auto"
      >
        {children}
      </div>
      {orientation && (
        <>
          <div onMouseDown={onDividerDown} style={dividerStyle} />
          <div
            style={{ gridArea: "panel" }}
            className="min-h-0 min-w-0 overflow-hidden"
          >
            {panelSlot}
          </div>
        </>
      )}
    </div>
  );
}
