import React from "react";
import { r, uid, useBHGravity, SUCK_DUR } from "./_shared";

// ── 5. Meteor Shower ───────────────────────────────────────────────────────────

export interface Meteor { id: number; x: number; y: number; angle: number; length: number; travel: number; duration: number; delay: number; }

export function MeteorEl({ meteor, onDone }: { meteor: Meteor; onDone: () => void }) {
  const { x, y, angle, length, travel, duration, delay } = meteor;
  const rad = (angle * Math.PI) / 180;
  const tx = Math.cos(rad) * travel;
  const ty = Math.sin(rad) * travel;
  const [vanishing, setVanishing] = React.useState(false);
  const { captured, gravRef, suckStyle } = useBHGravity(x, y, { moving: true });

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

  return (
    <div ref={gravRef} data-space-dismissable="true" onClick={() => !captured && !vanishing && setVanishing(true)} style={{
      position: "absolute", left: `${x}%`, top: `${y}%`,
      ...(captured ? suckStyle : vanishing ? {
        animation: "m-se-vanish 0.3s ease-in forwards"
      } : {
        animationName: "m-meteor", animationDuration: `${duration}ms`,
        animationDelay: `${delay}ms`, animationTimingFunction: "ease-out",
        animationFillMode: "both"
      }),
      cursor: "pointer",
      pointerEvents: "auto",
      "--mt-tx": `${tx}px`,
      "--mt-ty": `${ty}px`,
    } as unknown as React.CSSProperties}>
      <div style={{
        width: `${length}px`, height: "1.5px",
        background: "linear-gradient(90deg, transparent 0%, rgba(200,220,255,0.55) 55%, rgba(255,255,255,0.95) 100%)",
        borderRadius: "9999px",
        transform: `rotate(${angle}deg)`,
        transformOrigin: "left center",
        boxShadow: "0 0 3px 1px rgba(180,210,255,0.22)",
      }} />
    </div>
  );
}

export function mkMeteors(): Meteor[] {
  const count = 16 + Math.floor(r() * 14);
  const baseAngle = 28 + r() * 24;
  return Array.from({ length: count }, (_, i) => {
    const angle = baseAngle + (r() - 0.5) * 14;
    const travel = 280 + r() * 300;
    return {
      id: uid(),
      x: 2 + r() * 75,
      y: 2 + r() * 42,
      angle,
      length: 45 + r() * 80,
      travel,
      duration: 420 + r() * 320,
      delay: i * (80 + r() * 140),
    };
  });
}
