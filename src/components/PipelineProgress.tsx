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
//  Meridian arcs both have their top at y=55 (17 px below nodes at y=38),
//  keeping nodes above the arcs just as in logo mode.
//  Outer arc: r=R_CIRC (same curvature as nodes), shifted so top = y=55.
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
const LABEL_Y = 100;

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
//   outer matches R_CIRC node circle exactly (top at NODE_Y=38, same as active node)
//   inner r=1044 keeps its top at y=60 (same as logo-mode inner top)

interface MA { cx: number; cy: number; rx: number; ry: number; }

// Centred logo-mode arcs (anchor cx=480)
const MARC1_LOGO:   MA = { cx: 479.3, cy: 127.6, rx:  35.5, ry:  67.0 };
const MARC2_LOGO:   MA = { cx: 478.7, cy: 140.4, rx:  80.2, ry:  80.2 };
// Left-aligned (anchor cx=120, shift cx by −360)
const MARC1_LOGO_L: MA = { cx: 119.3, cy: 127.6, rx:  35.5, ry:  67.0 };
const MARC2_LOGO_L: MA = { cx: 118.7, cy: 140.4, rx:  80.2, ry:  80.2 };
// Pipeline-mode arcs (component space, centred on ACTIVE_X)
//
// Both arcs have their topmost point at y=55 (17 px below the nodes at y=38),
// so the nodes sit clearly ABOVE the meridian lines — matching the compact view.
//
// Outer (r=R_CIRC): same curvature as the node circle, shifted down so its top
// is at y=55.  At y=116 (viewBox bottom) it spans x ≈ [45, 755].
//
// Inner: elongated ellipse preserving the logo-mode aspect ratio
//   rx_logo/rx_outer_logo = 35.5/80.2 ≈ 0.443  →  rx = 1066 × 0.443 ≈ 472
//   ry_logo/ry_outer_logo = 67.0/80.2 ≈ 0.836  →  ry = 1066 × 0.836 ≈ 891
// At y=116 it spans x ≈ [228, 572], clearly narrower than the outer arc.
const PIPE_ARC_TOP  = 55;                                    // y of both arc tops
const MARC1_PIPE:   MA = { cx: ACTIVE_X, cy: PIPE_ARC_TOP + 891, rx: 472,    ry: 891    };
const MARC2_PIPE:   MA = { cx: ACTIVE_X, cy: PIPE_ARC_TOP + R_CIRC, rx: R_CIRC, ry: R_CIRC };

// ── Node state ────────────────────────────────────────────────────────────────

interface NS { cx: number; cy: number; r: number; op: number; }

const LOGO_NODES: NS[] = [
  { cx: 480, cy: 38, r: 9.5,    op: 0 },
  { cx: 511, cy: 43, r: 6,      op: 0 },
  { cx: 533, cy: 58, r: 6,      op: 0 },
  { cx: 1080, cy: 73, r: DOT_R, op: 0 },
  { cx: 1180, cy: 73, r: DOT_R, op: 0 },
  { cx: 1280, cy: 73, r: DOT_R, op: 0 },
  { cx: 1380, cy: 73, r: DOT_R, op: 0 },
  { cx: 1480, cy: 73, r: DOT_R, op: 0 },
];
const LEFT_SHOW: NS[] = [
  { cx: 427, cy: 57, r: SAT_R, op: 0 },
  { cx: 449, cy: 43, r: SAT_R, op: 0 },
];
const LOGO_NODES_L: NS[] = [
  { cx: 120, cy: 38, r: 9.5,    op: 0 },
  { cx: 151, cy: 43, r: 6,      op: 0 },
  { cx: 173, cy: 58, r: 6,      op: 0 },
  { cx:  720, cy: 73, r: DOT_R, op: 0 },
  { cx:  820, cy: 73, r: DOT_R, op: 0 },
  { cx:  920, cy: 73, r: DOT_R, op: 0 },
  { cx: 1020, cy: 73, r: DOT_R, op: 0 },
  { cx: 1120, cy: 73, r: DOT_R, op: 0 },
];
const LEFT_SHOW_L: NS[] = [
  { cx:  67, cy: 57, r: SAT_R, op: 0 },
  { cx:  89, cy: 43, r: SAT_R, op: 0 },
];

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
  const lp0 = pipePos(sFloat - 2, sFloat);
  const lp1 = pipePos(sFloat - 1, sFloat);
  return {
    nodes,
    left: [
      { cx: lp0.cx, cy: lp0.cy, r: lp0.r, op: lerp(fromS.left[0].op, toS.left[0].op, t) },
      { cx: lp1.cx, cy: lp1.cy, r: lp1.r, op: lerp(fromS.left[1].op, toS.left[1].op, t) },
    ],
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
    op: rel === 0 ? 1 : Math.abs(rel) <= 2 ? 0.38 : Math.abs(rel) === 3 ? 0.15 : 0,
  };
}

