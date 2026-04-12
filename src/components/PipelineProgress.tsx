import { useState, useEffect, useRef, useLayoutEffect } from "react";

export const PIPELINE_STEPS = [
  "Grooming",
  "Impact Analysis",
  "Triage",
  "Implementation",
  "Test Generation",
  "Code Review",
  "PR Description",
  "Retrospective",
];

// ── Geometry ──────────────────────────────────────────────────────────────────
//
// LOGO MODE  (activeStep === undefined)
// ─────────────────────────────────────
//  Nodes and arc derived by applying the SVG's own transform
//  (translate(120 120) scale(1.35) translate(-120 -111)) to the original
//  coordinates, then uniformly scaling to fit the 960×116 viewBox while
//  preserving the icon's aspect ratio  (scale = 0.5144, centred at x = 480).
//
//  Nodes sit ABOVE the arc — they are independent of it, not on the curve.
//  The arc is purely decorative and exits the viewBox below y ≈ 80 (clipped).
//
//  Logo layout (960 × 116 space):
//    (428, 72) outer-left  r=6   ← decorative, not a pipeline node
//    (451, 51) inner-left  r=6   ← decorative, not a pipeline node
//    (480, 36) centre      r=8   → pipeline node 0  (Grooming)  ← topmost
//    (509, 51) inner-right r=6   → pipeline node 1  (Impact Analysis)
//    (532, 72) outer-right r=6   → pipeline node 2  (Triage)
//    halo: cx=480 cy=36 r=13
//    arc:  M 422 105  C 452 51  508 51  539 106
//
// PIPELINE MODE  (activeStep = 0-7)
// ──────────────────────────────────
//  Eight nodes on a large circle whose centre sits far below the header.
//  Only the shallow top arc is ever visible; nodes rotate like a clock face.
//  ACTIVE_X / NODE_Y marks the fixed 12-o'clock position (active step).
//
//   R = 1066, spacing = 7°
//   θ = 0°  → (400,  32)   active
//   θ = ±7° → (530/270, 40)
//   θ = ±14°→ (658/142, 63)
//   θ = ±21°→ (782/18,  103) — just below clip edge
//
// TRANSITION
// ──────────
//  When activeStep flips undefined ↔ number the component morphs smoothly:
//  the five visible logo dots map to the inner five clock positions for the
//  active step (indices s−2…s+2); remaining indices start from hidden logo
//  slots. Step-to-step motion keeps fixed pipeline index → same circle element.
//  The arc and halo also move / fade in sync.  All animation uses a single
//  requestAnimationFrame loop with easeInOutCubic easing.
//  Pipeline step changes interpolate the active step in float space so nodes stay
//  on R_CIRC (Cartesian lerp would cut chords through the arch).
//  Duration: 700 ms for mode changes, 580 ms for step-to-step advances.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_X  = 400;
const NODE_Y    = 32;
const R_CIRC    = 1066;
const CY        = NODE_Y + R_CIRC;   // 1098 — circle centre far below header
const ANGLE_DEG = 7;
const RAD       = Math.PI / 180;

const DOT_R     = 7;
const ACT_R     = 10;
const PIPE_HR   = 18;   // pipeline halo radius
const LOGO_HR   = 13;   // logo halo radius (scaled from original SVG r=19*1.35)
const LABEL_Y   = 100;   // baseline; sits below the pipeline arc (peak y≈60)

const STEP_MS   = 580;
const MODE_MS   = 700;

// Arc coordinate arrays [x0, y0, cp1x, cp1y, cp2x, cp2y, x1, y1] for cubic Bezier arcs.
// Stored as numbers so they can be interpolated during mode transitions.
//
// LOGO arc  — derived from original SVG (centred / left-aligned variants)
const LOGO_ARC_C:   number[] = [422, 105, 452, 51, 508, 51, 539, 106];
// PIPELINE arc — same curvature as the R_CIRC=1066 node circle, shifted down +28 units
//   so the peak sits at y≈60: between the halo bottom (y=50) and the label (LABEL_Y=76).
//   Base: M -10 114 C 254 4 546 4 810 114  (peak y≈32, on the node circle).
//   After +28 shift: peak y = (1/8)·142 + (3/4)·32 + (1/8)·142 ≈ 60. ✓
const PIPE_ARC_C:   number[] = [-10, 142, 254, 32, 546, 32, 810, 142];

function ptsToD(p: number[]): string {
  return `M ${p[0]} ${p[1]} C ${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`;
}

// ── Node state ────────────────────────────────────────────────────────────────

