import { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  type ThemeConfig,
  type ThemeMode,
  type AccentColor,
  loadTheme,
  saveTheme,
  applyTheme,
} from "@/lib/theme";

interface ThemeContextValue {
  config: ThemeConfig;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentColor) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<ThemeConfig>(loadTheme);

  // Apply on mount and whenever config changes
  useEffect(() => {
    applyTheme(config);
    saveTheme(config);
  }, [config]);

  // Re-apply when system preference changes (only relevant in "system" mode)
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => { if (config.mode === "system") applyTheme(config); };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [config]);

  const setMode = useCallback((mode: ThemeMode) => {
    setConfig((prev) => ({ ...prev, mode }));
  }, []);

  const setAccent = useCallback((accent: AccentColor) => {
    setConfig((prev) => ({ ...prev, accent }));
  }, []);

  return (
    <ThemeContext.Provider value={{ config, setMode, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
