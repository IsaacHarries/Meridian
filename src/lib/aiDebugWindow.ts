/**
 * Helpers for the popped-out AI debug window.
 *
 * Tauri lets us spawn an extra `WebviewWindow` pointing at the same
 * frontend URL — we pass `?aidebug=1` so `Root.tsx` can detect the
 * popped-out instance at boot and render only the debug panel
 * (skipping the main app shell). The popped-out window subscribes to
 * the same Tauri event channel and zustand stores, so capture, clear,
 * and dock-mode changes are mirrored across both windows.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const AI_DEBUG_WINDOW_LABEL = "ai-debug";
export const AI_DEBUG_QUERY_PARAM = "aidebug";

export function isAiDebugWindow(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get(AI_DEBUG_QUERY_PARAM) === "1";
}

export async function openAiDebugWindow(): Promise<void> {
  // If a window with this label already exists, focus it instead of
  // spawning a duplicate. WebviewWindow.getByLabel returns null when
  // the label isn't registered.
  const existing = await WebviewWindow.getByLabel(AI_DEBUG_WINDOW_LABEL);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  const baseUrl = window.location.origin + window.location.pathname;
  const url = `${baseUrl}?${AI_DEBUG_QUERY_PARAM}=1`;
  // Reasonable defaults for a tool window — half the laptop screen,
  // resizable, no requirement that the main window be focused.
  const w = new WebviewWindow(AI_DEBUG_WINDOW_LABEL, {
    url,
    title: "Meridian — AI Debug",
    width: 720,
    height: 720,
    resizable: true,
  });
  // The constructor returns synchronously and dispatches the actual
  // create over IPC. Failures (missing capability grant, label clash,
  // OS rejection) come back via the `tauri://error` event — listen
  // for it so the user sees a console error rather than the button
  // appearing to do nothing.
  w.once("tauri://error", (event) => {
    console.error(
      `[ai-debug] failed to open popped-out window: ${JSON.stringify(event.payload)}`,
    );
  });
  await w.once("tauri://created", () => {
    /* spawn confirmed */
  });
}

export async function closeAiDebugWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(AI_DEBUG_WINDOW_LABEL);
  if (existing) await existing.close();
}
