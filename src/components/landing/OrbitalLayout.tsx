import { useEffect, useRef, useState } from "react";
import type { WorkflowId } from "@/screens/WorkflowScreen";
import type { LandingLayoutProps } from "@/lib/landingLayouts";
import { CardBadge } from "./CardBadge";

// Geometry — viewBox is locked to the same 3:2 aspect as the container so
// SVG units = rendered pixels under preserveAspectRatio "xMidYMid meet". The
// 8 workflow nodes orbit a wireframe planet on a single ring at NODE_R.

const VBOX_W = 1200;
const VBOX_H = 960;          // 5:4 — more vertical room than the previous 3:2
const CX = VBOX_W / 2;
const CY = VBOX_H / 2;
const PLANET_R = 240;       // wireframe sphere outer radius
const ORBIT_R = 360;        // node-orbit radius — circular path around the planet

const NODE_COUNT = 8;
function nodeAngle(i: number): number {
  return -Math.PI / 2 + (i * Math.PI * 2) / NODE_COUNT;
}

// Position on the orbital ring — a perfect circle of radius ORBIT_R.
function nodePos(i: number): { x: number; y: number } {
  const a = nodeAngle(i);
  return {
    x: CX + ORBIT_R * Math.cos(a),
    y: CY + ORBIT_R * Math.sin(a),
  };
}

// ── Planet wireframe ──────────────────────────────────────────────────────────
// Classic globe-icon construction: sphere outline + N rotating longitude
// ellipses (sharing top/bottom poles, sweeping rx in sync to simulate the
// globe rotating around its polar axis) + a static equator + latitudes.

const N_LONGITUDES = 6;          // longitudes evenly distributed in 3D
const ROTATION_PERIOD_S = 90;    // seconds per full rotation
const LONGITUDE_OPACITY = 0.4;   // constant stroke opacity for any visible longitude
const AXIAL_TILT_DEG = 23.5;     // Earth's axial tilt relative to its orbital plane

