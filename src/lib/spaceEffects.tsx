import React from "react";
import { BACKGROUNDS, type BgCategory } from "./backgrounds";

// ── Helpers ────────────────────────────────────────────────────────────────────

const SPACE_CATS: BgCategory[] = ["space", "jwst"];
export function isSpaceBg(bgId: string): boolean {
  return !!BACKGROUNDS.find((b) => b.id === bgId && SPACE_CATS.includes(b.category));
}

const r = Math.random;
let _id = 0;
const uid = () => _id++;

// ── Fire events (used by test buttons) ────────────────────────────────────────

const EV_NOVA          = "m-fire-nova";
const EV_BH            = "m-fire-bh";
const EV_COMET         = "m-fire-comet";
const EV_PULSAR        = "m-fire-pulsar";
const EV_METEORS       = "m-fire-meteors";
const EV_WORMHOLE      = "m-fire-wormhole";
const EV_SHOOTING_STAR = "meridian-ss-fire";
const EV_CLEAR         = "m-clear-all";
const EV_ENABLED       = "m-effects-enabled";

export const fireSupernova    = () => window.dispatchEvent(new CustomEvent(EV_NOVA));
export const fireBlackHole    = () => window.dispatchEvent(new CustomEvent(EV_BH));
export const fireComet        = () => window.dispatchEvent(new CustomEvent(EV_COMET));
export const firePulsar       = () => window.dispatchEvent(new CustomEvent(EV_PULSAR));
export const fireMeteorShower = () => window.dispatchEvent(new CustomEvent(EV_METEORS));
export const fireWormhole     = () => window.dispatchEvent(new CustomEvent(EV_WORMHOLE));
export const fireShootingStar = () => window.dispatchEvent(new CustomEvent(EV_SHOOTING_STAR));
export const clearAllEffects  = () => window.dispatchEvent(new CustomEvent(EV_CLEAR));
export const setEffectsEnabled = (on: boolean) => window.dispatchEvent(new CustomEvent(EV_ENABLED, { detail: on }));

// ── CSS keyframe injection ─────────────────────────────────────────────────────

