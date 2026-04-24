import { createContext, useContext } from "react";

const RecordingContextTagsContext = createContext<string[]>([]);

/**
 * Declares tags that should be auto-applied to any meeting recording started
 * while this subtree is mounted — e.g. "standup" when started from the Sprint
 * Dashboard, "retro" from Retrospectives. Screens with no semantic context
 * don't need to wrap anything.
 */
export function RecordingContextTagsProvider({
  tags,
  children,
}: {
  tags: string[];
  children: React.ReactNode;
}) {
  return (
    <RecordingContextTagsContext.Provider value={tags}>
      {children}
    </RecordingContextTagsContext.Provider>
  );
}

export function useRecordingContextTags(): string[] {
  return useContext(RecordingContextTagsContext);
}
