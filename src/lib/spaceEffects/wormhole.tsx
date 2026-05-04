import React from "react";
import { r, uid, useBHGravity, SUCK_DUR } from "./_shared";

// ── 6. Wormhole ───────────────────────────────────────────────────────────────

export interface WH { id: number; x: number; y: number; duration: number; size: number; }

export function WormholeEl({ wh, onDone }: { wh: WH; onDone: () => void }) {
  const { x, y, duration, size: S } = wh;
  const APPEAR = 2200;
  const VANISH = 1800;
  const [vanishing, setVanishing] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const frameRef = React.useRef<number>(0);
  const { captured, gravRef, suckStyle } = useBHGravity(x, y);

  React.useEffect(() => {
    if (vanishing) {
      const t = setTimeout(onDone, VANISH);
      return () => clearTimeout(t);
    }
    const t1 = setTimeout(() => setVanishing(true), duration - VANISH);
    const t2 = setTimeout(onDone, duration + 200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [duration, onDone, vanishing]);

  React.useEffect(() => {
    if (!captured) return;
    const t = setTimeout(onDone, SUCK_DUR + 100);
    return () => clearTimeout(t);
  }, [captured, onDone]);

  // Canvas-based gravitational lensing
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    if (!ctx) return;

    const SIZE = Math.round(S * 3.2);
    const cx = SIZE / 2, cy = SIZE / 2;
    const eR = S * 0.75;         // Einstein ring radius (px)
    const eR2 = eR * eR;
    const eR4 = eR2 * eR2;

    // Seeded PRNG — reproducible star field per wormhole instance
    let seed = (wh.id * 1337 + 42) >>> 0;
    const rng = () => {
      seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };

    // Source stars placed in the sky plane (coords relative to lens center)
    const stars = Array.from({ length: 240 }, () => ({
      bx: (rng() - 0.5) * SIZE * 2.4,
      by: (rng() - 0.5) * SIZE * 2.4,
      brightness: 0.3 + rng() * 0.7,
      sz: 0.5 + rng() * 1.5,
    }));

    let t0 = 0;
    function draw(ts: number) {
      if (!t0) t0 = ts;
      const t = (ts - t0) / 1000;

      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, SIZE / 2, 0, Math.PI * 2);
      ctx.clip();


      // Gravitational lensing — two-image point mass solution
      // For source at β from center, images appear at θ = (β ± √(β²+4θE²)) / 2
      for (const star of stars) {
        const beta = Math.sqrt(star.bx * star.bx + star.by * star.by);
        if (beta < 1) continue;
        const phi = Math.atan2(star.by, star.bx);
        const disc = Math.sqrt(beta * beta + 4 * eR2);

        // Primary image: outside the Einstein ring, same angular side as source
        const theta1 = (beta + disc) / 2;
        if (theta1 > eR * 1.02 && theta1 < SIZE / 2 - 4) {
          const t14 = theta1 ** 4;
          const mag = Math.min(t14 / Math.abs(t14 - eR4), 6);
          const fade = Math.min(1, (SIZE / 2 - 4 - theta1) / 22);
          ctx.beginPath();
          ctx.arc(cx + Math.cos(phi) * theta1, cy + Math.sin(phi) * theta1,
            star.sz * Math.min(1 + mag * 0.28, 2.8), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(212,230,255,${Math.min(star.brightness * mag * 0.30, 1) * fade})`;
          ctx.fill();
        }

        // Secondary image: inside the ring, opposite side, inverted — the lensing "ghost"
        const theta2 = Math.abs((beta - disc) / 2);
        if (theta2 > 3 && theta2 < eR * 0.88) {
          const t24 = theta2 ** 4;
          const mag = Math.min(t24 / Math.abs(t24 - eR4), 5);
          ctx.beginPath();
          ctx.arc(cx + Math.cos(phi + Math.PI) * theta2, cy + Math.sin(phi + Math.PI) * theta2,
            star.sz * Math.min(1 + mag * 0.25, 2.2), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(195,218,255,${Math.min(star.brightness * mag * 0.24, 0.8)})`;
          ctx.fill();
        }
      }

      // Einstein ring — bright pulsing band where magnification → ∞
      const pulse = 0.82 + Math.sin(t * 1.8) * 0.18;

      const glow = ctx.createRadialGradient(cx, cy, eR - 22, cx, cy, eR + 22);
      glow.addColorStop(0,   "rgba(140,200,255,0)");
      glow.addColorStop(0.5, `rgba(175,222,255,${0.52 * pulse})`);
      glow.addColorStop(1,   "rgba(140,200,255,0)");
      ctx.beginPath(); ctx.arc(cx, cy, eR, 0, Math.PI * 2);
      ctx.strokeStyle = glow; ctx.lineWidth = 44; ctx.stroke();

      ctx.beginPath(); ctx.arc(cx, cy, eR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(228,244,255,${0.92 * pulse})`; ctx.lineWidth = 1.8; ctx.stroke();

      ctx.beginPath(); ctx.arc(cx, cy, eR - 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(200,230,255,${0.28 * pulse})`; ctx.lineWidth = 5; ctx.stroke();


      ctx.restore(); // lift circle clip

      // Soft-edge circular mask — feather canvas edges to transparent
      ctx.globalCompositeOperation = "destination-in";
      const mask = ctx.createRadialGradient(cx, cy, SIZE * 0.36, cx, cy, SIZE * 0.50);
      mask.addColorStop(0, "rgba(0,0,0,1)");
      mask.addColorStop(1, "rgba(0,0,0,0)");
      ctx.beginPath(); ctx.arc(cx, cy, SIZE / 2, 0, Math.PI * 2);
      ctx.fillStyle = mask; ctx.fill();
      ctx.globalCompositeOperation = "source-over";

      frameRef.current = requestAnimationFrame(draw);
    }

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [wh.id, S]);

  const SIZE = Math.round(S * 3.2);

  return (
    <div ref={gravRef} data-space-dismissable="true" onClick={() => !captured && !vanishing && setVanishing(true)} style={{
      position: "absolute", left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)",
      cursor: "pointer", pointerEvents: "auto",
      ...(captured ? suckStyle : {}),
    } as React.CSSProperties}>
      <div style={{
        animationName: captured ? undefined : vanishing ? "m-wh-vanish" : "m-wh-appear",
        animationDuration: vanishing ? `${VANISH}ms` : `${APPEAR}ms`,
        animationTimingFunction: "ease-out",
        animationFillMode: "forwards",
      }}>
        <canvas ref={canvasRef} width={SIZE} height={SIZE} style={{ display: "block" }} />
      </div>
    </div>
  );
}

export function mkWH(): WH {
  return {
    id: uid(),
    x: 12 + r() * 76,
    y: 12 + r() * 76,
    duration: (8 + r() * 9) * 1000,
    size: 60 + r() * 50,
  };
}
