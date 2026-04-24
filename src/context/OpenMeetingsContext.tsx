import { createContext, useContext } from "react";

const OpenMeetingsContext = createContext<(() => void) | null>(null);

export function OpenMeetingsProvider({
  openMeetings,
  children,
}: {
  openMeetings: () => void;
  children: React.ReactNode;
}) {
  return (
    <OpenMeetingsContext.Provider value={openMeetings}>
      {children}
    </OpenMeetingsContext.Provider>
  );
}

export function useOpenMeetings(): () => void {
  const fn = useContext(OpenMeetingsContext);
  return fn ?? (() => {});
}
