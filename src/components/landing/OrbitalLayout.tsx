import { useState } from "react";
import type { WorkflowId } from "@/screens/WorkflowScreen";
import type { LandingLayoutProps } from "@/lib/landingLayouts";
import { CardBadge } from "./CardBadge";

// Geometry — viewBox is locked to the same 3:2 aspect as the container so
// SVG units = rendered pixels under preserveAspectRatio "xMidYMid meet". The
// 8 workflow nodes orbit a wireframe planet on a single ring at NODE_R.

const VBOX_W = 1200;
const VBOX_H = 800;
const CX = VBOX_W / 2;
const CY = VBOX_H / 2;
const PLANET_R = 200;       // wireframe sphere outer radius
const ORBIT_R = 340;        // outer orbital ring (where the nodes sit)
const ORBIT_TILT = 0.18;    // ry/rx ratio for the orbital ring (slight tilt)

const NODE_COUNT = 8;
function nodeAngle(i: number): number {
  return -Math.PI / 2 + (i * Math.PI * 2) / NODE_COUNT;
}

// Position on the orbital ring (a tilted ellipse, not a circle), in viewBox units.
function nodePos(i: number): { x: number; y: number } {
  const a = nodeAngle(i);
  return {
    x: CX + ORBIT_R * Math.cos(a),
    // Compress vertical extent so the ring reads as tilted toward the viewer.
    y: CY + ORBIT_R * (1 - ORBIT_TILT) * Math.sin(a),
  };
}

// ── Planet wireframe ──────────────────────────────────────────────────────────
// Classic globe-icon construction: outer sphere outline + a few vertical
// longitudes (all sharing top/bottom poles, varying rx) + a few horizontal
// latitudes (centred on cy, scaled to fit inside the sphere).

function PlanetWireframe() {
  const stroke = "currentColor";
  // Latitudes at ±lat_offset (as a fraction of PLANET_R) — rx scales by
  // sqrt(1 - offset²) so the ellipse touches the sphere's outline.
  const latitudes = [0.5, -0.5];
  return (
    <g>
      {/* Sphere outline */}
      <circle cx={CX} cy={CY} r={PLANET_R} stroke={stroke} fill="none" strokeWidth={1.5} opacity={0.55} />
      {/* Longitudes — vertical ellipses through the top/bottom poles */}
      {[0.32, 0.62].map((frac) => (
        <ellipse
          key={`lon-${frac}`}
          cx={CX}
          cy={CY}
          rx={PLANET_R * frac}
          ry={PLANET_R}
          stroke={stroke}
          fill="none"
          strokeWidth={1.2}
          opacity={0.4}
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
      {/* Faint planet fill so the orbital ring reads as passing behind it */}
      <circle
        cx={CX}
        cy={CY}
        r={PLANET_R}
        fill="hsl(var(--background) / 0.55)"
        opacity={0.6}
        style={{ mixBlendMode: "normal" }}
      />
    </g>
  );
}

export function OrbitalLayout({ cards, onNavigate }: LandingLayoutProps) {
  const [hoveredId, setHoveredId] = useState<WorkflowId | null>(null);
  const hovered = cards.find((c) => c.id === hoveredId) ?? null;

  return (
    <div className="max-w-6xl w-full mx-auto bg-background/60 rounded-xl p-4 sm:p-6">
      <div
        className="relative w-full aspect-[3/2] mx-auto"
        style={{ maxHeight: "calc(100vh - 200px)" }}
      >
        <svg
          viewBox={`0 0 ${VBOX_W} ${VBOX_H}`}
          preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 w-full h-full text-primary pointer-events-none"
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
          // Label renders on the outward side of the halo (away from the
          // planet) so the orbital ring stays clear of text.
          const isLeft = xPct < 35;
          const isRight = xPct > 65;
          const isBottomHalf = yPct >= 50;
          // The badge always sits directly below the halo. When the title
          // label is also below the halo (bottom-half nodes), push it further
          // down so it doesn't overlap the badge.
          const labelOffsetForBadge = isBottomHalf && card.badge ? "mt-9" : "mt-1.5";
          const labelClass = isRight
            ? "left-full ml-2 top-1/2 -translate-y-1/2 text-left"
            : isLeft
            ? "right-full mr-2 top-1/2 -translate-y-1/2 text-right"
            : yPct < 50
            ? "bottom-full mb-1.5 left-1/2 -translate-x-1/2 text-center"
            : `top-full ${labelOffsetForBadge} left-1/2 -translate-x-1/2 text-center`;
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
              <span className="absolute inset-0 flex items-center justify-center rounded-full border bg-card/85 backdrop-blur-sm shadow-sm transition-all group-hover:scale-110 group-hover:border-primary group-hover:bg-accent group-hover:shadow-md group-focus-visible:scale-110 group-focus-visible:border-primary">
                <card.Icon className="h-7 w-7 text-foreground/85 group-hover:text-primary transition-colors" />
              </span>
              {card.badge && (
                <CardBadge
                  badge={card.badge}
                  className="absolute top-full mt-1.5 left-1/2 -translate-x-1/2 z-10 whitespace-nowrap"
                />
              )}
              <span
                className={`absolute text-xs font-medium whitespace-nowrap text-foreground/80 group-hover:text-primary transition-colors pointer-events-none ${labelClass}`}
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
