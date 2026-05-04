import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { APP_HEADER_BAR, APP_HEADER_ROW_LANDING } from "@/components/appHeaderLayout";
import { Card, CardContent } from "@/components/ui/card";
import { setMockClaudeMode, setMockMode } from "@/lib/tauri/core";
import { useState } from "react";
import { StepIndicator, TOTAL_STEPS } from "./onboarding/_shared";
import { AiProvidersStep } from "./onboarding/ai-providers-step";
import { BitbucketStep } from "./onboarding/bitbucket-step";
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
    <div className="flex min-h-screen flex-col">
      <header className={APP_HEADER_BAR}>
        <div className={APP_HEADER_ROW_LANDING}>
          <HeaderSettingsButton className="relative z-10 shrink-0" />
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl bg-background/60 p-6">
          {step > 0 && (
            <div className="mb-6 flex justify-center">
              <StepIndicator current={step} total={TOTAL_STEPS} />
            </div>
          )}
          <Card>
            <CardContent className="pt-6 pb-6">{steps[step]}</CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
