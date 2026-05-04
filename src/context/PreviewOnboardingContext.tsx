import { createContext, useContext } from "react";

const PreviewOnboardingContext = createContext<(() => void) | null>(null);

/** Re-show the onboarding wizard from anywhere in the app — used by the
 *  Settings → Developer dev tools to iterate on the wizard UI without
 *  having to reset credentials and restart. The host (App.tsx) restores
 *  the prior screen when the wizard's `onComplete` fires. */
export function PreviewOnboardingProvider({
  previewOnboarding,
  children,
}: {
  previewOnboarding: () => void;
  children: React.ReactNode;
}) {
  return (
    <PreviewOnboardingContext.Provider value={previewOnboarding}>
      {children}
    </PreviewOnboardingContext.Provider>
  );
}

export function usePreviewOnboarding(): () => void {
  const fn = useContext(PreviewOnboardingContext);
  return fn ?? (() => {});
}
