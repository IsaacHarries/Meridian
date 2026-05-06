import React from "react";

export const W = 1280, H = 800;

// ── Star field generator ───────────────────────────────────────────────────────
// Seeded PRNG so positions are deterministic but visually random (no tiling).

export interface Star { x: number; y: number; r: number; opacity: number }

const rand = (n: number) => {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
};

export function makeStars(count: number, seed: number, minR = 0.5, maxR = 2.0): Star[] {
  return Array.from({ length: count }, (_, i) => ({
    x:       rand(seed + i * 4 + 0) * W,
    y:       rand(seed + i * 4 + 1) * H,
    r:       minR + rand(seed + i * 4 + 2) * (maxR - minR),
    opacity: 0.25 + rand(seed + i * 4 + 3) * 0.70,
  }));
}

/** Render a star field. Stars TWINKLE by default — each star runs the
 *  shared `bg-star-twinkle` keyframe (defined in `index.css`) on a
 *  per-star randomised duration (4–8 s) and delay (0–6 s) so the field
 *  shimmers organically rather than pulsing in sync. The star's intrinsic
 *  brightness is exposed as a CSS custom property so the keyframe peaks
 *  at that brightness and dims toward invisibility — preserves the
 *  varied opacity that `makeStars` already encodes.
 *
 *  Opt out with `twinkle={false}` for static stars. */
export function Stars({
  stars, color = "hsl(var(--foreground))", twinkle = true,
}: {
  stars: Star[]; color?: string; twinkle?: boolean;
}) {
  if (!twinkle) {
    return (
      <>
        {stars.map((s, i) => (
          <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)}
            fill={color} opacity={s.opacity.toFixed(2)} />
        ))}
      </>
    );
  }
  return (
    <>
      {stars.map((s, i) => {
        // Per-star animation parameters from the same seeded PRNG used
        // for positions, so timing is deterministic + reproducible.
        // Starting from the star's own seed slot so the values aren't
        // correlated with adjacent stars' positions.
        const duration = 4 + rand(i * 7 + 13.7) * 4;
        const delay = rand(i * 11 + 5.3) * 6;
        return (
          <circle
            key={i}
            cx={s.x.toFixed(1)}
            cy={s.y.toFixed(1)}
            r={s.r.toFixed(2)}
            fill={color}
            style={{
              // CSS custom property the keyframe reads as its peak
              // brightness — so the dimmer stars dip toward invisible
              // while bright stars stay visible throughout the cycle.
              ["--star-opacity" as string]: s.opacity.toFixed(2),
              // `backwards` fill mode pre-applies the 0% keyframe
              // (opacity = var(--star-opacity)) during the delay
              // window, so each star sits at its keyframe-start
              // opacity from the very first frame instead of
              // rendering at default opacity 1 and then snapping
              // when its animation kicks in.
              animation: `bg-star-twinkle ${duration.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite backwards`,
            }}
          />
        );
      })}
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
