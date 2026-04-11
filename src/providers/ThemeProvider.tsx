import { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  type ThemeConfig,
  type AccentColor,
  loadTheme,
  saveTheme,
  applyTheme,
} from "@/lib/theme";

interface ThemeContextValue {
  config: ThemeConfig;
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

  const setAccent = useCallback((accent: AccentColor) => {
    setConfig((prev) => ({ ...prev, accent }));
  }, []);

  return (
    <ThemeContext.Provider value={{ config, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