const KF_ID = "m-se-kf";
function ensureKF() {
  if (document.getElementById(KF_ID)) return;
  const s = document.createElement("style");
  s.id = KF_ID;
  s.textContent = `
    /* ── Supernova ── */
    @keyframes m-nova-core {
      0%   { transform: scale(0.05); opacity: 1; filter: brightness(6) saturate(0.2); }
      12%  { transform: scale(1);    opacity: 1; filter: brightness(2.5) saturate(1); }
      50%  { transform: scale(2.5);  opacity: 0.5; }
      100% { transform: scale(5);    opacity: 0; }
    }
    @keyframes m-nova-ring1 {
      0%   { transform: scale(0.3);  opacity: 0.9; }
      100% { transform: scale(10);   opacity: 0; }
    }
    @keyframes m-nova-ring2 {
      0%   { transform: scale(0.5);  opacity: 0.7; }
      100% { transform: scale(16);   opacity: 0; }
    }
    @keyframes m-nova-flash {
      0%,100% { opacity: 0; }
      8%      { opacity: 1; }
      28%     { opacity: 0; }
    }
    /* ── Supernova Remnant Gas Cloud ──
       Fades in at full size while the blast is still dying out, holds briefly,
       then gravity collapses it inward to the size of the neutron star point.
       ease-in on the shrink makes the collapse accelerate like real gravity.
    */
    @keyframes m-nova-cloud-outer {
      0%   { transform: scale(1);     opacity: 0; }
      9%   { transform: scale(1.02);  opacity: 0.76; }
      18%  { transform: scale(1.02);  opacity: 0.76; }
      100% { transform: scale(0.015); opacity: 0; }
    }
    @keyframes m-nova-cloud-mid {
      0%   { transform: scale(0.92) rotate(-4deg); opacity: 0; }
      10%  { transform: scale(0.94) rotate(-4deg); opacity: 0.84; }
      18%  { transform: scale(0.94) rotate(-4deg); opacity: 0.84; }
      100% { transform: scale(0.015) rotate(3deg); opacity: 0; }
    }
    @keyframes m-nova-cloud-inner {
      0%   { transform: scale(0.78); opacity: 0; }
      11%  { transform: scale(0.80); opacity: 0.88; }
      18%  { transform: scale(0.80); opacity: 0.88; }
      100% { transform: scale(0.015); opacity: 0; }
    }
    @keyframes m-nova-filament {
      0%   { transform: scale(1.05); opacity: 0; }
      8%   { opacity: 0.62; }
      18%  { opacity: 0.62; }
      100% { transform: scale(0.015); opacity: 0; }
    }
    /* ── Black Hole ── */
    @keyframes m-bh-appear {
      from { opacity: 0; transform: scale(0.05); }
      to   { opacity: 1; transform: scale(1); }
    }
    @keyframes m-bh-vanish {
      from { opacity: 1; transform: scale(1); }
      to   { opacity: 0; transform: scale(0.05); }
    }
    @keyframes m-bh-disk-rot {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    @keyframes m-bh-arch-pulse {
      0%,100% { opacity: 0.82; }
      50%     { opacity: 1; }
    }
    /* ── Pulsar ── */
    @keyframes m-pulsar-spin {
      0%      { transform: translate(-50%,-50%) rotate(0deg); animation-timing-function: ease-out; }
      12.5%   { transform: translate(-50%,-50%) rotate(26deg); animation-timing-function: ease-in; }
      25%     { transform: translate(-50%,-50%) rotate(0deg); animation-timing-function: ease-out; }
      37.5%   { transform: translate(-50%,-50%) rotate(-26deg); animation-timing-function: ease-in; }
      50%     { transform: translate(-50%,-50%) rotate(0deg); animation-timing-function: ease-out; }
      62.5%   { transform: translate(-50%,-50%) rotate(26deg); animation-timing-function: ease-in; }
      75%     { transform: translate(-50%,-50%) rotate(0deg); animation-timing-function: ease-out; }
      87.5%   { transform: translate(-50%,-50%) rotate(-26deg); animation-timing-function: ease-in; }
      100%    { transform: translate(-50%,-50%) rotate(0deg); }
    }
    @keyframes m-pulsar-core {
      0%,42%,58%,100% { opacity: 0.35; transform: translate(-50%,-50%) scale(0.8); box-shadow: 0 0 4px 2px rgba(160,210,255,0.35); }
      50%             { opacity: 1;    transform: translate(-50%,-50%) scale(1.5); box-shadow: 0 0 18px 8px rgba(160,210,255,0.9); }
    }
    @keyframes m-pulsar-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    /* ── Shooting Star ── */
    @keyframes meridian-ss {
      0%   { transform: translate(0,0); opacity: 0; }
      8%   { opacity: 1; }
      80%  { opacity: 0.8; }
      100% { transform: translate(var(--ss-tx),var(--ss-ty)); opacity: 0; }
    }
    /* ── Comet ── */
    @keyframes m-comet {
      0%   { transform: translate(0,0); opacity: 0; }
      6%   { opacity: 1; }
      88%  { opacity: 1; }
      100% { transform: translate(var(--cx-tx),var(--cx-ty)); opacity: 0; }
    }
    /* ── Meteor (shower) ── */
    @keyframes m-meteor {
      0%   { transform: translate(0,0); opacity: 0; }
      8%   { opacity: 1; }
      80%  { opacity: 0.9; }
      100% { transform: translate(var(--mt-tx),var(--mt-ty)); opacity: 0; }
    }
    /* ── Wormhole ── */
    @keyframes m-wh-appear {
      from { opacity: 0; transform: scale(0) rotate(-540deg); }
      to   { opacity: 1; transform: scale(1) rotate(0deg); }
    }
    @keyframes m-wh-vanish {
      from { opacity: 1; transform: scale(1) rotate(0deg); }
      to   { opacity: 0; transform: scale(0) rotate(540deg); }
    }
    @keyframes m-wh-cw {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    @keyframes m-wh-ccw {
      from { transform: rotate(0deg); }
      to   { transform: rotate(-360deg); }
    }
    @keyframes m-wh-core {
      0%,100% { opacity: 0.5; transform: translate(-50%,-50%) scale(0.88); }
      50%     { opacity: 1;   transform: translate(-50%,-50%) scale(1.12); }
    }
    @keyframes m-se-vanish {
      to { opacity: 0; scale: 0; }
    }
    /* ── Black-hole suck-in ──
       --grav-x/y: gravity drift offset at capture time (element's current displaced position).
       --bh-tx/ty: BH position relative to the element's original spawn point.
       The animation starts at the gravity-drifted position and pulls into the BH.
    */
    @keyframes m-bh-suck {
      0%   { transform: translate(var(--grav-x, 0px), var(--grav-y, 0px)) scale(1);    opacity: 1; }
      60%  { transform: translate(var(--bh-tx), var(--bh-ty))              scale(0.18); opacity: 0.7; }
      100% { transform: translate(var(--bh-tx), var(--bh-ty))              scale(0);    opacity: 0; }
    }
  `;
  document.head.appendChild(s);
}

