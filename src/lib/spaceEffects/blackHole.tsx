import React from "react";
import { r, uid } from "./_shared";

// ── 2. Black Hole ──────────────────────────────────────────────────────────────

export interface BH { id: number; x: number; y: number; duration: number; rotation: number; }

const BH_DUR = 5 * 60_000; // 5 minutes on-screen, then vanish

export function BHEl({ bh, onDone, onVanishing }: { bh: BH; onDone: () => void; onVanishing: () => void }) {
  const APPEAR = 3500;
  const VANISH = 2800;
  const [vanishing, setVanishing] = React.useState(false);

  // Parent passes fresh inline callbacks each render — timer must not depend on them
  // or the 5 min auto-vanish keeps resetting (same issue as PulsarEl).
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;
  const onVanishingRef = React.useRef(onVanishing);
  onVanishingRef.current = onVanishing;

  const startVanish = React.useCallback(() => {
    setVanishing(true);
    onVanishingRef.current();
  }, []);

  React.useEffect(() => {
    if (vanishing) {
      const t = setTimeout(() => onDoneRef.current(), VANISH);
      return () => clearTimeout(t);
    }
    // Natural lifetime: same path as click — m-bh-vanish for VANISH ms, then unmount.
    const t = setTimeout(startVanish, bh.duration - VANISH);
    return () => clearTimeout(t);
  }, [bh.duration, vanishing, startVanish]);

  const fadeAnim: React.CSSProperties = {
    animationName: vanishing ? "m-bh-vanish" : "m-bh-appear",
    animationDuration: vanishing ? `${VANISH}ms` : `${APPEAR}ms`,
    animationTimingFunction: vanishing ? "ease-in" : "ease-out",
    animationFillMode: "forwards",
  };

  return (
    <div data-space-dismissable="true" onClick={() => !vanishing && startVanish()} style={{ position: "absolute", left: `${bh.x}%`, top: `${bh.y}%`, transform: "translate(-50%, -50%)", cursor: "pointer", pointerEvents: "auto" }}>
      {/* Rotation wrapper — separate from fade so keyframe scale() doesn't overwrite rotate() */}
      <div style={{ transform: `rotate(${bh.rotation}deg)` }}>
        <div style={fadeAnim}>
          <img
            src="/bh.webp"
            alt=""
            style={{
              width: "480px",
              height: "auto",
              display: "block",
              mixBlendMode: "screen",
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function mkBH(x?: number, y?: number): BH {
  return { id: uid(), x: x ?? (15 + r() * 70), y: y ?? (15 + r() * 65), duration: BH_DUR, rotation: (r() * 90) - 45 };
}
