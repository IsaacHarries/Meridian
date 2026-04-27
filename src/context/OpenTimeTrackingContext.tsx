import { createContext, useContext } from "react";

const OpenTimeTrackingContext = createContext<(() => void) | null>(null);

export function OpenTimeTrackingProvider({
  openTimeTracking,
  children,
}: {
  openTimeTracking: () => void;
  children: React.ReactNode;
}) {
  return (
    <OpenTimeTrackingContext.Provider value={openTimeTracking}>
      {children}
    </OpenTimeTrackingContext.Provider>
  );
}

export function useOpenTimeTracking(): () => void {
  const fn = useContext(OpenTimeTrackingContext);
  return fn ?? (() => {});
}
