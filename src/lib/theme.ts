// ── Theme types ───────────────────────────────────────────────────────────────

export type AccentColor =
  | "slate"
  | "blue"
  | "violet"
  | "green"
  | "orange"
  | "rose";

export interface ThemeConfig {
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

export const ACCENT_VARS: Record<AccentColor, AccentVars> = {
  slate:  { primary: "210 40% 98%",       primaryForeground: "222.2 47.4% 11.2%", ring: "212.7 26.8% 83.9%" },
  blue:   { primary: "217 91% 60%",       primaryForeground: "0 0% 100%",         ring: "217 91% 60%" },
  violet: { primary: "263 70% 65%",       primaryForeground: "0 0% 100%",         ring: "263 70% 65%" },
  green:  { primary: "142 71% 45%",       primaryForeground: "0 0% 100%",         ring: "142 71% 45%" },
  orange: { primary: "25 95% 55%",        primaryForeground: "0 0% 100%",         ring: "25 95% 55%" },
  rose:   { primary: "346 77% 58%",       primaryForeground: "0 0% 100%",         ring: "346 77% 58%" },
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
  slate:  "hsl(210 40% 70%)",
  blue:   "hsl(217 91% 60%)",
  violet: "hsl(263 70% 65%)",
  green:  "hsl(142 71% 45%)",
  orange: "hsl(25 95% 55%)",
  rose:   "hsl(346 77% 58%)",
};

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "meridian-theme";

export function loadTheme(): ThemeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { accent: parsed.accent ?? "slate" };
    }
  } catch { /* ignore */ }
  return { accent: "slate" };
}

export function saveTheme(config: ThemeConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// ── Apply theme to document ───────────────────────────────────────────────────

export function applyTheme(config: ThemeConfig) {
  const root = document.documentElement;

  // Always dark
  root.classList.add("dark");

  // Apply accent variables
  const vars = ACCENT_VARS[config.accent];
  root.style.setProperty("--primary", vars.primary);
  root.style.setProperty("--primary-foreground", vars.primaryForeground);
  root.style.setProperty("--ring", vars.ring);
}
