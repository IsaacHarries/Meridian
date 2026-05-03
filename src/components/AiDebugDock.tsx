/**
 * Layout shell that hosts the `AiDebugPanel` in one of four slots:
 *
 *   - "bottom" / "right" / "left": split off a strip from the main
 *     window for the panel, with a draggable divider.
 *   - "window": pop the panel out into its own Tauri WebviewWindow
 *     so the user can drag it to a second monitor.
 *   - "hidden": panel is collapsed to a small floating button.
 *
 * The dock mode is persisted in `aiDebugStore` (mirroring the
 * preference in `appPreferences`). Dragging the divider is purely
 * in-memory — sticking the size to the user's last drag is a future
 * polish and not load-bearing for the core debug workflow.
 *
 * Children are rendered inside the "main" slot; the panel sits on the
 * configured edge. When dock mode is "window" or "hidden", children
 * fill the entire viewport and the panel is rendered elsewhere (the
 * popped-out window owns its own copy; the hidden mode shows a small
 * pill the user can click to re-dock).
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

  // The panel is hidden in two cases:
  //   - dockMode === "hidden": user explicitly closed it; reveal via the
  //     View → AI Debug Panel native menu (shortcut Cmd/Ctrl+Shift+D).
  //   - dockMode === "window": panel lives in the popped-out window.
  // In both cases the main window just renders its children unmodified.
  if (dockMode === "hidden" || dockMode === "window") {
    return <>{children}</>;
  }

  return (
    <DockSplit
      orientation={dockMode}
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
  orientation: "bottom" | "right" | "left";
  panelSize: number;
  onPanelSizeChange: (px: number) => void;
  panelSlot: React.ReactNode;
  children: React.ReactNode;
}) {
  const draggingRef = useRef(false);
  const startRef = useRef({ pos: 0, size: 0 });

  const onDividerDown = (e: React.MouseEvent) => {
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

  const containerStyle = useMemo<React.CSSProperties>(() => {
    if (orientation === "bottom") {
      return {
        display: "grid",
        gridTemplateRows: `1fr 4px ${panelSize}px`,
        height: "100vh",
        width: "100vw",
      };
    }
    if (orientation === "right") {
      return {
        display: "grid",
        gridTemplateColumns: `1fr 4px ${panelSize}px`,
        height: "100vh",
        width: "100vw",
      };
    }
    return {
      display: "grid",
      gridTemplateColumns: `${panelSize}px 4px 1fr`,
      height: "100vh",
      width: "100vw",
    };
  }, [orientation, panelSize]);

  const dividerStyle: React.CSSProperties = {
    cursor: orientation === "bottom" ? "ns-resize" : "ew-resize",
    background: "var(--border)",
  };

  if (orientation === "bottom") {
    return (
      <div style={containerStyle}>
        <div className="overflow-hidden">{children}</div>
        <div onMouseDown={onDividerDown} style={dividerStyle} />
        <div className="overflow-hidden">{panelSlot}</div>
      </div>
    );
  }
  if (orientation === "right") {
    return (
      <div style={containerStyle}>
        <div className="overflow-hidden">{children}</div>
        <div onMouseDown={onDividerDown} style={dividerStyle} />
        <div className="overflow-hidden">{panelSlot}</div>
      </div>
    );
  }
  return (
    <div style={containerStyle}>
      <div className="overflow-hidden">{panelSlot}</div>
      <div onMouseDown={onDividerDown} style={dividerStyle} />
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}
