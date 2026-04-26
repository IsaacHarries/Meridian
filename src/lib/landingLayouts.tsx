// Landing-page layout selector.
//
// Four layouts share the same shape data and just render it differently:
//   - constellation : the original 2×4 emoji grid, now with custom SVG icons
//   - bento         : asymmetric "bento box" with hero tiles + small ones
//   - shaped        : each card silhouette has its own SVG shape
//   - orbital       : workflows orbit a central Meridian glyph
//
// Layout choice is persisted to localStorage and broadcast via a window event,
// matching the same pattern as backgrounds.tsx.

import React, { useEffect, useState } from "react";
import type { WorkflowId } from "@/screens/WorkflowScreen";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LandingLayoutId = "constellation" | "bento" | "shaped" | "orbital";

export type WorkflowBadge =
  | { kind: "session"; label: string }
  | { kind: "attention"; label: string };

export interface RenderableCard {
  id: WorkflowId;
  Icon: React.FC<{ className?: string }>;
  title: string;
  description: string;
  badge: WorkflowBadge | null;
}

export interface LandingLayoutProps {
  cards: RenderableCard[];
  onNavigate: (id: WorkflowId) => void;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const LS_KEY = "meridian_landing_layout";
const CHANGE_EVENT = "meridian-landing-layout-change";
const VALID_IDS: LandingLayoutId[] = ["constellation", "bento", "shaped", "orbital"];

export function getLandingLayoutId(): LandingLayoutId {
  const raw = localStorage.getItem(LS_KEY);
  return (VALID_IDS as string[]).includes(raw ?? "")
    ? (raw as LandingLayoutId)
    : "constellation";
}

export function setLandingLayoutId(id: LandingLayoutId): void {
  localStorage.setItem(LS_KEY, id);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: id }));
}

