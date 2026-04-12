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
//  Five dots matching the new Meridian mark: a centre node, two right satellites,
//  and two left decorative mirrors.  Two "meridian" elliptic arcs sit below the
//  node cluster — only their upper arcs are visible at the bottom of the header.
//
//  Centred layout (960 × 116 viewBox):
//    outer-left  (420, 73)  r=6.5  ← decorative left
//    inner-left  (450, 52)  r=6.5  ← decorative left
//    centre      (480, 38)  r=9    → pipeline node 0  (topmost)
//    inner-right (510, 52)  r=6.5  → pipeline node 1
//    outer-right (540, 73)  r=6.5  → pipeline node 2
//    halo ring:  cx=480 cy=38 r=16  stroke-opacity=0.4
//    arc 1 (inner):  ellipse cx=480 cy=137 rx=41 ry=79
//    arc 2 (outer):  ellipse cx=480 cy=157 rx=93 ry=93
//
// PIPELINE MODE  (activeStep = 0-7)
// ──────────────────────────────────
//  Eight nodes on an R_CIRC=1066 circle centred below the header (same clock-face
//  animation as before).  The meridian arcs remain visible but dim to mArcOp=0.45.
//  The pipeline progress Bezier arc fades in (arcOp: 0 → 0.5).
//
// TRANSITION
// ──────────
//  Logo → Pipeline: satellite dots spread to clock positions, pipeline arc fades in,
//  meridian arcs dim. Pipeline → Logo: reverse. Step-to-step: arc-constrained lerp.
//  Duration: 700 ms mode change, 580 ms step advance.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_X  = 400;
const NODE_Y    = 38;
const R_CIRC    = 1066;
const CY        = NODE_Y + R_CIRC;   // 1104 — circle centre far below header
const ANGLE_DEG = 7;
const RAD       = Math.PI / 180;

const DOT_R   = 7;     // pipeline node radius
const SAT_R   = 6.5;   // logo satellite dot radius
// CTR_R formerly used in LOGO_NODES — now hardcoded to 9.5 to match SVG scale
const ACT_R   = 10;    // active pipeline node radius
const PIPE_HR = 18;    // pipeline halo radius
const LOGO_HR = 16;    // logo halo radius
const LABEL_Y = 100;   // step label baseline

const STEP_MS = 580;
const MODE_MS = 700;

// Pipeline-mode arc — wide Bezier below the clock-face nodes.
// Shown only in pipeline mode (arcOp fades from 0 → 0.5 on activation).
// In logo mode the SVG ellipses handle the meridian-line visuals instead.
const PIPE_ARC_C: number[] = [-10, 142, 254, 32, 546, 32, 810, 142];

function ptsToD(p: number[]): string {
  return `M ${p[0]} ${p[1]} C ${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`;
}

// ── Node state ────────────────────────────────────────────────────────────────

interface NS { cx: number; cy: number; r: number; op: number; }

// Eight pipeline-node slots.  Slot 0 = logo centre; slots 1-2 = right satellites.
// Slots 3-7 are hidden off-screen until pipeline mode spreads them out.
const LOGO_NODES: NS[] = [
  { cx: 480, cy: 38, r: 9.5,   op: 0 },  // slot 0 — centre (matches embedded SVG dot)
  { cx: 511, cy: 43, r: 6,     op: 0 },  // slot 1 — right-inner
  { cx: 533, cy: 58, r: 6,     op: 0 },  // slot 2 — right-outer
  { cx: 1080, cy: 73, r: DOT_R, op: 0 },
  { cx: 1180, cy: 73, r: DOT_R, op: 0 },
  { cx: 1280, cy: 73, r: DOT_R, op: 0 },
  { cx: 1380, cy: 73, r: DOT_R, op: 0 },
  { cx: 1480, cy: 73, r: DOT_R, op: 0 },
];

// Two left decorative nodes — hidden in logo mode (SVG logo handles them), fade/slide in pipeline mode.
// Positions mirror the SVG logo's left satellites in the 960×116 coordinate space.
const LEFT_SHOW: NS[] = [
  { cx: 427, cy: 57, r: SAT_R, op: 0 },  // outer-left (mirrors slot 2)
  { cx: 449, cy: 43, r: SAT_R, op: 0 },  // inner-left (mirrors slot 1)
];

