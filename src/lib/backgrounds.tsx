import React, { useMemo } from "react";

const W = 1280, H = 800;

// ── Star field generator ───────────────────────────────────────────────────────
// Seeded PRNG so positions are deterministic but visually random (no tiling).

interface Star { x: number; y: number; r: number; opacity: number }

function makeStars(count: number, seed: number, minR = 0.5, maxR = 2.0): Star[] {
  const rand = (n: number) => {
    const x = Math.sin(n) * 43758.5453;
    return x - Math.floor(x);
  };
  return Array.from({ length: count }, (_, i) => ({
    x:       rand(seed + i * 4 + 0) * W,
    y:       rand(seed + i * 4 + 1) * H,
    r:       minR + rand(seed + i * 4 + 2) * (maxR - minR),
    opacity: 0.25 + rand(seed + i * 4 + 3) * 0.70,
  }));
}

// Pre-computed star fields (module-level so they're only computed once)
const STARS_NEBULA     = makeStars(110,  42, 0.4, 1.5);
const STARS_COSMOS     = makeStars(170, 137, 0.4, 1.8);
const STARS_SUPERNOVA  = makeStars( 90, 251, 0.4, 1.2);
const STARS_STARFIELD  = makeStars(320,  73, 0.5, 2.6);
const STARS_DEEPSPACE  = makeStars(260, 191, 0.3, 1.0);

function Stars({ stars, color = "hsl(var(--foreground))" }: { stars: Star[]; color?: string }) {
  return (
    <>
      {stars.map((s, i) => (
        <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)}
          fill={color} opacity={s.opacity.toFixed(2)} />
      ))}
    </>
  );
}

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

// ── SVG base ───────────────────────────────────────────────────────────────────

function BgSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="100%" height="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

// ── Backgrounds ────────────────────────────────────────────────────────────────

// 1. Meridian — accent-tinted blobs + concentric arcs
function MeridianBg() {
  return (
    <BgSvg>
      <defs>
        <pattern id="mer-dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
        </pattern>
        <filter id="mer-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="80" />
        </filter>
        <filter id="mer-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="55" />
        </filter>
      </defs>
      <rect width={W} height={H} fill="url(#mer-dots)" style={{ color: "hsl(var(--foreground))", opacity: 0.06 }} />
      <ellipse cx="1180" cy="-80" rx="520" ry="420" filter="url(#mer-xl)" fill="hsl(var(--primary))" opacity="0.20" />
      <ellipse cx="100" cy="860" rx="380" ry="300" filter="url(#mer-lg)" fill="hsl(var(--primary))" opacity="0.15" />
      <circle cx="1280" cy="0" r="280" fill="none" stroke="hsl(var(--primary))" strokeWidth="1" opacity="0.20" />
      <circle cx="1280" cy="0" r="460" fill="none" stroke="hsl(var(--primary))" strokeWidth="1" opacity="0.12" />
      <circle cx="1280" cy="0" r="640" fill="none" stroke="hsl(var(--primary))" strokeWidth="0.75" opacity="0.07" />
    </BgSvg>
  );
}

// 2. Dusk — warm sunset oranges and roses
function DuskBg() {
  return (
    <BgSvg>
      <defs>
        <pattern id="dusk-dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
        </pattern>
        <filter id="dusk-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="90" />
        </filter>
        <filter id="dusk-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="65" />
        </filter>
        <filter id="dusk-md" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="50" />
        </filter>
      </defs>
      <rect width={W} height={H} fill="url(#dusk-dots)" style={{ color: "hsl(var(--foreground))", opacity: 0.05 }} />
      <ellipse cx="1150" cy="80" rx="580" ry="440" filter="url(#dusk-xl)" fill="hsl(25 90% 55%)" opacity="0.22" />
      <ellipse cx="750" cy="560" rx="500" ry="360" filter="url(#dusk-lg)" fill="hsl(340 75% 60%)" opacity="0.18" />
      <ellipse cx="80" cy="720" rx="420" ry="300" filter="url(#dusk-md)" fill="hsl(38 95% 57%)" opacity="0.15" />
      <circle cx="1280" cy="0" r="300" fill="none" stroke="hsl(25 90% 55%)" strokeWidth="1" opacity="0.18" />
      <circle cx="1280" cy="0" r="500" fill="none" stroke="hsl(25 90% 55%)" strokeWidth="0.75" opacity="0.10" />
    </BgSvg>
  );
}

// 3. Aurora — cool horizontal light bands
function AuroraBg() {
  return (
    <BgSvg>
      <defs>
        <pattern id="aur-dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
        </pattern>
        <filter id="aur-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="55" />
        </filter>
        <filter id="aur-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="45" />
        </filter>
      </defs>
      <rect width={W} height={H} fill="url(#aur-dots)" style={{ color: "hsl(var(--foreground))", opacity: 0.05 }} />
      <ellipse cx="640" cy="130" rx="900" ry="90" filter="url(#aur-xl)" fill="hsl(182 75% 50%)" opacity="0.18" />
      <ellipse cx="580" cy="290" rx="820" ry="70" filter="url(#aur-lg)" fill="hsl(158 68% 47%)" opacity="0.15" />
      <ellipse cx="700" cy="440" rx="750" ry="60" filter="url(#aur-xl)" fill="hsl(172 65% 43%)" opacity="0.12" />
      <ellipse cx="620" cy="580" rx="680" ry="55" filter="url(#aur-lg)" fill="hsl(192 72% 50%)" opacity="0.09" />
      {/* Wavy highlight strokes */}
      <path d="M0,130 Q320,100 640,140 T1280,130" fill="none" stroke="hsl(182 75% 60%)" strokeWidth="1.5" opacity="0.14" />
      <path d="M0,290 Q280,260 640,295 T1280,285" fill="none" stroke="hsl(158 68% 55%)" strokeWidth="1.2" opacity="0.12" />
    </BgSvg>
  );
}