export function useLandingLayoutId(): LandingLayoutId {
  const [id, setId] = useState<LandingLayoutId>(() => getLandingLayoutId());
  useEffect(() => {
    const handler = (e: Event) => setId((e as CustomEvent<LandingLayoutId>).detail);
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);
  return id;
}

// ── Wireframe previews (used by Settings picker) ──────────────────────────────
//
// Each preview is a 120×72 monochrome SVG schematic of the layout. They're
// drawn with currentColor so they pick up muted-foreground in the picker.

const WF_W = 120;
const WF_H = 72;

function WireframeFrame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${WF_W} ${WF_H}`}
      className="w-full h-full"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
    >
      {children}
    </svg>
  );
}

function ConstellationWireframe() {
  // 4 columns × 2 rows of small rounded tiles, each with a single dot
  const cols = 4, rows = 2;
  const padX = 8, padY = 10, gap = 4;
  const tileW = (WF_W - padX * 2 - gap * (cols - 1)) / cols;
  const tileH = (WF_H - padY * 2 - gap * (rows - 1)) / rows;
  const tiles: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      tiles.push({ x: padX + c * (tileW + gap), y: padY + r * (tileH + gap) });
  return (
    <WireframeFrame>
      {tiles.map((t, i) => (
        <g key={i}>
          <rect x={t.x} y={t.y} width={tileW} height={tileH} rx={2.5} opacity={0.55} />
          <circle cx={t.x + 5} cy={t.y + 5} r={1} fill="currentColor" />
        </g>
      ))}
    </WireframeFrame>
  );
}

function BentoWireframe() {
  // 4×4 cell grid: hero implement (2×2), wide review (2×1), quality+retro,
  // hero sprint (2×2), kb+meetings, tall address (1×2)
  const padX = 8, padY = 6, gap = 3;
  const cellW = (WF_W - padX * 2 - gap * 3) / 4;
  const cellH = (WF_H - padY * 2 - gap * 3) / 4;
  const tile = (cx: number, cy: number, w: number, h: number) => ({
    x: padX + cx * (cellW + gap),
    y: padY + cy * (cellH + gap),
    width: w * cellW + (w - 1) * gap,
    height: h * cellH + (h - 1) * gap,
  });
  const tiles = [
    tile(0, 0, 2, 2), // implement
    tile(2, 0, 2, 1), // review
    tile(2, 1, 1, 1), // quality
    tile(3, 1, 1, 1), // retro
    tile(0, 2, 2, 2), // sprint
    tile(2, 2, 1, 1), // kb
    tile(2, 3, 1, 1), // meetings
    tile(3, 2, 1, 2), // address
  ];
  return (
    <WireframeFrame>
      {tiles.map((t, i) => (
        <rect key={i} {...t} rx={2} opacity={i === 0 || i === 4 ? 0.85 : 0.5} />
      ))}
    </WireframeFrame>
  );
}

function ShapedWireframe() {
  // 2×4 grid of distinct silhouettes hinting that each card has its own shape
  const padX = 8, padY = 10, gap = 4;
  const cols = 4, rows = 2;
  const tileW = (WF_W - padX * 2 - gap * (cols - 1)) / cols;
  const tileH = (WF_H - padY * 2 - gap * (rows - 1)) / rows;
  const x = (c: number) => padX + c * (tileW + gap);
  const y = (r: number) => padY + r * (tileH + gap);
  // Eight different silhouettes hinted in miniature
  const shapes = [
    // ticket stub
    `M ${x(0) + 1} ${y(0) + 2} V ${y(0) + tileH / 2 - 2} A 1.6 1.6 0 0 1 ${x(0) + 1} ${y(0) + tileH / 2 + 2} V ${y(0) + tileH - 2} H ${x(0) + tileW - 1} V ${y(0) + tileH / 2 + 2} A 1.6 1.6 0 0 1 ${x(0) + tileW - 1} ${y(0) + tileH / 2 - 2} V ${y(0) + 2} Z`,
    // lens (rect with bite from top-right)
    `M ${x(1) + 1} ${y(0) + 2} H ${x(1) + tileW - 6} A 5 5 0 0 1 ${x(1) + tileW - 1} ${y(0) + 7} V ${y(0) + tileH - 2} H ${x(1) + 1} Z`,
    // bar chart silhouette (stepped top)
    `M ${x(2) + 1} ${y(0) + tileH - 2} V ${y(0) + 8} H ${x(2) + tileW / 4} V ${y(0) + 6} H ${x(2) + tileW / 2} V ${y(0) + 4} H ${x(2) + 3 * tileW / 4} V ${y(0) + 2} H ${x(2) + tileW - 1} V ${y(0) + tileH - 2} Z`,
    // orbit (oval/rounded)
    `M ${x(3) + 1} ${y(0) + tileH / 2} A ${tileW / 2 - 1} ${tileH / 2 - 2} 0 1 1 ${x(3) + tileW - 1} ${y(0) + tileH / 2} A ${tileW / 2 - 1} ${tileH / 2 - 2} 0 1 1 ${x(3) + 1} ${y(0) + tileH / 2}`,
    // tag (rect with chevron right)
    `M ${x(0) + 1} ${y(1) + 2} H ${x(0) + tileW - 4} L ${x(0) + tileW - 1} ${y(1) + tileH / 2} L ${x(0) + tileW - 4} ${y(1) + tileH - 2} H ${x(0) + 1} Z`,
    // book (rect with spine line)
    `M ${x(1) + 1} ${y(1) + 2} H ${x(1) + tileW - 1} V ${y(1) + tileH - 2} H ${x(1) + 1} Z M ${x(1) + 4} ${y(1) + 2} V ${y(1) + tileH - 2}`,
    // speech bubble (with tail)
    `M ${x(2) + 1} ${y(1) + 2} H ${x(2) + tileW - 1} V ${y(1) + tileH - 5} H ${x(2) + 6} L ${x(2) + 3} ${y(1) + tileH - 1} L ${x(2) + 4} ${y(1) + tileH - 5} H ${x(2) + 1} Z`,
    // pill (fully rounded)
    `M ${x(3) + tileH / 2} ${y(1) + 2} H ${x(3) + tileW - tileH / 2} A ${tileH / 2 - 2} ${tileH / 2 - 2} 0 0 1 ${x(3) + tileW - tileH / 2} ${y(1) + tileH - 2} H ${x(3) + tileH / 2} A ${tileH / 2 - 2} ${tileH / 2 - 2} 0 0 1 ${x(3) + tileH / 2} ${y(1) + 2} Z`,
  ];
  return (
    <WireframeFrame>
      {shapes.map((d, i) => (
        <path key={i} d={d} opacity={0.6} />
      ))}
    </WireframeFrame>
  );
}

function OrbitalWireframe() {
  const cx = WF_W / 2;
  const cy = WF_H / 2;
  const PR = 12;     // planet radius (matches OrbitalLayout proportions)
  const OR = 26;     // orbital ring radius
  const TILT = 0.18;
  const angles = Array.from({ length: 8 }, (_, i) => -Math.PI / 2 + (i * Math.PI * 2) / 8);
  return (
    <WireframeFrame>
      {/* Orbital ring */}
      <ellipse cx={cx} cy={cy} rx={OR} ry={OR * (1 - TILT)} opacity={0.4} strokeDasharray="2 3" />
      {/* Planet wireframe — sphere outline + 2 longitudes + equator */}
      <circle cx={cx} cy={cy} r={PR} opacity={0.55} />
      <ellipse cx={cx} cy={cy} rx={PR * 0.32} ry={PR} opacity={0.45} />
      <ellipse cx={cx} cy={cy} rx={PR * 0.62} ry={PR} opacity={0.45} />
      <ellipse cx={cx} cy={cy} rx={PR} ry={PR * 0.18} opacity={0.55} />
      {/* Nodes on the orbital ring */}
      {angles.map((a, i) => (
        <circle
          key={i}
          cx={cx + OR * Math.cos(a)}
          cy={cy + OR * (1 - TILT) * Math.sin(a)}
          r={2.4}
          fill="currentColor"
          opacity={0.85}
        />
      ))}
    </WireframeFrame>
  );
}

// ── Layout metadata ───────────────────────────────────────────────────────────

export interface LandingLayoutDef {
  id: LandingLayoutId;
  name: string;
  description: string;
  Wireframe: React.FC;
}

export const LANDING_LAYOUTS: LandingLayoutDef[] = [
  {
    id: "constellation",
    name: "Constellation",
    description: "The original grid with custom line-art icons.",
    Wireframe: ConstellationWireframe,
  },
  {
    id: "bento",
    name: "Bento",
    description: "Asymmetric tiles — hero workflows get more space.",
    Wireframe: BentoWireframe,
  },
  {
    id: "shaped",
    name: "Shaped",
    description: "Each card has its own SVG silhouette.",
    Wireframe: ShapedWireframe,
  },
  {
    id: "orbital",
    name: "Orbital",
    description: "Workflows orbit a central Meridian glyph.",
    Wireframe: OrbitalWireframe,
  },
];
