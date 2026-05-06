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

// Only a fraction of the field is animated — SVG `<circle>` opacity
// animations aren't GPU-composited (the browser repaints the whole SVG
// region on every frame), so animating all 260 stars per background was
// CPU-heavy enough to noticeably degrade UI responsiveness on
// heavier screens. Twinkling ~1-in-9 stars preserves the shimmering
// vibe at roughly a tenth of the per-frame paint cost. The picked
// stars are spread evenly through the index so the animation isn't
// clumped in one corner.
const TWINKLE_STRIDE = 9;

/** Render a star field. By default ~1-in-9 stars twinkle (see
 *  `TWINKLE_STRIDE`) running the shared `bg-star-twinkle` keyframe
 *  defined in `index.css` on per-star randomised duration (4–8 s) and
 *  delay (0–6 s) so the shimmer is organic rather than synchronised.
 *  The star's intrinsic brightness is exposed as a CSS custom property
 *  so the keyframe peaks at that brightness and dims toward
 *  invisibility — preserves the varied opacity that `makeStars` encodes.
 *
 *  Opt out entirely with `twinkle={false}`. */
export function Stars({
  stars, color = "hsl(var(--foreground))", twinkle = true,
}: {
  stars: Star[]; color?: string; twinkle?: boolean;
}) {
  return (
    <>
      {stars.map((s, i) => {
        // Static render — used both when the caller opts out and for
        // the majority of stars on a twinkling field.
        if (!twinkle || i % TWINKLE_STRIDE !== 0) {
          return (
            <circle
              key={i}
              cx={s.x.toFixed(1)}
              cy={s.y.toFixed(1)}
              r={s.r.toFixed(2)}
              fill={color}
              opacity={s.opacity.toFixed(2)}
            />
          );
        }
        // Animated subset. Per-star animation parameters from the same
        // seeded PRNG used for positions, so timing is deterministic +
        // reproducible. Starting from the star's own seed slot so the
        // values aren't correlated with adjacent stars' positions.
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