// 4. Forest — organic greens
function ForestBg() {
  return (
    <BgSvg>
      <defs>
        <pattern id="fst-dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
        </pattern>
        <filter id="fst-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="80" />
        </filter>
        <filter id="fst-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="60" />
        </filter>
        <filter id="fst-md" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="45" />
        </filter>
      </defs>
      <rect width={W} height={H} fill="url(#fst-dots)" style={{ color: "hsl(var(--foreground))", opacity: 0.06 }} />
      <ellipse cx="1100" cy="-60" rx="500" ry="400" filter="url(#fst-xl)" fill="hsl(142 55% 40%)" opacity="0.20" />
      <ellipse cx="150" cy="820" rx="440" ry="320" filter="url(#fst-lg)" fill="hsl(165 45% 45%)" opacity="0.17" />
      <ellipse cx="650" cy="380" rx="340" ry="240" filter="url(#fst-md)" fill="hsl(155 50% 35%)" opacity="0.12" />
      <circle cx="1280" cy="0" r="280" fill="none" stroke="hsl(142 55% 40%)" strokeWidth="1" opacity="0.18" />
      <circle cx="1280" cy="0" r="460" fill="none" stroke="hsl(142 55% 40%)" strokeWidth="0.75" opacity="0.10" />
    </BgSvg>
  );
}

// 5. Nebula — pink/purple/blue space clouds
function NebulaBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="neb-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="80" />
        </filter>
        <filter id="neb-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="60" />
        </filter>
      </defs>
      <Stars stars={STARS_NEBULA} />
      <ellipse cx="1000" cy="100" rx="600" ry="400" filter="url(#neb-xl)" fill="hsl(318 65% 60%)" opacity="0.22" />
      <ellipse cx="300" cy="500" rx="500" ry="360" filter="url(#neb-xl)" fill="hsl(278 60% 55%)" opacity="0.20" />
      <ellipse cx="850" cy="680" rx="400" ry="280" filter="url(#neb-lg)" fill="hsl(240 65% 56%)" opacity="0.16" />
    </BgSvg>
  );
}

// 6. Cosmos — blue/purple + orbital lines (accent-tinted)
function CosmosBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="cos-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="80" />
        </filter>
        <filter id="cos-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="60" />
        </filter>
      </defs>
      <Stars stars={STARS_COSMOS} />
      <ellipse cx="1100" cy="160" rx="560" ry="400" filter="url(#cos-xl)" fill="hsl(var(--primary))" opacity="0.22" />
      <ellipse cx="200" cy="620" rx="450" ry="340" filter="url(#cos-lg)" fill="hsl(265 58% 50%)" opacity="0.18" />
      {/* Orbital rings */}
      <ellipse cx="640" cy="400" rx="560" ry="180" fill="none" stroke="hsl(var(--primary))" strokeWidth="0.75" opacity="0.12" />
      <ellipse cx="640" cy="400" rx="400" ry="130" fill="none" stroke="hsl(var(--primary))" strokeWidth="0.5" opacity="0.08" />
    </BgSvg>
  );
}

// 7. Supernova — radial burst in top-right
function SupernovaBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="sn-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="65" />
        </filter>
        <filter id="sn-md" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="45" />
        </filter>
        <filter id="sn-sm" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="25" />
        </filter>
      </defs>
      <Stars stars={STARS_SUPERNOVA} />
      <ellipse cx="980" cy="160" rx="600" ry="500" filter="url(#sn-lg)" fill="hsl(0 85% 52%)" opacity="0.18" />
      <ellipse cx="980" cy="160" rx="380" ry="320" filter="url(#sn-md)" fill="hsl(25 95% 55%)" opacity="0.22" />
      <ellipse cx="980" cy="160" rx="200" ry="170" filter="url(#sn-sm)" fill="hsl(50 100% 62%)" opacity="0.28" />
      <ellipse cx="980" cy="160" rx="80" ry="70" filter="url(#sn-sm)" fill="hsl(60 100% 80%)" opacity="0.35" />
      {/* Rays */}
      {[0, 40, 80, 120, 160, 200, 240, 280, 320].map((deg, i) => {
        const rad = (deg * Math.PI) / 180;
        const x2 = 980 + 500 * Math.cos(rad);
        const y2 = 160 + 500 * Math.sin(rad);
        return (
          <line key={i} x1="980" y1="160" x2={x2.toFixed(0)} y2={y2.toFixed(0)}
            stroke="hsl(38 95% 60%)" strokeWidth="0.75" opacity="0.08" />
        );
      })}
    </BgSvg>
  );
}

// 8. Starfield — dense star dots
function StarfieldBg() {
  return (
    <BgSvg>
      <Stars stars={STARS_STARFIELD} />
    </BgSvg>
  );
}

// 9. Deep Space — atmospheric dark with tiny stars + subtle glow
function DeepSpaceBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="ds-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="90" />
        </filter>
        <filter id="ds-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="70" />
        </filter>
      </defs>
      <Stars stars={STARS_DEEPSPACE} />
      <ellipse cx="960" cy="200" rx="600" ry="450" filter="url(#ds-xl)" fill="hsl(225 50% 30%)" opacity="0.14" />
      <ellipse cx="320" cy="600" rx="480" ry="360" filter="url(#ds-lg)" fill="hsl(250 45% 28%)" opacity="0.12" />
    </BgSvg>
  );
}

// 10. Watercolor — multiple overlapping pastel blobs
function WatercolorBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="wc-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="70" />
        </filter>
        <filter id="wc-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="55" />
        </filter>
      </defs>
      <ellipse cx="260"  cy="160" rx="360" ry="260" filter="url(#wc-xl)" fill="hsl(340 60% 72%)" opacity="0.22" />
      <ellipse cx="900"  cy="100" rx="300" ry="220" filter="url(#wc-lg)" fill="hsl(48 78% 66%)"  opacity="0.20" />
      <ellipse cx="1100" cy="500" rx="360" ry="250" filter="url(#wc-xl)" fill="hsl(200 65% 66%)" opacity="0.20" />
      <ellipse cx="180"  cy="620" rx="320" ry="250" filter="url(#wc-lg)" fill="hsl(158 55% 62%)" opacity="0.18" />
      <ellipse cx="680"  cy="700" rx="400" ry="260" filter="url(#wc-xl)" fill="hsl(28 78% 66%)"  opacity="0.18" />
      <ellipse cx="620"  cy="300" rx="280" ry="200" filter="url(#wc-lg)" fill="hsl(275 52% 68%)" opacity="0.16" />
    </BgSvg>
  );
}

