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
//  Six dots from Meridian_no_bg.svg + two ellipse arcs as meridian lines.
//  All geometry in component (960×116) space.
//
//  Meridian arc positions are derived from the SVG's 240×240 space via:
//    translate(anchor_cx, 38) · scale(0.55) · translate(-121.052, -87.969)
//
// PIPELINE MODE  (activeStep = 0-7)
// ──────────────────────────────────
//  Eight nodes on R_CIRC=1066 circle centred at (ACTIVE_X, CY=1104).
//  Meridian arcs both have their top at PIPE_ARC_TOP (~24 px below nodes at y=38),
//  leaving a visible gap under the pipeline halo (r≈18 + stroke) so it does not touch the arcs.
//  Outer arc: r=R_CIRC (same curvature as nodes), shifted so top = PIPE_ARC_TOP.
//  Inner arc: elongated ellipse (rx≈472, ry≈891) matching logo proportions —
//  narrower than outer, fans out to ~344 px at viewBox bottom vs ~710 px outer.
//
// TRANSITION
// ──────────
//  Logo → Pipeline: dots spread to clock positions, logo circles fade, meridian
//  arcs morph shape+position.  Step-to-step: arc-constrained lerp.
//  Duration: 700 ms mode change, 580 ms step advance.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_X  = 400;
const NODE_Y    = 38;
const R_CIRC    = 1066;
const CY        = NODE_Y + R_CIRC;   // 1104
const ANGLE_DEG = 7;
const RAD       = Math.PI / 180;

const DOT_R   = 7;
const SAT_R   = 6.5;
const ACT_R   = 10;
const PIPE_HR = 18;
const LOGO_HR = 16;
/** Shared stroke-opacity for the JSX halo in both logo and pipeline modes (avoids fade-out during mode transitions). */
const HALO_STROKE_OP = 0.55;
const LABEL_Y = 110;

const STEP_MS = 580;
const MODE_MS = 700;

// ── Meridian arc geometry ─────────────────────────────────────────────────────
//
// Logo-mode values are the SVG ellipse coordinates mapped to component space via
//   translate(anchor 38) scale(0.55) translate(-121.052 -87.969)
// where anchor = 480 (centred) or 120 (left).
//
// SVG inner ellipse: cx=119.729 cy=250.888 rx=64.527 ry=121.84
// SVG outer ellipse: cx=118.632 cy=274.1   rx=145.804 ry=145.804
//
// Component-space (centred, anchor=480):
//   inner → cx=479.3  cy=127.6  rx=35.5  ry=67.0
//   outer → cx=478.7  cy=140.4  rx=80.2  ry=80.2
//
// Pipeline-mode values:
//   outer is the R_CIRC circle whose top is PIPE_ARC_TOP (below the active node / halo)
//   inner ellipse shares that top y; geometry matches logo proportions scaled to R_CIRC

interface MA { cx: number; cy: number; rx: number; ry: number; }

