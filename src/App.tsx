import { useState, useEffect, useCallback } from "react";
import { OpenSettingsProvider } from "@/context/OpenSettingsContext";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { Loader2 } from "lucide-react";
import { type CredentialStatus, credentialStatusComplete, getCredentialStatus } from "@/lib/tauri";
import { BackgroundRenderer, getBackgroundId, useBgChangeListener } from "@/lib/backgrounds";
import {
  SpaceEffectsOverlay,
  fireShootingStar, fireBlackHole, fireComet, firePulsar,
  fireMeteorShower, fireWormhole, clearAllEffects, setEffectsEnabled,
} from "@/lib/spaceEffects";
import { OnboardingScreen } from "@/screens/OnboardingScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { LandingScreen } from "@/screens/LandingScreen";
import { WorkflowScreen, type WorkflowId } from "@/screens/WorkflowScreen";
import { SprintDashboardScreen } from "@/screens/SprintDashboardScreen";
import { RetrospectivesScreen } from "@/screens/RetrospectivesScreen";
import { StandupScreen } from "@/screens/StandupScreen";
import { WorkloadBalancerScreen } from "@/screens/WorkloadBalancerScreen";
import { KnowledgeBaseScreen } from "@/screens/KnowledgeBaseScreen";
import { TicketQualityScreen } from "@/screens/TicketQualityScreen";
import { PrReviewScreen } from "@/screens/PrReviewScreen";
import { ImplementTicketScreen } from "@/screens/ImplementTicketScreen";
import { AgentSkillsScreen } from "@/screens/AgentSkillsScreen";

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
  "standup",
  "workload-balancer",
  "ticket-quality",
  "knowledge-base",
];

function isWorkflowId(s: Screen): s is WorkflowId {
  return WORKFLOW_IDS.includes(s as WorkflowId);
}

