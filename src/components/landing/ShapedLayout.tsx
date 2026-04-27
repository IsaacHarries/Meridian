import type { WorkflowId } from "@/screens/WorkflowScreen";
import type { LandingLayoutProps, RenderableCard } from "@/lib/landingLayouts";
import { cn } from "@/lib/utils";
import { CardBadge } from "./CardBadge";

// Each card is bounded by an SVG silhouette specific to its workflow. The path
// is drawn at viewBox 200×120 and scaled (non-uniformly) to fill the tile, so
// every card has the same physical footprint but a distinct outline.

interface ShapeDef {
  d: string;
  // Optional secondary decoration drawn inside (stroked, no fill)
  decoration?: React.ReactNode;
  // Where to inset the content relative to the silhouette (in % of width/height)
  inset?: { top?: number; right?: number; bottom?: number; left?: number };
}

const SHAPES: Record<WorkflowId, ShapeDef> = {
  // Ticket stub — perforations on left/right edges at midline
  "implement-ticket": {
    d: "M 4 4 V 50 A 8 8 0 0 1 4 70 V 116 H 196 V 70 A 8 8 0 0 1 196 50 V 4 Z",
  },
  // Lens — corner bite from top-right
  "review-pr": {
    d: "M 4 4 H 168 A 28 28 0 0 1 196 32 V 116 H 4 Z",
  },
  // Bar-chart silhouette — stepped top edge
  "sprint-dashboard": {
    d: "M 4 116 V 90 H 50 V 70 H 100 V 50 H 150 V 30 H 196 V 116 Z",
  },
  // Sprint cycle — semi-circular bite from the top
  "retrospectives": {
    d: "M 4 4 H 78 A 22 14 0 0 0 122 4 H 196 V 116 H 4 Z",
  },
  // Tag — chevron point on the right
  "ticket-quality": {
    d: "M 4 4 H 170 L 196 60 L 170 116 H 4 Z",
  },
  // Speech bubble — tail at bottom-left
  "address-pr-comments": {
    d: "M 4 4 H 196 V 96 H 36 L 16 116 L 24 96 H 4 Z",
    inset: { bottom: 8 },
  },
  // Pill — fully rounded ends
  "meetings": {
    d: "M 60 4 H 140 A 56 56 0 0 1 140 116 H 60 A 56 56 0 0 1 60 4 Z",
    inset: { left: 4, right: 4 },
  },
  // Stopwatch — circular face with a small stem on top
  "time-tracking": {
    d: "M 90 4 H 110 V 12 A 54 54 0 0 1 100 116 A 54 54 0 0 1 100 12 V 12 Z",
    inset: { top: 4, bottom: 4 },
  },
};

function ShapedTile({
  card,
  onNavigate,
}: {
  card: RenderableCard;
  onNavigate: (id: WorkflowId) => void;
}) {
  const shape = SHAPES[card.id];
  const inset = shape.inset ?? {};
  return (
    <button
      onClick={() => onNavigate(card.id)}
      className="group relative aspect-[5/3] text-left cursor-pointer"
      // The silhouette drives the visual bounds; remove any default button styling.
      style={{ background: "transparent" }}
    >
      <svg
        className="absolute inset-0 w-full h-full text-border group-hover:text-primary/60 transition-colors"
        viewBox="0 0 200 120"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d={shape.d}
          className="fill-card/70 group-hover:fill-accent/70 transition-colors"
          stroke="currentColor"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
        {shape.decoration}
      </svg>
      <div
        className="absolute inset-0 flex flex-col gap-1.5 p-4 z-10"
        style={{
          paddingTop: `${(inset.top ?? 0) + 16}px`,
          paddingRight: `${(inset.right ?? 0) + 16}px`,
          paddingBottom: `${(inset.bottom ?? 0) + 16}px`,
          paddingLeft: `${(inset.left ?? 0) + 16}px`,
        }}
      >
        {card.badge && (
          <CardBadge
            badge={card.badge}
            className={cn(
              "absolute top-2 left-2",
              // Some shapes have busy right edges — keep the badge on the left to avoid clipping.
            )}
          />
        )}
        <card.Icon className="h-7 w-7 text-foreground/85 group-hover:text-primary transition-colors" />
        <div className="mt-auto">
          <p className="text-sm font-medium leading-snug">{card.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-snug line-clamp-2">
            {card.description}
          </p>
        </div>
      </div>
    </button>
  );
}

export function ShapedLayout({ cards, onNavigate }: LandingLayoutProps) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {cards.map((card) => (
        <ShapedTile key={card.id} card={card} onNavigate={onNavigate} />
      ))}
    </div>
  );
}