// Centred logo-mode arcs (anchor cx=480)
const MARC1_LOGO:   MA = { cx: 479.3, cy: 127.6, rx:  35.5, ry:  67.0 };
const MARC2_LOGO:   MA = { cx: 478.7, cy: 140.4, rx:  80.2, ry:  80.2 };
// Left-aligned (anchor cx=120, shift cx by −360)
const MARC1_LOGO_L: MA = { cx: 119.3, cy: 127.6, rx:  35.5, ry:  67.0 };
const MARC2_LOGO_L: MA = { cx: 118.7, cy: 140.4, rx:  80.2, ry:  80.2 };
// Pipeline-mode arcs (component space, centred on ACTIVE_X)
//
// Both arcs share the same top y = PIPE_ARC_TOP, placed low enough that the
// active-node halo (NODE_Y + PIPE_HR + half stroke ≈ 57) clears the arc tops.
//
// Outer (r=R_CIRC): same curvature as the node circle, shifted down so its top
// is at PIPE_ARC_TOP.  At y=116 (viewBox bottom) it spans x ≈ [45, 755].
//
// Inner: elongated ellipse preserving the logo-mode aspect ratio
//   rx_logo/rx_outer_logo = 35.5/80.2 ≈ 0.443  →  rx = 1066 × 0.443 ≈ 472
//   ry_logo/ry_outer_logo = 67.0/80.2 ≈ 0.836  →  ry = 1066 × 0.836 ≈ 891
// At y=116 it spans x ≈ [228, 572], clearly narrower than the outer arc.
const PIPE_ARC_TOP  = 63;                                    // y of both arc tops (was 55; lowered arcs for halo clearance)
const MARC1_PIPE:   MA = { cx: ACTIVE_X, cy: PIPE_ARC_TOP + 891, rx: 472,    ry: 891    };
const MARC2_PIPE:   MA = { cx: ACTIVE_X, cy: PIPE_ARC_TOP + R_CIRC, rx: R_CIRC, ry: R_CIRC };

// ── Node state ────────────────────────────────────────────────────────────────
//
// Logo-mode satellite positions are computed from the outer meridian circle:
//   cx_outer=478.7  cy_outer=140.4  r_outer=80.2  (component space, centred)
//
// Satellites are placed at 16° angular intervals from the top (α = -90 + 16k).
//   comp_x = cx_outer ± r_outer * sin(16k°)
//   comp_y = cy_outer  - r_outer * cos(16k°)
//
// k   comp_x  comp_y   SVG_x    SVG_y
// ±1   500.8   63.3    158.9 / 78.5    134.0
// ±2   521.2   72.4    196.0 / 41.4    150.5
// ±3   538.3   86.7    227.1 / 10.3    176.5
// ±4   550.8  105.2    249.8 / −12.4   210.2
//
// LOGO_NODES[0]  → center dot        (step s   start / end)
// LOGO_NODES[1]  → k=+1 right sat   (step s+1 start / end)
// LOGO_NODES[2]  → k=+2 right sat   (step s+2 start / end)
// LOGO_NODES[3]  → k=+3 right sat   (step s+3 start / end)
// LOGO_NODES[4]  → k=+4 right sat   (step s+4 start / end)
// LEFT_SHOW[3]   → k=−1 left sat    (left[] decorative, index 3)
// LEFT_SHOW[2]   → k=−2 left sat    (left[] decorative, index 2)
// LEFT_SHOW[1]   → k=−3 left sat    (left[] decorative, index 1)
// LEFT_SHOW[0]   → k=−4 left sat    (left[] decorative, index 0)
// LEFT_PIPE[i]   → fixed arc positions for left[] circles in pipeline mode (rel −4…−1)

interface NS { cx: number; cy: number; r: number; op: number; }

