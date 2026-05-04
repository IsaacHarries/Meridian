import React from "react";
import { MeridianBg, DuskBg, AuroraBg, ForestBg } from "./meridian";
import { NebulaBg, CosmosBg, SupernovaBg, StarfieldBg, DeepSpaceBg } from "./space";
import {
  JWSTCarinaBg, JWSTPillarsBg, JWSTSouthernRingBg, JWSTPhantomBg,
  JWSTTarantulaBg, JWSTDeepFieldBg, JWSTStephansBg, JWSTCartwheelBg,
} from "./jwst";
import { WatercolorBg, NeonBg, PrismBg, GeometricBg, MeshBg } from "./abstract";
import { HoneycombBg, WavesBg, CircuitBg, BlueprintBg, TopographicBg } from "./patterns";
import { DotsBg, NoneBg } from "./minimal";

// ── Storage ────────────────────────────────────────────────────────────────────

const LS_KEY = "meridian_bg";
const CHANGE_EVENT = "meridian-bg-change";

export function getBackgroundId(): string {
  return localStorage.getItem(LS_KEY) ?? "meridian";
}

export function setBackgroundId(id: string): void {
  localStorage.setItem(LS_KEY, id);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: id }));
}

export function useBgChangeListener(cb: (id: string) => void) {
  React.useEffect(() => {
    const handler = (e: Event) => cb((e as CustomEvent<string>).detail);
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, [cb]);
}

// ── Metadata ───────────────────────────────────────────────────────────────────

export type BgCategory = "meridian" | "space" | "jwst" | "abstract" | "patterns" | "minimal";

export interface BackgroundDef {
  id: string;
  name: string;
  category: BgCategory;
}

export const CATEGORY_LABELS: Record<BgCategory, string> = {
  meridian: "Meridian",
  space: "Space",
  jwst: "James Webb",
  abstract: "Abstract",
  patterns: "Patterns",
  minimal: "Minimal",
};

export const BACKGROUNDS: BackgroundDef[] = [
  // Meridian
  { id: "meridian",    name: "Meridian",    category: "meridian" },
  { id: "dusk",        name: "Dusk",        category: "meridian" },
  { id: "aurora",      name: "Aurora",      category: "meridian" },
  { id: "forest",      name: "Forest",      category: "meridian" },
  // Space
  { id: "nebula",      name: "Nebula",      category: "space" },
  { id: "cosmos",      name: "Cosmos",      category: "space" },
  { id: "supernova",   name: "Supernova",   category: "space" },
  { id: "starfield",   name: "Starfield",   category: "space" },
  { id: "deep-space",  name: "Deep Space",  category: "space" },
  // James Webb
  { id: "jwst-carina",        name: "Cosmic Cliffs",      category: "jwst" },
  { id: "jwst-pillars",       name: "Pillars of Creation", category: "jwst" },
  { id: "jwst-southern-ring", name: "Southern Ring",       category: "jwst" },
  { id: "jwst-phantom",       name: "Phantom Galaxy",      category: "jwst" },
  { id: "jwst-tarantula",     name: "Tarantula Nebula",    category: "jwst" },
  { id: "jwst-deep-field",    name: "Deep Field",          category: "jwst" },
  { id: "jwst-stephans",      name: "Stephan's Quintet",   category: "jwst" },
  { id: "jwst-cartwheel",     name: "Cartwheel Galaxy",    category: "jwst" },
  // Abstract
  { id: "watercolor",  name: "Watercolor",  category: "abstract" },
  { id: "neon",        name: "Neon",        category: "abstract" },
  { id: "prism",       name: "Prism",       category: "abstract" },
  { id: "geometric",   name: "Geometric",   category: "abstract" },
  { id: "mesh",        name: "Mesh",        category: "abstract" },
  // Patterns
  { id: "honeycomb",   name: "Honeycomb",   category: "patterns" },
  { id: "waves",       name: "Waves",       category: "patterns" },
  { id: "circuit",     name: "Circuit",     category: "patterns" },
  { id: "blueprint",   name: "Blueprint",   category: "patterns" },
  { id: "topographic", name: "Topographic", category: "patterns" },
  // Minimal
  { id: "dots",        name: "Dots",        category: "minimal" },
  { id: "none",        name: "None",        category: "minimal" },
];

// ── Registry ───────────────────────────────────────────────────────────────────
const COMPONENTS: Record<string, React.FC> = {
  "meridian":       MeridianBg,
  "dusk":            DuskBg,
  "aurora":      AuroraBg,
  "forest":      ForestBg,
  "nebula":      NebulaBg,
  "cosmos":      CosmosBg,
  "supernova":   SupernovaBg,
  "starfield":   StarfieldBg,
  "deep-space":  DeepSpaceBg,
  "jwst-carina":      JWSTCarinaBg,
  "jwst-pillars": JWSTPillarsBg,
  "jwst-cartwheel":   JWSTCartwheelBg,
  "jwst-southern-ring": JWSTSouthernRingBg,
  "jwst-phantom": JWSTPhantomBg,
  "jwst-tarantula": JWSTTarantulaBg,
  "jwst-deep-field": JWSTDeepFieldBg,
  "jwst-stephans": JWSTStephansBg,
  "watercolor":  WatercolorBg,
  "neon":        NeonBg,
  "prism":       PrismBg,
  "geometric":   GeometricBg,
  "mesh":        MeshBg,
  "honeycomb":   HoneycombBg,
  "waves":       WavesBg,
  "circuit":     CircuitBg,
  "blueprint":   BlueprintBg,
  "topographic": TopographicBg,
  "dots":        DotsBg,
  "none":        NoneBg,
};

export function BackgroundRenderer({ id }: { id: string }) {
  const Component = COMPONENTS[id] ?? MeridianBg;
  return <Component />;
}