// 11. Neon — vivid cyan/magenta/lime
function NeonBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="neon-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="80" />
        </filter>
        <filter id="neon-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="60" />
        </filter>
      </defs>
      <ellipse cx="1100" cy="100" rx="520" ry="400" filter="url(#neon-xl)" fill="hsl(187 100% 52%)" opacity="0.28" />
      <ellipse cx="100"  cy="720" rx="420" ry="320" filter="url(#neon-lg)" fill="hsl(300 100% 52%)" opacity="0.25" />
      <ellipse cx="640"  cy="380" rx="360" ry="260" filter="url(#neon-xl)" fill="hsl(80 88% 52%)"  opacity="0.20" />
      <circle cx="1280" cy="0" r="320" fill="none" stroke="hsl(187 100% 52%)" strokeWidth="1.5" opacity="0.22" />
      <circle cx="1280" cy="0" r="520" fill="none" stroke="hsl(187 100% 52%)" strokeWidth="0.75" opacity="0.12" />
    </BgSvg>
  );
}

// 12. Prism — rainbow gradient with accent tint
function PrismBg() {
  return (
    <BgSvg>
      <defs>
        <linearGradient id="prism-grad" x1="0" y1="0" x2="1" y2="0.5" gradientUnits="objectBoundingBox">
          <stop offset="0%"   stopColor="hsl(0 80% 56%)"   />
          <stop offset="17%"  stopColor="hsl(30 90% 56%)"  />
          <stop offset="34%"  stopColor="hsl(58 85% 55%)"  />
          <stop offset="50%"  stopColor="hsl(120 68% 50%)" />
          <stop offset="67%"  stopColor="hsl(200 80% 55%)" />
          <stop offset="84%"  stopColor="hsl(240 70% 60%)" />
          <stop offset="100%" stopColor="hsl(280 70% 60%)" />
        </linearGradient>
        <filter id="prism-blur" x="-5%" y="-5%" width="110%" height="110%">
          <feGaussianBlur stdDeviation="15" />
        </filter>
      </defs>
      <rect width={W} height={H} fill="url(#prism-grad)" opacity="0.13" />
      {/* Refraction streak */}
      <rect x="-100" y="150" width="1600" height="60" fill="url(#prism-grad)"
        transform="rotate(-8 640 400)" filter="url(#prism-blur)" opacity="0.18" />
      <rect x="-100" y="300" width="1600" height="30" fill="url(#prism-grad)"
        transform="rotate(-8 640 400)" filter="url(#prism-blur)" opacity="0.10" />
    </BgSvg>
  );
}

// 13. Geometric — large polygon shapes (accent-tinted)
function GeometricBg() {
  return (
    <BgSvg>
      {/* Large triangle top-right */}
      <polygon points="1280,0 880,0 1280,480" fill="hsl(var(--primary))" opacity="0.06" />
      <polygon points="1280,0 1060,0 1280,280" fill="hsl(var(--primary))" opacity="0.06" />
      {/* Large triangle bottom-left */}
      <polygon points="0,800 400,800 0,360" fill="hsl(var(--primary))" opacity="0.06" />
      <polygon points="0,800 220,800 0,560" fill="hsl(var(--primary))" opacity="0.06" />
      {/* Diagonal lines */}
      <line x1="0" y1="0" x2="1280" y2="800" stroke="hsl(var(--primary))" strokeWidth="1" opacity="0.08" />
      <line x1="0" y1="160" x2="1120" y2="800" stroke="hsl(var(--primary))" strokeWidth="0.75" opacity="0.06" />
      <line x1="160" y1="0" x2="1280" y2="640" stroke="hsl(var(--primary))" strokeWidth="0.75" opacity="0.06" />
      <line x1="0" y1="800" x2="1280" y2="0" stroke="hsl(var(--primary))" strokeWidth="1" opacity="0.06" />
      {/* Corner diamond */}
      <polygon points="1280,0 1160,200 1280,400" fill="none" stroke="hsl(var(--primary))" strokeWidth="1" opacity="0.12" />
    </BgSvg>
  );
}

// 14. Mesh — overlapping radial colour mesh (accent-tinted)
function MeshBg() {
  return (
    <BgSvg>
      <defs>
        <radialGradient id="mesh-a" cx="20%" cy="20%" r="60%">
          <stop offset="0%"   stopColor="hsl(var(--primary))" stopOpacity="0.25" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mesh-b" cx="80%" cy="80%" r="55%">
          <stop offset="0%"   stopColor="hsl(258 60% 58%)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="hsl(258 60% 58%)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mesh-c" cx="75%" cy="25%" r="50%">
          <stop offset="0%"   stopColor="hsl(var(--primary))" stopOpacity="0.18" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mesh-d" cx="25%" cy="75%" r="50%">
          <stop offset="0%"   stopColor="hsl(220 70% 58%)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="hsl(220 70% 58%)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill="url(#mesh-a)" />
      <rect width={W} height={H} fill="url(#mesh-b)" />
      <rect width={W} height={H} fill="url(#mesh-c)" />
      <rect width={W} height={H} fill="url(#mesh-d)" />
    </BgSvg>
  );
}

// 15. Honeycomb — computed hex grid (accent-tinted)
function HoneycombBg() {
  const paths = useMemo(() => {
    const r = 48, h = r * Math.sqrt(3) / 2;
    const colSpacing = 2 * h, rowSpacing = 1.5 * r;
    const result: string[] = [];
    for (let row = -1; row <= Math.ceil(H / rowSpacing) + 1; row++) {
      for (let col = -1; col <= Math.ceil(W / colSpacing) + 1; col++) {
        const cx = col * colSpacing + (row % 2 === 0 ? 0 : h);
        const cy = row * rowSpacing;
        result.push(
          `M${cx.toFixed(1)},${(cy - r).toFixed(1)} ` +
          `L${(cx + h).toFixed(1)},${(cy - r / 2).toFixed(1)} ` +
          `L${(cx + h).toFixed(1)},${(cy + r / 2).toFixed(1)} ` +
          `L${cx.toFixed(1)},${(cy + r).toFixed(1)} ` +
          `L${(cx - h).toFixed(1)},${(cy + r / 2).toFixed(1)} ` +
          `L${(cx - h).toFixed(1)},${(cy - r / 2).toFixed(1)} Z`
        );
      }
    }
    return result;
  }, []);

  return (
    <BgSvg>
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="hsl(var(--primary))" strokeWidth="0.8" opacity="0.14" />
      ))}
    </BgSvg>
  );
}

