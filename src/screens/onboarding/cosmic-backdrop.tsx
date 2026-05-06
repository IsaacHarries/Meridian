/**
 * Wizard-scoped cosmic backdrop.
 *
 * The body already paints the user's chosen background (Deep Space by
 * default), but the onboarding screen needs a richer, denser cosmos that
 * frames the wizard card without depending on the user's setting. This
 * component layers two soft nebula clouds + a dense star field behind
 * the card and a faint orbital halo around the card itself, all using
 * the primary accent so it recolors with the user's theme.
 *
 * Sits at z-0 with `pointer-events-none` so it never intercepts input —
 * the wizard renders above it.
 *
 * Stars twinkle via the shared <Stars> component (which now animates
 * each star's opacity on a randomised cycle by default — same behaviour
 * applies to every space-themed background app-wide).
 */

import { makeStars, Stars } from "@/lib/backgrounds/_shared";

const STARS_FRONT = makeStars(160, 911, 0.3, 1.6);
const STARS_BACK  = makeStars(220, 419, 0.2, 1.0);

export function CosmicBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <svg
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 1280 800"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter id="ob-bg-blur-xl" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="100" />
          </filter>
          <filter id="ob-bg-blur-lg" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="70" />
          </filter>
          <radialGradient id="ob-vignette" cx="50%" cy="55%" r="65%">
            <stop offset="60%" stopColor="hsl(var(--background))" stopOpacity="0" />
            <stop offset="100%" stopColor="hsl(var(--background))" stopOpacity="0.45" />
          </radialGradient>
        </defs>

        {/* faint background star layer (twinkles via shared <Stars>) */}
        <Stars stars={STARS_BACK} />

        {/* nebulae */}
        <ellipse
          cx="980" cy="220" rx="520" ry="380"
          filter="url(#ob-bg-blur-xl)"
          fill="hsl(var(--primary))"
          opacity="0.22"
        />
        <ellipse
          cx="280" cy="640" rx="460" ry="340"
          filter="url(#ob-bg-blur-lg)"
          fill="hsl(265 60% 50%)"
          opacity="0.16"
        />

        {/* dense front star layer (twinkles) */}
        <Stars stars={STARS_FRONT} />

        {/* gentle vignette so the card edges don't fight the nebula glow */}
        <rect x="0" y="0" width="1280" height="800" fill="url(#ob-vignette)" />
      </svg>
    </div>
  );
}
