import React from "react";
import { useBHGravity, SUCK_DUR } from "./_shared";

// ── 7. Shooting Star ──────────────────────────────────────────────────────────

export interface SStar {
  id: number;
  x: number;
  y: number;
  angle: number;
  length: number;
  travel: number;
  duration: number;
  delay: number;
}

let ssIdCounter = 0;

export function ShootingStarEl({ star, onDone }: { star: SStar; onDone: () => void }) {
  const { x, y, angle, length, travel, duration, delay } = star;
  const rad = (angle * Math.PI) / 180;
  const tx = Math.cos(rad) * travel;
  const ty = Math.sin(rad) * travel;
  const [vanishing, setVanishing] = React.useState(false);
  const headRef = React.useRef<HTMLDivElement>(null);
  const { captured, gravRef, suckStyle } = useBHGravity(x, y, { moving: true, trackRef: headRef });

  React.useEffect(() => {
    if (vanishing) {
      const t = setTimeout(onDone, 300);
      return () => clearTimeout(t);
    }
    const t = setTimeout(onDone, duration + delay + 300);
    return () => clearTimeout(t);
  }, [duration, delay, onDone, vanishing]);

  React.useEffect(() => {
    if (!captured) return;
    const t = setTimeout(onDone, SUCK_DUR + 100);
    return () => clearTimeout(t);
  }, [captured, onDone]);

  // Leading-edge offset from the outer div's origin (tail end)
  const headX = Math.cos(rad) * length;
  const headY = Math.sin(rad) * length;

  return (
    <div
      ref={gravRef}
      data-space-dismissable="true"
      onClick={() => !captured && !vanishing && setVanishing(true)}
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        ...(captured ? suckStyle : vanishing ? {
          animation: "m-se-vanish 0.3s ease-in forwards",
        } : {
          animationName: "meridian-ss",
          animationDuration: `${duration}ms`,
          animationDelay: `${delay}ms`,
          animationTimingFunction: "ease-out",
          animationFillMode: "both",
        }),
        cursor: "pointer",
        pointerEvents: "auto",
        "--ss-tx": `${tx}px`,
        "--ss-ty": `${ty}px`,
      } as unknown as React.CSSProperties}
    >
      <div style={{
        width: `${length}px`,
        height: "1.5px",
        background: "linear-gradient(90deg, transparent 0%, rgba(200,220,255,0.6) 60%, rgba(255,255,255,0.95) 100%)",
        borderRadius: "9999px",
        transform: `rotate(${angle}deg)`,
        transformOrigin: "left center",
        boxShadow: "0 0 4px 1px rgba(180,210,255,0.25)",
      }} />
      {/* Zero-size anchor at the bright leading tip for BH proximity detection */}
      <div ref={headRef} style={{
        position: "absolute",
        width: 0, height: 0,
        left: `${headX}px`,
        top: `${headY}px`,
        pointerEvents: "none",
      }} />
    </div>
  );
}

export function mkShootingStars(count: number): SStar[] {
  const r = Math.random;
  return Array.from({ length: count }, (_, i) => {
    const angle = 25 + r() * 30;
    return {
      id: ssIdCounter++,
      x: 5 + r() * 60,
      y: 3 + r() * 38,
      angle,
      length: 60 + r() * 110,
      travel: 350 + r() * 400,
      duration: 500 + r() * 400,
      delay: i * (70 + r() * 110),
    };
  });
}