// [0] center, [1] k=+1, [2] k=+2, [3] k=+3, [4] k=+4, [5–7] parking
const LOGO_NODES: NS[] = [
  { cx: 480,   cy: 38,   r: 9.5,   op: 0 },
  { cx: 511,   cy: 43,   r: 6,     op: 0 },
  { cx: 533,   cy: 58,   r: 6,     op: 0 },
  { cx: 555.6, cy: 74.9, r: 6,     op: 0 },
  { cx: 571.0, cy: 99.3, r: 6,     op: 0 },
  { cx: 1280,  cy: 73,   r: DOT_R, op: 0 },
  { cx: 1380,  cy: 73,   r: DOT_R, op: 0 },
  { cx: 1480,  cy: 73,   r: DOT_R, op: 0 },
];
// [0] k=−4, [1] k=−3, [2] k=−2, [3] k=−1 (farthest first)
const LEFT_SHOW: NS[] = [
  { cx: 387.6, cy: 96.8, r: SAT_R, op: 0 },
  { cx: 403.5, cy: 73.0, r: SAT_R, op: 0 },
  { cx: 427,   cy: 57,   r: SAT_R, op: 0 },
  { cx: 449,   cy: 43,   r: SAT_R, op: 0 },
];
const LOGO_NODES_L: NS[] = [
  { cx: 120,   cy: 38,   r: 9.5,   op: 0 },
  { cx: 151,   cy: 43,   r: 6,     op: 0 },
  { cx: 173,   cy: 58,   r: 6,     op: 0 },
  { cx: 195.6, cy: 74.9, r: 6,     op: 0 },
  { cx: 211.0, cy: 99.3, r: 6,     op: 0 },
  { cx:  920,  cy: 73,   r: DOT_R, op: 0 },
  { cx: 1020,  cy: 73,   r: DOT_R, op: 0 },
  { cx: 1120,  cy: 73,   r: DOT_R, op: 0 },
];
const LEFT_SHOW_L: NS[] = [
  { cx:  27.6, cy: 96.8, r: SAT_R, op: 0 },
  { cx:  43.5, cy: 73.0, r: SAT_R, op: 0 },
  { cx:  67,   cy: 57,   r: SAT_R, op: 0 },
  { cx:  89,   cy: 43,   r: SAT_R, op: 0 },
];

// Arc positions for the 4 left decorative circles at a given floating step.
// Treated as virtual step indices −4…−1 (before step 0), so they rotate with
// the arc as the active step advances — giving the same rotation effect as the
// pipeline nodes rather than staying at fixed screen positions.
function leftPipePositions(sFloat: number): NS[] {
  return [-4, -3, -2, -1].map(absIdx => {
    const a = (-90 + (absIdx - sFloat) * ANGLE_DEG) * RAD;
    return { cx: ACTIVE_X + R_CIRC * Math.cos(a), cy: CY + R_CIRC * Math.sin(a), r: SAT_R, op: 0.2 };
  });
}

// ── Animation state ───────────────────────────────────────────────────────────

interface S {
  nodes:  NS[];
  left:   NS[];
  hCx:    number;
  hCy:    number;
  hR:     number;
  hSOp:   number;
  /** Logo circles group opacity: 1 in logo mode, 0 in pipeline mode. */
  logoOp: number;
  /** Meridian arc group opacity: 1 in logo mode, 0.5 in pipeline mode. */
  mArcOp: number;
  /** Inner meridian ellipse shape (component space). */
  mArc1:  MA;
  /** Outer meridian ellipse shape (component space). */
  mArc2:  MA;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function eio(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpNS(a: NS, b: NS, t: number): NS {
  return {
    cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t),
    r:  lerp(a.r,  b.r,  t), op: lerp(a.op, b.op, t),
  };
}
function lerpMA(a: MA, b: MA, t: number): MA {
  return {
    cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t),
    rx: lerp(a.rx, b.rx, t), ry: lerp(a.ry, b.ry, t),
  };
}
function lerpS(a: S, b: S, t: number): S {
  return {
    nodes:  a.nodes.map((an, i) => lerpNS(an, b.nodes[i], t)),
    left:   a.left.map((al, i)  => lerpNS(al, b.left[i],  t)),
    hCx:    lerp(a.hCx,    b.hCx,    t),
    hCy:    lerp(a.hCy,    b.hCy,    t),
    hR:     lerp(a.hR,     b.hR,     t),
    hSOp:   lerp(a.hSOp,   b.hSOp,   t),
    logoOp: lerp(a.logoOp, b.logoOp, t),
    mArcOp: lerp(a.mArcOp, b.mArcOp, t),
    mArc1:  lerpMA(a.mArc1, b.mArc1, t),
    mArc2:  lerpMA(a.mArc2, b.mArc2, t),
  };
}

