import { BACKGROUNDS, type BgCategory } from "@/lib/backgrounds/_registry";
import React from "react";

// ── Helpers ────────────────────────────────────────────────────────────────────

const SPACE_CATS: BgCategory[] = ["space", "jwst"];
export function isSpaceBg(bgId: string): boolean {
  return !!BACKGROUNDS.find((b) => b.id === bgId && SPACE_CATS.includes(b.category));
}

export const r = Math.random;
let _id = 0;
export const uid = () => _id++;

// ── Fire events (used by test buttons) ────────────────────────────────────────

export const EV_NOVA          = "m-fire-nova";
export const EV_BH            = "m-fire-bh";
export const EV_COMET         = "m-fire-comet";
export const EV_PULSAR        = "m-fire-pulsar";
export const EV_METEORS       = "m-fire-meteors";
export const EV_WORMHOLE      = "m-fire-wormhole";
export const EV_SHOOTING_STAR = "meridian-ss-fire";
export const EV_CLEAR         = "m-clear-all";
export const EV_ENABLED       = "m-effects-enabled";
/** Same event name used by the FX drawer to stay in sync with the overlay. */
export const SPACE_FX_TOGGLES_EVENT = "m-space-fx-kinds" as const;

const FX_KINDS_LS = "meridian-space-fx-kinds";

/** Background animation channels (auto-spawn + manual triggers respect these). */
export type SpaceEffectKind =
  | "shootingStars"
  | "comets"
  | "pulsars"
  | "meteors"
  | "wormholes"
  | "blackHole"
  | "novas";

export const SPACE_EFFECT_KINDS: SpaceEffectKind[] = [
  "shootingStars",
  "comets",
  "pulsars",
  "meteors",
  "wormholes",
  "blackHole",
  "novas",
];

export const SPACE_FX_KIND_META: Record<
  SpaceEffectKind,
  { icon: string; short: string }
> = {
  shootingStars: { icon: "✦", short: "stars" },
  comets:        { icon: "☄", short: "comet" },
  pulsars:       { icon: "※", short: "supernova" },
  meteors:       { icon: "⁂", short: "meteors" },
  wormholes:     { icon: "⊕", short: "wormhole" },
  blackHole:     { icon: "◉", short: "black hole" },
  novas:         { icon: "※", short: "supernova" },
};

const DEFAULT_KIND_TOGGLES: Record<SpaceEffectKind, boolean> = {
  shootingStars: true,
  comets:        true,
  pulsars:       true,
  meteors:       true,
  wormholes:     true,
  blackHole:     true,
  novas:         true,
};

export function loadKindToggles(): Record<SpaceEffectKind, boolean> {
  try {
    const raw = localStorage.getItem(FX_KINDS_LS);
    if (!raw) return { ...DEFAULT_KIND_TOGGLES };
    const o = JSON.parse(raw) as Partial<Record<SpaceEffectKind, boolean>>;
    return { ...DEFAULT_KIND_TOGGLES, ...o };
  } catch {
    return { ...DEFAULT_KIND_TOGGLES };
  }
}

let kindTogglesCache = loadKindToggles();

export function getSpaceEffectKindToggles(): Record<SpaceEffectKind, boolean> {
  return { ...kindTogglesCache };
}

export function setSpaceEffectKindEnabled(kind: SpaceEffectKind, on: boolean) {
  if (kindTogglesCache[kind] === on) return;
  kindTogglesCache = { ...kindTogglesCache, [kind]: on };
  try {
    localStorage.setItem(FX_KINDS_LS, JSON.stringify(kindTogglesCache));
  } catch {
    /* ignore quota */
  }
  window.dispatchEvent(
    new CustomEvent(SPACE_FX_TOGGLES_EVENT, { detail: { ...kindTogglesCache } })
  );
}

export function toggleSpaceEffectKind(kind: SpaceEffectKind) {
  setSpaceEffectKindEnabled(kind, !kindTogglesCache[kind]);
}

// ── Black hole gravity (user preference, persisted) ─────────────────────────

const BH_GRAVITY_PREF_LS = "meridian-bh-gravity-enabled";

/** Drawer + overlay stay in sync when this preference changes */
export const SPACE_FX_BH_GRAVITY_EVENT = "m-space-fx-bh-gravity" as const;

export function loadBhGravityPreference(): boolean {
  try {
    const v = localStorage.getItem(BH_GRAVITY_PREF_LS);
    if (v === null) return true;
    return v === "1" || v === "true";
  } catch {
    return true;
  }
}

let bhGravityPreferenceCache = loadBhGravityPreference();

export function getBhGravityEnabled(): boolean {
  return bhGravityPreferenceCache;
}

export function setBhGravityEnabled(on: boolean) {
  if (bhGravityPreferenceCache === on) return;
  bhGravityPreferenceCache = on;
  try {
    localStorage.setItem(BH_GRAVITY_PREF_LS, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(
    new CustomEvent(SPACE_FX_BH_GRAVITY_EVENT, { detail: on })
  );
}

export function toggleBhGravityEnabled() {
  setBhGravityEnabled(!bhGravityPreferenceCache);
}

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
export function ensureKF() {
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

// ── Black Hole gravity context + hook ─────────────────────────────────────────

// Context that broadcasts the active BH position to all animation elements.
// When non-null, animations switch to a "suck-in" mode where they fly toward
// the BH and shrink to nothing instead of playing their normal animation.
export const BHContext = React.createContext<{ x: number; y: number } | null>(null);

export const SUCK_DUR = 1400; // ms — duration of the suck-in animation

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
export function useBHGravity(myX: number, myY: number, opts?: { moving?: boolean; trackRef?: React.RefObject<HTMLDivElement> }): {
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
