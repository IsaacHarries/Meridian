// ── Theme types ───────────────────────────────────────────────────────────────

export type ThemeMode = "light" | "dark" | "system";

export type AccentColor =
  | "slate"
  | "blue"
  | "violet"
  | "green"
  | "orange"
  | "rose";

export interface ThemeConfig {
  mode: ThemeMode;
  accent: AccentColor;
}

// ── Accent colour definitions ─────────────────────────────────────────────────
// Each accent overrides --primary, --primary-foreground, and --ring
// Values are HSL components (space-separated, no hsl() wrapper — matches shadcn convention)

interface AccentVars {
  primary: string;
  primaryForeground: string;
  ring: string;
}

export const ACCENT_VARS: Record<AccentColor, { light: AccentVars; dark: AccentVars }> = {
  slate: {
    light: { primary: "222.2 47.4% 11.2%", primaryForeground: "210 40% 98%", ring: "222.2 84% 4.9%" },
    dark:  { primary: "210 40% 98%",        primaryForeground: "222.2 47.4% 11.2%", ring: "212.7 26.8% 83.9%" },
  },
  blue: {
    light: { primary: "221 83% 53%",  primaryForeground: "0 0% 100%", ring: "221 83% 53%" },
    dark:  { primary: "217 91% 60%",  primaryForeground: "0 0% 100%", ring: "217 91% 60%" },
  },
  violet: {
    light: { primary: "262 83% 58%",  primaryForeground: "0 0% 100%", ring: "262 83% 58%" },
    dark:  { primary: "263 70% 65%",  primaryForeground: "0 0% 100%", ring: "263 70% 65%" },
  },
  green: {
    light: { primary: "142 71% 35%",  primaryForeground: "0 0% 100%", ring: "142 71% 35%" },
    dark:  { primary: "142 71% 45%",  primaryForeground: "0 0% 100%", ring: "142 71% 45%" },
  },
  orange: {
    light: { primary: "25 95% 48%",   primaryForeground: "0 0% 100%", ring: "25 95% 48%" },
    dark:  { primary: "25 95% 55%",   primaryForeground: "0 0% 100%", ring: "25 95% 55%" },
  },
  rose: {
    light: { primary: "346 77% 49%",  primaryForeground: "0 0% 100%", ring: "346 77% 49%" },
    dark:  { primary: "346 77% 58%",  primaryForeground: "0 0% 100%", ring: "346 77% 58%" },
  },
};

export const ACCENT_LABELS: Record<AccentColor, string> = {
  slate: "Slate",
  blue: "Blue",
  violet: "Violet",
  green: "Green",
  orange: "Orange",
  rose: "Rose",
};

// Swatch colour shown in the UI (a solid representative colour)
export const ACCENT_SWATCH: Record<AccentColor, string> = {
  slate:  "hsl(222 47% 20%)",
  blue:   "hsl(221 83% 53%)",
  violet: "hsl(262 83% 58%)",
  green:  "hsl(142 71% 35%)",
  orange: "hsl(25 95% 48%)",
  rose:   "hsl(346 77% 49%)",
};

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "meridian-theme";

export function loadTheme(): ThemeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ThemeConfig;
  } catch { /* ignore */ }
  return { mode: "system", accent: "slate" };
}

export function saveTheme(config: ThemeConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// ── Apply theme to document ───────────────────────────────────────────────────

export function applyTheme(config: ThemeConfig) {
  const root = document.documentElement;

  // Resolve effective mode
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark =
    config.mode === "dark" ||
    (config.mode === "system" && prefersDark);

  root.classList.toggle("dark", dark);

  // Apply accent variables
  const vars = ACCENT_VARS[config.accent][dark ? "dark" : "light"];
  root.style.setProperty("--primary", vars.primary);
  root.style.setProperty("--primary-foreground", vars.primaryForeground);
  root.style.setProperty("--ring", vars.ring);
}
