/**
 * Custom SVG illustrations for the onboarding wizard.
 *
 * All artwork is flat-shaded, accent-aware (uses `hsl(var(--primary))` so it
 * recolors with the user's chosen accent), and shares one visual vocabulary —
 * orbits, planets, and stars — so the four steps read as one set. The hero
 * illustrations sit above the title on each step; the small glyphs replace
 * the emoji feature list on the welcome step.
 *
 * Sizing: all heroes use `width="100%"` with a viewBox; the height tracks
 * via `aspect-[ratio]` on the wrapper so the cards stay tidy on every
 * width inside the wizard's max-w container. CSS animations are scoped to
 * each SVG via inline `<style>` blocks so they don't bleed.
 */

import { BitbucketIcon as AtlasBitbucketIcon, JiraIcon as AtlasJiraIcon } from "@atlaskit/logo";

// ── Shared paint helpers ────────────────────────────────────────────────────

function Twinkle({ cx, cy, r = 1, delay = 0, opacity = 0.85 }: {
  cx: number; cy: number; r?: number; delay?: number; opacity?: number;
}) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill="hsl(var(--foreground))"
      opacity={opacity}
      style={{ animation: `obStarTwinkle 3.2s ease-in-out ${delay}s infinite` }}
    />
  );
}

const TWINKLE_KEYFRAMES = `
@keyframes obStarTwinkle {
  0%, 100% { opacity: 0.35; }
  50%      { opacity: 1; }
}
@keyframes obOrbit {
  from { transform: rotate(0deg);   transform-origin: var(--ox) var(--oy); }
  to   { transform: rotate(360deg); transform-origin: var(--ox) var(--oy); }
}
@keyframes obBeacon {
  0%, 100% { opacity: 0.18; }
  50%      { opacity: 0.42; }
}
@keyframes obPulse {
  0%, 100% { transform: scale(1);   opacity: 0.9; }
  50%      { transform: scale(1.4); opacity: 0.45; }
}
`;

// ── Welcome hero — Earth rising over the meridian, north star above ────────

const EARTH = { cx: 135, cy: 105, r: 44 } as const;

/** Earth's actual axial tilt is ~23.44°; round to 23.5 for the SVG transform.
 *  Positive in SVG (where +y is down) tilts the north pole to the LEFT — the
 *  alternative orientation to the conventional right-leaning textbook view. */
const EARTH_TILT_DEG = 23.5;

/** Width of one continent strip in user units. The strip holds all of Earth's
 *  major landmasses laid out at their actual longitudinal positions (an
 *  equirectangular projection sliced into a horizontal band). The strip is
 *  instanced twice side-by-side and translated by exactly this amount per
 *  rotation cycle so the wrap loops without a visual jump — and because one
 *  cycle drifts a full Earth circumference past the disc, every continent
 *  comes into view as the planet spins. */
const STRIP_WIDTH = 264;

/** Horizontal offset of the strip's local origin from user-space x=0. Picked
 *  so strip-x range [88, 176] (the Atlantic-centered slice of the world map)
 *  lands inside the visible disc at user-space [91, 179] when the rotation
 *  animation is at t=0. */
const STRIP_ORIGIN_X = 3;

/** Continent (land) rotation period. Halved from the prior 60s for a calm
 *  drift — at this pace the user can comfortably read each continent as
 *  it passes through view. */
const LAND_ROTATION_SECONDS = 120;

/** Cloud rotation period. Kept at the original faster pace so the
 *  atmosphere visibly moves at a different rate from the surface,
 *  reinforcing the impression that clouds are weather (a separate
 *  layer) rather than land. */
const CLOUD_ROTATION_SECONDS = 60;

// Cartoon-style colour palette traced from the reference image (a hand-drawn
// Atlantic-centered globe). Pinned hues — not theme-driven — because Earth
// only reads as Earth in green-and-blue.
const OCEAN_DEEP   = "hsl(212 55% 32%)";
const OCEAN_MID    = "hsl(208 60% 42%)";
const OCEAN_LIGHT  = "hsl(202 70% 60%)";
const LAND_GREEN   = "hsl(95 60% 54%)";
const LAND_OUTLINE = "hsl(220 35% 10%)";

/** Pill geometry — every landmass and cloud is a horizontal rounded
 *  rectangle. Land pills are 1.5× the size of clouds so continents read
 *  as the dominant feature; clouds are smaller and faster-moving so they
 *  feel like weather drifting over the surface. */
const LAND_PILL_W = 54;
const LAND_PILL_H = 18;
const LAND_PILL_R = 9;