// ── 1. Supernova ───────────────────────────────────────────────────────────────

interface Nova { id: number; x: number; y: number; }

const NOVA_DUR   = 3200;  // explosion blast phase (ms)
const CLOUD_START = Math.round(NOVA_DUR * 0.45); // cloud mounts during blast (~1440ms)
const CLOUD_DUR  = 6000;  // cloud collapse duration (ms)

function NovaEl({ nova, onDone, onNearDone }: { nova: Nova; onDone: () => void; onNearDone?: () => void }) {
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

function mkNova(): Nova { return { id: uid(), x: 8 + r() * 84, y: 8 + r() * 84 }; }

// ── 2. Black Hole ──────────────────────────────────────────────────────────────

interface BH { id: number; x: number; y: number; duration: number; rotation: number; }
interface BHDayRec { date: string; show: boolean; x: number; y: number; }

const BH_LS = "meridian-bh-day";
const BH_DUR = 10 * 60_000; // 10 minutes on-screen

// Context that broadcasts the active BH position to all animation elements.
// When non-null, animations switch to a "suck-in" mode where they fly toward
// the BH and shrink to nothing instead of playing their normal animation.
const BHContext = React.createContext<{ x: number; y: number } | null>(null);

const SUCK_DUR = 1400; // ms — duration of the suck-in animation

// How close a stationary object must drift before suck-in fires (px).
const CAPTURE_RADIUS_PX = 50;
// Capture radius for fast-moving elements checked via visual bounding rect (px).
// Smaller so only passes through the visible dark core trigger a capture.
const MOVING_CAPTURE_RADIUS_PX = 60;
// Gravitational constant — gentle pull that builds gradually as objects get closer.
const G_CONST = 1200;
// Hard cap on drift velocity (px/s).
const MAX_DRIFT_SPEED = 300;

/**
 * Gravity simulation hook — two modes:
 *
 * Default (moving = false) — for stationary elements (nova, pulsar, wormhole):
 *   - Always runs the rAF loop when a BH is active.
 *   - Runs a Newtonian physics loop, updating `element.style.translate` directly.
 *   - Captures when the drifted position crosses CAPTURE_RADIUS_PX.
 *
 * moving = true — for elements with their own CSS animation (comet, meteor, star):
 *   - Always runs the rAF loop when a BH is active.
 *   - Reads the element's actual visual bounding rect each frame (respects the
 *     CSS animation's current translation).
 *   - No gravity drift applied — just instant capture when the visual position
 *     crosses MOVING_CAPTURE_RADIUS_PX.  Fast movers don't need a slow pull.
 */
function useBHGravity(myX: number, myY: number, opts?: { moving?: boolean; trackRef?: React.RefObject<HTMLDivElement> }): {
  captured: boolean;
  gravRef: React.RefObject<HTMLDivElement>;
  suckStyle: React.CSSProperties;
  captureAngle: number;
} {
  const moving = opts?.moving ?? false;
  const bh = React.useContext(BHContext);
  const divRef = React.useRef<HTMLDivElement>(null);
  const physRef    = React.useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const captureRef = React.useRef({ gravX: 0, gravY: 0, bhTx: 0, bhTy: 0, angle: 0 });
  const frameRef   = React.useRef<number>(0);
  const prevTsRef  = React.useRef<number>(0);
  const [captured, setCaptured] = React.useState(false);

  React.useEffect(() => {
    if (!bh || captured) return;

    const bhPx  = (bh.x / 100) * window.innerWidth;
    const bhPy  = (bh.y / 100) * window.innerHeight;
    const origX = (myX  / 100) * window.innerWidth;
    const origY = (myY  / 100) * window.innerHeight;

    prevTsRef.current = 0;

    function tick(ts: number) {
      if (!prevTsRef.current) {
        prevTsRef.current = ts;
        frameRef.current = requestAnimationFrame(tick);
        return;
      }

      if (moving) {
        // ── Fast-mover mode ──────────────────────────────────────────────────
        // Use the element's live bounding rect so we track its CSS-animated position.
        const el = divRef.current;
        if (!el) { frameRef.current = requestAnimationFrame(tick); return; }

        // trackRef (e.g. comet nucleus) is used for proximity detection so that
        // the capture point is the leading edge, not the bounding-box center.
        // Fall back to the outer div if no trackRef is provided.
        const probeEl = opts?.trackRef?.current ?? el;
        const probeRect = probeEl.getBoundingClientRect();
        const probeX = probeRect.left + probeRect.width  / 2;
        const probeY = probeRect.top  + probeRect.height / 2;
        const dx = bhPx - probeX;
        const dy = bhPy - probeY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < MOVING_CAPTURE_RADIUS_PX) {
          // Read the CSS animation's current translation via the computed transform
          // matrix. This gives the outer div's exact origin offset from spawn —
          // using the bounding-rect centre instead would cause a visual snap because
          // the rect is enlarged by the element's children (tail, streak, etc.).
          const t = window.getComputedStyle(el).transform;
          const matrix = t && t !== "none" ? new DOMMatrix(t) : new DOMMatrix();
          const gravX = matrix.m41;
          const gravY = matrix.m42;
          captureRef.current = {
            gravX,
            gravY,
            bhTx: bhPx - origX,
            bhTy: bhPy - origY,
            angle: Math.atan2(dy, dx) * (180 / Math.PI),
          };
          setCaptured(true);
          return;
        }
        frameRef.current = requestAnimationFrame(tick);
      } else {
        // ── Stationary mode ──────────────────────────────────────────────────
        const dt = Math.min((ts - prevTsRef.current) / 1000, 0.05);
        prevTsRef.current = ts;

        const s    = physRef.current;
        const curX = origX + s.x;
        const curY = origY + s.y;
        const dx   = bhPx - curX;
        const dy   = bhPy - curY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < CAPTURE_RADIUS_PX) {
          captureRef.current = {
            gravX: s.x, gravY: s.y,
            bhTx: s.x + dx, bhTy: s.y + dy,
            angle: Math.atan2(dy, dx) * (180 / Math.PI),
          };
          setCaptured(true);
          return;
        }

        const acc = G_CONST / (dist * dist);
        s.vx += (dx / dist) * acc * dt;
        s.vy += (dy / dist) * acc * dt;
        const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
        if (speed > MAX_DRIFT_SPEED) {
          s.vx = (s.vx / speed) * MAX_DRIFT_SPEED;
          s.vy = (s.vy / speed) * MAX_DRIFT_SPEED;
        }
        s.x += s.vx * dt;
        s.y += s.vy * dt;

        if (divRef.current) {
          (divRef.current.style as unknown as Record<string, string>).translate =
            `${s.x}px ${s.y}px`;
        }
        frameRef.current = requestAnimationFrame(tick);
      }
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [bh, captured, moving, myX, myY]);

  // Reset everything when the BH disappears
  React.useEffect(() => {
    if (bh) return;
    cancelAnimationFrame(frameRef.current);
    physRef.current = { x: 0, y: 0, vx: 0, vy: 0 };
    prevTsRef.current = 0;
    setCaptured(false);
    if (divRef.current) {
      (divRef.current.style as unknown as Record<string, string>).translate = "";
    }
  }, [bh]);

  const suckStyle: React.CSSProperties = captured
    ? {
        translate: "none",
        animationName: "m-bh-suck",
        animationDuration: `${SUCK_DUR}ms`,
        animationTimingFunction: "ease-in",
        animationFillMode: "forwards",
        "--grav-x": `${captureRef.current.gravX}px`,
        "--grav-y": `${captureRef.current.gravY}px`,
        "--bh-tx":  `${captureRef.current.bhTx}px`,
        "--bh-ty":  `${captureRef.current.bhTy}px`,
      } as React.CSSProperties
    : {};

  return { captured, gravRef: divRef, suckStyle, captureAngle: captureRef.current.angle };
}

function getBHRec(): BHDayRec {
  const today = new Date().toDateString();
  try {
    const raw = localStorage.getItem(BH_LS);
    if (raw) {
      const rec = JSON.parse(raw) as BHDayRec;
      if (rec.date === today) return rec;
    }
  } catch { /* */ }
  const rec: BHDayRec = {
    date: today,
    show: Math.random() < 0.10,
    x: 18 + Math.random() * 64,
    y: 18 + Math.random() * 64,
  };
  try { localStorage.setItem(BH_LS, JSON.stringify(rec)); } catch { /* */ }
  return rec;
}

function BHEl({ bh, onDone, onVanishing }: { bh: BH; onDone: () => void; onVanishing: () => void }) {
  const APPEAR = 3500;
  const VANISH = 2800;
  const [vanishing, setVanishing] = React.useState(false);

  const startVanish = React.useCallback(() => {
    setVanishing(true);
    onVanishing();
  }, [onVanishing]);

  React.useEffect(() => {
    if (vanishing) {
      const t = setTimeout(onDone, VANISH);
      return () => clearTimeout(t);
    }
    const t1 = setTimeout(startVanish, bh.duration - VANISH);
    const t2 = setTimeout(onDone, bh.duration + 200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [bh.duration, onDone, vanishing, startVanish]);

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

function mkBH(x?: number, y?: number): BH {
  return { id: uid(), x: x ?? (15 + r() * 70), y: y ?? (15 + r() * 65), duration: BH_DUR, rotation: (r() * 90) - 45 };
}

// ── 3. Comet ───────────────────────────────────────────────────────────────────

interface Comet { id: number; x: number; y: number; angle: number; tail: number; duration: number; tx: number; ty: number; }

function CometEl({ comet, onDone }: { comet: Comet; onDone: () => void }) {
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

function mkComet(): Comet {
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

// ── 4. Pulsar ──────────────────────────────────────────────────────────────────

interface Pulsar { id: number; x: number; y: number; duration: number; period: number; }

function PulsarEl({ pulsar, onDone }: { pulsar: Pulsar; onDone: () => void }) {
  const [novaDone, setNovaDone] = React.useState(false);
  const [showPulsar, setShowPulsar] = React.useState(false);
  const [vanishing, setVanishing] = React.useState(false);
  const { x, y, duration, period } = pulsar;
  const BEAM_LEN = 600;
  const { captured, gravRef, suckStyle } = useBHGravity(x, y);

  // Stable callbacks so NovaEl's useEffect dependency array never sees a new
  // reference — inline lambdas would reset the cloud timers on every re-render
  // of PulsarEl (e.g. triggered by meteors completing during a shower).
  const handleNovaNearDone = React.useCallback(() => setShowPulsar(true), []);
  const handleNovaDone     = React.useCallback(() => setNovaDone(true), []);

  // Pulsar emerges after the gas cloud finishes collapsing (novaDone fires).
  // Also serves as a fallback when the nova is cut short by the black hole —
  // onNearDone is never called in that path, so we catch it here instead.
  React.useEffect(() => {
    if (novaDone) setShowPulsar(true);
  }, [novaDone]);

  React.useEffect(() => {
    if (!showPulsar) return;
    if (vanishing) {
      const t = setTimeout(onDone, 300);
      return () => clearTimeout(t);
    }
    const t = setTimeout(onDone, duration + 200);
    return () => clearTimeout(t);
  }, [duration, onDone, showPulsar, vanishing]);

  // When captured, skip normal lifecycle for the pulsar phase
  React.useEffect(() => {
    if (!captured || !showPulsar) return;
    const t = setTimeout(onDone, SUCK_DUR + 100);
    return () => clearTimeout(t);
  }, [captured, showPulsar, onDone]);

  const beamStyle = (delay: string): React.CSSProperties => ({
    position: "absolute",
    width: `${BEAM_LEN}px`, height: "2px",
    left: "50%", top: "50%",
    transform: "translate(-50%, -50%)",
    background: "linear-gradient(90deg, transparent 0%, rgba(160,210,255,0.25) 20%, rgba(160,210,255,0.65) 50%, rgba(160,210,255,0.25) 80%, transparent 100%)",
    filter: "blur(1.5px)",
    animationName: "m-pulsar-spin",
    animationDuration: `${period}ms`,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationDelay: delay,
  });

  return (
    <>
      {!novaDone && <NovaEl nova={{ id: pulsar.id, x, y }} onNearDone={handleNovaNearDone} onDone={handleNovaDone} />}
      {showPulsar && (
        <div ref={gravRef} data-space-dismissable="true" onClick={() => !captured && !vanishing && setVanishing(true)} style={{
          position: "absolute", left: `${x}%`, top: `${y}%`,
          transform: `rotate(${pulsar.id * 47}deg)`,
          ...(captured ? suckStyle : { animation: vanishing ? "m-se-vanish 0.3s ease-in forwards" : "m-pulsar-fade-in 3s ease-out forwards" }),
          cursor: "pointer", pointerEvents: "auto",
        } as React.CSSProperties}>
          {/* Single light beam */}
          <div style={beamStyle("0ms")} />
          {/* Pulsing core */}
          <div style={{
            position: "absolute",
            width: "8px", height: "8px",
            left: "50%", top: "50%",
            borderRadius: "50%",
            background: "rgba(210,230,255,0.95)",
            animationName: "m-pulsar-core",
            animationDuration: `${period}ms`,
            animationTimingFunction: "ease-in-out",
            animationIterationCount: "infinite",
          }} />
        </div>
      )}
    </>
  );
}

function mkPulsar(): Pulsar {
  return {
    id: uid(),
    x: 10 + r() * 80,
    y: 10 + r() * 80,
    duration: 120_000,
    period: 16000 + r() * 4800,
  };
}

// ── 5. Meteor Shower ───────────────────────────────────────────────────────────

interface Meteor { id: number; x: number; y: number; angle: number; length: number; travel: number; duration: number; delay: number; }

function MeteorEl({ meteor, onDone }: { meteor: Meteor; onDone: () => void }) {
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

function mkMeteors(): Meteor[] {
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

// ── 6. Wormhole ───────────────────────────────────────────────────────────────

interface WH { id: number; x: number; y: number; duration: number; size: number; }

function WormholeEl({ wh, onDone }: { wh: WH; onDone: () => void }) {
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

function mkWH(): WH {
  return {
    id: uid(),
    x: 12 + r() * 76,
    y: 12 + r() * 76,
    duration: (8 + r() * 9) * 1000,
    size: 60 + r() * 50,
  };
}

// ── 7. Shooting Star ──────────────────────────────────────────────────────────

interface SStar {
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

function ShootingStarEl({ star, onDone }: { star: SStar; onDone: () => void }) {
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

function mkShootingStars(count: number): SStar[] {
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

// ── SpaceEffectsOverlay ───────────────────────────────────────────────────────

interface State {
  novas: Nova[];
  bh: BH | null;
  comets: Comet[];
  pulsars: Pulsar[];
  meteors: Meteor[];
  wormholes: WH[];
  shootingStars: SStar[];
}

const EMPTY: State = { novas: [], bh: null, comets: [], pulsars: [], meteors: [], wormholes: [], shootingStars: [] };

export function SpaceEffectsOverlay({ bgId }: { bgId: string }) {
  const space = isSpaceBg(bgId);
  const [st, setSt] = React.useState<State>(EMPTY);
  const [enabled, setEnabled] = React.useState(true);
  // Gravity turns off the moment the BH starts vanishing, even though the
  // visual fade-out continues for another ~2.8 s.
  const [bhGravityActive, setBhGravityActive] = React.useState(false);

  const onBHVanishing = React.useCallback(() => setBhGravityActive(false), []);

  const addNova    = React.useCallback(() => setSt(p => ({ ...p, novas:    [...p.novas, mkNova()] })), []);
  const addBH      = React.useCallback((x?: number, y?: number) => setSt(p => {
    if (p.bh) return p;
    setBhGravityActive(true);
    return { ...p, bh: mkBH(x, y) };
  }), []);
  const replaceBH  = React.useCallback(() => setSt(p => {
    setBhGravityActive(true);
    return { ...p, bh: mkBH() };
  }), []);
  const addComet   = React.useCallback(() => setSt(p => ({ ...p, comets:   [...p.comets, mkComet()] })), []);
  const addPulsar     = React.useCallback(() => setSt(p => p.pulsars.length > 0 ? p : ({ ...p, pulsars: [mkPulsar()] })), []);
  const replacePulsar = React.useCallback(() => setSt(p => ({ ...p, pulsars: [mkPulsar()] })), []);
  const addMeteors = React.useCallback(() => setSt(p => ({ ...p, meteors:  [...p.meteors, ...mkMeteors()] })), []);
  const addWH      = React.useCallback(() => setSt(p => ({ ...p, wormholes:[...p.wormholes, mkWH()] })), []);
  const replaceWH  = React.useCallback(() => setSt(p => ({ ...p, wormholes: [mkWH()] })), []);
  const addShootingStars = React.useCallback((count: number) => setSt(p => ({ ...p, shootingStars: [...p.shootingStars, ...mkShootingStars(count)] })), []);

  // Forward clicks through the UI layer to animation elements underneath.
  // Because GlobalForeground sits at z-[0] behind the z-[1] content wrapper,
  // native hit-testing never reaches the animation elements. We intercept every
  // trusted document click in capture phase, find any [data-space-dismissable]
  // element at that point via elementsFromPoint, and dispatch a synthetic click
  // on it so React's onClick handler fires normally.
  //
  // We stop before forwarding if any real interactive UI element (button, link,
  // input, etc.) appears in front of the space element — those must win.
  React.useEffect(() => {
    const INTERACTIVE = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
    function isInteractive(el: Element): boolean {
      const h = el as HTMLElement;
      return (
        INTERACTIVE.has(h.tagName) ||
        h.role === "button" ||
        h.getAttribute("role") === "button" ||
        h.tabIndex >= 0 ||
        h.isContentEditable
      );
    }

    function handleClick(e: MouseEvent) {
      if (!e.isTrusted) return;
      const els = document.elementsFromPoint(e.clientX, e.clientY);
      // Walk front-to-back; if we hit an interactive element before a space
      // element, the real UI gets the click — don't forward.
      for (const el of els) {
        if ((el as HTMLElement).dataset?.spaceDismissable === "true") {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          break;
        }
        if (isInteractive(el)) break;
      }
    }
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  // Listen for manual fire events, clear, and enabled toggle
  React.useEffect(() => {
    ensureKF();
    const clearAll = () => setSt(EMPTY);
    const onEnabled = (e: Event) => {
      const on = (e as CustomEvent<boolean>).detail;
      setEnabled(on);
      if (!on) setSt(EMPTY);
    };
    const pairs: [string, () => void][] = [
      [EV_NOVA,          () => { if (enabled) addNova(); }],
      [EV_BH,            () => { if (enabled) replaceBH(); }],
      [EV_COMET,         () => { if (enabled) addComet(); }],
      [EV_PULSAR,        () => { if (enabled) replacePulsar(); }],
      [EV_METEORS,       () => { if (enabled) addMeteors(); }],
      [EV_WORMHOLE,      () => { if (enabled) replaceWH(); }],
      [EV_SHOOTING_STAR, () => { if (enabled) addShootingStars(1 + Math.floor(Math.random() * 3)); }],
    ];
    pairs.forEach(([ev, fn]) => window.addEventListener(ev, fn));
    window.addEventListener(EV_CLEAR, clearAll);
    window.addEventListener(EV_ENABLED, onEnabled);
    return () => {
      pairs.forEach(([ev, fn]) => window.removeEventListener(ev, fn));
      window.removeEventListener(EV_CLEAR, clearAll);
      window.removeEventListener(EV_ENABLED, onEnabled);
    };
  }, [enabled, addNova, addBH, replaceBH, addComet, addPulsar, replacePulsar, addMeteors, addWH, replaceWH, addShootingStars]);

  // Auto-schedule random effects when on a space background and effects are enabled
  React.useEffect(() => {
    if (!space || !enabled) { if (!space) setSt(EMPTY); return; }
    ensureKF();

    const timers: ReturnType<typeof setTimeout>[] = [];
    const sched = (fn: () => void, minMs: number, maxMs: number) => {
      const tick = () => {
        fn();
        timers.push(setTimeout(tick, minMs + r() * (maxMs - minMs)));
      };
      timers.push(setTimeout(tick, minMs + r() * (maxMs - minMs)));
    };

    sched(addComet,        18_000,  55_000);
    sched(addPulsar,       55_000, 160_000);
    sched(addMeteors,      80_000, 220_000);
    sched(addWH,        3_600_000, 7_200_000);
    // Shooting stars: every 2.5–8 s, occasionally 2 at once
    sched(() => addShootingStars(Math.random() < 0.25 ? 2 : 1), 2_500, 8_000);

    // Black hole: daily 10% check
    const rec = getBHRec();
    if (rec.show) {
      // Small delay so it appears after background settles
      timers.push(setTimeout(() => addBH(rec.x, rec.y), 4000));
    }

    return () => timers.forEach(clearTimeout);
  }, [space, enabled, addNova, addComet, addPulsar, addMeteors, addWH, addBH, addShootingStars]);

  const rmNova    = (id: number) => setSt(p => ({ ...p, novas:         p.novas.filter(x => x.id !== id) }));
  const rmComet   = (id: number) => setSt(p => ({ ...p, comets:        p.comets.filter(x => x.id !== id) }));
  const rmPulsar  = (id: number) => setSt(p => ({ ...p, pulsars:       p.pulsars.filter(x => x.id !== id) }));
  const rmMeteor  = (id: number) => setSt(p => ({ ...p, meteors:       p.meteors.filter(x => x.id !== id) }));
  const rmWH      = (id: number) => setSt(p => ({ ...p, wormholes:     p.wormholes.filter(x => x.id !== id) }));
  const rmStar    = (id: number) => setSt(p => ({ ...p, shootingStars: p.shootingStars.filter(x => x.id !== id) }));

  const empty = !st.bh && !st.novas.length && !st.comets.length && !st.pulsars.length && !st.meteors.length && !st.wormholes.length && !st.shootingStars.length;
  if (!space && empty) return null;

  return (
    <BHContext.Provider value={st.bh && bhGravityActive ? { x: st.bh.x, y: st.bh.y } : null}>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
        {st.novas.map(n =>
          <NovaEl key={n.id} nova={n} onDone={() => rmNova(n.id)} />
        )}
        {st.bh &&
          <BHEl bh={st.bh} onVanishing={onBHVanishing} onDone={() => { setSt(p => ({ ...p, bh: null })); setBhGravityActive(false); }} />
        }
        {st.comets.map(c =>
          <CometEl key={c.id} comet={c} onDone={() => rmComet(c.id)} />
        )}
        {st.pulsars.map(p =>
          <PulsarEl key={p.id} pulsar={p} onDone={() => rmPulsar(p.id)} />
        )}
        {st.meteors.map(m =>
          <MeteorEl key={m.id} meteor={m} onDone={() => rmMeteor(m.id)} />
        )}
        {st.wormholes.map(w =>
          <WormholeEl key={w.id} wh={w} onDone={() => rmWH(w.id)} />
        )}
        {st.shootingStars.map(s =>
          <ShootingStarEl key={s.id} star={s} onDone={() => rmStar(s.id)} />
        )}
      </div>
    </BHContext.Provider>
  );
}