// 16. Waves — sine wave lines (accent-tinted)
function WavesBg() {
  const wavePaths = useMemo(() => {
    return Array.from({ length: 10 }, (_, i) => {
      const baseY = 60 + i * 82;
      const amplitude = 22 + i * 4;
      const freq = 0.0035 + i * 0.0003;
      const phase = i * 1.1;
      const pts = Array.from({ length: 130 }, (_, j) => {
        const x = j * 10;
        const y = baseY + amplitude * Math.sin(x * freq * Math.PI * 2 + phase);
        return `${j === 0 ? "M" : "L"}${x},${y.toFixed(1)}`;
      });
      return pts.join(" ");
    });
  }, []);

  return (
    <BgSvg>
      {wavePaths.map((d, i) => (
        <path
          key={i} d={d} fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth={i % 3 === 0 ? 1.2 : 0.75}
          opacity={0.08 + (i % 3) * 0.03}
        />
      ))}
    </BgSvg>
  );
}

// 17. Circuit — PCB-style traces (accent-tinted)
function CircuitBg() {
  const { lines, dots } = useMemo(() => {
    const tileW = 80, tileH = 80;
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const dots: { cx: number; cy: number }[] = [];

    // Deterministic pseudo-random using seed
    const rand = (seed: number) => {
      const x = Math.sin(seed) * 10000;
      return x - Math.floor(x);
    };

    let seed = 0;
    for (let row = 0; row * tileH <= H + tileH; row++) {
      for (let col = 0; col * tileW <= W + tileW; col++) {
        const x = col * tileW;
        const y = row * tileH;
        const r = rand(seed++);
        if (r < 0.4) {
          // Horizontal then vertical (L-shape)
          const midX = x + tileW * 0.6;
          lines.push({ x1: x, y1: y + 20, x2: midX, y2: y + 20 });
          lines.push({ x1: midX, y1: y + 20, x2: midX, y2: y + tileH });
          dots.push({ cx: x, cy: y + 20 });
          dots.push({ cx: midX, cy: y + 20 });
        } else if (r < 0.7) {
          // Vertical then horizontal
          const midY = y + tileH * 0.4;
          lines.push({ x1: x + 40, y1: y, x2: x + 40, y2: midY });
          lines.push({ x1: x + 40, y1: midY, x2: x + tileW, y2: midY });
          dots.push({ cx: x + 40, cy: midY });
          dots.push({ cx: x + tileW, cy: midY });
        }
        seed++;
      }
    }
    return { lines, dots };
  }, []);

  return (
    <BgSvg>
      {lines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="hsl(var(--primary))" strokeWidth="0.8" opacity="0.14" />
      ))}
      {dots.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r="2.5"
          fill="none" stroke="hsl(var(--primary))" strokeWidth="0.8" opacity="0.18" />
      ))}
    </BgSvg>
  );
}

// 18. Blueprint — engineering grid
function BlueprintBg() {
  const { minorLines, majorLines } = useMemo(() => {
    const minor: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const major: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const step = 40;
    for (let x = 0; x <= W; x += step) {
      (x % 200 === 0 ? major : minor).push({ x1: x, y1: 0, x2: x, y2: H });
    }
    for (let y = 0; y <= H; y += step) {
      (y % 200 === 0 ? major : minor).push({ x1: 0, y1: y, x2: W, y2: y });
    }
    return { minorLines: minor, majorLines: major };
  }, []);

  return (
    <BgSvg>
      {minorLines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="hsl(210 75% 52%)" strokeWidth="0.5" opacity="0.10" />
      ))}
      {majorLines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="hsl(210 75% 52%)" strokeWidth="1" opacity="0.18" />
      ))}
      {/* Center crosshair marks */}
      {Array.from({ length: Math.ceil(W / 200) + 1 }, (_, ci) =>
        Array.from({ length: Math.ceil(H / 200) + 1 }, (_, ri) => {
          const cx = ci * 200, cy = ri * 200;
          return (
            <g key={`${ci}-${ri}`}>
              <line x1={cx - 6} y1={cy} x2={cx + 6} y2={cy} stroke="hsl(210 75% 52%)" strokeWidth="0.8" opacity="0.25" />
              <line x1={cx} y1={cy - 6} x2={cx} y2={cy + 6} stroke="hsl(210 75% 52%)" strokeWidth="0.8" opacity="0.25" />
            </g>
          );
        })
      )}
    </BgSvg>
  );
}

// 19. Topographic — concentric contour lines (accent-tinted)
function TopographicBg() {
  const curves = useMemo(() => {
    return Array.from({ length: 18 }, (_, i) => {
      const scaleA = 80 + i * 55;
      const scaleB = 60 + i * 45;
      return { scaleA, scaleB, opacity: 0.20 - i * 0.007 };
    });
  }, []);

  return (
    <BgSvg>
      {curves.map((c, i) => (
        <g key={i}>
          <ellipse cx="900" cy="-50" rx={c.scaleA} ry={c.scaleA * 0.7}
            fill="none" stroke="hsl(var(--primary))" strokeWidth="0.75"
            opacity={Math.max(c.opacity, 0.04)}
            transform={`rotate(${i * 7}, 900, -50)`}
          />
          <ellipse cx="200" cy="850" rx={c.scaleB} ry={c.scaleB * 0.65}
            fill="none" stroke="hsl(var(--primary))" strokeWidth="0.75"
            opacity={Math.max(c.opacity * 0.8, 0.03)}
            transform={`rotate(${i * -5}, 200, 850)`}
          />
        </g>
      ))}
    </BgSvg>
  );
}

// ── JWST star fields & galaxy helper ──────────────────────────────────────────

const STARS_CARINA        = makeStars(220, 333, 0.3, 2.2);
const STARS_PILLARS       = makeStars(200, 557, 0.3, 1.8);
const STARS_SOUTHERN_RING = makeStars(130, 889, 0.4, 1.6);
const STARS_PHANTOM       = makeStars( 90, 123, 0.3, 1.4);
const STARS_TARANTULA     = makeStars(280, 777, 0.3, 2.4);
const STARS_DEEP_BG       = makeStars( 60, 444, 0.3, 1.0);
const STARS_STEPHANS      = makeStars( 80, 666, 0.3, 1.2);
const STARS_CARTWHEEL     = makeStars( 90, 999, 0.3, 1.4);

