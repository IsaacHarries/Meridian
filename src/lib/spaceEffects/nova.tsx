import React from "react";
import { r, uid, useBHGravity, SUCK_DUR } from "./_shared";

// ── 1. Supernova ───────────────────────────────────────────────────────────────

export interface Nova { id: number; x: number; y: number; }

const NOVA_DUR   = 3200;  // explosion blast phase (ms)
const CLOUD_START = Math.round(NOVA_DUR * 0.45); // cloud mounts during blast (~1440ms)
const CLOUD_DUR  = 6000;  // cloud collapse duration (ms)

export function NovaEl({ nova, onDone, onNearDone }: { nova: Nova; onDone: () => void; onNearDone?: () => void }) {
  const [phase, setPhase] = React.useState<"blast" | "cloud">("blast");
  const [vanishing, setVanishing] = React.useState(false);
  const { captured, gravRef, suckStyle } = useBHGravity(nova.x, nova.y);

  // Mount cloud elements while the blast is still fading out
  React.useEffect(() => {
    const t = setTimeout(() => setPhase("cloud"), CLOUD_START);
    return () => clearTimeout(t);
  }, []);

  // When captured by a black hole, skip normal lifecycle and call onDone after suck completes
  React.useEffect(() => {
    if (!captured) return;
    const t = setTimeout(onDone, SUCK_DUR + 100);
    return () => clearTimeout(t);
  }, [captured, onDone]);

  // Auto-dismiss after cloud collapses; vanish exits early.
  // onNearDone fires at 65% through the collapse so callers can overlap
  // their next animation with the cloud's fading tail.
  React.useEffect(() => {
    if (vanishing) {
      const t = setTimeout(onDone, 400);
      return () => clearTimeout(t);
    }
    if (phase === "cloud") {
      const timers: ReturnType<typeof setTimeout>[] = [];
      if (onNearDone) timers.push(setTimeout(onNearDone, Math.round(CLOUD_DUR * 0.45)));
      timers.push(setTimeout(onDone, CLOUD_DUR + 500));
      return () => timers.forEach(clearTimeout);
    }
  }, [phase, vanishing, onDone, onNearDone]);

  const blast: React.CSSProperties = {
    position: "absolute", borderRadius: "50%",
    animationTimingFunction: "ease-out", animationFillMode: "both",
  };
  const cloud: React.CSSProperties = {
    position: "absolute",
    // ease-in: collapse starts slow then accelerates, mimicking gravitational infall
    animationTimingFunction: "ease-in", animationFillMode: "forwards",
  };

  return (
    <div ref={gravRef} data-space-dismissable="true" onClick={() => !captured && !vanishing && setVanishing(true)} style={{
      position: "absolute", left: `${nova.x}%`, top: `${nova.y}%`,
      cursor: "pointer", pointerEvents: "auto",
      ...(captured ? suckStyle : vanishing ? { animation: "m-se-vanish 0.4s ease-in forwards" } : {}),
    } as React.CSSProperties}>

      {/* ── Blast phase ── */}
      {/* Wide radial flash */}
      <div style={{
        ...blast,
        width: "1400px", height: "1400px",
        left: "-700px", top: "-700px",
        background: "radial-gradient(circle, rgba(255,245,200,0.20) 0%, rgba(255,200,80,0.07) 30%, transparent 60%)",
        animationName: "m-nova-flash",
        animationDuration: "1.4s",
      }} />
      {/* Core burst */}
      <div style={{
        ...blast,
        width: "100px", height: "100px",
        left: "-50px", top: "-50px",
        background: "radial-gradient(circle, #fff 0%, hsl(55,100%,82%) 22%, hsl(35,95%,62%) 52%, transparent 100%)",
        boxShadow: "0 0 45px 22px rgba(255,220,80,0.5)",
        animationName: "m-nova-core",
        animationDuration: `${NOVA_DUR}ms`,
      }} />
      {/* Shock ring 1 — warm orange */}
      <div style={{
        ...blast,
        width: "80px", height: "80px",
        left: "-40px", top: "-40px",
        border: "2.5px solid rgba(255,165,55,0.9)",
        boxShadow: "0 0 10px rgba(255,165,55,0.45)",
        animationName: "m-nova-ring1",
        animationDuration: `${NOVA_DUR * 0.88}ms`,
        animationDelay: "170ms",
      }} />
      {/* Shock ring 2 — cool blue outer front */}
      <div style={{
        ...blast,
        width: "80px", height: "80px",
        left: "-40px", top: "-40px",
        border: "1.5px solid rgba(120,185,255,0.7)",
        animationName: "m-nova-ring2",
        animationDuration: `${NOVA_DUR}ms`,
        animationDelay: "520ms",
      }} />

      {/* ── Remnant gas cloud phase ──
            Spherical pink-purple cloud matching the NASA reference image.
            All layers are centered at (0,0) so the ease-in collapse converges
            to the same point. Dark texture patches are baked via offset radial-
            gradient focal points rather than off-centre elements.
      */}
      {phase === "cloud" && (
        <>
          {/* Outer diffuse atmosphere — soft purple halo */}
          <div style={{
            ...cloud,
            width: "700px", height: "700px",
            left: "-350px", top: "-350px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(200,145,228,0.22) 0%, rgba(165,108,208,0.15) 42%, rgba(132,82,188,0.08) 72%, transparent 90%)",
            filter: "blur(28px)",
            animationName: "m-nova-cloud-outer",
            animationDuration: `${CLOUD_DUR}ms`,
          }} />

          {/* Main cloud body — pink to purple */}
          <div style={{
            ...cloud,
            width: "540px", height: "540px",
            left: "-270px", top: "-270px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(255,215,242,0.72) 0%, rgba(238,172,222,0.58) 24%, rgba(205,132,212,0.40) 50%, rgba(168,100,198,0.20) 70%, rgba(138,78,182,0.08) 86%, transparent 96%)",
            filter: "blur(16px)",
            animationName: "m-nova-cloud-mid",
            animationDuration: `${CLOUD_DUR * 0.95}ms`,
          }} />

          {/* Dark swirling patch — upper-right (gradient focal offset) */}
          <div style={{
            ...cloud,
            width: "480px", height: "480px",
            left: "-240px", top: "-240px",
            borderRadius: "50%",
            background: "radial-gradient(ellipse at 66% 28%, rgba(92,52,138,0.32) 0%, rgba(78,40,122,0.16) 38%, transparent 65%)",
            filter: "blur(22px)",
            animationName: "m-nova-filament",
            animationDuration: `${CLOUD_DUR * 0.93}ms`,
          }} />

          {/* Dark swirling patch — lower-left (gradient focal offset) */}
          <div style={{
            ...cloud,
            width: "460px", height: "460px",
            left: "-230px", top: "-230px",
            borderRadius: "50%",
            background: "radial-gradient(ellipse at 32% 70%, rgba(72,38,118,0.26) 0%, rgba(60,28,105,0.12) 40%, transparent 68%)",
            filter: "blur(20px)",
            animationName: "m-nova-filament",
            animationDuration: `${CLOUD_DUR * 0.87}ms`,
          }} />

          {/* Bright inner glow — white-pink */}
          <div style={{
            ...cloud,
            width: "300px", height: "300px",
            left: "-150px", top: "-150px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(255,235,250,0.82) 18%, rgba(252,198,238,0.62) 40%, rgba(228,155,218,0.30) 65%, transparent 84%)",
            filter: "blur(10px)",
            animationName: "m-nova-cloud-inner",
            animationDuration: `${CLOUD_DUR * 0.88}ms`,
          }} />

          {/* Hot white core */}
          <div style={{
            ...cloud,
            width: "130px", height: "130px",
            left: "-65px", top: "-65px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(255,255,255,1) 0%, rgba(255,252,255,0.96) 22%, rgba(252,224,248,0.75) 48%, transparent 80%)",
            filter: "blur(4px)",
            animationName: "m-nova-filament",
            animationDuration: `${CLOUD_DUR * 0.85}ms`,
          }} />
        </>
      )}

    </div>
  );
}

export function mkNova(): Nova { return { id: uid(), x: 8 + r() * 84, y: 8 + r() * 84 }; }
