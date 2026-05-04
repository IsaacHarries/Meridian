import { AiDebugDock } from "@/components/AiDebugDock";
import { AiDebugPanel } from "@/components/AiDebugPanel";
import { TasksPanel } from "@/components/TasksPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OpenMeetingsProvider } from "@/context/OpenMeetingsContext";
import { OpenSettingsProvider } from "@/context/OpenSettingsContext";
import { OpenTimeTrackingProvider } from "@/context/OpenTimeTrackingContext";
import { PreviewOnboardingProvider } from "@/context/PreviewOnboardingContext";
import { RecordingContextTagsProvider } from "@/context/RecordingContextTagsContext";
import { startAiDebugListener } from "@/lib/aiDebugListener";
import { isAiDebugWindow } from "@/lib/aiDebugWindow";
import { APP_PREFERENCE_DEFAULTS, getAppPreferences } from "@/lib/appPreferences";
import { BackgroundRenderer, getBackgroundId, useBgChangeListener } from "@/lib/backgrounds/_registry";
import { startRateLimitListener } from "@/lib/rateLimitListener";
import { clearAllEffects, fireBlackHole, fireComet, fireMeteorShower, firePulsar, fireShootingStar, fireWormhole, getBhGravityEnabled, getSpaceEffectKindToggles, setEffectsEnabled, SPACE_FX_BH_GRAVITY_EVENT, SPACE_FX_TOGGLES_EVENT, toggleBhGravityEnabled, toggleSpaceEffectKind, type SpaceEffectKind } from "@/lib/spaceEffects/_shared";
import { SpaceEffectsOverlay } from "@/lib/spaceEffects/overlay";
import { setLocalLlmUrlCache } from "@/lib/tauri/core";
import { bitbucketComplete, credentialStatusComplete, getCredentialStatus, getNonSecretConfig, jiraComplete, type CredentialStatus } from "@/lib/tauri/credentials";
import { setRuntimeOverloadPct } from "@/lib/workloadClassifier";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { AddressPrCommentsScreen } from "@/screens/AddressPrCommentsScreen";
import { AgentSkillsScreen } from "@/screens/AgentSkillsScreen";
import { GroomTicketScreen } from "@/screens/GroomTicketScreen";
import { ImplementTicketScreen } from "@/screens/ImplementTicketScreen";
import { LandingScreen } from "@/screens/LandingScreen";
import { MeetingsScreen } from "@/screens/MeetingsScreen";
import { OnboardingScreen } from "@/screens/OnboardingScreen";
import { PrReviewScreen } from "@/screens/PrReviewScreen";
import { RetrospectivesScreen } from "@/screens/RetrospectivesScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { SprintDashboardScreen } from "@/screens/SprintDashboardScreen";
import { TimeTrackingScreen } from "@/screens/TimeTrackingScreen";
import { WorkflowScreen, type WorkflowId } from "@/screens/WorkflowScreen";
import { useAiDebugStore } from "@/stores/aiDebugStore";
import { useCredentialStatusStore } from "@/stores/credentialStatusStore";
import { hydrateImplementStore, setStreamingPartialsEnabledRuntime } from "@/stores/implementTicket/listeners";
import { hydrateMeetingsStore } from "@/stores/meetings/listeners";
import { hydratePrReviewStore } from "@/stores/prReview/listeners";
import { usePrTasksStore } from "@/stores/prTasksStore";
import { hydrateTasksStore, useTasksStore } from "@/stores/tasksStore";
import { hydrateTimeTrackingStore } from "@/stores/timeTrackingStore";
import { POLL_INTERVAL_MS, useWorkloadAlertStore } from "@/stores/workloadAlertStore";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";

type Screen = "loading" | "onboarding" | "landing" | "settings" | "agent-skills" | WorkflowId;

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

const WORKFLOW_IDS: WorkflowId[] = [
  "implement-ticket",
  "review-pr",
  "sprint-dashboard",
  "retrospectives",
  "ticket-quality",
  "address-pr-comments",
  "meetings",
  "time-tracking",
];

function isWorkflowId(s: Screen): s is WorkflowId {
  return WORKFLOW_IDS.includes(s as WorkflowId);
}

