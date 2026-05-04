import { BgSvg, W, H } from "./_shared";

// 20. Dots — enhanced dot grid (accent-tinted)
export function DotsBg() {
  return (
    <BgSvg>
      <defs>
        {/* Small dots */}
        <pattern id="dots-sm" x="0" y="0" width="30" height="30" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
        </pattern>
        {/* Large accent dots */}
        <pattern id="dots-lg" x="0" y="0" width="120" height="120" patternUnits="userSpaceOnUse">
          <circle cx="60" cy="60" r="3.5" fill="hsl(var(--primary))" opacity="0.25" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#dots-sm)" style={{ color: "hsl(var(--foreground))", opacity: 0.10 }} />
      <rect width={W} height={H} fill="url(#dots-lg)" />
    </BgSvg>
  );
}

// 21. None — plain
export function NoneBg() {
  return null;
}
