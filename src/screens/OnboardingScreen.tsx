import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { APP_HEADER_BAR, APP_HEADER_ROW_LANDING } from "@/components/appHeaderLayout";
import { Card, CardContent } from "@/components/ui/card";
import { setMockClaudeMode, setMockMode } from "@/lib/tauri/core";
import { useState } from "react";
import { StepIndicator, TOTAL_STEPS } from "./onboarding/_shared";
import { AiProvidersStep } from "./onboarding/ai-providers-step";
import { BitbucketStep } from "./onboarding/bitbucket-step";
import { CosmicBackdrop } from "./onboarding/cosmic-backdrop";
import { JiraStep } from "./onboarding/jira-step";
import { WelcomeStep } from "./onboarding/welcome-step";

interface OnboardingScreenProps {
  onComplete: () => void;
  onMockMode?: () => void;
}

export function OnboardingScreen({ onComplete, onMockMode }: OnboardingScreenProps) {
  const [step, setStep] = useState(0);

  function handleMockMode() {
    setMockMode(true);
    setMockClaudeMode(true);
    onMockMode?.();
    onComplete();
  }

  const steps = [
    <WelcomeStep key="welcome" onNext={() => setStep(1)} onMockMode={handleMockMode} />,
    <AiProvidersStep key="ai" onNext={() => setStep(2)} onBack={() => setStep(0)} stepNum={1} />,
    <JiraStep key="jira" onNext={() => setStep(3)} onBack={() => setStep(1)} stepNum={2} />,
    <BitbucketStep key="bitbucket" onNext={onComplete} onBack={() => setStep(2)} stepNum={3} />,
  ];

  return (
    <div className="relative flex min-h-screen flex-col">
      {/* Wizard-scoped cosmic backdrop sits beneath everything else. */}
      <CosmicBackdrop />
      <header className={`${APP_HEADER_BAR} relative z-10`}>
        <div className={APP_HEADER_ROW_LANDING}>
          <HeaderSettingsButton className="relative z-10 shrink-0" />
        </div>
      </header>
      <div className="relative z-10 flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md">
          {step > 0 && (
            <div className="mb-5 flex justify-center">
              <StepIndicator current={step} total={TOTAL_STEPS} />
            </div>
          )}
          {/* Glassy wizard card. The wrapper provides the soft outer halo;
              the Card itself is semi-translucent with a thin primary-tinted
              border so the cosmic backdrop bleeds through the edges and the
              card feels like it's floating in space. */}
          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-px rounded-xl bg-gradient-to-br from-primary/40 via-primary/10 to-primary/40 opacity-70 blur-[10px]"
            />
            <Card
              key={step}
              className="relative border border-primary/25 bg-background/70 shadow-[0_8px_40px_-8px_hsl(var(--primary)/0.25)] backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-300"
            >
              <CardContent className="pt-6 pb-6">{steps[step]}</CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
