/**
 * Boot-time subscriber to the `ai-traffic-event` Tauri event.
 *
 * Listens once at app start and pipes every event into the in-memory
 * debug ring buffer. The toggle in Settings (`aiDebugEnabled`) is
 * already enforced sidecar-side — when off, the sidecar doesn't emit
 * traffic events, so this listener is a no-op for the cost of the
 * single Tauri event subscription.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAiDebugStore, type AiTrafficEvent } from "@/stores/aiDebugStore";
import { openAiDebugWindow } from "@/lib/aiDebugWindow";

let unlistenTraffic: UnlistenFn | null = null;
let unlistenMenu: UnlistenFn | null = null;

export async function startAiDebugListener(): Promise<void> {
  if (!unlistenTraffic) {
    unlistenTraffic = await listen<AiTrafficEvent>(
      "ai-traffic-event",
      (event) => {
        const payload = event.payload;
        if (!payload || typeof payload !== "object") return;
        useAiDebugStore.getState().pushEvent(payload);
      },
    );
  }

  if (!unlistenMenu) {
    // Native menu integration: View → AI Debug Panel
    // (CmdOrCtrl+Shift+D). The action depends on the current dock mode:
    //
    //   - "window": the panel is in its own popped-out window. The user
    //     hit the shortcut because that window is buried — bring it
    //     forward via show() + setFocus() rather than toggling it to
    //     hidden (which would close it and discard the layout the user
    //     deliberately picked).
    //   - "hidden": restore the panel to whichever dock mode the user
    //     last had visible.
    //   - bottom/right/left: hide the panel.
    unlistenMenu = await listen<string>("menu-action", (event) => {
      if (event.payload !== "ai_debug_toggle") return;
      const store = useAiDebugStore.getState();
      const prevMode = store.dockMode;
      if (prevMode === "window") {
        // openAiDebugWindow is a no-op-ish for an existing label —
        // it calls show() + setFocus() and returns. Spawns a new
        // window only if the user closed it via the OS chrome.
        void openAiDebugWindow();
        return;
      }
      if (prevMode === "hidden") {
        void store.setDockMode(store.lastVisibleDockMode);
      } else {
        void store.setDockMode("hidden");
      }
    });
  }
}

export async function stopAiDebugListener(): Promise<void> {
  if (unlistenTraffic) {
    unlistenTraffic();
    unlistenTraffic = null;
  }
  if (unlistenMenu) {
    unlistenMenu();
    unlistenMenu = null;
  }
}
