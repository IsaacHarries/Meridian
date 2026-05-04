import { BgSvg, W, H } from "./_shared";

// 1. Meridian — accent-tinted blobs + concentric arcs
export function MeridianBg() {
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
export function DuskBg() {
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
export function AuroraBg() {
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
export function ForestBg() {
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