/** Pipeline-only: move nodes along R_CIRC arc to avoid chord shortcuts. */
function lerpPipelineAlongArc(
  fromS: S, toS: S, t: number, s0: number, s1: number, n: number,
): S {
  const sFloat = s0 + (s1 - s0) * t;
  const nodes = Array.from({ length: n }, (_, i) => {
    const a  = (-90 + (i - sFloat) * ANGLE_DEG) * RAD;
    const p0 = pipePos(i, s0);
    const p1 = pipePos(i, s1);
    return {
      cx: ACTIVE_X + R_CIRC * Math.cos(a),
      cy: CY       + R_CIRC * Math.sin(a),
      r:  lerp(p0.r,  p1.r,  t),
      op: lerp(p0.op, p1.op, t),
    };
  });
  return {
    nodes,
    // Left decorative circles track virtual steps −4…−1 on the same arc,
    // so they rotate with the arc as sFloat advances.
    left: leftPipePositions(sFloat),
    hCx:    lerp(fromS.hCx,    toS.hCx,    t),
    hCy:    lerp(fromS.hCy,    toS.hCy,    t),
    hR:     lerp(fromS.hR,     toS.hR,     t),
    hSOp:   lerp(fromS.hSOp,   toS.hSOp,   t),
    logoOp: lerp(fromS.logoOp, toS.logoOp, t),
    mArcOp: lerp(fromS.mArcOp, toS.mArcOp, t),
    mArc1:  lerpMA(fromS.mArc1, toS.mArc1, t),
    mArc2:  lerpMA(fromS.mArc2, toS.mArc2, t),
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
    op: rel === 0 ? 1 : rel < 0 ? 0.2 : Math.abs(rel) <= 2 ? 0.38 : Math.abs(rel) === 3 ? 0.15 : 0,
  };
}

function getTarget(step: number | undefined, n: number, logoLeft = false): S {
  if (step === undefined) {
    const cx = logoLeft ? 120 : 480;
    return {
      nodes:  (logoLeft ? LOGO_NODES_L : LOGO_NODES).slice(0, n),
      left:   (logoLeft ? LEFT_SHOW_L  : LEFT_SHOW).slice(),
      hCx: cx, hCy: NODE_Y, hR: LOGO_HR, hSOp: HALO_STROKE_OP,
      logoOp: 1,
      mArcOp: 1,
      mArc1: logoLeft ? MARC1_LOGO_L : MARC1_LOGO,
      mArc2: logoLeft ? MARC2_LOGO_L : MARC2_LOGO,
    };
  }
  const s   = step;
  return {
    nodes: Array.from({ length: n }, (_, i) => pipePos(i, s)),
    left: leftPipePositions(s),
    hCx: ACTIVE_X, hCy: NODE_Y, hR: PIPE_HR, hSOp: HALO_STROKE_OP,
    logoOp: 0,
    mArcOp: 1.0,
    mArc1: MARC1_PIPE,
    mArc2: MARC2_PIPE,
  };
}

const _PARKING: NS = { cx: 2000, cy: 73, r: DOT_R, op: 0 };

function buildLogoToPipelineFrom(s: number, n: number, logoLeft: boolean): S {
  const logo    = logoLeft ? LOGO_NODES_L : LOGO_NODES;
  const leftPos = logoLeft ? LEFT_SHOW_L  : LEFT_SHOW;
  const base    = getTarget(undefined, n, logoLeft);
  const starts: NS[] = new Array(n);
  const inner   = new Set<number>();

  // 5 right-side logo dots → their pipeline step targets (start visible).
  starts[s] = { ...logo[0], op: 1 }; inner.add(s);
  if (s + 1 < n) { starts[s + 1] = { ...logo[1], op: 0.85 }; inner.add(s + 1); }
  if (s + 2 < n) { starts[s + 2] = { ...logo[2], op: 0.85 }; inner.add(s + 2); }
  if (s + 3 < n) { starts[s + 3] = { ...logo[3], op: 0.85 }; inner.add(s + 3); }
  if (s + 4 < n) { starts[s + 4] = { ...logo[4], op: 0.85 }; inner.add(s + 4); }

  // All remaining pipeline nodes (past steps, far-future) — park off-screen invisible.
  for (let j = 0; j < n; j++) if (!inner.has(j)) starts[j] = { ..._PARKING };

  // 4 left-side logo satellites → LEFT_PIPE arc positions.
  // Start at their logo positions, fully visible (seamless swap from logo group).
  const leftStarts: NS[] = leftPos.map(lp => ({ ...lp, op: 0.85 }));

  return { ...base, nodes: starts, left: leftStarts, logoOp: 0 };
}