function PlanetWireframe() {
  const longitudeRefs = useRef<(SVGEllipseElement | null)[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Project a longitude line at base angle θ as 2D rx given a rotation
    // phase. Longitudes with sin > 0 face the viewer; sin < 0 are behind the
    // planet and we hide them so the rotation reads as directional rather
    // than a symmetric pulse. Stroke opacity stays constant for every
    // visible longitude — only rx animates.
    const apply = (phase: number) => {
      for (let i = 0; i < N_LONGITUDES; i++) {
        const ref = longitudeRefs.current[i];
        if (!ref) continue;
        const baseAngle = (i * 2 * Math.PI) / N_LONGITUDES;
        const s = Math.sin(baseAngle + phase);
        if (s > 0) {
          ref.setAttribute("rx", (s * PLANET_R).toString());
          ref.setAttribute("opacity", LONGITUDE_OPACITY.toString());
        } else {
          ref.setAttribute("opacity", "0");
        }
      }
    };

    // Respect prefers-reduced-motion: paint once at a non-zero phase so the
    // longitudes are still visible, but skip the RAF loop.
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      apply(Math.PI / 4);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const phase = (((now - start) / 1000) / ROTATION_PERIOD_S) * 2 * Math.PI;
      apply(phase);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const stroke = "currentColor";
  // Latitudes at ±lat_offset (as a fraction of PLANET_R) — rx scales by
  // sqrt(1 - offset²) so the ellipse touches the sphere's outline.
  const latitudes = [0.5, -0.5];
  return (
    // Tilt the entire wireframe (sphere + longitudes + latitudes) by Earth's
    // axial tilt. The longitude animation rotates around the now-tilted
    // polar axis, matching how Earth spins relative to its orbital plane.
    <g transform={`rotate(${AXIAL_TILT_DEG} ${CX} ${CY})`}>
      {/* Sphere outline */}
      <circle cx={CX} cy={CY} r={PLANET_R} stroke={stroke} fill="none" strokeWidth={1.5} opacity={0.55} />
      {/* Animated longitudes — initial rx=0/opacity=0; the RAF effect updates
          them every frame to simulate rotation around the polar axis. */}
      {Array.from({ length: N_LONGITUDES }, (_, i) => (
        <ellipse
          key={i}
          ref={(el) => {
            longitudeRefs.current[i] = el;
          }}
          cx={CX}
          cy={CY}
          rx={0}
          ry={PLANET_R}
          stroke={stroke}
          fill="none"
          strokeWidth={1.2}
          opacity={0}
        />
      ))}
      {/* Equator */}
      <ellipse
        cx={CX}
        cy={CY}
        rx={PLANET_R}
        ry={PLANET_R * 0.18}
        stroke={stroke}
        fill="none"
        strokeWidth={1.2}
        opacity={0.5}
      />
      {/* Latitude rings — narrower than the equator, offset above/below */}
      {latitudes.map((offset) => (
        <ellipse
          key={`lat-${offset}`}
          cx={CX}
          cy={CY + PLANET_R * offset}
          rx={PLANET_R * Math.sqrt(1 - offset * offset)}
          ry={PLANET_R * 0.13}
          stroke={stroke}
          fill="none"
          strokeWidth={1.1}
          opacity={0.32}
        />
      ))}
      {/* Faint planet fill so the rotating longitudes read as wrapping a
          translucent sphere rather than floating in front of it. */}
      <circle
        cx={CX}
        cy={CY}
        r={PLANET_R}
        fill="hsl(var(--background) / 0.55)"
        opacity={0.6}
      />
    </g>
  );
}

export function OrbitalLayout({ cards, onNavigate }: LandingLayoutProps) {
  const [hoveredId, setHoveredId] = useState<WorkflowId | null>(null);
  const hovered = cards.find((c) => c.id === hoveredId) ?? null;

  return (
    <div className="max-w-7xl w-full mx-auto p-4 sm:p-6">
      <div
        className="relative w-full aspect-[5/4] mx-auto"
        style={{ maxHeight: "calc(100vh - 170px)" }}
      >
        <svg
          viewBox={`0 0 ${VBOX_W} ${VBOX_H}`}
          preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 w-full h-full text-primary pointer-events-none overflow-visible"
          fill="none"
          stroke="currentColor"
        >
          <PlanetWireframe />
        </svg>

        {/* Centre — meridian glyph by default, hovered card details when active.
            Sits slightly above-centre so it's clear of the orbital ring's
            front edge. */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="max-w-[280px] text-center px-4">
            {hovered ? (
              <div className="animate-in fade-in duration-200">
                <hovered.Icon className="h-10 w-10 mx-auto text-primary mb-2" />
                <p className="text-lg font-semibold leading-snug">{hovered.title}</p>
                <p className="text-sm text-muted-foreground mt-1.5 leading-snug">
                  {hovered.description}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground tracking-wide uppercase opacity-85">
                Pick a workflow
              </p>
            )}
          </div>
        </div>

        {/* Eight nodes on the outer orbital ring. Positions expressed in
            viewBox-relative percentages so they line up with the SVG planet
            under preserveAspectRatio="xMidYMid meet". */}
        {cards.map((card, i) => {
          const { x, y } = nodePos(i);
          const xPct = (x / VBOX_W) * 100;
          const yPct = (y / VBOX_H) * 100;
          // Label always renders directly above the halo, regardless of the
          // card's position on the orbital ring. The badge sits below the
          // halo, so above-the-halo placement never collides with it.
          const labelClass = "bottom-full mb-1.5 left-1/2 -translate-x-1/2 text-center";
          return (
            <button
              key={card.id}
              onClick={() => onNavigate(card.id)}
              onMouseEnter={() => setHoveredId(card.id)}
              onMouseLeave={() => setHoveredId((cur) => (cur === card.id ? null : cur))}
              onFocus={() => setHoveredId(card.id)}
              onBlur={() => setHoveredId((cur) => (cur === card.id ? null : cur))}
              className="absolute group cursor-pointer w-16 h-16"
              style={{
                left: `${xPct}%`,
                top: `${yPct}%`,
                transform: "translate(-50%, -50%)",
              }}
            >
              <span className="absolute inset-0 flex items-center justify-center rounded-full border border-blue-400/40 bg-blue-500/15 backdrop-blur-sm shadow-sm transition-all group-hover:scale-110 group-hover:border-blue-400 group-hover:bg-blue-500/25 group-hover:shadow-md group-focus-visible:scale-110 group-focus-visible:border-blue-400">
                <card.Icon className="h-7 w-7 text-white/90 group-hover:text-white transition-colors" />
              </span>
              {card.badge && (
                <CardBadge
                  badge={card.badge}
                  className="absolute top-full mt-1.5 left-1/2 -translate-x-1/2 z-10 whitespace-nowrap"
                />
              )}
              <span
                className={`absolute rounded-md bg-background/75 backdrop-blur-sm px-2 py-0.5 text-xs font-medium whitespace-nowrap text-white/90 group-hover:text-white group-hover:bg-background/85 transition-colors pointer-events-none ${labelClass}`}
              >
                {card.title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