const JWST_STAR_COLOR = "hsl(220 30% 92%)";

interface GalaxyShape {
  x: number; y: number; rx: number; ry: number;
  rot: number; color: string; opacity: number;
}
const GALAXY_PALETTE = [
  "hsl(45 90% 68%)", "hsl(200 80% 68%)", "hsl(340 70% 68%)",
  "hsl(25 85% 62%)", "hsl(270 65% 68%)", "hsl(160 65% 62%)",
  "hsl(0 72% 65%)",  "hsl(240 75% 72%)",
];
function makeGalaxies(count: number, seed: number): GalaxyShape[] {
  const rand = (n: number) => { const x = Math.sin(n) * 43758.5453; return x - Math.floor(x); };
  return Array.from({ length: count }, (_, i) => ({
    x:       rand(seed + i * 7 + 0) * W,
    y:       rand(seed + i * 7 + 1) * H,
    rx:      5  + rand(seed + i * 7 + 2) * 22,
    ry:      2  + rand(seed + i * 7 + 3) * 7,
    rot:     rand(seed + i * 7 + 4) * 180,
    color:   GALAXY_PALETTE[Math.floor(rand(seed + i * 7 + 5) * GALAXY_PALETTE.length)],
    opacity: 0.28 + rand(seed + i * 7 + 6) * 0.55,
  }));
}
const DEEP_FIELD_GALAXIES = makeGalaxies(90, 444);

// ── JWST backgrounds ───────────────────────────────────────────────────────────

// Webb 1: Carina Nebula — Cosmic Cliffs
// Orange-rust cliff of gas in the lower half, teal-blue upper atmosphere, stars bursting out.
function JWSTCarinaBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="car-xl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="85" /></filter>
        <filter id="car-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55" /></filter>
        <filter id="car-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="35" /></filter>
      </defs>
      {/* Upper teal atmosphere */}
      <ellipse cx="640"  cy="100"  rx="900" ry="300" filter="url(#car-xl)" fill="hsl(188 72% 42%)" opacity="0.22" />
      <ellipse cx="900"  cy="50"   rx="600" ry="200" filter="url(#car-lg)" fill="hsl(200 78% 48%)" opacity="0.18" />
      {/* The cliff — dense orange-rust cloud mass at the bottom */}
      <ellipse cx="640"  cy="780"  rx="900" ry="380" filter="url(#car-xl)" fill="hsl(20  82% 42%)" opacity="0.38" />
      <ellipse cx="300"  cy="700"  rx="500" ry="280" filter="url(#car-lg)" fill="hsl(15  78% 36%)" opacity="0.30" />
      <ellipse cx="980"  cy="720"  rx="480" ry="250" filter="url(#car-lg)" fill="hsl(28  85% 48%)" opacity="0.25" />
      {/* Cliff edge — brighter gas where stars are forming */}
      <ellipse cx="640"  cy="480"  rx="700" ry="90"  filter="url(#car-md)" fill="hsl(38  90% 60%)" opacity="0.18" />
      <ellipse cx="400"  cy="440"  rx="300" ry="60"  filter="url(#car-md)" fill="hsl(45  95% 68%)" opacity="0.14" />
      {/* Stars — concentrated near the cliff edge, sparser above */}
      <Stars stars={STARS_CARINA} color={JWST_STAR_COLOR} />
    </BgSvg>
  );
}

// Webb 2: Pillars of Creation
// Three iconic dark dust columns rising from orange gas. Purple-blue outer nebula.
function JWSTPillarsBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="pil-xl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="80" /></filter>
        <filter id="pil-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55" /></filter>
        <filter id="pil-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30" /></filter>
      </defs>
      {/* Outer purple-blue nebula */}
      <ellipse cx="640"  cy="400" rx="800" ry="500" filter="url(#pil-xl)" fill="hsl(268 58% 45%)" opacity="0.28" />
      <ellipse cx="200"  cy="300" rx="400" ry="350" filter="url(#pil-lg)" fill="hsl(220 68% 48%)" opacity="0.20" />
      <ellipse cx="1100" cy="500" rx="380" ry="300" filter="url(#pil-lg)" fill="hsl(240 65% 48%)" opacity="0.18" />
      {/* Surrounding warm orange-rust gas */}
      <ellipse cx="640"  cy="600" rx="700" ry="350" filter="url(#pil-xl)" fill="hsl(20  78% 40%)" opacity="0.30" />
      <ellipse cx="400"  cy="500" rx="400" ry="280" filter="url(#pil-lg)" fill="hsl(15  75% 36%)" opacity="0.22" />
      {/* The pillars — tall dark dust columns */}
      <ellipse cx="420"  cy="550" rx="55"  ry="280" filter="url(#pil-md)" fill="hsl(18  65% 22%)" opacity="0.55" />
      <ellipse cx="640"  cy="600" rx="45"  ry="320" filter="url(#pil-md)" fill="hsl(16  60% 20%)" opacity="0.55" />
      <ellipse cx="840"  cy="580" rx="38"  ry="260" filter="url(#pil-md)" fill="hsl(20  62% 24%)" opacity="0.50" />
      {/* Glowing pillar tips */}
      <ellipse cx="420"  cy="270" rx="40"  ry="25"  filter="url(#pil-md)" fill="hsl(38  90% 62%)" opacity="0.25" />
      <ellipse cx="640"  cy="280" rx="35"  ry="20"  filter="url(#pil-md)" fill="hsl(40  88% 60%)" opacity="0.22" />
      <ellipse cx="840"  cy="320" rx="30"  ry="18"  filter="url(#pil-md)" fill="hsl(36  85% 58%)" opacity="0.20" />
      <Stars stars={STARS_PILLARS} color={JWST_STAR_COLOR} />
    </BgSvg>
  );
}

