import { createContext, useContext } from "react";

const OpenSettingsContext = createContext<(() => void) | null>(null);

export function OpenSettingsProvider({
  openSettings,
  children,
}: {
  openSettings: () => void;
  children: React.ReactNode;
}) {
  return (
    <OpenSettingsContext.Provider value={openSettings}>
      {children}
    </OpenSettingsContext.Provider>
  );
}

export function useOpenSettings(): () => void {
  const fn = useContext(OpenSettingsContext);
  return fn ?? (() => {});
}