interface NS { cx: number; cy: number; r: number; op: number; }

// The 8 pipeline-node slots in LOGO mode.
// Slot 0 sits at the logo centre; slots 1-2 are the right logo nodes.
// Slots 3-7 are hidden off-screen to the right.
const LOGO_NODES: NS[] = [
  { cx: 480,  cy: 36, r: 8,     op: 1    },  // slot 0 — logo centre (arch peak)
  { cx: 509,  cy: 51, r: 6,     op: 0.85 },  // slot 1 — logo right-inner
  { cx: 532,  cy: 72, r: 6,     op: 0.85 },  // slot 2 — logo right-outer
  { cx: 1080, cy: 72, r: DOT_R, op: 0    },  // slot 3-7 — hidden off-screen right
  { cx: 1180, cy: 72, r: DOT_R, op: 0    },
  { cx: 1280, cy: 72, r: DOT_R, op: 0    },
  { cx: 1380, cy: 72, r: DOT_R, op: 0    },
  { cx: 1480, cy: 72, r: DOT_R, op: 0    },
];

// Two decorative left nodes — visible in logo mode, slide off-screen in pipeline mode.
// Positioned symmetrically to right-inner and right-outer (scaled from original SVG).
const LEFT_SHOW: NS[] = [
  { cx: 428, cy: 72, r: 6, op: 0.85 },  // outer-left (symmetric to slot 2)
  { cx: 451, cy: 51, r: 6, op: 0.85 },  // inner-left (symmetric to slot 1)
];
// Note: LEFT_HIDE removed — pipeline mode now uses phantom clock-face nodes instead.

// ── Left-aligned logo geometry (cluster centred at x=120, shifted −360 from centre) ──
// Same relative positions and proportions as the centred layout, just placed near the
// left edge of the 960-wide viewBox so the cluster appears in the left portion of the
// header when the SVG spans the full/wide container width.
const LOGO_NODES_L: NS[] = [
  { cx: 120,  cy: 36, r: 8,     op: 1    },  // slot 0 — centre (arch peak)
  { cx: 149,  cy: 51, r: 6,     op: 0.85 },  // slot 1 — right-inner
  { cx: 172,  cy: 72, r: 6,     op: 0.85 },  // slot 2 — right-outer
  { cx:  720, cy: 72, r: DOT_R, op: 0    },  // slots 3-7 — hidden off-screen right
  { cx:  820, cy: 72, r: DOT_R, op: 0    },
  { cx:  920, cy: 72, r: DOT_R, op: 0    },
  { cx: 1020, cy: 72, r: DOT_R, op: 0    },
  { cx: 1120, cy: 72, r: DOT_R, op: 0    },
];
const LEFT_SHOW_L: NS[] = [
  { cx:  68, cy: 72, r: 6, op: 0.85 },  // outer-left
  { cx:  91, cy: 51, r: 6, op: 0.85 },  // inner-left
];
const LOGO_ARC_C_L: number[] = [62, 105, 92, 51, 148, 51, 179, 106]; // left-aligned logo arc

// ── Animation state snapshot ──────────────────────────────────────────────────