const CLOUD_PILL_W = 36;
const CLOUD_PILL_H = 12;
const CLOUD_PILL_R = 6;

/** A single rounded-pill shape centred at (cx, cy) with explicit
 *  dimensions. All instances are aligned horizontally — no rotation —
 *  so the planet reads as a uniform cartoon abstraction. */
function Pill({
  cx, cy, w, h, r, fill, opacity = 1,
}: {
  cx: number; cy: number; w: number; h: number; r: number;
  fill: string; opacity?: number;
}) {
  return (
    <rect
      x={cx - w / 2}
      y={cy - h / 2}
      width={w}
      height={h}
      rx={r}
      ry={r}
      fill={fill}
      opacity={opacity}
    />
  );
}

/** Land-pill positions across the equirectangular strip. Pared down to
 *  one pill per major landmass (NA, Greenland, SA, Europe, Africa N + S,
 *  Arabia, Asia, India, Australia) so the planet reads cleanly without
 *  feeling crowded. With pills sized 36×12 the no-overlap rule is
 *  `|Δx| ≥ 36 OR |Δy| ≥ 12` between any two pills — every pair below
 *  satisfies that. The Pacific gap at strip-x ≥ 262 + ≤ 0 keeps the
 *  wrap seam invisible. Coordinates are strip-local. */
const LAND_PILLS: { cx: number; cy: number }[] = [
  // ── North America ────────────────────────────────────────────────────
  { cx: 52, cy: 72 },   // Canada
  { cx: 52, cy: 90 },   // USA
  // ── Greenland ───────────────────────────────────────────────────────
  { cx: 108, cy: 72 },
  // ── South America ───────────────────────────────────────────────────
  { cx: 96, cy: 130 },
  // ── Europe ──────────────────────────────────────────────────────────
  { cx: 146, cy: 88 },
  // ── Africa ──────────────────────────────────────────────────────────
  { cx: 180, cy: 102 }, // Sahara
  { cx: 188, cy: 130 }, // Central + Cape
  // ── Middle East ─────────────────────────────────────────────────────
  { cx: 218, cy: 88 },  // Arabia
  // ── Asia ────────────────────────────────────────────────────────────
  { cx: 236, cy: 72 },  // East Asia / Siberia
  // ── India ───────────────────────────────────────────────────────────
  { cx: 220, cy: 108 },
  // ── Australia ───────────────────────────────────────────────────────
  { cx: 240, cy: 126 },
];

/** Cloud-pill positions. Same pill shape, white + translucent, deliberately
 *  more numerous than the land pills so the planet feels alive with weather.
 *  Clouds may overlap continents (they sit on the upper layer) and other
 *  clouds — they're decorative, not constrained by the land collision rule. */
const CLOUD_PILLS: { cx: number; cy: number; opacity: number }[] = [
  { cx: 40,  cy: 80,  opacity: 0.85 },
  { cx: 70,  cy: 130, opacity: 0.8  },
  { cx: 95,  cy: 96,  opacity: 0.85 },
  { cx: 130, cy: 116, opacity: 0.8  },
  { cx: 160, cy: 70,  opacity: 0.85 },
  { cx: 175, cy: 142, opacity: 0.8  },
  { cx: 200, cy: 76,  opacity: 0.85 },
  { cx: 224, cy: 134, opacity: 0.8  },
];

/** All land pills for one full Earth circumference. Defined separately
 *  from the cloud pills so the two layers can animate at different
 *  speeds (land slow, clouds faster — clouds drift independently of
 *  the surface they cover). */
function LandSet() {
  return (
    <g>
      {LAND_PILLS.map((p, i) => (
        <Pill
          key={`land-${i}`}
          cx={p.cx}
          cy={p.cy}
          w={LAND_PILL_W}
          h={LAND_PILL_H}
          r={LAND_PILL_R}
          fill={LAND_GREEN}
        />
      ))}
    </g>
  );
}

/** All cloud pills for one full Earth circumference. */
function CloudSet() {
  return (
    <g>
      {CLOUD_PILLS.map((c, i) => (
        <Pill
          key={`cloud-${i}`}
          cx={c.cx}
          cy={c.cy}
          w={CLOUD_PILL_W}
          h={CLOUD_PILL_H}
          r={CLOUD_PILL_R}
          fill="hsl(0 0% 100%)"
          opacity={c.opacity}
        />
      ))}
    </g>
  );
}