// Webb 3: Southern Ring Nebula
// Concentric rings from a dying star. Blue inner ring, orange outer ring.
function JWSTSouthernRingBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="sr-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="50" /></filter>
        <filter id="sr-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="28" /></filter>
        <filter id="sr-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="12" /></filter>
      </defs>
      <Stars stars={STARS_SOUTHERN_RING} color={JWST_STAR_COLOR} />
      {/* Outermost ring — red-orange */}
      <ellipse cx="640" cy="400" rx="480" ry="340" fill="none"
        stroke="hsl(12 88% 52%)" strokeWidth="60" filter="url(#sr-lg)" opacity="0.22" />
      {/* Outer ring — rose */}
      <ellipse cx="640" cy="400" rx="380" ry="270" fill="none"
        stroke="hsl(340 75% 58%)" strokeWidth="45" filter="url(#sr-md)" opacity="0.28" />
      {/* Mid ring — blue */}
      <ellipse cx="640" cy="400" rx="270" ry="192" fill="none"
        stroke="hsl(208 82% 58%)" strokeWidth="50" filter="url(#sr-md)" opacity="0.32" />
      {/* Inner ring — vivid cyan */}
      <ellipse cx="640" cy="400" rx="160" ry="114" fill="none"
        stroke="hsl(192 90% 62%)" strokeWidth="40" filter="url(#sr-sm)" opacity="0.38" />
      {/* Central dying star glow */}
      <ellipse cx="640" cy="400" rx="55"  ry="40"  filter="url(#sr-sm)" fill="hsl(48 100% 78%)" opacity="0.55" />
      <ellipse cx="640" cy="400" rx="20"  ry="14"  filter="url(#sr-sm)" fill="hsl(0   0% 100%)" opacity="0.70" />
      {/* Faint outer shell */}
      <ellipse cx="640" cy="400" rx="570" ry="405" fill="none"
        stroke="hsl(25 70% 48%)" strokeWidth="30" filter="url(#sr-lg)" opacity="0.12" />
    </BgSvg>
  );
}

// Webb 4: Phantom Galaxy (M74)
// Clean spiral structure — golden core, blue star-forming arms, pink outer dust.
function JWSTPhantomBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="ph-xl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="75" /></filter>
        <filter id="ph-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="45" /></filter>
        <filter id="ph-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22" /></filter>
        <filter id="ph-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10" /></filter>
      </defs>
      <Stars stars={STARS_PHANTOM} color={JWST_STAR_COLOR} />
      {/* Outer faint halo */}
      <ellipse cx="640" cy="400" rx="420" ry="380" filter="url(#ph-xl)" fill="hsl(270 45% 40%)" opacity="0.18" />
      {/* Outer spiral arm traces — pink/rose dust */}
      <ellipse cx="640" cy="400" rx="340" ry="200" filter="url(#ph-lg)" fill="hsl(330 68% 55%)" opacity="0.20"
        transform="rotate(35 640 400)" />
      <ellipse cx="640" cy="400" rx="300" ry="170" filter="url(#ph-lg)" fill="hsl(350 65% 52%)" opacity="0.18"
        transform="rotate(-40 640 400)" />
      {/* Mid spiral arms — blue star-forming regions */}
      <ellipse cx="640" cy="400" rx="240" ry="120" filter="url(#ph-md)" fill="hsl(205 82% 58%)" opacity="0.28"
        transform="rotate(20 640 400)" />
      <ellipse cx="640" cy="400" rx="210" ry="100" filter="url(#ph-md)" fill="hsl(215 78% 55%)" opacity="0.24"
        transform="rotate(-55 640 400)" />
      {/* Inner arms — brighter blue */}
      <ellipse cx="640" cy="400" rx="140" ry="55"  filter="url(#ph-md)" fill="hsl(195 88% 62%)" opacity="0.30"
        transform="rotate(10 640 400)" />
      <ellipse cx="640" cy="400" rx="120" ry="48"  filter="url(#ph-md)" fill="hsl(200 85% 60%)" opacity="0.26"
        transform="rotate(-70 640 400)" />
      {/* Bright golden core */}
      <ellipse cx="640" cy="400" rx="60"  ry="52"  filter="url(#ph-sm)" fill="hsl(45 95% 72%)"  opacity="0.55" />
      <ellipse cx="640" cy="400" rx="22"  ry="18"  filter="url(#ph-sm)" fill="hsl(50 100% 85%)" opacity="0.80" />
    </BgSvg>
  );
}

// Webb 5: Tarantula Nebula (30 Doradus)
// Vivid blue-white core of hot young stars, orange-red surrounding gas, dense star field.
function JWSTTarantulaBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="tar-xl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="85" /></filter>
        <filter id="tar-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55" /></filter>
        <filter id="tar-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30" /></filter>
        <filter id="tar-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14" /></filter>
      </defs>
      {/* Outer diffuse gas clouds — orange and red */}
      <ellipse cx="640"  cy="380" rx="800" ry="550" filter="url(#tar-xl)" fill="hsl(15  80% 42%)" opacity="0.25" />
      <ellipse cx="380"  cy="300" rx="500" ry="380" filter="url(#tar-lg)" fill="hsl(8   75% 38%)" opacity="0.22" />
      <ellipse cx="920"  cy="500" rx="420" ry="320" filter="url(#tar-lg)" fill="hsl(22  82% 45%)" opacity="0.20" />
      {/* Streaming gas filaments */}
      <ellipse cx="200"  cy="200" rx="350" ry="120" filter="url(#tar-md)" fill="hsl(340 65% 50%)" opacity="0.20"
        transform="rotate(-25 200 200)" />
      <ellipse cx="1050" cy="600" rx="320" ry="100" filter="url(#tar-md)" fill="hsl(30  80% 52%)" opacity="0.18"
        transform="rotate(20 1050 600)" />
      {/* Central hot nebula — blue-white */}
      <ellipse cx="640"  cy="380" rx="300" ry="240" filter="url(#tar-lg)" fill="hsl(198 90% 55%)" opacity="0.35" />
      <ellipse cx="640"  cy="380" rx="160" ry="130" filter="url(#tar-md)" fill="hsl(205 95% 65%)" opacity="0.42" />
      {/* Blazing core cluster */}
      <ellipse cx="640"  cy="380" rx="70"  ry="58"  filter="url(#tar-sm)" fill="hsl(210 100% 80%)" opacity="0.60" />
      <ellipse cx="640"  cy="380" rx="28"  ry="22"  filter="url(#tar-sm)" fill="hsl(0   0%  100%)" opacity="0.75" />
      <Stars stars={STARS_TARANTULA} color={JWST_STAR_COLOR} />
    </BgSvg>
  );
}

