import { BgSvg, Stars, makeStars } from "./_shared";

// Pre-computed star fields (module-level so they're only computed once)
const STARS_NEBULA     = makeStars(110,  42, 0.4, 1.5);
const STARS_COSMOS     = makeStars(170, 137, 0.4, 1.8);
const STARS_SUPERNOVA  = makeStars( 90, 251, 0.4, 1.2);
const STARS_STARFIELD  = makeStars(320,  73, 0.5, 2.6);
const STARS_DEEPSPACE  = makeStars(260, 191, 0.3, 1.0);

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

// 6. Cosmos — blue/purple + orbital lines (accent-tinted)
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
      {/* Orbital rings */}
      <ellipse cx="640" cy="400" rx="560" ry="180" fill="none" stroke="hsl(var(--primary))" strokeWidth="0.75" opacity="0.12" />
      <ellipse cx="640" cy="400" rx="400" ry="130" fill="none" stroke="hsl(var(--primary))" strokeWidth="0.5" opacity="0.08" />
    </BgSvg>
  );
}

// 7. Supernova — radial burst in top-right
export function SupernovaBg() {
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
export function StarfieldBg() {
  return (
    <BgSvg>
      <Stars stars={STARS_STARFIELD} />
    </BgSvg>
  );
}

// 9. Deep Space — atmospheric dark with tiny stars + subtle glow
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
