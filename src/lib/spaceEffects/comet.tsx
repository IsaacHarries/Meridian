import React from "react";
import { r, uid, useBHGravity, SUCK_DUR } from "./_shared";

// ── 3. Comet ───────────────────────────────────────────────────────────────────

export interface Comet { id: number; x: number; y: number; angle: number; tail: number; duration: number; tx: number; ty: number; }

export function CometEl({ comet, onDone }: { comet: Comet; onDone: () => void }) {
  const { x, y, angle, tail, duration, tx, ty } = comet;
  const HEAD = 3;
  const coneHalf = tail * 0.30;
  const [vanishing, setVanishing] = React.useState(false);
  const nucleusRef = React.useRef<HTMLDivElement>(null);
  const { captured, gravRef, suckStyle } = useBHGravity(x, y, { moving: true, trackRef: nucleusRef });

  React.useEffect(() => {
    if (vanishing) {
      const t = setTimeout(onDone, 300);
      return () => clearTimeout(t);
    }
    const t = setTimeout(onDone, duration + 400);
    return () => clearTimeout(t);
  }, [duration, onDone, vanishing]);

  React.useEffect(() => {
    if (!captured) return;
    const t = setTimeout(onDone, SUCK_DUR + 100);
    return () => clearTimeout(t);
  }, [captured, onDone]);

  return (
    <div ref={gravRef} data-space-dismissable="true" onClick={() => !captured && !vanishing && setVanishing(true)} style={{
      position: "absolute", left: `${x}%`, top: `${y}%`,
      willChange: "transform, opacity",
      ...(captured ? suckStyle : vanishing ? {
        animation: "m-se-vanish 0.3s ease-in forwards"
      } : {
        animationName: "m-comet", animationDuration: `${duration}ms`,
        animationTimingFunction: "linear", animationFillMode: "both"
      }),
      cursor: "pointer",
      pointerEvents: "auto",
      "--cx-tx": `${tx}px`,
      "--cx-ty": `${ty}px`,
    } as unknown as React.CSSProperties}>
      <div style={{
        transform: `rotate(${angle}deg)`,
        transformOrigin: "left center",
      }}>
        {/* Cone tail — wide at trailing end, points toward nucleus */}
        <div style={{
          position: "absolute",
          width: `${tail * 0.72}px`,
          height: `${coneHalf * 0.75}px`,
          top: `${-coneHalf * 0.375}px`,
          left: `${tail * 0.28}px`,
          background: "linear-gradient(90deg, rgba(180,225,255,0.0) 0%, rgba(160,218,255,0.12) 55%, rgba(200,235,255,0.42) 100%)",
          clipPath: "polygon(100% 50%, 0% 0%, 0% 100%)",
        }} />
        {/* Nucleus */}
        <div ref={nucleusRef} style={{
          position: "absolute",
          width: `${HEAD * 2}px`, height: `${HEAD * 2}px`,
          left: `${tail - HEAD}px`, top: `${-HEAD}px`,
          borderRadius: "50%",
          background: "radial-gradient(circle, #fff 18%, rgba(210,235,255,0.7) 50%, transparent 100%)",
          boxShadow: `0 0 ${HEAD * 0.75}px ${HEAD * 0.4}px rgba(190,225,255,0.6)`,
        }} />
      </div>
    </div>
  );
}

export function mkComet(): Comet {
  const angle = 22 + r() * 35;
  const rad = (angle * Math.PI) / 180;
  const travel = 500 + r() * 300;
  return {
    id: uid(),
    x: 2 + r() * 55,
    y: 2 + r() * 45,
    angle,
    tail: 20 + r() * 400,
    duration: 2200 + r() * 1800,
    tx: Math.cos(rad) * travel,
    ty: Math.sin(rad) * travel,
  };
}