// Left-aligned variants (logo centre at x = 120, −360 shift from centred positions)
const LOGO_NODES_L: NS[] = [
  { cx: 120, cy: 38, r: 9.5, op: 0 },
  { cx: 151, cy: 43, r: 6,   op: 0 },
  { cx: 173, cy: 58, r: 6,   op: 0 },
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

// ── Animation state snapshot ──────────────────────────────────────────────────

interface S {
  nodes:  NS[];
  left:   NS[];
  /** Bezier arc opacity: 0 in logo mode, 0.5 in pipeline mode. */
  arcOp:  number;
  hCx:    number;
  hCy:    number;
  hR:     number;
  hSOp:   number;
  /** Logo SVG group opacity: 1 in logo mode, 0 in pipeline mode. */
  logoOp: number;
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
function lerpS(a: S, b: S, t: number): S {
  return {
    nodes:  a.nodes.map((an, i) => lerpNS(an, b.nodes[i], t)),
    left:   a.left.map((al, i)  => lerpNS(al, b.left[i],  t)),
    arcOp:  lerp(a.arcOp,  b.arcOp,  t),
    hCx:    lerp(a.hCx,    b.hCx,    t),
    hCy:    lerp(a.hCy,    b.hCy,    t),
    hR:     lerp(a.hR,     b.hR,     t),
    hSOp:   lerp(a.hSOp,   b.hSOp,   t),
    logoOp: lerp(a.logoOp, b.logoOp, t),
  };
}

/** Pipeline-only: move each node along the R_CIRC arc (avoids chord shortcuts). */
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
    arcOp:  lerp(fromS.arcOp,  toS.arcOp,  t),
    hCx:    lerp(fromS.hCx,   toS.hCx,    t),
    hCy:    lerp(fromS.hCy,   toS.hCy,    t),
    hR:     lerp(fromS.hR,    toS.hR,     t),
    hSOp:   lerp(fromS.hSOp,  toS.hSOp,   t),
    logoOp: lerp(fromS.logoOp, toS.logoOp, t),
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
      arcOp:  0,
      hCx:    logoLeft ? 120 : 480, hCy: NODE_Y, hR: LOGO_HR, hSOp: 0,
      logoOp: 1,
    };
  }
  const s   = step;
  const lp0 = pipePos(s - 2, s);
  const lp1 = pipePos(s - 1, s);
  return {
    nodes: Array.from({ length: n }, (_, i) => pipePos(i, s)),
    left: [
      { ...lp0, op: 0 },
      { ...lp1, op: 0 },
    ],
    arcOp:  0.5,
    hCx:    ACTIVE_X, hCy: NODE_Y, hR: PIPE_HR, hSOp: 0.55,
    logoOp: 0,
  };
}