function AppInner() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [credStatus, setCredStatusLocal] = useState<CredentialStatus | null>(null);
  const setCredentialStatusInStore = useCredentialStatusStore((s) => s.setStatus);
  const setCredStatus = useCallback(
    (next: CredentialStatus | null) => {
      setCredStatusLocal(next);
      setCredentialStatusInStore(next);
    },
    [setCredentialStatusInStore],
  );
  const [screenBeforeSettings, setScreenBeforeSettings] = useState<Screen>("landing");
  const [screenBeforeOnboardingPreview, setScreenBeforeOnboardingPreview] =
    useState<Screen | null>(null);

  useEffect(() => {
    // Hydrate persisted stores from file cache before loading credentials
    Promise.allSettled([
      hydrateImplementStore(),
      hydratePrReviewStore(),
      hydrateMeetingsStore(),
      hydrateTasksStore(),
      hydrateTimeTrackingStore(),
      // Pull saved PR-task filter rules from preferences so the sidebar
      // applies them on the very first render — otherwise the user
      // sees noise tasks flash in for a moment before the filter loads.
      usePrTasksStore.getState().hydrateFilters(),
    ]);

    // Hydrate runtime flags driven by user preferences. These map to
    // module-level toggles in their respective stores so the listeners
    // can consult them on every event without round-tripping through
    // React state.
    void getAppPreferences().then((prefs) => {
      setStreamingPartialsEnabledRuntime(prefs.streamingPartialsEnabled);
      setRuntimeOverloadPct(prefs.workloadOverloadThresholdPct);
      useAiDebugStore.getState().hydrate({
        enabled: prefs.aiDebugEnabled,
        dockMode: prefs.aiDebugDockMode,
      });
    });

    // Boot the AI traffic listener. Idempotent — it'll no-op if
    // already started (e.g. on hot-reload). When debug is off the
    // sidecar emits no events, so this is essentially free.
    void startAiDebugListener();
    // Boot the global rate-limit listener so the HeaderModelPicker's
    // bars update regardless of which workflow produced the snapshot.
    void startRateLimitListener();

    getCredentialStatus()
      .then((status) => {
        setCredStatus(status);
        setScreen(credentialStatusComplete(status) ? "landing" : "onboarding");
      })
      .catch(() => setScreen("onboarding"));
    // Pre-load the local LLM URL into the cache so toasts can display it.
    getNonSecretConfig()
      .then((cfg) => {
        const url = cfg["local_llm_url"];
        if (url) setLocalLlmUrlCache(url);
      })
      .catch(() => {});
  }, []);

  const checkWorkload = useWorkloadAlertStore((s) => s.checkWorkload);
  const refreshPrTasks = usePrTasksStore((s) => s.refresh);

  useEffect(() => {
    // Poll the workload store so the Sprint Dashboard landing-card badge stays
    // fresh. Only polls when both JIRA and Bitbucket credentials are present.
    if (!credStatus || !jiraComplete(credStatus) || !bitbucketComplete(credStatus)) return;
    void checkWorkload();
    const interval = setInterval(() => void checkWorkload(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [credStatus, checkWorkload]);

  useEffect(() => {
    // Pull the user's Bitbucket PR-tasks into the right-hand Tasks panel.
    // Polling cadence is user-configurable (Settings → Tasks → poll
    // interval); we read it once on mount and rebuild the interval if
    // it changes. The Tasks panel triggers its own refresh on open and
    // we also refresh on window focus so freshly-returning-to-the-app
    // users don't see stale data.
    if (!credStatus || !bitbucketComplete(credStatus)) return;
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const onFocus = () => void refreshPrTasks();
    void getAppPreferences().then((prefs) => {
      if (cancelled) return;
      const minutes =
        prefs.prTasksPollIntervalMinutes ||
        APP_PREFERENCE_DEFAULTS.prTasksPollIntervalMinutes;
      void refreshPrTasks();
      interval = setInterval(() => void refreshPrTasks(), minutes * 60 * 1000);
      window.addEventListener("focus", onFocus);
    });
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [credStatus, refreshPrTasks]);

  const openSettings = useCallback(() => {
    if (screen === "settings") return;
    setScreenBeforeSettings(screen);
    setScreen("settings");
  }, [screen]);

  const openMeetings = useCallback(() => {
    setScreen("meetings");
  }, []);

  const openTimeTracking = useCallback(() => {
    setScreen("time-tracking");
  }, []);

  function closeSettings() {
    getCredentialStatus()
      .then((status) => {
        setCredStatus(status);
        const returnTo = screenBeforeSettings === "settings" ? "landing" : screenBeforeSettings;
        setScreen(returnTo);
      })
      .catch(() => setScreen("landing"));
  }

  function completeOnboarding() {
    // When the wizard is being shown as a developer preview from inside
    // Settings, return to whichever screen the user came from rather than
    // forcing them back to the landing card. `screenBeforeOnboardingPreview`
    // is non-null only when previewOnboarding kicked off the visit.
    const restoreTo = screenBeforeOnboardingPreview;
    getCredentialStatus()
      .then((status) => {
        setCredStatus(status);
        if (restoreTo) {
          setScreenBeforeOnboardingPreview(null);
          setScreen(restoreTo);
        } else {
          setScreen("landing");
        }
      })
      .catch(() => {
        if (restoreTo) {
          setScreenBeforeOnboardingPreview(null);
          setScreen(restoreTo);
        } else {
          setScreen("landing");
        }
      });
  }

  const previewOnboarding = useCallback(() => {
    setScreenBeforeOnboardingPreview(screen);
    setScreen("onboarding");
  }, [screen]);

  return (
    <OpenSettingsProvider openSettings={openSettings}>
     <PreviewOnboardingProvider previewOnboarding={previewOnboarding}>
     <OpenMeetingsProvider openMeetings={openMeetings}>
      <OpenTimeTrackingProvider openTimeTracking={openTimeTracking}>
      <RecordingContextTagsProvider tags={recordingContextTagsForScreen(screen)}>
      <ScreenWithTasksPanel>
      {screen === "loading" ? (
        <LoadingScreen />
      ) : screen === "onboarding" ? (
        <OnboardingScreen onComplete={completeOnboarding} />
      ) : screen === "settings" ? (
        <SettingsScreen
          onClose={closeSettings}
          onNavigate={(id) => setScreen(id as Screen)}
        />
      ) : screen === "sprint-dashboard" && credStatus ? (
        <SprintDashboardScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "retrospectives" ? (
        <RetrospectivesScreen onBack={() => setScreen("landing")} />
      ) : screen === "ticket-quality" && credStatus ? (
        <GroomTicketScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "review-pr" && credStatus ? (
        <PrReviewScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "implement-ticket" && credStatus ? (
        <ImplementTicketScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "address-pr-comments" && credStatus ? (
        <AddressPrCommentsScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "meetings" ? (
        <MeetingsScreen onBack={() => setScreen("landing")} />
      ) : screen === "time-tracking" ? (
        <TimeTrackingScreen onBack={() => setScreen("landing")} />
      ) : screen === "agent-skills" ? (
        <AgentSkillsScreen onBack={() => setScreen("landing")} />
      ) : isWorkflowId(screen) ? (
        <WorkflowScreen workflowId={screen} onBack={() => setScreen("landing")} />
      ) : credStatus ? (
        <LandingScreen credStatus={credStatus} onNavigate={(id) => setScreen(id)} />
      ) : (
        <LoadingScreen />
      )}
      </ScreenWithTasksPanel>
      </RecordingContextTagsProvider>
      </OpenTimeTrackingProvider>
     </OpenMeetingsProvider>
     </PreviewOnboardingProvider>
    </OpenSettingsProvider>
  );
}

// Wraps the active screen and reserves space on the right for the Tasks panel
// when it's open. The panel itself is `position: fixed` so it slots in over
// that reserved column without each individual screen having to know about it.
//
// The reserved width tracks the user's chosen panelWidth — which they can
// drag-resize via the panel's left edge — so the screen content always meets
// the panel exactly at its border, no overlap and no gap.
function ScreenWithTasksPanel({ children }: { children: React.ReactNode }) {
  const open = useTasksStore((s) => s.panelOpen);
  const width = useTasksStore((s) => s.panelWidth);
  return (
    <>
      <div style={{ paddingRight: open ? width : 0 }}>
        {children}
      </div>
      <TasksPanel />
    </>
  );
}

const RECORDING_TAGS_BY_SCREEN: Partial<Record<Screen, string[]>> = {
  "sprint-dashboard": ["standup"],
  retrospectives: ["retro"],
};

function recordingContextTagsForScreen(screen: Screen): string[] {
  return RECORDING_TAGS_BY_SCREEN[screen] ?? [];
}

function GlobalBackground() {
  const [bgId, setBgId] = useState(() => getBackgroundId());
  const handleChange = useCallback((id: string) => setBgId(id), []);
  useBgChangeListener(handleChange);
  return (
    <div aria-hidden className="fixed inset-0 overflow-hidden pointer-events-none select-none">
      <BackgroundRenderer id={bgId} />
    </div>
  );
}

function GlobalForeground() {
  const [bgId, setBgId] = useState(() => getBackgroundId());
  const handleChange = useCallback((id: string) => setBgId(id), []);
  useBgChangeListener(handleChange);
  return (
    <div aria-hidden className="fixed inset-0 overflow-hidden pointer-events-none select-none z-[0]">
      <SpaceEffectsOverlay bgId={bgId} />
    </div>
  );
}

const FX_ENABLED_EVENT = "m-effects-enabled";

function GlobalFxDrawer({ hideUI, onToggleHideUI }: { hideUI: boolean; onToggleHideUI: () => void }) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(true);
  const [kinds, setKinds] = useState<Record<SpaceEffectKind, boolean>>(getSpaceEffectKindToggles);
  const [bhGravityOn, setBhGravityOn] = useState(() => getBhGravityEnabled());

  useEffect(() => {
    const syncEnabled = (e: Event) => setOn((e as CustomEvent<boolean>).detail);
    const syncKinds = (e: Event) =>
      setKinds({ ...(e as CustomEvent<Record<SpaceEffectKind, boolean>>).detail });
    const syncGrav = (e: Event) =>
      setBhGravityOn((e as CustomEvent<boolean>).detail);
    window.addEventListener(FX_ENABLED_EVENT, syncEnabled);
    window.addEventListener(SPACE_FX_TOGGLES_EVENT, syncKinds);
    window.addEventListener(SPACE_FX_BH_GRAVITY_EVENT, syncGrav);
    return () => {
      window.removeEventListener(FX_ENABLED_EVENT, syncEnabled);
      window.removeEventListener(SPACE_FX_TOGGLES_EVENT, syncKinds);
      window.removeEventListener(SPACE_FX_BH_GRAVITY_EVENT, syncGrav);
    };
  }, []);

  function toggle() {
    const next = !on;
    setOn(next);
    setEffectsEnabled(next);
  }

  const spawnRows: { kind: SpaceEffectKind; icon: string; label: string; fn: () => void }[] = [
    { kind: "shootingStars", icon: "✦", label: "shooting star", fn: fireShootingStar },
    { kind: "comets", icon: "☄", label: "comet", fn: fireComet },
    { kind: "meteors", icon: "⁂", label: "meteor shower", fn: fireMeteorShower },
    { kind: "blackHole", icon: "◉", label: "black hole", fn: fireBlackHole },
    { kind: "pulsars", icon: "※", label: "supernova", fn: firePulsar },
    { kind: "wormholes", icon: "⊕", label: "wormhole", fn: fireWormhole },
  ];

  const chk =
    "h-3.5 w-3.5 shrink-0 rounded border border-white/25 bg-black/50 accent-zinc-500 focus:ring-1 focus:ring-white/20 focus:ring-offset-0";

  const gravityFootnote =
    "When on, comets, stars, and other effects drift toward an active black hole. The hole still appears if enabled above; this only toggles the pull.";

  return (
    <div className="pointer-events-none fixed bottom-2 left-3 z-50 flex max-w-[calc(100%-1.5rem)] items-center gap-2 sm:left-4 sm:max-w-[calc(100%-2rem)]">
      {/* fx chip on the left; drawer grows right */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="fx-drawer-panel"
        className="pointer-events-auto flex h-8 w-14 shrink-0 select-none items-center justify-center gap-1 rounded-lg border border-white/12 bg-black/55 text-[10px] text-white/50 shadow-lg shadow-black/30 backdrop-blur-md hover:bg-black/70 hover:text-white/80"
      >
        <span>fx</span>
        <span
          className="inline-block"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
      </button>
      {/* Drawer grows right from the fx chip; same row, max-width clip */}
      <div
        className={`min-w-0 overflow-hidden transition-[max-width] ${
          open ? "max-w-[min(calc(100vw-5.5rem),92vw)]" : "max-w-0"
        }`}
        style={{
          transitionDuration: "280ms",
          transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)",
        }}
      >
        <div className="pointer-events-auto w-max max-w-[min(calc(100vw-5.5rem),92vw)] rounded-r-2xl border border-white/12 border-l-transparent bg-black/50 py-2 pr-3 pl-2 backdrop-blur-md sm:pr-4">
          <div
            id="fx-drawer-panel"
            aria-hidden={!open}
            className="flex max-w-full flex-nowrap items-center gap-x-1.5 overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="group"
            aria-label="Space effects"
          >
            <button
              type="button"
              onClick={toggle}
              className={`shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                on
                  ? "bg-white/20 border-white/35 text-white/90 hover:bg-white/30"
                  : "bg-white/5 border-white/15 text-white/40 hover:bg-white/10"
              }`}
            >
              {on ? "⬤ on" : "○ off"}
            </button>
            <button
              type="button"
              onClick={clearAllEffects}
              className="shrink-0 rounded-full border border-red-400/30 bg-red-500/20 px-2.5 py-1 text-xs text-red-300/80 transition-colors hover:bg-red-500/30"
            >
              ✕ clear
            </button>
            <div className="h-5 w-px shrink-0 bg-white/15" />
            <button
              type="button"
              onClick={onToggleHideUI}
              className={`shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                hideUI
                  ? "bg-white/20 border-white/35 text-white/90 hover:bg-white/30"
                  : "bg-white/5 border-white/15 text-white/50 hover:bg-white/10"
              }`}
            >
              {hideUI ? "◨ show ui" : "◧ hide ui"}
            </button>
            <div className="h-5 w-px shrink-0 bg-white/15" />
            <label
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-0.5 hover:bg-white/[0.04]"
              title={gravityFootnote}
            >
              <input
                type="checkbox"
                checked={bhGravityOn}
                onChange={() => toggleBhGravityEnabled()}
                className={chk}
                aria-label="gravity"
                aria-describedby="fx-gravity-footnote"
              />
              <span id="fx-gravity-footnote" className="sr-only">
                {gravityFootnote}
              </span>
              <span className="whitespace-nowrap text-xs font-medium text-white/80">gravity</span>
            </label>
            <div className="h-5 w-px shrink-0 bg-white/15" />
            {spawnRows.map(({ kind, icon, label, fn }) => {
              const enabledKind = kinds[kind];
              const canSpawn = on && enabledKind;
              return (
                <div key={label} className="inline-flex shrink-0 items-center gap-1">
                  <input
                    type="checkbox"
                    checked={enabledKind}
                    onChange={() => toggleSpaceEffectKind(kind)}
                    className={chk}
                    title={enabledKind ? `disable ${label}` : `enable ${label}`}
                    aria-label={enabledKind ? `Disable ${label}` : `Enable ${label}`}
                  />
                  <button
                    type="button"
                    disabled={!canSpawn}
                    onClick={fn}
                    title={`spawn ${label}`}
                    className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                      canSpawn
                        ? "border-white/20 bg-white/10 text-white/70 hover:bg-white/20"
                        : "cursor-not-allowed border-white/10 bg-white/[0.04] text-white/25"
                    }`}
                  >
                    {icon} {label}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}


function AiDebugWindowRoot() {
  // Popped-out debug window: subscribes to the same Tauri event
  // channel and renders only the panel. The dock-mode picker isn't
  // shown here since the user is already in the popped-out variant
  // and re-docking happens from the main window.
  useEffect(() => {
    void getAppPreferences().then((prefs) => {
      useAiDebugStore.getState().hydrate({
        enabled: prefs.aiDebugEnabled,
        dockMode: prefs.aiDebugDockMode,
      });
    });
    void startAiDebugListener();
    void startRateLimitListener();
  }, []);
  return (
    <ThemeProvider>
      <div className="h-screen w-screen overflow-hidden bg-background">
        <AiDebugPanel />
      </div>
    </ThemeProvider>
  );
}

export default function Root() {
  const [hideUI, setHideUI] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === "r") {
        e.preventDefault();
        window.location.reload();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (isAiDebugWindow()) return <AiDebugWindowRoot />;

  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <GlobalBackground />
        <div
          className="relative z-[1] transition-opacity duration-300"
          style={{ opacity: hideUI ? 0 : 1, pointerEvents: hideUI ? "none" : undefined }}
        >
          <AiDebugDock>
            <AppInner />
          </AiDebugDock>
        </div>
        <GlobalForeground />
        <GlobalFxDrawer hideUI={hideUI} onToggleHideUI={() => setHideUI(h => !h)} />
        <Toaster
          position="top-right"
          theme="dark"
          richColors
          closeButton
          toastOptions={{
            style: { fontFamily: "inherit" },
          }}
        />
      </TooltipProvider>
    </ThemeProvider>
  );
}
