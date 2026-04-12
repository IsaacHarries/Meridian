import { useState, useEffect, useCallback } from "react";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { Loader2 } from "lucide-react";
import { type CredentialStatus, credentialStatusComplete, getCredentialStatus } from "@/lib/tauri";
import { BackgroundRenderer, getBackgroundId, useBgChangeListener } from "@/lib/backgrounds";
import { SpaceEffectsOverlay } from "@/lib/spaceEffects";
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

  function openSettings() {
    setScreenBeforeSettings(screen);
    setScreen("settings");
  }

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

  if (screen === "loading") return <LoadingScreen />;

  if (screen === "onboarding") {
    return <OnboardingScreen onComplete={completeOnboarding} />;
  }

  if (screen === "settings") {
    return (
      <SettingsScreen
        onClose={closeSettings}
        onNavigate={(id) => setScreen(id as Screen)}
      />
    );
  }

  if (screen === "sprint-dashboard") {
    return <SprintDashboardScreen onBack={() => setScreen("landing")} />;
  }

  if (screen === "retrospectives") {
    return <RetrospectivesScreen onBack={() => setScreen("landing")} />;
  }

  if (screen === "standup" && credStatus) {
    return <StandupScreen credStatus={credStatus} onBack={() => setScreen("landing")} />;
  }

  if (screen === "workload-balancer" && credStatus) {
    return <WorkloadBalancerScreen credStatus={credStatus} onBack={() => setScreen("landing")} />;
  }

  if (screen === "knowledge-base") {
    return <KnowledgeBaseScreen onBack={() => setScreen("landing")} />;
  }

  if (screen === "ticket-quality" && credStatus) {
    return <TicketQualityScreen credStatus={credStatus} onBack={() => setScreen("landing")} />;
  }

  if (screen === "review-pr" && credStatus) {
    return <PrReviewScreen credStatus={credStatus} onBack={() => setScreen("landing")} />;
  }

  if (screen === "implement-ticket" && credStatus) {
    return <ImplementTicketScreen credStatus={credStatus} onBack={() => setScreen("landing")} />;
  }

  if (screen === "agent-skills") {
    return <AgentSkillsScreen onBack={() => setScreen("landing")} />;
  }

  if (isWorkflowId(screen)) {
    return <WorkflowScreen workflowId={screen} onBack={() => setScreen("landing")} />;
  }

  if (credStatus) {
    return (
      <LandingScreen
        credStatus={credStatus}
        onOpenSettings={openSettings}
        onNavigate={(id) => setScreen(id)}
      />
    );
  }

  return <LoadingScreen />;
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

export default function Root() {
  return (
    <ThemeProvider>
      <GlobalBackground />
      <div className="relative z-[1]">
        <AppInner />
      </div>
      <GlobalForeground />
    </ThemeProvider>
  );
}