function getTarget(step: number | undefined, n: number, logoLeft = false): S {
  if (step === undefined) {
    const cx = logoLeft ? 120 : 480;
    return {
      nodes:  (logoLeft ? LOGO_NODES_L : LOGO_NODES).slice(0, n),
      left:   (logoLeft ? LEFT_SHOW_L  : LEFT_SHOW).slice(),
      hCx: cx, hCy: NODE_Y, hR: LOGO_HR, hSOp: 0,
      logoOp: 1,
      mArcOp: 1,
      mArc1: logoLeft ? MARC1_LOGO_L : MARC1_LOGO,
      mArc2: logoLeft ? MARC2_LOGO_L : MARC2_LOGO,
    };
  }
  const s   = step;
  const lp0 = pipePos(s - 2, s);
  const lp1 = pipePos(s - 1, s);
  return {
    nodes: Array.from({ length: n }, (_, i) => pipePos(i, s)),
    left: [{ ...lp0, op: 0 }, { ...lp1, op: 0 }],
    hCx: ACTIVE_X, hCy: NODE_Y, hR: PIPE_HR, hSOp: 0.55,
    logoOp: 0,
    mArcOp: 0.5,
    mArc1: MARC1_PIPE,
    mArc2: MARC2_PIPE,
  };
}

function buildLogoToPipelineFrom(s: number, n: number, logoLeft: boolean): S {
  const logo    = logoLeft ? LOGO_NODES_L : LOGO_NODES;
  const leftPos = logoLeft ? LEFT_SHOW_L  : LEFT_SHOW;
  const base    = getTarget(undefined, n, logoLeft);
  const starts: NS[] = new Array(n);
  const inner   = new Set<number>();

  if (s >= 2) { starts[s - 2] = { ...leftPos[0] }; inner.add(s - 2); }
  if (s >= 1) { starts[s - 1] = { ...leftPos[1] }; inner.add(s - 1); }
  starts[s] = { ...logo[0] }; inner.add(s);
  if (s + 1 < n) { starts[s + 1] = { ...logo[1] }; inner.add(s + 1); }
  if (s + 2 < n) { starts[s + 2] = { ...logo[2] }; inner.add(s + 2); }

  const outer: number[] = [];
  for (let j = 0; j < n; j++) if (!inner.has(j)) outer.push(j);
  outer.sort((a, b) => a - b);
  for (let k = 0; k < outer.length; k++) starts[outer[k]] = { ...logo[3 + k] };

  return { ...base, nodes: starts };
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
  const leftRefs     = useRef<(SVGCircleElement   | null)[]>(Array(2).fill(null));
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

    if (modeChange && activeStep !== undefined) {
      fromRef.current = buildLogoToPipelineFrom(activeStep, n, logoLeft);
    } else {
      fromRef.current = { ...curRef.current };
    }
    tgtRef.current = tgt;
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
                         inner arc stays near y=60, matching its logo-mode top.
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
          Centre dot, halo ring, and four satellites from Meridian_no_bg.svg.  */}
      <g
        ref={logoGroupRef}
        transform={`translate(${logoLeft ? 120 : 480} 38) scale(0.55) translate(-121.052 -87.969)`}
        opacity={Math.max(0, Math.min(1, init.logoOp))}
      >
        <circle cx="121.052" cy="87.969" r="17.211" style={{ fill: "hsl(var(--primary))" }} />
        <circle cx="121.052" cy="87.969" r="29.728" strokeWidth={2.7}
          style={{ fill: "none", stroke: "hsl(var(--primary))", strokeOpacity: 0.54 }} />
        <circle cx="64.542" cy="96.615" r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
        <circle cx="24.205" cy="123.082" r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
        <circle cx="-178.16" cy="96.335" r="10.822" opacity={0.85}
          transform="matrix(-1 0 0 1 0 0)" style={{ fill: "hsl(var(--primary))" }} />
        <circle cx="-217.5" cy="124.802" r="10.822" opacity={0.85}
          transform="matrix(-1 0 0 1 0 0)" style={{ fill: "hsl(var(--primary))" }} />
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