// Webb 6: JWST Deep Field — thousands of galaxies at all distances
function JWSTDeepFieldBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="df-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>
      {/* Background stars */}
      <Stars stars={STARS_DEEP_BG} color={JWST_STAR_COLOR} />
      {/* Galaxy shapes — each a small rotated ellipse */}
      {DEEP_FIELD_GALAXIES.map((g, i) => (
        <ellipse key={i}
          cx={g.x.toFixed(1)} cy={g.y.toFixed(1)}
          rx={g.rx.toFixed(1)} ry={g.ry.toFixed(1)}
          fill={g.color} opacity={g.opacity.toFixed(2)}
          transform={`rotate(${g.rot.toFixed(0)}, ${g.x.toFixed(1)}, ${g.y.toFixed(1)})`}
          filter="url(#df-sm)"
        />
      ))}
      {/* A few larger foreground galaxies */}
      <ellipse cx="240"  cy="180" rx="38" ry="12" fill="hsl(45 90% 68%)"  opacity="0.55"
        transform="rotate(25 240 180)"  filter="url(#df-sm)" />
      <ellipse cx="960"  cy="580" rx="45" ry="14" fill="hsl(200 80% 68%)" opacity="0.52"
        transform="rotate(-40 960 580)" filter="url(#df-sm)" />
      <ellipse cx="520"  cy="640" rx="30" ry="10" fill="hsl(340 70% 68%)" opacity="0.48"
        transform="rotate(60 520 640)"  filter="url(#df-sm)" />
      <ellipse cx="860"  cy="150" rx="35" ry="11" fill="hsl(270 65% 68%)" opacity="0.50"
        transform="rotate(-15 860 150)" filter="url(#df-sm)" />
    </BgSvg>
  );
}

// Webb 7: Stephan's Quintet — five galaxies in close proximity with a blue shock wave
function JWSTStephansBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="sq-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55" /></filter>
        <filter id="sq-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30" /></filter>
        <filter id="sq-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14" /></filter>
      </defs>
      <Stars stars={STARS_STEPHANS} color={JWST_STAR_COLOR} />
      {/* The five galaxies */}
      {/* NGC 7320 — foreground galaxy, bluer */}
      <ellipse cx="260"  cy="560" rx="110" ry="65"  filter="url(#sq-md)" fill="hsl(210 75% 58%)" opacity="0.42"
        transform="rotate(-20 260 560)" />
      {/* NGC 7318a — interacting pair */}
      <ellipse cx="700"  cy="340" rx="90"  ry="55"  filter="url(#sq-md)" fill="hsl(45  88% 62%)" opacity="0.45"
        transform="rotate(15 700 340)" />
      {/* NGC 7318b — interacting with a */}
      <ellipse cx="800"  cy="420" rx="80"  ry="48"  filter="url(#sq-md)" fill="hsl(38  82% 58%)" opacity="0.40"
        transform="rotate(-10 800 420)" />
      {/* NGC 7319 */}
      <ellipse cx="980"  cy="260" rx="75"  ry="50"  filter="url(#sq-md)" fill="hsl(28  80% 55%)" opacity="0.42"
        transform="rotate(30 980 260)" />
      {/* NGC 7317 */}
      <ellipse cx="580"  cy="580" rx="65"  ry="40"  filter="url(#sq-md)" fill="hsl(270 62% 58%)" opacity="0.38"
        transform="rotate(-35 580 580)" />
      {/* Blue intergalactic shock wave between the interacting pair */}
      <ellipse cx="760"  cy="400" rx="200" ry="320" filter="url(#sq-lg)" fill="hsl(212 88% 55%)" opacity="0.22"
        transform="rotate(8 760 400)" />
      <ellipse cx="760"  cy="400" rx="120" ry="220" filter="url(#sq-md)" fill="hsl(205 92% 62%)" opacity="0.18"
        transform="rotate(8 760 400)" />
      {/* Intergalactic gas streams */}
      <ellipse cx="640"  cy="450" rx="500" ry="80"  filter="url(#sq-lg)" fill="hsl(35  72% 50%)" opacity="0.14"
        transform="rotate(-5 640 450)" />
    </BgSvg>
  );
}

// Webb 8: Cartwheel Galaxy — ring galaxy with vivid outer ring and radial spokes
function JWSTCartwheelBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="cw-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="50" /></filter>
        <filter id="cw-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="25" /></filter>
        <filter id="cw-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10" /></filter>
      </defs>
      <Stars stars={STARS_CARTWHEEL} color={JWST_STAR_COLOR} />
      {/* Outer halo glow */}
      <ellipse cx="640" cy="400" rx="440" ry="400" filter="url(#cw-lg)" fill="hsl(330 60% 45%)" opacity="0.18" />
      {/* Outer ring — pink/rose with hot star-forming clumps */}
      <ellipse cx="640" cy="400" rx="360" ry="328" fill="none"
        stroke="hsl(328 75% 58%)" strokeWidth="48" filter="url(#cw-md)" opacity="0.38" />
      {/* Outer ring texture — bright blue spots (young stars) */}
      <ellipse cx="640" cy="400" rx="360" ry="328" fill="none"
        stroke="hsl(195 85% 65%)" strokeWidth="20" filter="url(#cw-sm)" opacity="0.28" />
      {/* Radial spokes */}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
        const rad = (deg * Math.PI) / 180;
        const x1 = 640 + 110 * Math.cos(rad), y1 = 400 + 100 * Math.sin(rad);
        const x2 = 640 + 330 * Math.cos(rad), y2 = 400 + 300 * Math.sin(rad);
        return (
          <line key={i}
            x1={x1.toFixed(1)} y1={y1.toFixed(1)}
            x2={x2.toFixed(1)} y2={y2.toFixed(1)}
            stroke="hsl(32 78% 55%)" strokeWidth="6"
            filter="url(#cw-sm)" opacity="0.22" />
        );
      })}
      {/* Inner ring */}
      <ellipse cx="640" cy="400" rx="110" ry="100" fill="none"
        stroke="hsl(200 80% 60%)" strokeWidth="30" filter="url(#cw-md)" opacity="0.38" />
      {/* Core */}
      <ellipse cx="640" cy="400" rx="45"  ry="40"  filter="url(#cw-sm)" fill="hsl(45 95% 72%)"  opacity="0.60" />
      <ellipse cx="640" cy="400" rx="16"  ry="14"  filter="url(#cw-sm)" fill="hsl(0  0%  100%)" opacity="0.80" />
      {/* Companion galaxies */}
      <ellipse cx="980" cy="200" rx="28" ry="18" filter="url(#cw-sm)" fill="hsl(45 85% 65%)" opacity="0.42"
        transform="rotate(30 980 200)" />
      <ellipse cx="250" cy="600" rx="22" ry="14" filter="url(#cw-sm)" fill="hsl(200 75% 62%)" opacity="0.38"
        transform="rotate(-20 250 600)" />
    </BgSvg>
  );
}

