import { BgSvg, W, H } from "./_shared";

// 10. Watercolor — multiple overlapping pastel blobs
export function WatercolorBg() {
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
export function NeonBg() {
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
export function PrismBg() {
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
export function GeometricBg() {
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
export function MeshBg() {
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