interface S {
  nodes:  NS[];
  left:   NS[];
  arcOp:  number;
  arcPts: number[];  // [x0, y0, cp1x, cp1y, cp2x, cp2y, x1, y1] — interpolated during transitions
  hCx:    number;
  hCy:    number;
  hR:     number;
  hSOp:   number;  // stroke-opacity
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function eio(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpNS(a: NS, b: NS, t: number): NS {
  return { cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t),
           r:  lerp(a.r,  b.r,  t), op: lerp(a.op, b.op, t) };
}
function lerpS(a: S, b: S, t: number): S {
  return {
    nodes:  a.nodes.map((an, i) => lerpNS(an, b.nodes[i], t)),
    left:   a.left.map((al, i)  => lerpNS(al, b.left[i],  t)),
    arcOp:  lerp(a.arcOp, b.arcOp, t),
    arcPts: a.arcPts.map((v, i) => lerp(v, b.arcPts[i], t)),
    hCx:    lerp(a.hCx,   b.hCx,   t),
    hCy:    lerp(a.hCy,   b.hCy,   t),
    hR:     lerp(a.hR,    b.hR,    t),
    hSOp:   lerp(a.hSOp,  b.hSOp,  t),
  };
}

/** Pipeline-only: move each node along the R_CIRC arc (avoids chord paths through the arch). */
function lerpPipelineAlongArc(fromS: S, toS: S, t: number, s0: number, s1: number, n: number): S {
  const sFloat = s0 + (s1 - s0) * t;
  const nodes = Array.from({ length: n }, (_, i) => {
    const a = (-90 + (i - sFloat) * ANGLE_DEG) * RAD;
    const p0 = pipePos(i, s0);
    const p1 = pipePos(i, s1);
    return {
      cx: ACTIVE_X + R_CIRC * Math.cos(a),
      cy: CY + R_CIRC * Math.sin(a),
      r:  lerp(p0.r, p1.r, t),
      op: lerp(p0.op, p1.op, t),
    };
  });
  const lp0 = pipePos(sFloat - 2, sFloat);
  const lp1 = pipePos(sFloat - 1, sFloat);
  return {
    nodes,
    left: [
      { cx: lp0.cx, cy: lp0.cy, r: lp0.r, op: lerp(fromS.left[0].op, toS.left[0].op, t) },
      { cx: lp1.cx, cy: lp1.cy, r: lp1.r, op: lerp(fromS.left[1].op, toS.left[1].op, t) },
    ],
    arcOp:  lerp(fromS.arcOp, toS.arcOp, t),
    arcPts: fromS.arcPts.map((v, i) => lerp(v, toS.arcPts[i], t)),
    hCx:    lerp(fromS.hCx, toS.hCx, t),
    hCy:    lerp(fromS.hCy, toS.hCy, t),
    hR:     lerp(fromS.hR, toS.hR, t),
    hSOp:   lerp(fromS.hSOp, toS.hSOp, t),
  };
}

/** Clock-face position for pipeline node i when activeStep = s. */
function pipePos(i: number, s: number): NS {
  const rel = i - s;
  const a   = (-90 + rel * ANGLE_DEG) * RAD;
  return {
    cx: ACTIVE_X + R_CIRC * Math.cos(a),
    cy: CY       + R_CIRC * Math.sin(a),
    r:  rel === 0 ? ACT_R : DOT_R,
    op: rel === 0 ? 1 : Math.abs(rel) <= 2 ? 0.38 : Math.abs(rel) === 3 ? 0.15 : 0,
  };
}

function getTarget(step: number | undefined, n: number, logoLeft = false): S {
  if (step === undefined) {
    return {
      nodes:  (logoLeft ? LOGO_NODES_L : LOGO_NODES).slice(0, n),
      left:   (logoLeft ? LEFT_SHOW_L  : LEFT_SHOW).slice(),
      arcOp:  1,
      arcPts: [...(logoLeft ? LOGO_ARC_C_L : LOGO_ARC_C)],
      hCx:    logoLeft ? 120 : 480, hCy: 36, hR: LOGO_HR, hSOp: 0.4,
    };
  }
  const s = step;
  // Inner two “phantom” slots sit at pipeline indices (s−2, s−1). Using
  // pipePos(s−2, s) keeps rel at −2/−1 so they stay aligned with the clock
  // (pipePos(−2, s) wrongly used rel = −2 − s).
  const lp0 = pipePos(s - 2, s);
  const lp1 = pipePos(s - 1, s);
  return {
    nodes:  Array.from({ length: n }, (_, i) => pipePos(i, s)),
    // Same geometry as nodes[s−2]/[s−1] but hidden — the 8 node circles carry
    // those steps; left elements only fade out after the logo→pipeline morph.
    left: [
      { ...lp0, op: 0 },
      { ...lp1, op: 0 },
    ],
    arcOp:  0.5,             // visible but subdued so nodes remain the focal point
    arcPts: [...PIPE_ARC_C], // matches the R_CIRC=1066 node-circle curvature
    hCx:    ACTIVE_X, hCy: NODE_Y, hR: PIPE_HR, hSOp: 0.55,
  };
}

/**
 * Snapshot for the start of logo → pipeline: each pipeline index j begins at the
 * compact-logo dot that will become that step’s clock position (inner five map to
 * left + centre cluster; the rest start on the hidden logo slots).
 */
function buildLogoToPipelineFrom(s: number, n: number, logoLeft: boolean): S {
  const logo = logoLeft ? LOGO_NODES_L : LOGO_NODES;
  const leftPos = logoLeft ? LEFT_SHOW_L : LEFT_SHOW;
  const base = getTarget(undefined, n, logoLeft);
  const starts: NS[] = new Array(n);
  const inner = new Set<number>();

  if (s >= 2) {
    starts[s - 2] = { ...leftPos[0] };
    inner.add(s - 2);
  }
  if (s >= 1) {
    starts[s - 1] = { ...leftPos[1] };
    inner.add(s - 1);
  }
  starts[s] = { ...logo[0] };
  inner.add(s);
  if (s + 1 < n) {
    starts[s + 1] = { ...logo[1] };
    inner.add(s + 1);
  }
  if (s + 2 < n) {
    starts[s + 2] = { ...logo[2] };
    inner.add(s + 2);
  }

  const outer: number[] = [];
  for (let j = 0; j < n; j++) if (!inner.has(j)) outer.push(j);
  outer.sort((a, b) => a - b);
  for (let k = 0; k < outer.length; k++) {
    starts[outer[k]] = { ...logo[3 + k] };
  }

  return { ...base, nodes: starts };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface PipelineProgressProps {
  /** 0-indexed active step, or undefined for logo / decorative mode. */
  activeStep?: number;
  steps?: string[];
  className?: string;
  style?: React.CSSProperties;
  /** Where to anchor the logo cluster in logo mode. Default 'center'. */
  logoAlign?: 'left' | 'center';
}

export function PipelineProgress({
  activeStep,
  steps = PIPELINE_STEPS,
  className,
  style,
  logoAlign,
}: PipelineProgressProps) {
  const n        = steps.length;
  const logoLeft = logoAlign === 'left';

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const nodeRefs  = useRef<(SVGCircleElement | null)[]>(Array(n).fill(null));
  const leftRefs  = useRef<(SVGCircleElement | null)[]>(Array(2).fill(null));
  const arcRef    = useRef<SVGPathElement | null>(null);
  const haloRef   = useRef<SVGCircleElement | null>(null);

  // ── Animation tracking refs (mutated by rAF, never cause re-renders) ──────
  const rafRef    = useRef<number | null>(null);
  const curRef    = useRef<S>(getTarget(activeStep, n, logoLeft));
  const fromRef   = useRef<S>(getTarget(activeStep, n, logoLeft));
  const tgtRef    = useRef<S>(getTarget(activeStep, n, logoLeft));
  const t0Ref     = useRef(0);
  const durRef    = useRef(0);
  const firstRef  = useRef(true);  // true until the first real activeStep change
  /** Virtual active step during pipeline mode; used as arc-anim start + survives mid-flight interrupts. */
  const pipelineStepFloatRef = useRef(0);

  // ── DOM applier ───────────────────────────────────────────────────────────
  function apply(s: S) {
    s.nodes.forEach((ns, i) => {
      const el = nodeRefs.current[i];
      if (!el) return;
      el.setAttribute("cx", String(ns.cx));
      el.setAttribute("cy", String(ns.cy));
      el.setAttribute("r",  String(Math.max(0.5, ns.r)));
      el.setAttribute("opacity", String(Math.max(0, Math.min(1, ns.op))));
    });
    s.left.forEach((ns, i) => {
      const el = leftRefs.current[i];
      if (!el) return;
      el.setAttribute("cx", String(ns.cx));
      el.setAttribute("cy", String(ns.cy));
      el.setAttribute("opacity", String(Math.max(0, Math.min(1, ns.op))));
    });
    if (arcRef.current) {
      arcRef.current.setAttribute("opacity", String(Math.max(0, Math.min(1, s.arcOp))));
      arcRef.current.setAttribute("d", ptsToD(s.arcPts));
    }
    if (haloRef.current) {
      haloRef.current.setAttribute("cx",             String(s.hCx));
      haloRef.current.setAttribute("cy",             String(s.hCy));
      haloRef.current.setAttribute("r",              String(Math.max(0.5, s.hR)));
      haloRef.current.setAttribute("stroke-opacity", String(s.hSOp));
    }
    curRef.current = s;
  }

  // ── Snap to initial state before first paint ──────────────────────────────
  useLayoutEffect(() => {
    const init = getTarget(activeStep, n, logoLeft);
    fromRef.current = init;
    tgtRef.current  = init;
    apply(init);
    if (typeof activeStep === "number") pipelineStepFloatRef.current = activeStep;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Animate on activeStep change ──────────────────────────────────────────
  useEffect(() => {
    // Skip the very first effect run — initial state already set by useLayoutEffect.
    if (firstRef.current) {
      firstRef.current = false;
      if (typeof activeStep === "number") pipelineStepFloatRef.current = activeStep;
      return;
    }

    const tgt = getTarget(activeStep, n, logoLeft);
    const modeChange = (curRef.current.arcOp > 0.5) !== (tgt.arcOp > 0.5);

    if (modeChange && activeStep !== undefined) {
      fromRef.current = buildLogoToPipelineFrom(activeStep, n, logoLeft);
    } else {
      fromRef.current = { ...curRef.current };
    }
    tgtRef.current  = tgt;
    t0Ref.current   = performance.now();
    durRef.current  = modeChange ? MODE_MS : STEP_MS;

    const useArc =
      !modeChange &&
      typeof activeStep === "number" &&
      curRef.current.arcOp <= 0.5;

    const s0Arc = pipelineStepFloatRef.current;
    const s1Arc: number = typeof activeStep === "number" ? activeStep : 0;

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    function tick(now: number) {
      const e = eio(Math.min((now - t0Ref.current) / durRef.current, 1));
      if (useArc) {
        const sFloat = s0Arc + (s1Arc - s0Arc) * e;
        pipelineStepFloatRef.current = sFloat;
        apply(lerpPipelineAlongArc(fromRef.current, tgtRef.current, e, s0Arc, s1Arc, n));
      } else {
        apply(lerpS(fromRef.current, tgtRef.current, e));
      }
      if (e >= 1) {
        if (typeof activeStep === "number") pipelineStepFloatRef.current = activeStep;
        rafRef.current = null;
      } else {
        rafRef.current = requestAnimationFrame(tick);
      }
    }
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep]);

  // ── Label cross-fade ──────────────────────────────────────────────────────
  const [labelOpaque,  setLabelOpaque]  = useState(true);
  const [displayStep,  setDisplayStep]  = useState(activeStep);
  const prevLblRef = useRef(activeStep);

  useEffect(() => {
    if (prevLblRef.current === activeStep) return;
    setLabelOpaque(false);
    const id = setTimeout(() => {
      setDisplayStep(activeStep);
      setLabelOpaque(true);
      prevLblRef.current = activeStep;
    }, 250);
    return () => clearTimeout(id);
  }, [activeStep]);

  const label = displayStep !== undefined ? steps[displayStep] : undefined;

  // ── Render ────────────────────────────────────────────────────────────────
  // The JSX attribute values below are stable initial defaults; all subsequent
  // visual updates are applied directly to the DOM via `apply()` in the rAF
  // loop, bypassing React's reconciler to avoid overwriting animated positions.
  const init = curRef.current;

  return (
    <svg
      viewBox="0 0 960 116"
      preserveAspectRatio="xMinYMin meet"
      aria-label={label ? `Step: ${label}` : "Meridian pipeline"}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      {/* Arc — logo mode and pipeline mode; shape morphs between them */}
      <path
        ref={arcRef}
        d={ptsToD(init.arcPts)}
        fill="none"
        strokeLinecap="round"
        strokeWidth="5"
        opacity={init.arcOp}
        style={{ stroke: "hsl(var(--primary))" }}
      />

      {/* Left decorative nodes — logo only, slide off-screen in pipeline mode */}
      {LEFT_SHOW.map((_, i) => (
        <circle
          key={`l${i}`}
          ref={el => { leftRefs.current[i] = el; }}
          cx={init.left[i].cx}
          cy={init.left[i].cy}
          r={DOT_R}
          opacity={init.left[i].op}
          style={{ fill: "hsl(var(--primary))" }}
        />
      ))}

      {/* Pipeline nodes 0-7 */}
      {steps.map((_, i) => {
        const nd = init.nodes[i] ?? { cx: 1000, cy: 48, r: DOT_R, op: 0 };
        return (
          <circle
            key={i}
            ref={el => { nodeRefs.current[i] = el; }}
            cx={nd.cx}
            cy={nd.cy}
            r={nd.r}
            opacity={nd.op}
            style={{ fill: "hsl(var(--primary))" }}
          />
        );
      })}

      {/* Halo ring — animates position, size, and opacity between modes */}
      <circle
        ref={haloRef}
        cx={init.hCx}
        cy={init.hCy}
        r={init.hR}
        fill="none"
        strokeWidth="2"
        strokeOpacity={init.hSOp}
        style={{ stroke: "hsl(var(--primary))" }}
      />

      {/* Step label — cross-fades on step change, hidden in logo mode */}
      {label !== undefined && (
        <text
          x={ACTIVE_X}
          y={LABEL_Y}
          textAnchor="middle"
          style={{
            fill: "hsl(var(--primary))",
            fontSize: "20px",
            fontFamily: "inherit",
            letterSpacing: "0.07em",
            opacity: labelOpaque ? 0.85 : 0,
            transition: "opacity 0.25s ease",
          }}
        >
          {label.toUpperCase()}
        </text>
      )}
    </svg>
  );
}