function AppInner() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [credStatus, setCredStatus] = useState<CredentialStatus | null>(null);
  const [screenBeforeSettings, setScreenBeforeSettings] = useState<Screen>("landing");

  useEffect(() => {
    getCredentialStatus()
      .then((status) => {
        setCredStatus(status);
        setScreen(credentialStatusComplete(status) ? "landing" : "onboarding");
      })
      .catch(() => setScreen("onboarding"));
  }, []);

  const openSettings = useCallback(() => {
    if (screen === "settings") return;
    setScreenBeforeSettings(screen);
    setScreen("settings");
  }, [screen]);

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
    getCredentialStatus()
      .then((status) => {
        setCredStatus(status);
        setScreen("landing");
      })
      .catch(() => setScreen("landing"));
  }

  return (
    <OpenSettingsProvider openSettings={openSettings}>
      {screen === "loading" ? (
        <LoadingScreen />
      ) : screen === "onboarding" ? (
        <OnboardingScreen onComplete={completeOnboarding} />
      ) : screen === "settings" ? (
        <SettingsScreen
          onClose={closeSettings}
          onNavigate={(id) => setScreen(id as Screen)}
        />
      ) : screen === "sprint-dashboard" ? (
        <SprintDashboardScreen onBack={() => setScreen("landing")} />
      ) : screen === "retrospectives" ? (
        <RetrospectivesScreen onBack={() => setScreen("landing")} />
      ) : screen === "standup" && credStatus ? (
        <StandupScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "workload-balancer" && credStatus ? (
        <WorkloadBalancerScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "knowledge-base" ? (
        <KnowledgeBaseScreen onBack={() => setScreen("landing")} />
      ) : screen === "ticket-quality" && credStatus ? (
        <TicketQualityScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "review-pr" && credStatus ? (
        <PrReviewScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "implement-ticket" && credStatus ? (
        <ImplementTicketScreen credStatus={credStatus} onBack={() => setScreen("landing")} />
      ) : screen === "agent-skills" ? (
        <AgentSkillsScreen onBack={() => setScreen("landing")} />
      ) : isWorkflowId(screen) ? (
        <WorkflowScreen workflowId={screen} onBack={() => setScreen("landing")} />
      ) : credStatus ? (
        <LandingScreen credStatus={credStatus} onNavigate={(id) => setScreen(id)} />
      ) : (
        <LoadingScreen />
      )}
    </OpenSettingsProvider>
  );
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

function GlobalFxDrawer({ hideUI, onToggleHideUI }: { hideUI: boolean; onToggleHideUI: () => void }) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(true);

  function toggle() {
    const next = !on;
    setOn(next);
    setEffectsEnabled(next);
  }

  const EASE = "280ms cubic-bezier(0.4,0,0.2,1)";

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center justify-end pointer-events-none">
      {/* Panel — slides out to the left from behind the tab */}
      <div
        className="pointer-events-auto flex flex-wrap items-center gap-1.5 bg-black/50 backdrop-blur-md border border-white/12 rounded-2xl px-4 py-2.5 mr-2"
        style={{
          opacity: open ? 1 : 0,
          transform: open ? "translateX(0) scaleX(1)" : "translateX(12px) scaleX(0.92)",
          transformOrigin: "right center",
          transition: `opacity ${EASE}, transform ${EASE}`,
          pointerEvents: open ? "auto" : "none",
        }}
      >
        {/* Effects toggle */}
        <button
          onClick={toggle}
          className={`rounded-full border px-3 py-1 text-xs transition-colors ${
            on
              ? "bg-white/20 border-white/35 text-white/90 hover:bg-white/30"
              : "bg-white/5 border-white/15 text-white/40 hover:bg-white/10"
          }`}
        >
          {on ? "⬤ on" : "○ off"}
        </button>
        {/* Clear all */}
        <button
          onClick={clearAllEffects}
          className="rounded-full bg-red-500/20 border border-red-400/30 px-3 py-1 text-xs text-red-300/80 hover:bg-red-500/30 transition-colors"
        >
          ✕ clear
        </button>
        <div className="w-px bg-white/15 self-stretch mx-0.5" />
        {/* Hide UI */}
        <button
          onClick={onToggleHideUI}
          className={`rounded-full border px-3 py-1 text-xs transition-colors ${
            hideUI
              ? "bg-white/20 border-white/35 text-white/90 hover:bg-white/30"
              : "bg-white/5 border-white/15 text-white/50 hover:bg-white/10"
          }`}
        >
          {hideUI ? "◨ show ui" : "◧ hide ui"}
        </button>
        <div className="w-px bg-white/15 self-stretch mx-0.5" />
        {/* Spawn buttons */}
        {(
          [
            ["✦", "shooting star", fireShootingStar],
            ["☄", "comet",         fireComet],
            ["⁂", "meteor shower", fireMeteorShower],
            ["◉", "black hole",    fireBlackHole],
            ["✷", "supernova",     firePulsar],
            ["⊕", "wormhole",      fireWormhole],
          ] as [string, string, () => void][]
        ).map(([icon, label, fn]) => (
          <button
            key={label}
            onClick={fn}
            className="rounded-full bg-white/10 border border-white/20 px-3 py-1 text-xs text-white/70 hover:bg-white/20 transition-colors"
          >
            {icon} {label}
          </button>
        ))}
      </div>

      {/* Tab button — always visible in the corner */}
      <button
        onClick={() => setOpen(o => !o)}
        className="pointer-events-auto rounded-xl bg-black/50 backdrop-blur-md border border-white/12 px-3 py-2 text-[10px] text-white/50 hover:text-white/80 hover:bg-black/65 transition-colors flex items-center gap-1.5 select-none shrink-0"
      >
        <span
          style={{
            display: "inline-block",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: `transform ${EASE}`,
          }}
        >◀</span>
        fx
      </button>
    </div>
  );
}


export default function Root() {
  const [hideUI, setHideUI] = useState(false);

  return (
    <ThemeProvider>
      <GlobalBackground />
      <div
        className="relative z-[1] transition-opacity duration-300"
        style={{ opacity: hideUI ? 0 : 1, pointerEvents: hideUI ? "none" : undefined }}
      >
        <AppInner />
      </div>
      <GlobalForeground />
      <GlobalFxDrawer hideUI={hideUI} onToggleHideUI={() => setHideUI(h => !h)} />
    </ThemeProvider>
  );
}
