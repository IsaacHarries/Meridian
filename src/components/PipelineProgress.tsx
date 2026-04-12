import { useState, useEffect, useRef } from "react";

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
// Nodes sit on a large circle whose centre is far below the header.
// Only the shallow top arc is visible; 5 nodes fit within the header height.
//
//   R = 1066, angular spacing = 7°
//
//   θ = 0°  (active):   x=400  y=32  ← always at 12-o'clock
//   θ = ±7° (adjacent): x=530/270  y=40  ← clearly visible
//   θ = ±14° (outer):   x=658/142  y=63  ← visible, near clip boundary
//   θ = ±21° (beyond):  x=782/18   y=103 ← just below clip, arcs in during anim
//
// The group is rotated around the circle centre (ACTIVE_X, CY) via
// requestAnimationFrame which directly sets the SVG rotate(angle cx cy)
// attribute — this sidesteps CSS/viewBox coordinate-system mismatches.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_X  = 400;
const NODE_Y    = 32;
const R         = 1066;
const CY        = NODE_Y + R;   // 1098 — circle centre, far below visible area
const ANGLE_DEG = 7;
const DEG       = Math.PI / 180;
const DURATION  = 580;          // ms per step transition

const DOT_R    = 7;
const ACTIVE_R = 10;
const HALO_R   = 18;
const LABEL_Y  = 56;

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Fixed position of node i on the circle (before any group rotation). */
function nodePos(i: number) {
  const a = (-90 + i * ANGLE_DEG) * DEG;
  return { cx: ACTIVE_X + R * Math.cos(a), cy: CY + R * Math.sin(a) };
}

interface PipelineProgressProps {
  /** 0-indexed step. undefined = static / decorative (no active indicator). */
  activeStep?: number;
  steps?: string[];
  className?: string;
  style?: React.CSSProperties;
}

export function PipelineProgress({
  activeStep,
  steps = PIPELINE_STEPS,
  className,
  style,
}: PipelineProgressProps) {
  // ── rAF animation ──────────────────────────────────────────────────────────
  const groupRef  = useRef<SVGGElement>(null);
  const rafRef    = useRef<number | null>(null);
  const angleRef  = useRef(0);   // current visual angle (degrees)
  const fromRef   = useRef(0);
  const toRef     = useRef(0);
  const startRef  = useRef(0);
  const firstRef  = useRef(true);

  function applyAngle(deg: number) {
    groupRef.current?.setAttribute("transform", `rotate(${deg} ${ACTIVE_X} ${CY})`);
    angleRef.current = deg;
  }

  useEffect(() => {
    const target = -(activeStep ?? 0) * ANGLE_DEG;

    // On the very first render, snap immediately with no animation.
    if (firstRef.current) {
      firstRef.current = false;
      applyAngle(target);
      return;
    }

    fromRef.current  = angleRef.current;
    toRef.current    = target;
    startRef.current = performance.now();

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    function frame(now: number) {
      const t     = Math.min((now - startRef.current) / DURATION, 1);
      const angle = fromRef.current + (toRef.current - fromRef.current) * easeInOutCubic(t);
      applyAngle(angle);
      if (t < 1) rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [activeStep]);

  // ── Label cross-fade ───────────────────────────────────────────────────────
  const [labelOpaque,    setLabelOpaque]    = useState(true);
  const [displayedStep,  setDisplayedStep]  = useState(activeStep);
  const prevRef = useRef(activeStep);

  useEffect(() => {
    if (prevRef.current === activeStep) return;
    setLabelOpaque(false);
    const t = setTimeout(() => {
      setDisplayedStep(activeStep);
      setLabelOpaque(true);
      prevRef.current = activeStep;
    }, 250);
    return () => clearTimeout(t);
  }, [activeStep]);

  const label = displayedStep !== undefined ? steps[displayedStep] : undefined;

  return (
    <svg
      viewBox="0 0 960 116"
      preserveAspectRatio="xMinYMin meet"
      aria-label={label ? `Step: ${label}` : "Meridian pipeline"}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      {/* ── Rotating node group ───────────────────────────────────────────── */}
      <g ref={groupRef}>
        {steps.map((_, i) => {
          const { cx, cy } = nodePos(i);
          const isActive   = i === activeStep;
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={isActive ? ACTIVE_R : DOT_R}
              opacity={activeStep === undefined ? 0.55 : isActive ? 1 : 0.38}
              style={{ fill: "hsl(var(--primary))" }}
            />
          );
        })}
      </g>

      {/* ── Halo ring — fixed at 12-o'clock, never rotates ───────────────── */}
      {activeStep !== undefined && (
        <circle
          cx={ACTIVE_X}
          cy={NODE_Y}
          r={HALO_R}
          fill="none"
          strokeWidth="2"
          strokeOpacity={0.55}
          style={{ stroke: "hsl(var(--primary))" }}
        />
      )}

      {/* ── Step label — fixed below active position, cross-fades ─────────── */}
      {label !== undefined && (
        <text
          x={ACTIVE_X}
          y={LABEL_Y}
          textAnchor="middle"
          style={{
            fill: "hsl(var(--primary))",
            fontSize: "10px",
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