export function WelcomeHero() {
  return (
    <div className="relative w-full overflow-hidden rounded-md">
      <svg
        viewBox="0 0 520 160"
        width="100%"
        className="block"
        xmlns="http://www.w3.org/2000/svg"
      >
        <style>{TWINKLE_KEYFRAMES}</style>
        <defs>
          {/* Ocean — deep blue with a brighter top-left spherical highlight
              so the disc reads as a sphere lit from the upper-left. */}
          <radialGradient id="earth-ocean" cx="34%" cy="30%" r="80%">
            <stop offset="0%"   stopColor={OCEAN_LIGHT} />
            <stop offset="55%"  stopColor={OCEAN_MID} />
            <stop offset="100%" stopColor={OCEAN_DEEP} />
          </radialGradient>
          {/* Atmosphere — thin cyan ring beyond the planet edge */}
          <radialGradient id="earth-atmo" cx="50%" cy="50%" r="50%">
            <stop offset="78%" stopColor="hsl(195 95% 70%)" stopOpacity="0" />
            <stop offset="92%" stopColor="hsl(195 95% 70%)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="hsl(195 95% 70%)" stopOpacity="0" />
          </radialGradient>
          {/* North star halo */}
          <radialGradient id="ob-star-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%"  stopColor="hsl(var(--foreground))" stopOpacity="0.95" />
            <stop offset="60%" stopColor="hsl(var(--primary))"    stopOpacity="0.35" />
            <stop offset="100%" stopColor="hsl(var(--primary))"   stopOpacity="0" />
          </radialGradient>
          {/* Moon body — pale lunar gradient with a darker rim for the
              spherical shading */}
          <radialGradient id="moon-fill" cx="35%" cy="35%" r="65%">
            <stop offset="0%"   stopColor="hsl(45 28% 92%)" />
            <stop offset="80%"  stopColor="hsl(40 18% 75%)" />
            <stop offset="100%" stopColor="hsl(30 18% 55%)" />
          </radialGradient>
          {/* Horizon — fades in/out at the edges */}
          <linearGradient id="ob-horizon" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"  stopColor="hsl(var(--primary))" stopOpacity="0" />
            <stop offset="50%" stopColor="hsl(var(--primary))" stopOpacity="0.55" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </linearGradient>
          {/* Clip continents + ocean detail to the planet disc so they
              don't spill out beyond the sphere edge. The clip stays in
              user space — it doesn't tilt with the surface, so the planet
              keeps its round silhouette while the surface inside rotates. */}
          <clipPath id="earth-disc" clipPathUnits="userSpaceOnUse">
            <circle cx={EARTH.cx} cy={EARTH.cy} r={EARTH.r} />
          </clipPath>
          {/* Land + cloud strips defined separately so they can animate
              at different speeds. Each is instanced twice side-by-side in
              the rotating section below for the seamless wrap. */}
          <g id="earth-land">
            <LandSet />
          </g>
          <g id="earth-clouds">
            <CloudSet />
          </g>
          {/* Moon orbit — defined once and referenced via <mpath> by both
              the back-moon and front-moon copies so they stay perfectly
              synchronised. Horizontal ellipse around the Earth centre;
              the wrapping <g> applies the orbit-plane tilt. The orbit
              radius is wider than the prior pass so the bigger moon
              (r=12, matching the real ~27% Earth-to-moon diameter
              ratio) sits clear of Earth's surface at perigee. */}
          <path
            id="moon-orbit-path"
            d={`M ${EARTH.cx + 80} ${EARTH.cy}
                A 80 20 0 1 1 ${EARTH.cx - 80} ${EARTH.cy}
                A 80 20 0 1 1 ${EARTH.cx + 80} ${EARTH.cy} Z`}
          />
        </defs>

        {/* faint twinkling stars */}
        <Twinkle cx={60}  cy={28} r={1}    delay={0}   />
        <Twinkle cx={210} cy={20} r={1.2}  delay={1.4} />
        <Twinkle cx={300} cy={40} r={0.9}  delay={0.3} />
        <Twinkle cx={350} cy={70} r={0.8}  delay={1.1} />
        <Twinkle cx={460} cy={28} r={1}    delay={1.8} />
        <Twinkle cx={490} cy={75} r={0.8}  delay={0.5} />
        <Twinkle cx={45}  cy={75} r={0.7}  delay={2.2} opacity={0.6} />
        <Twinkle cx={250} cy={130} r={0.7} delay={1.6} opacity={0.55} />

        {/* horizon line — a literal meridian sweeping across; rendered
            BEHIND the planet so Earth appears to rise over it */}
        <line x1="0" y1="120" x2="520" y2="120" stroke="url(#ob-horizon)" strokeWidth="1" />

        {/* atmospheric halo just outside the sphere — rotationally
            symmetric so it doesn't need to participate in the tilt */}
        <circle
          cx={EARTH.cx} cy={EARTH.cy} r={EARTH.r + 4}
          fill="url(#earth-atmo)"
        />

        {/* ── Moon-back ──────────────────────────────────────────────
            Rendered BEFORE the Earth disc so Earth's ocean + continent
            pixels naturally occlude it whenever its 2D position overlaps
            the disc. Opacity is animated to be visible only during the
            back half of the orbit (when the moon would physically be
            behind Earth); during the front half this copy is invisible
            and the front-moon copy below takes over.

            The orbit goes clockwise (sweep-flag=1) starting from the
            right limb, so phase mapping is:
              t=0       → right limb
              t=0.25T   → bottom (FRONT — closest to viewer)
              t=0.5T    → left limb
              t=0.75T   → top (BACK — furthest from viewer)
            Front half = t∈[0, 0.5T]; back half = t∈[0.5T, T]. */}
        <g transform={`rotate(-10 ${EARTH.cx} ${EARTH.cy})`}>
          <g>
            <animateMotion dur="22s" repeatCount="indefinite" rotate="0">
              <mpath href="#moon-orbit-path" />
            </animateMotion>
            <animate
              attributeName="opacity"
              values="0; 0; 1; 1; 0"
              keyTimes="0; 0.499; 0.501; 0.999; 1"
              dur="22s"
              repeatCount="indefinite"
            />
            <circle r="12" fill="url(#moon-fill)"
              stroke={LAND_OUTLINE} strokeOpacity="0.55" strokeWidth="0.8" />
            <circle cx="-2.8" cy="-2.1" r="2.5" fill="hsl(35 15% 55%)" opacity="0.7" />
            <circle cx="3.5" cy="2.8" r="1.8" fill="hsl(35 15% 55%)" opacity="0.7" />
            <circle cx="1.4" cy="-4.9" r="1.4" fill="hsl(35 15% 55%)" opacity="0.6" />
          </g>
        </g>

        {/* ocean base sphere */}
        <circle cx={EARTH.cx} cy={EARTH.cy} r={EARTH.r} fill="url(#earth-ocean)" />

        {/* Disc-clipped surface. Everything inside is tilted by Earth's
            axial tilt; the rotating continent strip translates along the
            tilted equator so it reads as Earth spinning on a real axis. */}
        <g clipPath="url(#earth-disc)">
          <g transform={`rotate(${EARTH_TILT_DEG} ${EARTH.cx} ${EARTH.cy})`}>
            {/* Rotating LAND strip — slow drift so the user can read each
                continent as it passes. Two copies side-by-side; the wrap
                is seamless because the second copy lands exactly where the
                first started after one full cycle. SMIL animateTransform
                rather than CSS so the transform-origin behaviour is
                consistent across WebKit (Tauri) and Chromium. */}
            <g>
              <animateTransform
                attributeName="transform"
                type="translate"
                from="0 0"
                to={`-${STRIP_WIDTH} 0`}
                dur={`${LAND_ROTATION_SECONDS}s`}
                repeatCount="indefinite"
              />
              <use
                href="#earth-land"
                transform={`translate(${STRIP_ORIGIN_X} 0)`}
              />
              <use
                href="#earth-land"
                transform={`translate(${STRIP_ORIGIN_X + STRIP_WIDTH} 0)`}
              />
            </g>

            {/* Rotating CLOUD strip — independent (faster) drift so clouds
                visibly slip across the surface. Same two-copy seamless
                wrap pattern. */}
            <g>
              <animateTransform
                attributeName="transform"
                type="translate"
                from="0 0"
                to={`-${STRIP_WIDTH} 0`}
                dur={`${CLOUD_ROTATION_SECONDS}s`}
                repeatCount="indefinite"
              />
              <use
                href="#earth-clouds"
                transform={`translate(${STRIP_ORIGIN_X} 0)`}
              />
              <use
                href="#earth-clouds"
                transform={`translate(${STRIP_ORIGIN_X + STRIP_WIDTH} 0)`}
              />
            </g>
          </g>

          {/* Subtle terminator — soft shadow on the right limb. Sits in
              user space (NOT inside the tilt) because the day-night line
              is determined by the sun's direction, not the surface
              rotation. */}
          <ellipse
            cx={EARTH.cx + 22} cy={EARTH.cy + 6}
            rx={EARTH.r * 0.95} ry={EARTH.r * 0.95}
            fill="hsl(225 70% 8%)"
            opacity="0.16"
          />
        </g>

        {/* sphere highlight specular — punches a soft white glint into
            the upper-left to reinforce the spherical lighting. Stays in
            user space (lighting comes from outside, doesn't rotate with
            the surface). */}
        <ellipse
          cx={EARTH.cx - 14} cy={EARTH.cy - 18}
          rx="14" ry="6"
          fill="hsl(0 0% 100%)"
          fillOpacity="0.18"
          transform={`rotate(-30 ${EARTH.cx - 14} ${EARTH.cy - 18})`}
        />

        {/* dark outer rim — defines the planet edge against the cosmos
            and matches the bold-outline cartoon aesthetic */}
        <circle
          cx={EARTH.cx} cy={EARTH.cy} r={EARTH.r}
          fill="none"
          stroke={LAND_OUTLINE}
          strokeOpacity="0.85"
          strokeWidth="1"
        />

        {/* meridian ring (callback to the Meridian icon) — primary-tinted
            accent ring just inside the dark rim */}
        <circle
          cx={EARTH.cx} cy={EARTH.cy} r={EARTH.r - 1.2}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeOpacity="0.45"
          strokeWidth="0.6"
        />

        {/* ── Moon-front ─────────────────────────────────────────────
            Rendered AFTER the Earth disc so it draws on top whenever
            its 2D position overlaps the planet. Opacity is animated to
            be visible only during the front half of the orbit (when the
            moon would physically be in front of Earth); during the back
            half this copy is invisible and the back-moon copy above
            (rendered before Earth pixels) is the one shown — which
            Earth's disc naturally occludes when the moon's position
            overlaps the planet. Together the two copies create a true
            "moon hides behind Earth" effect. Both copies share the same
            orbit path via <mpath> so they stay perfectly synchronised. */}
        <g transform={`rotate(-10 ${EARTH.cx} ${EARTH.cy})`}>
          <g>
            <animateMotion dur="22s" repeatCount="indefinite" rotate="0">
              <mpath href="#moon-orbit-path" />
            </animateMotion>
            <animate
              attributeName="opacity"
              values="1; 1; 0; 0; 1"
              keyTimes="0; 0.499; 0.501; 0.999; 1"
              dur="22s"
              repeatCount="indefinite"
            />
            <circle r="12" fill="url(#moon-fill)"
              stroke={LAND_OUTLINE} strokeOpacity="0.55" strokeWidth="0.8" />
            <circle cx="-2.8" cy="-2.1" r="2.5" fill="hsl(35 15% 55%)" opacity="0.7" />
            <circle cx="3.5" cy="2.8" r="1.8" fill="hsl(35 15% 55%)" opacity="0.7" />
            <circle cx="1.4" cy="-4.9" r="1.4" fill="hsl(35 15% 55%)" opacity="0.6" />
          </g>
        </g>

        {/* north star with halo */}
        <circle cx="405" cy="42" r="22" fill="url(#ob-star-glow)" />
        <circle
          cx="405" cy="42" r="3.5"
          fill="hsl(var(--foreground))"
          style={{ animation: "obStarTwinkle 2.2s ease-in-out 0s infinite" }}
        />
        {/* star points */}
        {[0, 90, 180, 270].map((deg) => {
          const rad = (deg * Math.PI) / 180;
          const x2 = 405 + 9 * Math.cos(rad);
          const y2 = 42  + 9 * Math.sin(rad);
          return (
            <line
              key={deg}
              x1={405} y1={42} x2={x2.toFixed(2)} y2={y2.toFixed(2)}
              stroke="hsl(var(--foreground))"
              strokeWidth="0.8"
              opacity="0.85"
            />
          );
        })}
      </svg>
    </div>
  );
}