/**
 * Starting snapshot for the logo → pipeline morph.
 * Each pipeline slot begins at the compact logo dot that will become its clock position.
 */
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
  const nodeRefs    = useRef<(SVGCircleElement   | null)[]>(Array(n).fill(null));
  const leftRefs    = useRef<(SVGCircleElement   | null)[]>(Array(2).fill(null));
  const arcRef      = useRef<SVGPathElement      | null>(null);
  const haloRef     = useRef<SVGCircleElement    | null>(null);
  const logoGroupRef = useRef<SVGGElement        | null>(null);

  // ── Animation tracking refs ───────────────────────────────────────────────
  const rafRef   = useRef<number | null>(null);
  const curRef   = useRef<S>(getTarget(activeStep, n, logoLeft));
  const fromRef  = useRef<S>(getTarget(activeStep, n, logoLeft));
  const tgtRef   = useRef<S>(getTarget(activeStep, n, logoLeft));
  const t0Ref    = useRef(0);
  const durRef   = useRef(0);
  const firstRef = useRef(true);
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
    if (arcRef.current) {
      arcRef.current.setAttribute("opacity", String(Math.max(0, Math.min(1, s.arcOp))));
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
    // Logo mode = logoOp > 0.5  |  Pipeline mode = logoOp <= 0.5
    const modeChange = (curRef.current.logoOp > 0.5) !== (tgt.logoOp > 0.5);

    if (modeChange && activeStep !== undefined) {
      fromRef.current = buildLogoToPipelineFrom(activeStep, n, logoLeft);
    } else {
      fromRef.current = { ...curRef.current };
    }
    tgtRef.current = tgt;
    t0Ref.current  = performance.now();
    durRef.current = modeChange ? MODE_MS : STEP_MS;

    // Arc-constrained lerp only applies for step-to-step advances in pipeline mode
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
      {/* ── Meridian logo mark (Meridian_no_bg.svg) ─────────────────────────────
          Circles are already in the SVG's 240×240 coordinate space (no inner
          group transform needed).  Scale 0.55, centre at (121.052, 87.969)
          placed at the logo anchor (480 or 120, 38).                           */}
      {/* ── Meridian logo mark — fades out when pipeline activates ─────────────
          Two SVG ellipses are the "meridian lines" in logo mode.
          Circles and ellipses use the SVG's 240×240 coordinate space;
          transform centres them at the logo anchor (480 or 120, 38).          */}
      <g
        ref={logoGroupRef}
        transform={`translate(${logoLeft ? 120 : 480} 38) scale(0.55) translate(-121.052 -87.969)`}
        opacity={Math.max(0, Math.min(1, init.logoOp))}
      >
        {/* Meridian arc — inner ellipse */}
        <ellipse cx="119.729" cy="250.888" rx="64.527" ry="121.84"
          fill="none" strokeWidth={6} strokeLinecap="round"
          style={{ stroke: "hsl(var(--primary))", strokeOpacity: 0.7 }} />
        {/* Meridian arc — outer ellipse */}
        <ellipse cx="118.632" cy="274.1" rx="145.804" ry="145.804"
          fill="none" strokeWidth={6} strokeLinecap="round"
          style={{ stroke: "hsl(var(--primary))", strokeOpacity: 0.45 }} />
        {/* Centre dot */}
        <circle cx="121.052" cy="87.969" r="17.211" style={{ fill: "hsl(var(--primary))" }} />
        {/* Halo ring */}
        <circle cx="121.052" cy="87.969" r="29.728" strokeWidth={2.7}
          style={{ fill: "none", stroke: "hsl(var(--primary))", strokeOpacity: 0.54 }} />
        {/* Left satellite — inner */}
        <circle cx="64.542" cy="96.615" r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
        {/* Left satellite — outer */}
        <circle cx="24.205" cy="123.082" r="10.822" opacity={0.85} style={{ fill: "hsl(var(--primary))" }} />
        {/* Right satellite — inner (mirrored) */}
        <circle cx="-178.16" cy="96.335" r="10.822" opacity={0.85}
          transform="matrix(-1 0 0 1 0 0)" style={{ fill: "hsl(var(--primary))" }} />
        {/* Right satellite — outer (mirrored) */}
        <circle cx="-217.5" cy="124.802" r="10.822" opacity={0.85}
          transform="matrix(-1 0 0 1 0 0)" style={{ fill: "hsl(var(--primary))" }} />
      </g>

      {/* ── Pipeline meridian arc ──────────────────────────────────────────────
          Hidden in logo mode (arcOp=0); fades in when pipeline activates.
          Static path — only opacity is animated.                               */}
      <path
        ref={arcRef}
        d={ptsToD(PIPE_ARC_C)}
        fill="none"
        strokeLinecap="round"
        strokeWidth="5"
        opacity={init.arcOp}
        style={{ stroke: "hsl(var(--primary))" }}
      />

      {/* ── Left decorative nodes ──────────────────────────────────────────────
          Visible in logo mode; slide off-screen / fade in pipeline mode.         */}
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

      {/* ── Pipeline nodes 0-7 ────────────────────────────────────────────────
          In logo mode: slots 0-2 are the centre + right satellites;
          slots 3-7 are hidden off-screen right.                                  */}
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

      {/* ── Halo ring ─────────────────────────────────────────────────────────
          Animates position (logo centre → active pipeline node) and size.        */}
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

      {/* ── Step label ────────────────────────────────────────────────────────
          Cross-fades on step change; hidden in logo mode.                        */}
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
