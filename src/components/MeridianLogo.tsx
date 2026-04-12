import type { CSSProperties } from "react";

// ── Coordinate space: 960 × 116 ───────────────────────────────────────────────
//
// Nodes are placed near the top of the viewBox so they sit fully within the
// visible header area. The arc curves *downward* below them (bowl / smile
// shape), dipping out of view below the header boundary.
//
// Arc:  M -10 54  C 240 105  720 105  970 54
//   → starts at y = 54 at both edges, dips to y ≈ 93 at centre.
//
// Node positions (all well above the clipping boundary):
//   (89,  48)  outer-left   r = 8
//   (245, 38)  inner-left   r = 8
//   (480, 24)  centre       r = 12  (+halo r = 20)
//   (725, 38)  inner-right  r = 8
//   (881, 48)  outer-right  r = 8
// ─────────────────────────────────────────────────────────────────────────────

const ARC = "M -10 54 C 240 105 720 105 970 54";

const NODES = [
  { cx: 89,  cy: 48, r: 8,  opacity: 0.85 },
  { cx: 245, cy: 38, r: 8,  opacity: 0.85 },
  { cx: 480, cy: 24, r: 12, opacity: 1    },
  { cx: 725, cy: 38, r: 8,  opacity: 0.85 },
  { cx: 881, cy: 48, r: 8,  opacity: 0.85 },
] as const;

const CENTER = NODES[2];

interface MeridianLogoProps {
  className?: string;
  style?: CSSProperties;
}

export function MeridianLogo({ className, style }: MeridianLogoProps) {
  return (
    <svg
      viewBox="0 0 960 116"
      preserveAspectRatio="xMinYMin meet"
      aria-label="Meridian logo"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <defs>
        <linearGradient id="ml-arcgrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "hsl(var(--primary))", stopOpacity: 0.6 }} />
          <stop offset="1" style={{ stopColor: "hsl(var(--primary))" }} />
        </linearGradient>
      </defs>

      {/* Arc — drawn first so nodes render on top of it */}
      <path d={ARC} fill="none" stroke="url(#ml-arcgrad)" strokeWidth="5" strokeLinecap="round" />

      {/* Nodes */}
      {NODES.map((n, i) => (
        <circle key={i} cx={n.cx} cy={n.cy} r={n.r} opacity={n.opacity}
          style={{ fill: "hsl(var(--primary))" }} />
      ))}

      {/* Halo ring around centre node */}
      <circle cx={CENTER.cx} cy={CENTER.cy} r={20}
        fill="none" strokeWidth="2" strokeOpacity={0.4}
        style={{ stroke: "hsl(var(--primary))" }} />
    </svg>
  );
}