// ── AI providers hero — swiveling satellite tracking the active provider ────

/** Provider "stars" arranged in a gentle arc above the satellite. The order
 *  here matches PROVIDER_ORDER (claude, gemini, copilot, local) so the
 *  satellite's active index can index straight in. */
const AI_STARS = [
  { x: 110, y: 36, r: 3.5, delay: 0,   halo: 12 }, // claude
  { x: 220, y: 18, r: 3,   delay: 0.8, halo: 10 }, // gemini
  { x: 330, y: 22, r: 2.8, delay: 1.5, halo: 9  }, // copilot
  { x: 430, y: 48, r: 2.6, delay: 0.4, halo: 8  }, // local
] as const;

/** Pivot point on top of the satellite body that the dish swivels around.
 *  Chosen so the dish base sits flush with the body top. */
const SAT_PIVOT = { x: 270, y: 124 };

/** Compute the dish rotation (degrees, clockwise) so it points at the given
 *  star position from the pivot. 0° = straight up; positive = clockwise. */
function dishAngle(starIndex: number): number {
  const star = AI_STARS[Math.max(0, Math.min(AI_STARS.length - 1, starIndex))];
  const dx = star.x - SAT_PIVOT.x;
  const dy = star.y - SAT_PIVOT.y;
  // atan2(dx, -dy) measures the angle from "+Y up" axis, clockwise.
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

export function AiProvidersHero({ activeIndex = 0 }: { activeIndex?: number }) {
  const angle = dishAngle(activeIndex);
  const activeStar = AI_STARS[Math.max(0, Math.min(AI_STARS.length - 1, activeIndex))];
  return (
    <div className="relative w-full overflow-hidden rounded-md">
      <svg
        viewBox="0 0 520 160"
        width="100%"
        className="block"
        xmlns="http://www.w3.org/2000/svg"
      >
        <style>{TWINKLE_KEYFRAMES}</style>
        <defs>
          <radialGradient id="ob-ai-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%"  stopColor="hsl(var(--foreground))" stopOpacity="0.9" />
            <stop offset="100%" stopColor="hsl(var(--primary))"  stopOpacity="0" />
          </radialGradient>
          <linearGradient id="ob-link" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="hsl(var(--primary))" stopOpacity="0.05" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.45" />
          </linearGradient>
          <linearGradient id="ob-beam" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="hsl(var(--primary))" stopOpacity="0.05" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.95" />
          </linearGradient>
          <linearGradient id="ob-panel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="hsl(var(--primary))" stopOpacity="0.85" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.45" />
          </linearGradient>
          <radialGradient id="ob-beam-tip" cx="50%" cy="50%" r="50%">
            <stop offset="0%"  stopColor="hsl(var(--foreground))" stopOpacity="0.9" />
            <stop offset="60%" stopColor="hsl(var(--primary))"    stopOpacity="0.4" />
            <stop offset="100%" stopColor="hsl(var(--primary))"   stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* background twinkling stars */}
        <Twinkle cx={40}  cy={22} delay={0}   />
        <Twinkle cx={70}  cy={70} r={0.7} delay={1.2} />
        <Twinkle cx={185} cy={62} r={0.7} delay={0.4} />
        <Twinkle cx={285} cy={70} r={0.9} delay={1.8} />
        <Twinkle cx={395} cy={72} r={0.7} delay={1.0} />
        <Twinkle cx={490} cy={28} r={0.8} delay={0.6} />
        <Twinkle cx={500} cy={90} r={0.6} delay={2.1} />

        {/* dim dashed link lines from satellite pivot to every star —
            implies the satellite knows about all of them, even when it's
            currently aimed at one. */}
        {AI_STARS.map((s, i) => (
          <line
            key={i}
            x1={SAT_PIVOT.x} y1={SAT_PIVOT.y}
            x2={s.x} y2={s.y}
            stroke="url(#ob-link)"
            strokeWidth="0.7"
            strokeDasharray="2 3"
            opacity={i === activeIndex ? 0 : 0.6}
            style={{ transition: "opacity 400ms ease-out" }}
          />
        ))}

        {/* active beam — bright solid line from pivot to the active star.
            Endpoint coordinates are tweened by CSS transition so the beam
            sweeps to the new target instead of jumping. */}
        <line
          x1={SAT_PIVOT.x} y1={SAT_PIVOT.y}
          x2={activeStar.x} y2={activeStar.y}
          stroke="url(#ob-beam)"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity="0.9"
          style={{ transition: "x2 600ms cubic-bezier(0.25, 0.46, 0.45, 0.94), y2 600ms cubic-bezier(0.25, 0.46, 0.45, 0.94)" }}
        />
        {/* glow at the active star end of the beam */}
        <circle
          cx={activeStar.x} cy={activeStar.y} r={14}
          fill="url(#ob-beam-tip)"
          style={{ transition: "cx 600ms cubic-bezier(0.25, 0.46, 0.45, 0.94), cy 600ms cubic-bezier(0.25, 0.46, 0.45, 0.94)" }}
        />

        {/* provider stars (with halo) */}
        {AI_STARS.map((s, i) => (
          <g key={`s-${i}`}>
            <circle cx={s.x} cy={s.y} r={s.halo} fill="url(#ob-ai-halo)" />
            <circle
              cx={s.x} cy={s.y} r={i === activeIndex ? s.r * 1.35 : s.r}
              fill="hsl(var(--foreground))"
              style={{
                animation: `obStarTwinkle 2.6s ease-in-out ${s.delay}s infinite`,
                transition: "r 300ms ease-out",
              }}
            />
          </g>
        ))}

        {/* ground / horizon line */}
        <line x1="0" y1="148" x2="520" y2="148"
          stroke="hsl(var(--primary))" strokeOpacity="0.2" strokeWidth="0.8" />

        {/* ── Satellite ──────────────────────────────────────────────────
            Body and solar panels stay horizontal — the rotating part is
            only the dish + feed horn assembly above the pivot. Reads as
            a real satellite tracking its target.
        */}

        {/* solar panels */}
        <rect x="240" y="128" width="20" height="9" rx="0.6" fill="url(#ob-panel)" />
        <rect x="280" y="128" width="20" height="9" rx="0.6" fill="url(#ob-panel)" />
        {[244, 248, 252, 256, 284, 288, 292, 296].map((x) => (
          <line key={x} x1={x} y1="128" x2={x} y2="137"
            stroke="hsl(var(--background))" strokeWidth="0.4" strokeOpacity="0.85" />
        ))}
        {/* panel mounting struts to body */}
        <line x1="260" y1="132" x2="262" y2="132"
          stroke="hsl(var(--foreground))" strokeOpacity="0.7" strokeWidth="0.6" />
        <line x1="278" y1="132" x2="280" y2="132"
          stroke="hsl(var(--foreground))" strokeOpacity="0.7" strokeWidth="0.6" />

        {/* body */}
        <rect x="262" y="126" width="16" height="14" rx="1.6"
          fill="hsl(var(--foreground))" fillOpacity="0.92" />
        {/* body detail line */}
        <line x1="262" y1="132" x2="278" y2="132"
          stroke="hsl(var(--primary))" strokeOpacity="0.6" strokeWidth="0.5" />
        {/* status light */}
        <circle cx="270" cy="137" r="0.9" fill="hsl(var(--primary))" />

        {/* swiveling dish + feed horn — pivots around SAT_PIVOT */}
        <g
          style={{
            transform: `rotate(${angle.toFixed(2)}deg)`,
            transformOrigin: `${SAT_PIVOT.x}px ${SAT_PIVOT.y}px`,
            transformBox: "view-box",
            transition: "transform 600ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          }}
        >
          {/* dish parabola */}
          <path
            d={`M ${SAT_PIVOT.x - 8},${SAT_PIVOT.y} Q ${SAT_PIVOT.x},${SAT_PIVOT.y - 12} ${SAT_PIVOT.x + 8},${SAT_PIVOT.y} Z`}
            fill="hsl(var(--primary))"
            fillOpacity="0.95"
          />
          {/* dish inner shadow line */}
          <path
            d={`M ${SAT_PIVOT.x - 6},${SAT_PIVOT.y - 1} Q ${SAT_PIVOT.x},${SAT_PIVOT.y - 9} ${SAT_PIVOT.x + 6},${SAT_PIVOT.y - 1}`}
            fill="none"
            stroke="hsl(var(--background))"
            strokeOpacity="0.4"
            strokeWidth="0.6"
          />
          {/* feed horn — tiny mast + tip pointing along the swivel axis */}
          <line
            x1={SAT_PIVOT.x} y1={SAT_PIVOT.y - 3}
            x2={SAT_PIVOT.x} y2={SAT_PIVOT.y - 9}
            stroke="hsl(var(--foreground))"
            strokeWidth="0.7"
            strokeLinecap="round"
          />
          <circle cx={SAT_PIVOT.x} cy={SAT_PIVOT.y - 10} r="1.2"
            fill="hsl(var(--foreground))" />
        </g>
      </svg>
    </div>
  );
}

// ── JIRA hero — official Atlassian Jira icon, framed by stars ──────────────

/** Shared starry frame used by the JIRA and Bitbucket step heroes. The
 *  brand icon sits centred inside; the surrounding stars + ring keep the
 *  wizard's overall space theme even though the hero subject is now the
 *  official integration logo. */
function BrandHeroFrame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="relative w-full overflow-hidden rounded-md">
      <svg
        viewBox="0 0 520 160"
        width="100%"
        className="block absolute inset-0 -z-0"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <style>{TWINKLE_KEYFRAMES}</style>
        <defs>
          <radialGradient id="brand-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="hsl(var(--primary))" stopOpacity="0.22" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* primary-tinted glow behind the icon */}
        <circle cx="260" cy="80" r="80" fill="url(#brand-glow)" />
        {/* subtle accent ring */}
        <circle cx="260" cy="80" r="56" fill="none"
          stroke="hsl(var(--primary))" strokeOpacity="0.18" strokeWidth="0.7" />
        {/* twinkling stars */}
        <Twinkle cx={50}  cy={28} r={1}    delay={0}   />
        <Twinkle cx={110} cy={64} r={0.7}  delay={1.2} />
        <Twinkle cx={180} cy={32} r={0.9}  delay={0.4} />
        <Twinkle cx={340} cy={28} r={0.8}  delay={1.7} />
        <Twinkle cx={400} cy={70} r={1}    delay={0.6} />
        <Twinkle cx={470} cy={36} r={0.8}  delay={2.0} />
        <Twinkle cx={490} cy={120} r={0.7} delay={1.0} />
        <Twinkle cx={60}  cy={120} r={0.8} delay={2.4} />
      </svg>
      <div
        className="relative flex h-[160px] w-full items-center justify-center"
        aria-label={label}
      >
        {/* Atlaskit logo icons render at their `size` prop's intrinsic
            dimensions; flex centring above puts them dead-centre both
            horizontally and vertically inside the 160px hero band. */}
        {children}
      </div>
    </div>
  );
}