// 20. Dots — enhanced dot grid (accent-tinted)
function DotsBg() {
  return (
    <BgSvg>
      <defs>
        {/* Small dots */}
        <pattern id="dots-sm" x="0" y="0" width="30" height="30" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
        </pattern>
        {/* Large accent dots */}
        <pattern id="dots-lg" x="0" y="0" width="120" height="120" patternUnits="userSpaceOnUse">
          <circle cx="60" cy="60" r="3.5" fill="hsl(var(--primary))" opacity="0.25" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#dots-sm)" style={{ color: "hsl(var(--foreground))", opacity: 0.10 }} />
      <rect width={W} height={H} fill="url(#dots-lg)" />
    </BgSvg>
  );
}

// 21. None — plain
function NoneBg() {
  return null;
}

// ── Shooting Stars overlay (space & jwst categories only) ─────────────────────

interface SStar {
  id: number;
  x: number;        // start position, % of viewport width
  y: number;        // start position, % of viewport height
  angle: number;    // travel direction in degrees from +x axis
  length: number;   // streak length in px
  travel: number;   // total distance travelled in px
  duration: number; // animation duration in ms
  delay: number;    // animation delay in ms (used to stagger pairs)
}

const SS_KF_ID = "meridian-ss-kf";
const SS_FIRE_EVENT = "meridian-ss-fire";

export function fireShootingStar() {
  window.dispatchEvent(new CustomEvent(SS_FIRE_EVENT));
}

function ensureSSKeyframes() {
  if (document.getElementById(SS_KF_ID)) return;
  const el = document.createElement("style");
  el.id = SS_KF_ID;
  el.textContent = `
    @keyframes meridian-ss {
      0%   { transform: translate(0,0); opacity: 0; }
      8%   { opacity: 1; }
      80%  { opacity: 0.8; }
      100% { transform: translate(var(--ss-tx),var(--ss-ty)); opacity: 0; }
    }
  `;
  document.head.appendChild(el);
}

let ssIdCounter = 0;

function ShootingStarEl({ star, onDone }: { star: SStar; onDone: () => void }) {
  const { x, y, angle, length, travel, duration, delay } = star;
  const rad = (angle * Math.PI) / 180;
  const tx = Math.cos(rad) * travel;
  const ty = Math.sin(rad) * travel;

  React.useEffect(() => {
    const t = setTimeout(onDone, duration + delay + 300);
    return () => clearTimeout(t);
  }, [duration, delay, onDone]);

  return (
    <div
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        animationName: "meridian-ss",
        animationDuration: `${duration}ms`,
        animationDelay: `${delay}ms`,
        animationTimingFunction: "ease-out",
        animationFillMode: "both",
        "--ss-tx": `${tx}px`,
        "--ss-ty": `${ty}px`,
      } as React.CSSProperties}
    >
      <div
        style={{
          width: `${length}px`,
          height: "1.5px",
          background:
            "linear-gradient(90deg, transparent 0%, rgba(200,220,255,0.6) 60%, rgba(255,255,255,0.95) 100%)",
          borderRadius: "9999px",
          transform: `rotate(${angle}deg)`,
          transformOrigin: "left center",
          boxShadow: "0 0 4px 1px rgba(180,210,255,0.25)",
        }}
      />
    </div>
  );
}

const SPACE_BG_CATEGORIES: BgCategory[] = ["space", "jwst"];

export function ShootingStarOverlay({ bgId }: { bgId: string }) {
  const isSpace = React.useMemo(() => {
    const def = BACKGROUNDS.find((b) => b.id === bgId);
    return def ? SPACE_BG_CATEGORIES.includes(def.category) : false;
  }, [bgId]);

  const [stars, setStars] = React.useState<SStar[]>([]);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const spawnStars = React.useCallback((count: number) => {
    const r = Math.random;
    setStars((prev) => [
      ...prev,
      ...Array.from({ length: count }, (_, i): SStar => {
        const angle = 25 + r() * 30;
        return {
          id: ssIdCounter++,
          x: 5 + r() * 60,
          y: 3 + r() * 38,
          angle,
          length: 60 + r() * 110,
          travel: 350 + r() * 400,
          duration: 500 + r() * 400,
          delay: i * (70 + r() * 110),
        };
      }),
    ]);
  }, []);

  // Listen for manual fire events (used by test button)
  React.useEffect(() => {
    const handler = () => { ensureSSKeyframes(); spawnStars(1 + Math.floor(Math.random() * 3)); };
    window.addEventListener(SS_FIRE_EVENT, handler);
    return () => window.removeEventListener(SS_FIRE_EVENT, handler);
  }, [spawnStars]);

  React.useEffect(() => {
    if (!isSpace) {
      setStars([]);
      return;
    }
    ensureSSKeyframes();

    function schedule() {
      timerRef.current = setTimeout(() => {
        spawnStars(Math.random() < 0.25 ? 2 : 1);
        schedule();
      }, 2500 + Math.random() * 5500); // fire every 2.5–8 s
    }

    schedule();
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    };
  }, [isSpace, spawnStars]);

  const removeStar = React.useCallback((id: number) => {
    setStars((p) => p.filter((s) => s.id !== id));
  }, []);

  if (!isSpace) return null;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      {stars.map((s) => (
        <ShootingStarEl key={s.id} star={s} onDone={() => removeStar(s.id)} />
      ))}
    </div>
  );
}

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
