import { BgSvg, Stars, makeStars } from "./_shared";

// Pre-computed star fields (module-level so they're only computed once).
// Every space-category background shares the Deep Space star recipe
// (count 260, radius 0.3–1.0) — small, plentiful, never overpowering
// the foreground nebulae. Only the seed differs per background so the
// stars land in different positions in each.
// Seeds are deliberately spread far apart and chosen as primes so the
// `sin(seed)` PRNG inside `makeStars` produces uncorrelated positions
// per background — close-together seeds (e.g. 73 vs 137) can land on
// visually similar clusters because the sine values are similar.
const STARS_NEBULA    = makeStars(260, 1009, 0.3, 1.0);
const STARS_COSMOS    = makeStars(260, 3517, 0.3, 1.0);
const STARS_STARFIELD = makeStars(260, 6203, 0.3, 1.0);
const STARS_DEEPSPACE = makeStars(260,  191, 0.3, 1.0);

// 5. Nebula — pink/purple/blue space clouds
export function NebulaBg() {
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

// 6. Cosmos — blue/purple nebula clouds (accent-tinted)
export function CosmosBg() {
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
    </BgSvg>
  );
}

// 7. Starfield — dense star dots
export function StarfieldBg() {
  return (
    <BgSvg>
      <Stars stars={STARS_STARFIELD} />
    </BgSvg>
  );
}

// 8. Deep Space — atmospheric dark with tiny stars + subtle glow
export function DeepSpaceBg() {
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
