import React from "react";

export const W = 1280, H = 800;

// ── Star field generator ───────────────────────────────────────────────────────
// Seeded PRNG so positions are deterministic but visually random (no tiling).

export interface Star { x: number; y: number; r: number; opacity: number }

export function makeStars(count: number, seed: number, minR = 0.5, maxR = 2.0): Star[] {
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

export function Stars({ stars, color = "hsl(var(--foreground))" }: { stars: Star[]; color?: string }) {
  return (
    <>
      {stars.map((s, i) => (
        <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)}
          fill={color} opacity={s.opacity.toFixed(2)} />
      ))}
    </>
  );
}

// ── SVG base ───────────────────────────────────────────────────────────────────

export function BgSvg({ children }: { children: React.ReactNode }) {
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