/**
 * Reverse of buildLogoToPipelineFrom.  Used as the TO state when going
 * pipeline → logo.  The three "inner" pipeline nodes animate back to their
 * logo dot positions (center + two right satellites) while all others fade
 * out.  logoOp stays 0 throughout; a snapRef state (true logo target) is
 * applied in the same frame when the animation completes so the logo group
 * snaps in exactly when the moving dots arrive at their final positions.
 */
function buildPipelineToLogoTarget(s: number, n: number, logoLeft: boolean): S {
  const logo    = logoLeft ? LOGO_NODES_L : LOGO_NODES;
  const leftPos = logoLeft ? LEFT_SHOW_L  : LEFT_SHOW;

  // All nodes default to parking (invisible).
  const targets: NS[] = Array.from({ length: n }, () => ({ ..._PARKING }));

  // 5 right-side pipeline nodes → their logo dot end positions.
  targets[s] = { ...logo[0], op: 1 };
  if (s + 1 < n) targets[s + 1] = { ...logo[1], op: 0.85 };
  if (s + 2 < n) targets[s + 2] = { ...logo[2], op: 0.85 };
  if (s + 3 < n) targets[s + 3] = { ...logo[3], op: 0.85 };
  if (s + 4 < n) targets[s + 4] = { ...logo[4], op: 0.85 };

  // 4 left decorative circles → their logo satellite end positions (brighten as they return).
  const leftTargets: NS[] = leftPos.map(lp => ({ ...lp, op: 0.85 }));

  return {
    nodes: targets,
    left: leftTargets,
    hCx: logoLeft ? 120 : 480, hCy: NODE_Y, hR: LOGO_HR, hSOp: HALO_STROKE_OP,
    logoOp: 0, // stays hidden; snapRef applies the true logo state at end
    mArcOp: 1,
    mArc1: logoLeft ? MARC1_LOGO_L : MARC1_LOGO,
    mArc2: logoLeft ? MARC2_LOGO_L : MARC2_LOGO,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface PipelineProgressProps {
  activeStep?: number;
  steps?: string[];
  className?: string;
  style?: React.CSSProperties;
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
  const nodeRefs     = useRef<(SVGCircleElement   | null)[]>(Array(n).fill(null));
  const leftRefs     = useRef<(SVGCircleElement   | null)[]>(Array(4).fill(null));
  const haloRef      = useRef<SVGCircleElement    | null>(null);
  const logoGroupRef = useRef<SVGGElement         | null>(null);
  const meridianRef  = useRef<SVGGElement         | null>(null);
  const mArc1Ref     = useRef<SVGEllipseElement   | null>(null);
  const mArc2Ref     = useRef<SVGEllipseElement   | null>(null);

  // ── Animation tracking refs ───────────────────────────────────────────────
  const rafRef               = useRef<number | null>(null);
  const curRef               = useRef<S>(getTarget(activeStep, n, logoLeft));
  const fromRef              = useRef<S>(getTarget(activeStep, n, logoLeft));
  const tgtRef               = useRef<S>(getTarget(activeStep, n, logoLeft));
  /** Applied in the same frame when an animation completes (mode-change snaps). */
  const snapRef              = useRef<S | null>(null);
  const t0Ref                = useRef(0);
  const durRef               = useRef(0);
  const firstRef             = useRef(true);
  const pipelineStepFloatRef = useRef(0);

  // ── DOM applier ───────────────────────────────────────────────────────────
  function apply(s: S) {
    s.nodes.forEach((ns, i) => {
      const el = nodeRefs.current[i];
      if (!el) return;
      el.setAttribute("cx",      String(ns.cx));
      el.setAttribute("cy",      String(ns.cy));
      el.setAttribute("r",       String(Math.max(0.5, ns.r)));
      el.setAttribute("opacity", String(Math.max(0, Math.min(1, ns.op))));
    });
    s.left.forEach((ns, i) => {
      const el = leftRefs.current[i];
      if (!el) return;
      el.setAttribute("cx",      String(ns.cx));
      el.setAttribute("cy",      String(ns.cy));
      el.setAttribute("opacity", String(Math.max(0, Math.min(1, ns.op))));
    });
    if (meridianRef.current) {
      meridianRef.current.setAttribute("opacity", String(Math.max(0, Math.min(1, s.mArcOp))));
    }
    if (mArc1Ref.current) {
      mArc1Ref.current.setAttribute("cx", String(s.mArc1.cx));
      mArc1Ref.current.setAttribute("cy", String(s.mArc1.cy));
      mArc1Ref.current.setAttribute("rx", String(s.mArc1.rx));
      mArc1Ref.current.setAttribute("ry", String(s.mArc1.ry));
    }
    if (mArc2Ref.current) {
      mArc2Ref.current.setAttribute("cx", String(s.mArc2.cx));
      mArc2Ref.current.setAttribute("cy", String(s.mArc2.cy));
      mArc2Ref.current.setAttribute("rx", String(s.mArc2.rx));
      mArc2Ref.current.setAttribute("ry", String(s.mArc2.ry));
    }
    if (haloRef.current) {
      haloRef.current.setAttribute("cx",             String(s.hCx));
      haloRef.current.setAttribute("cy",             String(s.hCy));
      haloRef.current.setAttribute("r",              String(Math.max(0.5, s.hR)));
      haloRef.current.setAttribute("stroke-opacity", String(s.hSOp));
    }
    if (logoGroupRef.current) {
      logoGroupRef.current.setAttribute("opacity", String(Math.max(0, Math.min(1, s.logoOp))));
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
    if (firstRef.current) {
      firstRef.current = false;
      if (typeof activeStep === "number") pipelineStepFloatRef.current = activeStep;
      return;
    }

    const tgt = getTarget(activeStep, n, logoLeft);
    const modeChange = (curRef.current.logoOp > 0.5) !== (tgt.logoOp > 0.5);

    snapRef.current = null;

    if (modeChange && activeStep !== undefined) {
      // logo → pipeline: nodes start at logo dot positions (see buildLogoToPipelineFrom)
      fromRef.current = buildLogoToPipelineFrom(activeStep, n, logoLeft);
      tgtRef.current  = tgt;
    } else if (modeChange && activeStep === undefined) {
      // pipeline → logo: nodes animate back to logo dot positions; when they
      // arrive the logo group snaps in (applied via snapRef at animation end)
      const prevStep  = Math.round(pipelineStepFloatRef.current);
      fromRef.current = { ...curRef.current };
      tgtRef.current  = buildPipelineToLogoTarget(prevStep, n, logoLeft);
      snapRef.current = getTarget(undefined, n, logoLeft);
    } else {
      fromRef.current = { ...curRef.current };
      tgtRef.current  = tgt;
    }

    t0Ref.current  = performance.now();
    durRef.current = modeChange ? MODE_MS : STEP_MS;

    const useArc =
      !modeChange &&
      typeof activeStep === "number" &&
      curRef.current.logoOp < 0.5;

    const s0Arc = pipelineStepFloatRef.current;
    const s1Arc = typeof activeStep === "number" ? activeStep : 0;

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
        // Fire the snap: logo group appears, node circles disappear in the same frame.
        if (snapRef.current) {
          apply(snapRef.current);
          snapRef.current = null;
        }
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
  const [labelOpaque, setLabelOpaque] = useState(true);
  const [displayStep, setDisplayStep] = useState(activeStep);
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
      {/* ── Meridian arcs ─────────────────────────────────────────────────────
          Logo mode:    compact ellipses matching Meridian_no_bg.svg proportions.
          Pipeline mode: outer expands to the R_CIRC node circle (nodes sit on it);
                         inner arc top aligns with PIPE_ARC_TOP (below the halo).
          cx/cy/rx/ry are all animated directly by apply().                     */}
      <g ref={meridianRef} opacity={Math.max(0, Math.min(1, init.mArcOp))}>
        <ellipse
          ref={mArc1Ref}
          cx={init.mArc1.cx} cy={init.mArc1.cy}
          rx={init.mArc1.rx} ry={init.mArc1.ry}
          fill="none" strokeWidth={6} strokeLinecap="round"
          style={{ stroke: "hsl(var(--primary))", strokeOpacity: 0.55 }}
        />
        <ellipse
          ref={mArc2Ref}
          cx={init.mArc2.cx} cy={init.mArc2.cy}
          rx={init.mArc2.rx} ry={init.mArc2.ry}
          fill="none" strokeWidth={5} strokeLinecap="round"
          style={{ stroke: "hsl(var(--primary))", strokeOpacity: 0.35 }}
        />
      </g>

      {/* ── Logo circles — fade out when pipeline activates ───────────────────
          Centre dot + satellites (halo ring is only the shared <circle> below).
          4 additional satellites at k=±3 and k=±4 continuing the same orbit
          at ~16° angular spacing from the outer arc centre (479, 140).
          All same size (r=10.822 SVG) and same opacity (0.85).              */}
      <g
        ref={logoGroupRef}
        transform={`translate(${logoLeft ? 120 : 480} 38) scale(0.55) translate(-121.052 -87.969)`}
        opacity={Math.max(0, Math.min(1, init.logoOp))}
      >
        <circle cx="121.052" cy="87.969" r="17.211" style={{ fill: "hsl(var(--primary))" }} />
        {/* original left satellites */}
        <circle cx="64.542"  cy="96.615"  r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
        <circle cx="24.205"  cy="123.082" r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
        {/* original right satellites (reflected) */}
        <circle cx="-178.16" cy="96.335"  r="10.822" opacity={0.85}
          transform="matrix(-1 0 0 1 0 0)" style={{ fill: "hsl(var(--primary))" }} />
        <circle cx="-217.5"  cy="124.802" r="10.822" opacity={0.85}
          transform="matrix(-1 0 0 1 0 0)" style={{ fill: "hsl(var(--primary))" }} />
        {/* k=−3  comp≈(403.5, 73.0) — orbit radius ~101, angle −138° */}
        <circle cx="-18.0"   cy="151.6"   r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
        {/* k=−4  comp≈(387.6, 96.8) — angle −154° */}
        <circle cx="-46.9"   cy="194.9"   r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
        {/* k=+3  comp≈(555.6, 74.9) — angle −40° */}
        <circle cx="258.5"   cy="155.1"   r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
        {/* k=+4  comp≈(571.0, 99.3) — angle −24° */}
        <circle cx="286.6"   cy="199.4"   r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
      </g>

      {/* ── Left decorative nodes ─────────────────────────────────────────────*/}
      {LEFT_SHOW.map((_, i) => (
        <circle
          key={`l${i}`}
          ref={el => { leftRefs.current[i] = el; }}
          cx={init.left[i].cx}
          cy={init.left[i].cy}
          r={SAT_R}
          opacity={init.left[i].op}
          style={{ fill: "hsl(var(--primary))" }}
        />
      ))}

      {/* ── Pipeline nodes 0-7 ───────────────────────────────────────────────*/}
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

      {/* ── Halo ring ─────────────────────────────────────────────────────────*/}
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

      {/* ── Step label ────────────────────────────────────────────────────────*/}
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