export function JiraHero() {
  return (
    <BrandHeroFrame label="Jira">
      <AtlasJiraIcon appearance="brand" size="xlarge" label="Jira" />
    </BrandHeroFrame>
  );
}

export function BitbucketHero() {
  return (
    <BrandHeroFrame label="Bitbucket">
      <AtlasBitbucketIcon appearance="brand" size="xlarge" label="Bitbucket" />
    </BrandHeroFrame>
  );
}

// ── Small feature glyphs (welcome step) ─────────────────────────────────────
//
// Sized 40×40, accent-coloured, all share the orbit/star/planet vocabulary
// so the welcome step's feature list reads as one set with the hero above it.

/** AI chip glyph — adapted from svgrepo's "ai" chip icon (a microchip
 *  with "AI" lettering and connection pins on every side). The path data
 *  is unchanged from the source; only the wrapper's viewBox and fill are
 *  re-themed so the icon picks up the user's accent colour. */
export function AiGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <g fill="hsl(var(--primary))" transform="translate(64 64)">
        <path d="M320,64 L320,320 L64,320 L64,64 L320,64 Z M171.749388,128 L146.817842,128 L99.4840387,256 L121.976629,256 L130.913039,230.977 L187.575039,230.977 L196.319607,256 L220.167172,256 L171.749388,128 Z M260.093778,128 L237.691519,128 L237.691519,256 L260.093778,256 L260.093778,128 Z M159.094727,149.47526 L181.409039,213.333 L137.135039,213.333 L159.094727,149.47526 Z M341.333333,256 L384,256 L384,298.666667 L341.333333,298.666667 L341.333333,256 Z M85.3333333,341.333333 L128,341.333333 L128,384 L85.3333333,384 L85.3333333,341.333333 Z M170.666667,341.333333 L213.333333,341.333333 L213.333333,384 L170.666667,384 L170.666667,341.333333 Z M85.3333333,0 L128,0 L128,42.6666667 L85.3333333,42.6666667 L85.3333333,0 Z M256,341.333333 L298.666667,341.333333 L298.666667,384 L256,384 L256,341.333333 Z M170.666667,0 L213.333333,0 L213.333333,42.6666667 L170.666667,42.6666667 L170.666667,0 Z M256,0 L298.666667,0 L298.666667,42.6666667 L256,42.6666667 L256,0 Z M341.333333,170.666667 L384,170.666667 L384,213.333333 L341.333333,213.333333 L341.333333,170.666667 Z M0,256 L42.6666667,256 L42.6666667,298.666667 L0,298.666667 L0,256 Z M341.333333,85.3333333 L384,85.3333333 L384,128 L341.333333,128 L341.333333,85.3333333 Z M0,170.666667 L42.6666667,170.666667 L42.6666667,213.333333 L0,213.333333 L0,170.666667 Z M0,85.3333333 L42.6666667,85.3333333 L42.6666667,128 L0,128 L0,85.3333333 Z" />
      </g>
    </svg>
  );
}

// JiraGlyph and BitbucketGlyph have been retired in favour of the official
// Atlassian icons from @atlaskit/logo (used directly in the welcome step).
