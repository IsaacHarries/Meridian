import type { WorkflowId } from "@/screens/WorkflowScreen";
import type { LandingLayoutProps, RenderableCard } from "@/lib/landingLayouts";
import { cn } from "@/lib/utils";
import { CardBadge } from "./CardBadge";

// Bento — explicit DOM ordering with grid-auto-flow:dense maps cards into the
// right cells. Hero tiles (implement, sprint-dashboard) get faint full-bleed
// icon decoration; the tall "address" tile stretches vertically.

const ORDER: WorkflowId[] = [
  "implement-ticket",
  "review-pr",
  "ticket-quality",
  "retrospectives",
  "sprint-dashboard",
  "address-pr-comments",
  "meetings",
];

const SPAN: Record<WorkflowId, string> = {
  "implement-ticket":     "col-span-2 row-span-2",
  "review-pr":            "col-span-2",
  "ticket-quality":       "col-span-2",
  "retrospectives":       "",
  "sprint-dashboard":     "col-span-2 row-span-2",
  "address-pr-comments":  "row-span-2",
  "meetings":             "",
};

const HERO: Record<WorkflowId, boolean> = {
  "implement-ticket":     true,
  "sprint-dashboard":     true,
  "review-pr":            false,
  "retrospectives":       false,
  "ticket-quality":       false,
  "address-pr-comments":  false,
  "meetings":             false,
};

function BentoTile({
  card,
  onNavigate,
}: {
  card: RenderableCard;
  onNavigate: (id: WorkflowId) => void;
}) {
  const isHero = HERO[card.id];
  const isTall = card.id === "address-pr-comments";
  return (
    <button
      onClick={() => onNavigate(card.id)}
      className={cn(
        "group relative flex flex-col rounded-xl border bg-card/60 text-left transition-colors hover:bg-accent/60 hover:border-primary/40 cursor-pointer overflow-hidden",
        SPAN[card.id],
        isHero ? "p-5 gap-3" : "p-4 gap-2",
      )}
    >
      {/* Hero tiles: large faded icon in the lower-right as background art. */}
      {isHero && (
        <card.Icon className="absolute -bottom-4 -right-4 h-32 w-32 text-primary/15 group-hover:text-primary/25 transition-colors pointer-events-none" />
      )}
      {/* Non-hero corner decoration (small concentric arc) */}
      {!isHero && !isTall && (
        <svg
          className="absolute -top-5 -right-5 h-16 w-16 text-primary/10 group-hover:text-primary/25 transition-colors pointer-events-none"
          viewBox="0 0 64 64"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        >
          <circle cx="32" cy="32" r="22" />
          <circle cx="32" cy="32" r="14" opacity="0.6" />
        </svg>
      )}
      {card.badge && <CardBadge badge={card.badge} className="absolute top-2 right-2 z-10" />}
      <card.Icon
        className={cn(
          "relative z-0 text-foreground/85 group-hover:text-primary transition-colors",
          isHero ? "h-9 w-9" : "h-6 w-6",
        )}
      />
      <div className={cn("relative z-0", isTall && "flex-1")}>
        <p className={cn("font-medium leading-snug", isHero ? "text-base" : "text-sm")}>
          {card.title}
        </p>
        <p className={cn("text-muted-foreground mt-0.5 leading-snug", isHero ? "text-sm" : "text-xs")}>
          {card.description}
        </p>
      </div>
    </button>
  );
}

export function BentoLayout({ cards, onNavigate }: LandingLayoutProps) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return (
    <div
      className="grid grid-cols-2 sm:grid-cols-4 gap-3"
      style={{ gridAutoFlow: "dense", gridAutoRows: "minmax(110px, auto)" }}
    >
      {ORDER.map((id) => {
        const card = byId.get(id);
        if (!card) return null;
        return <BentoTile key={id} card={card} onNavigate={onNavigate} />;
      })}
    </div>
  );
}
