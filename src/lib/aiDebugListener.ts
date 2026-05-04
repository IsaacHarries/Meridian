/**
 * Boot-time subscriber to the `ai-traffic-event` Tauri event.
 *
 * Listens once at app start and pipes every event into the in-memory
 * debug ring buffer. The toggle in Settings (`aiDebugEnabled`) is
 * already enforced sidecar-side — when off, the sidecar doesn't emit
 * traffic events, so this listener is a no-op for the cost of the
 * single Tauri event subscription.
 *
 * Concurrency guard: React 18 StrictMode mounts effects twice in dev
 * (mount → cleanup → mount). If both invocations of
 * `startAiDebugListener` checked a `null` slot before either of their
 * `await listen()` calls settled, both would race past the guard and
 * register a listener — the second resolution would just overwrite
 * the slot, leaking the first listener and producing duplicate events
 * forever after. We hold the in-flight promises in module-level slots
 * synchronously so subsequent callers await the same registration
 * instead of starting a second one.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAiDebugStore, type AiTrafficEvent } from "@/stores/aiDebugStore";
import { openAiDebugWindow } from "@/lib/aiDebugWindow";

let trafficListener: Promise<UnlistenFn> | null = null;
let menuListener: Promise<UnlistenFn> | null = null;

export async function startAiDebugListener(): Promise<void> {
  if (!trafficListener) {
    trafficListener = listen<AiTrafficEvent>("ai-traffic-event", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return;
      useAiDebugStore.getState().pushEvent(payload);
    });
  }

  if (!menuListener) {
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
    menuListener = listen<string>("menu-action", (event) => {
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

  // Await both so any caller that needs the listeners ready (tests,
  // teardown helpers) can rely on the returned promise.
  await Promise.all([trafficListener, menuListener]);
}

export async function stopAiDebugListener(): Promise<void> {
  if (trafficListener) {
    const handle = await trafficListener;
    handle();
    trafficListener = null;
  }
  if (menuListener) {
    const handle = await menuListener;
    handle();
    menuListener = null;
  }
}
